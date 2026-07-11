# 模型管理增强 设计 spec

> 分支 `feat/langchain-1x` 连续提交。前置：会话级模型选择已落地（含远程），
> 模型行 id = 云端配置 id（跨设备一致）。

## 0. 需求（用户原话）

1. 主流模型的上下文大小维护在配置里；
2. 不知道上下文大小的模型，在上下文输入框下提供快捷输入按钮（如 128k、1M）;
3. server-main 与客户端的 socket 通道把所有模型变更（创建/编辑/启用禁用）作为
   事件推送，客户端实时更新；
4. 模型使用中被禁用：该报错报错，客户端正常响应错误即可。
5. （修订）**所有在线设备实时收到模型更新；离线设备上线后拉取一次；去掉轮询。**

## 1. 现状勘查结论

| 项 | 状态 |
|---|---|
| `MODEL_SPECS`（`libs/types-agent/src/ai/model-specs.ts`，~20 模型 + `resolveContextWindow()`） | 表与解析函数在，**生产零调用**——云端入库 `OrgModelConfigService.create/update` 硬编码 `?? 128_000`；多处注释声称"按 MODEL_SPECS 解析"实为未实现 |
| web-main 表单 contextWindow | 手填 number 框（Form/FormItem+useSchema 合规），无快捷按钮 |
| 模型变更通知链 | **全断**：CRUD 不发事件；im.gateway 无模型事件（有 device room 无 org room）；relay 无订阅；`syncNow` 触发=启动/登录/30min 轮询；web-agent `useModelConfigs` 是 React Query 纯拉取 |
| 禁用模型报错 | 后端 ✓（`resolveDecrypted` 过滤 enabled → 网关 404`model not found`；`listForAgent` 过滤 enabled → 禁用行不下发）；**前端 `onError` 把 `e.error` 文案完全丢弃**，用户只见失败气泡不知原因 |

## 2. 设计

### 2.1 MODEL_SPECS 接线 + 扩充（需求 1）

- `OrgModelConfigService.create/update`：`contextWindow: resolveContextWindow(input.model, input.contextWindow)`
  （优先级：用户显式值 > MODEL_SPECS > 128k 兜底——`resolveContextWindow` 现成）。
- `MODEL_SPECS` 清单更新至当下主流（实施时核对官方口径）：DeepSeek v4 系、
  Qwen3 系（含 Ollama 常见 tag 如 `qwen3:30b-a3b`）、Claude 4.x、GPT-5.x、
  Gemini 2.5 系。key 保持精确匹配；Ollama tag 含冒号照写。
- 端侧 `persistCloudConfigs` 的 `DEFAULT_CONTEXT_WINDOW` 兜底保留（云端已解析，
  正常路径不会落到它）。

### 2.2 上下文快捷输入（需求 2）

web-main `model-form-panel.tsx` 的 contextWindow 输入框下加一排快捷 chip：
`32k / 128k / 256k / 1M`（值 32_768 / 131_072 / 262_144 / 1_048_576），点击填入
表单字段（覆盖现值）。i18n 走 next-intl；表单规范不变。

### 2.3 模型变更事件全链（需求 3+5，本 feat 主体）

```
【云端】OrgModelConfigService.create/update/remove
   → EventEmitter2 `org.model-config.changed` { orgId }
   → im.gateway 监听 → 向 `org:<orgId>` room 广播
     IM_WS_EVENTS.modelConfigChanged {}（不携带明细——端侧收到即全量 syncNow，
     幂等替换，避免精细 diff 协议）
   ← 设备 WS 认证连接时 client.join(`org:<orgId>`)（token 里已有 org 信息）
【端侧】im-relay-client 订阅 modelConfigChanged
   → 桥本地 IM_RELAY_EVENTS.modelConfigChanged { cloudUserId }
   → ModelConfigSyncService 加 @OnEvent → syncNow(cloudUserId)
【端侧→前端】syncNow 完成且有变化时发本地事件
   → EventsGateway 信封 type "model-config.updated" → acct room
   → web-agent 全局事件 hook → queryClient.invalidateQueries(["model-configs"])
```

**同步触发源修订**（需求 5）：
- 保留：进程启动、账号运行时创建（登录）
- 新增：**relay WS connect/reconnect 成功**（im-relay-client 的 connect handler
  桥 `IM_RELAY_EVENTS.relayConnected { cloudUserId }` → sync `@OnEvent`）——
  离线期间的变更在重连瞬间追平
- 新增：云端 modelConfigChanged 推送（在线实时）
- **删除：30 分钟定时轮询**（`SYNC_INTERVAL_MS`/`schedule`/`nextDelay` 退避全删）

覆盖性论证：设备任意时刻要么在线（收推送）、要么离线（重连时拉取）；
两个触发点无缝衔接，不存在漏更新窗口，轮询无存在必要。

### 2.4 禁用模型报错文案（需求 4）

- 后端行为不动（已正确：禁用 → 下发列表剔除该行 + 网关 404；正在用它的会话
  发消息 → run 失败）。
- 前端 `use-session-stream` 的 `onError` 消费 `e.error`：失败 user 气泡下渲染
  一行错误小字（`text-destructive` 小号），重试按钮不变。`TimelineMessage` 加
  `errorText?: string`；历史恢复路径（fetchPending 的 failed 行）无错误文案，
  仅实时事件携带——可接受（刷新后只剩失败态+重试）。

## 3. V1 边界

- web-main 管理页自身不做实时刷新（操作者本地已乐观更新；org 内多管理员并发
  编辑的实时性后续按需）。
- 不做"禁用前检查在用会话"的阻止/警告。
- 不做模型明细 diff 推送（事件仅作失效信号，端侧全量 syncNow）。

## 4. 测试与验收

- 单测：resolveContextWindow 接线（create/update 各：显式值/查表命中/兜底）；
  CRUD 发事件；sync 的 relayConnected 与 modelConfigChanged 两个 @OnEvent；
  轮询删除后 schedule 相关测试同步清理。
- E2E 眼验：
  1. web-main 建模型（gpt-5.x 之类主流名不填上下文）→ 落库 contextWindow 为
     specs 值非 128k；
  2. web-main 改/禁用模型 → 两台在线设备的 web-agent 模型列表秒级刷新；
  3. 断开 B 的网络（或停 app）→ web-main 改模型 → B 重启/重连 → 列表已是新值；
  4. 会话绑定的模型被禁用 → 发消息 → 失败气泡下出现明确错误文案；
  5. 快捷 chip 点击填入。

## 5. 风险

- org room 是 im.gateway 新增的 join 维度：确认设备 token/握手里 org 信息可得
  （设备认证已带 org——`cloud_identity.org_id` 同步自云端，握手 token 校验侧应有）。
- 删轮询后若推送事件丢失（WS 半死连接），追平依赖下次重连——socket.io 心跳
  会最终判死并重连，语义闭环。
