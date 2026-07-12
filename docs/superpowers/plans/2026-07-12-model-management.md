# 模型管理增强 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MODEL_SPECS 接线并扩充、上下文快捷输入、模型变更实时推送（在线实时/重连拉取/删轮询）、禁用模型使用报错文案。

**Architecture:** 四个独立 Task，各自 commit。事件链复用全部现成基础设施：`org:<orgId>` room 已存在（im.gateway:159 设备连接即 join）、relay 客户端事件桥模式现成、`syncNow` 幂等全量替换现成、EventsGateway 信封现成、React Query invalidate 现成——全链只是"接线"，无新协议设计。

**Tech Stack:** EventEmitter2 / socket.io org room / React Query invalidateQueries / next-intl

## Global Constraints

- 分支 `feat/langchain-1x` 主仓，连续提交不切 PR。
- server-main 是编译产物：改完 `pnpm build:server-main` 并重启才生效。
- 端侧 relay/sync 改动需重启两台设备的 server-agent（打包 app 用 `pnpm run:local` 启动——直接 open 会连生产云端）。
- 事件不携带明细：`modelConfigChanged` 只是失效信号，端侧收到即全量 `syncNow`；
  syncNow 完成后**无条件**发前端刷新事件（invalidate 幂等且便宜，不做变化比对）。
- 前端新增用户可见文案走 next-intl（`pnpm sync:locales -- --write`）。
- 每 Task：`pnpm check:format` → 验收命令 → 独立 commit（中文 conventional）。

---

## Task A: MODEL_SPECS 接线 + 清单扩充

**Files:**
- Modify: `libs/types-agent/src/ai/model-specs.ts`（清单扩充）
- Modify: `libs/main/src/services/org-model-config.service.ts`（create :53 / update :71 接 resolveContextWindow）
- Test: `libs/main` 侧 org-model-config.service 的现有 spec 加用例

- [x] **Step 1（TDD）**: service spec 先加三用例并跑红：
  - create 不传 contextWindow、model 命中 specs（如 `deepseek-v4-pro`）→ 落库为 specs 值；
  - create 显式传 contextWindow → 用户值优先；
  - create 传未知 model 且不传 contextWindow → 128k 兜底。
  - update 同理（改 model 名后 contextWindow 重解析：**注意语义**——update 若只改名
    不动 contextWindow，应按新 model 重查 specs；若用户显式传了 contextWindow 则用户值优先。
    实现时 update 的解析入参用「本次请求的显式值」而非库里旧值，旧值视为"上次的解析结果"
    不再享有用户优先级——否则一次手填后永远无法回到自动解析。spec 用例钉住这个语义。）
- [x] **Step 2**: `org-model-config.service.ts` 的 create/update 接
  `resolveContextWindow(input.model, input.contextWindow)`（import 自 `@meshbot/types-agent`；
  确认 libs/main 可依赖 types-agent——若依赖方向不允许（main 域 vs agent 域），把
  model-specs 移到 `libs/types`（跨域共享）再引——实施时按 check:repo/依赖方向裁定，
  移动时保留原路径 re-export 防破坏现有 import）。
- [x] **Step 3**: `MODEL_SPECS` 清单扩充（key 精确匹配；数值实施时以官方文档核对）：
  DeepSeek（deepseek-v4-pro/chat/reasoner 已有，核对）、Qwen3（qwen3:8b / qwen3:14b /
  qwen3:30b-a3b / qwen3:32b 等 Ollama tag 形态 + qwen3-max 云端形态）、Claude 4.x
  （claude-opus-4-7 / claude-sonnet-4-6 / claude-haiku-4-5，核对现有）、GPT-5.x
  （gpt-5.2 / gpt-5.2-pro 等当前在售）、Gemini 2.5 系。每行一条注释标来源口径。
- [x] **Step 4**: 跑绿 + 回归（`npx jest libs/main` 或该 spec 所在套件）+ commit
  `feat(main): 模型上下文按 MODEL_SPECS 解析入库 + 清单扩充至当下主流`。

---

## Task B: 上下文快捷输入 chip

**Files:**
- Modify: `apps/web-main/src/components/models/model-form-panel.tsx`（contextWindow 框下）
- Modify: `apps/web-main/messages/{zh,en}.json`

- [x] **Step 1**: contextWindow `<Input>` 下加一排 chip 按钮：
  `32k(32768) / 128k(131072) / 256k(262144) / 1M(1048576)`，点击 `form.setValue`
  （按该表单库的受控写法，覆盖现值；样式随表单现有辅助行）。标签 32k/128k/256k/1M
  本身不需要翻译，但若加辅助说明文字（如「常用值」）走 i18n。
- [x] **Step 2**: `pnpm --filter @meshbot/web-main typecheck` + `pnpm sync:locales -- --write`
  （若加了文案）+ commit `feat(web-main): 上下文窗口快捷输入 chip`。

---

## Task C: 模型变更事件全链 + 触发源修订（主体）

**Files:**
- Modify: `libs/types/src/im/im.events.ts`（IM_WS_EVENTS 加 `modelConfigChanged`）
- Modify: `libs/main/src/services/org-model-config.service.ts`（CRUD 发事件）
- Modify: `apps/server-main/src/ws/im.gateway.ts`（监听 → org room 广播）
- Modify: `apps/server-agent/src/cloud/im-relay-client.service.ts`（订阅下行 + connect 桥事件）
- Modify: `apps/server-agent/src/cloud/im-relay.events.ts`（IM_RELAY_EVENTS 加两个）
- Modify: `apps/server-agent/src/services/model-config-sync.service.ts`（@OnEvent ×2 + 删轮询 + 完成后发前端事件）
- Modify: `apps/server-agent/src/ws/events.gateway.ts`（信封转发 `model-config.updated`）
- Modify: `apps/web-agent/src/hooks/use-global-events.ts`（收信封 → invalidateQueries）
- Test: sync spec（触发源）、org-model-config spec（发事件）、gateway 单测视现有覆盖形态

**Interfaces:**
- `IM_WS_EVENTS.modelConfigChanged = "im.modelConfigChanged"`（命名照现有枚举风格，实施时对齐）
- 云端内部事件 `ORG_MODEL_CONFIG_EVENTS.changed = "org.model-config.changed"`，payload `{ orgId: string }`
- 端侧 `IM_RELAY_EVENTS.modelConfigChanged` / `IM_RELAY_EVENTS.relayConnected`，payload `{ cloudUserId }`
- 前端信封 `type: "model-config.updated"`，payload `{}`

- [x] **Step 1（云端发）**: `OrgModelConfigService` 注入 `EventEmitter2`，create/update/remove
  成功后 `emit(ORG_MODEL_CONFIG_EVENTS.changed, { orgId })`。spec：三方法各断言事件发出。
  常量放 libs/main 内（云端域私有）。
- [x] **Step 2（gateway 广播）**: im.gateway `@OnEvent(ORG_MODEL_CONFIG_EVENTS.changed)` →
  `this.server.to(\`org:\${orgId}\`).emit(IM_WS_EVENTS.modelConfigChanged, {})`。
  org room 已存在（`:159` 设备连接即 join），零新增 join 逻辑。
- [x] **Step 3（relay 订阅 + connect 桥）**: im-relay-client：
  - 下行事件循环里加 `modelConfigChanged` → emit `IM_RELAY_EVENTS.modelConfigChanged { cloudUserId }`
    （照 message/presence 的桥接写法）；
  - socket `connect` handler（现有连接成功回调处）emit `IM_RELAY_EVENTS.relayConnected { cloudUserId }`
    ——**重连也走 connect 事件**（socket.io reconnect 后触发 connect），天然覆盖"上线拉取"。
- [x] **Step 4（sync 触发源修订）**: model-config-sync：
  - `@OnEvent(IM_RELAY_EVENTS.modelConfigChanged)` 与 `@OnEvent(IM_RELAY_EVENTS.relayConnected)`
    → `syncNow(cloudUserId)`；
  - **删除轮询**：`SYNC_INTERVAL_MS`、`schedule()`、`nextDelay()`、`timer` 字段及
    onApplicationBootstrap 里的首次 schedule 调用全删；相关测试同步清理/改写；
  - `syncNow` 成功路径末尾 emit 本地事件 `MODEL_CONFIG_EVENTS.updated { cloudUserId }`
    （常量放 server-agent 侧，与 SCHEDULE_EVENTS 同风格）。
- [x] **Step 5（前端刷新）**:
  - events.gateway 加 `@OnEvent(MODEL_CONFIG_EVENTS.updated)` → 信封
    `{ type: "model-config.updated", payload: {} }` → `acct:<cloudUserId>` room
    （照 SCHEDULE_EVENTS.fired 的转发写法）；
  - web-agent `use-global-events.ts` 收到该 type →
    `queryClient.invalidateQueries({ queryKey: ["model-configs"] })`（照现有信封分发写法）。
- [x] **Step 6**: 回归：`npx jest apps/server-agent apps/server-main/src libs/main libs/common`
  全绿（sync 的轮询测试已清）、`pnpm typecheck`、九围栏。commit
  `feat(model): 模型变更事件全链——org room 实时推送 + 重连拉取 + 删轮询`。

---

## Task D: 禁用模型报错文案

**Files:**
- Modify: `apps/web-agent/src/components/session/message-list.tsx`（TimelineMessage 加 `errorText?`，failed 气泡下渲染）
- Modify: `apps/web-agent/src/hooks/use-session-stream.ts`（onError 消费 `e.error` 写进目标气泡）
- Modify: `apps/web-agent/messages/{zh,en}.json`（前缀文案如「运行失败：」）

- [x] **Step 1**: `TimelineMessage` 加 `errorText?: string`；`onError` 里对 failedIds
  命中的消息除 `failed:true` 外写 `errorText: e.error`（截断到合理长度如 200 字符）。
- [x] **Step 2**: message-list 的 failed 分支下渲染错误行（小号 `text-destructive/80`，
  在消息正文下方、重试按钮语义不变）；仅 `errorText` 存在时渲染（历史恢复的 failed
  行无文案不渲染——可接受，spec 已记）。
- [x] **Step 3**: i18n + typecheck + commit
  `feat(web-agent): run 失败气泡展示错误原因文案`。

---

## Task 终验（眼验，需用户）

前置：`pnpm build:server-main` + 重启；两台 server-agent 重启（B 用 `pnpm run:local`）。

- [ ] web-main 新建模型填主流名（如 qwen3:30b-a3b）不填上下文 → 详情/列表显示 specs 值而非 128k
- [ ] 快捷 chip 点击填入
- [ ] web-main 编辑/禁用模型 → **两台在线设备**的 web-agent 模型选择器/列表秒级刷新（不重启不刷新页面）
- [ ] 停掉 B → web-main 改模型 → 重启 B → 列表即为新值（重连拉取；轮询已删）
- [ ] 会话绑定的模型禁用后发消息 → 失败气泡下出现明确错误文案（含 model not found 语义）
- [ ] 30 分钟内无轮询日志（同步只在事件/重连时发生）

## 回归结论

<!-- 眼验通过后填写 -->
