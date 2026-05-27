---
name: dev-workflow
description: "开发工作流规范：brainstorm → 编码 → 单元测试 → E2E 回归 → 静态围栏 → 写入鲁棒性 → 中文注释 Apply to all relevant work in this repo."
---

# 开发工作流规范

## 1. 开发前：Brainstorm（创意/需求阶段）

启动任何**创建功能 / 新增组件 / 修改行为**类的任务之前，**必须**先走一轮 brainstorm，不要上来就动代码。

- 触发 superpowers 的 `brainstorming` 技能（或在没有 superpowers 环境时按其精神：先澄清意图、约束、边界与设计取舍）
- 输出至少包含：要解决什么问题、关键设计决策、影响范围、可能的反例
- **不要**把 brainstorm 输出沉淀为长 PRD 文档（项目已不再依赖 PRD 流程）；写在对话里、记在 commit 信息里、或必要时落到 `docs/audits/` 或邻近设计 README 中即可

跳过 brainstorm 的场景（白名单）：

- 单点 bug 修复且根因已明确
- 文案 / 注释 / 配置参数微调
- 纯重构（行为不变）

## 2. 单元测试

代码变更完成后必须编写单元测试，覆盖：

- 新增/修改的 Service 方法
- 校验逻辑（参数范围、互斥规则、兼容性检查等）
- 边界条件与异常路径

测试文件放在对应 app 的 test 目录下，例如 `apps/server-agent/test/service/`、`apps/server-main/test/service/`。

## 3. E2E 测试回归

- 检查项目是否存在 E2E 测试（如 `test/e2e/*.e2e-spec.ts`）
- 如果存在，评估当前改动是否变更了业务流程（新增/修改 API 行为、校验规则变化、流程阶段变更等）
- 如果变更了流程，**同步更新 E2E 测试用例并重新执行**
- 不涉及流程变更的改动（如内部重构、性能优化）不强制修改 E2E 测试

## 4. 静态围栏（条件触发：大型调整）

当本次改动**触及下列任一场景**时，必须主动跑两个静态围栏 skill，不要等用户开口：

| 触发条件 | 含义 |
|---|---|
| 涉及数据库**写动作**（save / update / delete / upsert / 批量写） | 可能影响事务边界与归属 Service |
| **多环节方法**（一个 Service 方法内调用 ≥ 2 处子 Service 写入） | 需要核对事务装饰器是否到位 |
| 新增 / 修改 `@Transactional()` / `@WithLock()` / `@Cacheable()` | 装饰器组合容易出错（顺序倒置 / 倒置调用） |
| `@Transactional` 方法体内**新增对其他 service 的调用** | 可能引入事务-锁倒置（被调方带 `@WithLock`） |
| 新增 / 重命名 service 层私有方法 | 可能违反事务方法命名约定 |
| 新增 Entity / `@InjectRepository(X)` / 跨模块调用 Repo | 可能引入 `DUP_OWNER` / `CROSS_LIB_INJECT` |
| 新增 / 改造 Controller / Processor / Gateway / Resolver | 可能直接注入 Repository（NON_SERVICE_INJECT） |

### 跑哪四个围栏

| Skill | 命令 | 检查内容 |
|---|---|---|
| `check-transactional` | `pnpm check:tx` | `@Transactional()` 是否合规（MISSING / WRONG_IMPORT / REDUNDANT / BYPASS） |
| `check-method-naming` | `pnpm check:naming` | 事务方法命名与 `@Transactional()` 是否一致（PRIVATE_TX_NAMING / MISSING_TX_ON_NAMED） |
| `check-lock-tx` | `pnpm check:lock-tx` | 事务-锁倒置（LOCK_INSIDE_TX_DECORATOR / LOCK_INSIDE_TX_CALL） |
| `check-repo-access` | `pnpm check:repo` | Repository 注入是否合规（DUP_OWNER / NON_SERVICE_INJECT / CROSS_LIB_INJECT） |
| `check-dead-exports` | `pnpm check:dead` | 没人引用的 named export |
| `check-error-code` | `pnpm check:error-code` | 错误码重复 / 越界 / 断号 |

四个脚本都是**默认增量写报告**——只有出现新增 finding 时才生成新的 `<YYYY-MM-DD-HHmm>.md` + `.json`：

| 报告目录 | 说明 |
|---|---|
| `docs/audits/tx-fence/` | tx-check 报告（baseline + 增量） |
| `docs/audits/method-naming/` | naming-check 报告（baseline + 增量） |
| `docs/audits/lock-tx-fence/` | lock-tx-check 报告（baseline + 增量） |
| `docs/audits/repo-fence/` | repo-check 报告（baseline + 增量） |

> 前三个围栏构成事务侧的**完整闭环**：
> - `check:tx` 验证「该挂事务的方法是否挂了」
> - `check:naming` 验证「方法命名与装饰器是否一致」
> - `check:lock-tx` 验证「锁与事务边界是否倒置」（事务-锁倒置漏洞）
>
> 推荐**串联跑**：`pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:repo`。

### 增量报告处理

跑完后必须按下面方式向用户汇报：

- **无新增 finding**（"与 baseline 持平 → 未生成新报告"）：明确告诉用户"本次改动未引入新违规"，无需进一步动作
- **有新增 finding**（自动生成了新 `*.md` + `*.json`）：**主动提示用户关注新报告路径**，列出新增条目摘要（文件路径 + 类别 + 简要说明），并按 skill 中的修复指引给出建议
- **finding = 0**（围栏全绿）：明确告诉用户"事务围栏 / 命名围栏 / 锁-事务围栏 / Repo 访问围栏全绿"

不要把报告新增视为"通过即可"——新增 finding 即代表本次改动**实际引入了新违规**，必须当作 review item 显式呈现。

## 5. 写入路径鲁棒性：幂等与补偿

涉及**任何写动作**的接口/方法（DB 写、外部 IO 写、状态推进），在编码完成、过完静态围栏之后，必须**回答两个问题**才算完成：

1. **幂等性**：同一请求重复执行 ≥ 2 次，最终状态是否与执行 1 次完全一致？
2. **补偿性**：当中间步骤失败 / 超时 / 数据不一致时，业务能否回到一致状态（自动 / 人工）？

回答必须能给出**具体的实现选择**，不能含糊"应该会幂等"。

### 强制触发场景

下列写入场景**必须**显式设计幂等或补偿，**不允许**"先上线再说"：

| 场景 | 风险 |
|---|---|
| 涉及外部副作用（HTTP / MQ publish / 邮件 / 短信 / 支付 / Webhook） | 网络重试导致重复投递 |
| 多步流程（事务 + 外部调用 / 状态机推进） | 中间步骤失败留下半成品状态 |
| 客户端可能重试的端点（前端 retry / Webhook 端点 / 定时任务） | 重复请求叠加副作用 |
| 创建带唯一业务标识的资源（订单 / 用户 / 邀请码 / 上传任务） | 重复创建产生孤儿数据 |
| 跨服务调用（如 server-main 调用 server-agent） | 上下游故障窗口期数据漂移 |

### 幂等实现选项（按优先级）

| 选项 | 适用场景 |
|---|---|
| **数据库唯一约束 + ON CONFLICT** | 业务标识天然唯一（email / 外部订单号 / 邀请码）；用 `INSERT ... ON CONFLICT DO NOTHING/UPDATE` |
| **状态机推进（CAS）** | 状态有明确序列（`pending → running → done`）；写入用 `UPDATE WHERE status = X` 校验前置态，避免乱跳 |
| **幂等键（Idempotency Key）** | 客户端可生成 UUID 的写接口；持久化 `key → result` 表，重复 key 直接返回缓存结果 |
| **客户端 token / requestId 去重** | 短时间窗口内的重复点击；Redis `SETNX` + TTL |
| **天然幂等设计** | 操作本身可重复（如"标记为已读 / 设置头像 URL"），无需额外机制 |

### 补偿实现选项

| 选项 | 适用场景 |
|---|---|
| **同步补偿（try/catch + 反向操作）** | 多步本地写，失败时手动回滚已执行步骤；适合 2–3 步、链路短 |
| **Saga 模式** | 跨服务多步流程；每个正向步骤定义对应的补偿动作 |
| **死信队列 + 人工介入** | 异步任务失败次数超阈值；写入 DLQ，由运维 / 监控告警处理 |
| **定时对账（reconciliation job）** | 跨系统数据可能漂移；周期性扫描 + 修复 |
| **业务可降级容忍** | 失败影响小（如埋点 / 审计日志）；记日志后吞掉 |

### 自检清单

每个写入方法，提交前在脑里 / commit 信息 / brainstorm 输出中过一遍：

- [ ] 同一请求重复 2 次会发生什么？
- [ ] 第 N 步失败时，前 N-1 步的副作用会被怎么处理？
- [ ] 是否依赖外部 IO？外部超时 / 失败时本地状态如何收敛？
- [ ] 客户端是否会因网络抖动重试？
- [ ] **明确写出**：本次选择了哪种幂等机制？哪种补偿机制？为什么？

### 豁免

下列场景可以省略本节（**必须明确判定**，不要默认豁免）：

- 纯只读接口（无任何写动作）
- 单条 `UPDATE / DELETE WHERE pk = X`，业务上重复执行结果一致（天然幂等）
- 一次性脚本 / 内部管理工具（明确标注"非生产数据写入路径"）

豁免时建议在 commit 信息或方法注释中写一句"重复调用安全，无需幂等键"等说明，方便 reviewer 快速判断；避免后续读者重新追问。

### 与 `service-tx-lock-cache` 技能 的关系

| 关注点 | 由谁约束 |
|---|---|
| 单方法内的事务边界（`@Transactional`） | `service-tx-lock-cache` 技能 + `pnpm check:tx` + `pnpm check:naming` + `pnpm check:lock-tx` |
| 跨方法 / 跨服务的"重复执行 + 失败恢复" | **本节**（设计层，无静态检查兜底） |

事务装饰器只保证"本地多写要么全成要么全败"，**不解决**"客户端重发 / MQ 重投 / 上游重试"问题——这是本节的职责。

## 6. 方法级中文注释

所有 Service / Controller / Processor 中的**公开方法**必须包含中文注释，说明方法用途。

```typescript
/** 上传文档并创建 ingestion 任务 */
async uploadAndIngest(tenantId: string, kbId: string, file: FileInput): Promise<Result> {

/** 校验 chunk_method 与文件扩展名的兼容性，不兼容时抛出 400 */
validateChunkMethodFormat(chunkMethod: string, fileExt: string): void {

// 缺少中文注释（不允许）
async uploadAndIngest(tenantId: string, kbId: string, file: FileInput): Promise<Result> {
```

私有辅助方法（如纯映射函数）可以省略注释，但**逻辑复杂的私有方法**也应添加。

## 工作流速览

```
brainstorm（设计阶段）
    ↓
编码
    ↓
单元测试 ←──────────────────┐
    ↓                      │ 失败修复
E2E 回归（如改了流程）       │
    ↓                      │
静态围栏（大型调整时）        │
  ├─ pnpm check:tx         │
  ├─ pnpm check:naming     │
  ├─ pnpm check:lock-tx    │
  └─ pnpm check:repo       │
    ↓                      │
有增量报告？───是──→ 提示用户关注，回到编码修复
    ↓ 否                   │
写入鲁棒性自检（含写动作时） │
  ├─ 幂等机制？             │
  └─ 补偿/对账机制？        │
    ↓                      │
未明确？───是──→ 补设计，回到编码
    ↓ 否
完成 + 中文注释自检
```

