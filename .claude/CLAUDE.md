# CLAUDE.md

本文件指导 Claude Code 在 meshbot 仓库的工作方式。

## 常用命令

### 开发

| 命令 | 说明 |
|------|------|
| `pnpm dev:server-agent` | 本地 Agent 后端（NestJS watch，端口 7727，自动探测） |
| `pnpm dev:server-main` | 云协同后端（NestJS watch，端口 3200） |
| `pnpm dev:web-agent` | 桌面端 UI（Next.js，端口 3101） |
| `pnpm dev:web-main` | 云协同前端（Next.js，端口 3102） |
| `pnpm dev:desktop` | Electron 桌面壳 |
| `pnpm dev:cli` | 命令行 Agent |

### 构建与测试

- `pnpm build` — Turbo 拓扑构建
- `pnpm test` — Jest（root 配置，覆盖 libs/common 与 server-agent）
- `pnpm typecheck` — 全包 TS 类型检查
- `pnpm lint` / `pnpm format` — Biome
- `pnpm clean:imports` — 自动移除未使用 import（Biome）

### 静态围栏（写完代码必跑）

```bash
pnpm check          # 串行跑下面 6 个；pnpm check:parallel 并行
pnpm check:tx
pnpm check:naming
pnpm check:lock-tx
pnpm check:repo
pnpm check:dead
pnpm check:error-code
pnpm check:strict   # CI 用，所有围栏 strict 模式
```

## 项目架构

meshbot 是 **本地优先 + 云端协同** 的双形态 AI Agent 平台。

```
apps/
├── server-agent/   NestJS 本地 Agent 后端（SQLite + LangGraph）
├── server-main/    NestJS 云协同后端（Postgres）
├── web-agent/      Next.js 桌面端 UI
├── web-main/       Next.js 云协同前端
├── desktop/        Electron 壳（fork server-agent）
└── cli/      命令行 Agent 工具

libs/
├── common/         NestJS 基础设施（装饰器 / TxTypeOrmModule / Lock / Cache / Dto）
├── agent/          Agent 域 LangGraph 编排
├── types/          跨域 Zod schema + TS 类型
├── types-agent/    Agent 域 schema
└── types-main/     云协同域 schema

packages/
├── web-common/     Web 公共逻辑（前端 Next.js shared，原 packages/common）
└── design/         shadcn/Radix UI 组件库
```

**依赖方向**：`apps/server-*` → `libs/<domain>` → `libs/types-<domain>` → `libs/common`。只允许从上到下、从右到左，禁止反向。

**两轨**：
- **本地轨**（server-agent + cli + desktop + web-agent）：单进程 + SQLite + 单用户，跑全部 Agent 业务逻辑
- **云端轨**（server-main + web-main）：Postgres + Redis + 多租户，只跑协同元数据 CRUD，**不跑 Agent 逻辑**
- **IM 反向通道**（子项目 B）：云端轨 `server-main` 的 IM 消息经 `ws/im` device room 定向下发到已注册设备的本地轨 `server-agent`（`AgentInboxService` 触发本地 run），回复异步回流云端会话——是云端轨触发本地轨 Agent 逻辑的唯一例外通道，云端轨自身仍不跑 Agent 逻辑。

## 关键约定

### Repository 访问规范（check:repo）

- 每个 TypeORM Entity 有且仅有一个归属 Service（唯一持有 `@InjectRepository(X)` 的类）
- Controller / Gateway / Tool 禁止直接注入 Repository，必须通过归属 Service 访问
- 跨 `libs/<domain>/` 边界禁止注入其他模块的 Entity Repository

### 事务、锁、缓存（仅在 Service 层）

- **`@Transactional()`**：**跨表写入时使用**。单表 upsert / 单表 update 不需要。模块用 `TxTypeOrmModule.forFeature()` 注册 Entity（替代 `TypeOrmModule.forFeature()`）。事务上下文通过 AsyncLocalStorage 自动传播到子 Service。
- **`@WithLock`**：并发竞态/幂等保护。**必须在 `@Transactional` 外层**（锁包事务），严禁事务内嵌套锁（事务-锁倒置，`pnpm check:lock-tx` 自动校验）。
- **`@Cacheable` / `@CacheEvict`**：每个 `@Cacheable` 必须配对至少一个 `@CacheEvict`。缓存键格式：`模块:实体:#{参数索引或路径}`。

### 事务方法命名（check:naming）

私有 `@Transactional()` 方法命名必须命中以下约定之一：`*InDb`、`*InTx`、`*InTransaction`、`persist*`。反向也成立：私有方法名命中这些后缀 → 必须挂 `@Transactional()`。

### 数据库规范

- **本地轨**（SQLite）：用 TypeORM 迁移文件管理 schema（`synchronize:false` + `migrationsRun:true`，启动自动跑迁移，桌面端单节点自升级）；DataSource 启用 `journal_mode=WAL` + `busy_timeout=5000` 缓解 SQLITE_BUSY（通过 `prepareDatabase` 回调）
- **云端轨**（Postgres）：纯 SQL DDL 文件 `apps/server-main/migrations/<YYYYMMDDHHmm>-<english-summary>.sql`，**DBA 手动执行，服务任何模式都不自动建表 / 跑迁移**；幂等 SQL（`IF NOT EXISTS`）+ 文件不可变（变更追加新文件）+ 列名 snake_case + 逻辑外键 + 线上大表索引 `CONCURRENTLY` 单独成文件。改 Entity 必须配套 DDL 文件，详见 `ddl-migration` 技能
- 禁止数据库级别外键约束（不使用 `@ManyToOne`/`@OneToMany`/`@JoinColumn`）

### Zod / DTO（共享数据模型）

- 跨域 schema 放 `libs/types`；域内 schema 放 `libs/types-<domain>`
- `libs/types-*` **禁止依赖 NestJS / TypeORM**
- 后端用 `createZodDto(schema)` 把 Zod 转 NestJS DTO 类
- Entity 与 Schema 分离：Entity 在业务代码或 `libs/<domain>/`，Schema 在 `libs/types-<domain>/`

### 前端表单

写表单走 `Form/FormItem` + `useSchema`（共享 Zod Schema + 多语言，详见 `web-form-convention` 技能）。

### 测试

- 新代码默认 Jest；`libs/agent` 历史用 vitest，不强行统一
- 装饰器、Provider、围栏脚本必须有单测
- E2E 测试覆盖 server-main（含 Postgres service）

### 其他

- 数据库列名 snake_case（项目配置 `SnakeNamingStrategy`）
- 公开方法包含中文 JSDoc
- 禁止在 `if` 前一行放置注释（Biome 格式化会破坏结构）
- **禁用原生 `window.alert` / `confirm`**：一律走 `packages/design/src/components/ui/` 的 shadcn 组件（`alert-dialog.tsx` / `alert.tsx`），惯例见 `apps/web-agent/src/components/agent/agent-editor-sheet.tsx`。原生弹窗阻塞、样式不受控、在 Electron 壳里尤其突兀。hook 里无法直接渲染时用 atom 存提示态 + shell layout 挂宿主组件
- 不新建产品需求 / PRD 文档；设计决策记在对话或 commit 中。superpowers 流程产物（brainstorm 设计 spec、实施 plan）可写入 `docs/superpowers/`，属流程附件、不算 PRD

## 开发工作流

1. **brainstorm** —— 用 superpowers:brainstorming skill 探讨需求 / 确认范围
2. **writing-plans** —— 出实施 plan
3. **编码** —— TDD 优先（先写失败的单测）
4. **静态围栏** —— commit 前 `pnpm check`
5. **commit** —— 中文提交信息，遵循 conventional commits 风格

## 按风险分档投入（速度与质量平衡）

不是所有改动都值得走完整的 review + 变异验证。**分档判据是「这个改动是否可能只坏一半」**
——那类 bug 本地全对、远端全错，单测和 typecheck 都拦不住（真实案例：重复
`EventEmitterModule.forRoot()` 导致两个 EventEmitter2，`@OnEvent` 两边都绑而运行时
`.on()` 只绑一个，本地 UI 全正常、跨设备镜像永远收不到工具事件，查了四轮）。

| 档 | 流程 | 适用 |
|----|------|------|
| **高** | 实施 → 独立 review → 变异验证 → 修 → 复审 | 跨设备协议 / wire format、并发与时序、seq 与去重、鉴权与归属校验、带生命周期的状态机 |
| **中** | 实施 + 只对核心不变量做变异 + 抽查，不另派 reviewer | 单进程业务逻辑、前端 reducer、REST/DTO |
| **低** | 直接做，测试 + 围栏过了就提交 | 文案 / i18n / 注释、纯样式布局、重命名挪文件、加兜底 label |

小修**攒 3–5 个走一次 review**，不要一修一轮。用户的真机验收是质量体系的一环，
不必全靠内部往返兜住。

### 不因提速而放松的底线

每条都对应本仓真实事故：

1. **读完整输出，别信退出码** —— turbo / `tail` / `grep` 会掩盖真实失败
2. **有未提交改动时绝不 `git checkout -- <文件>`** —— 会把未提交的修复一起还原
3. **变异后先确认「变异真的落地」**（打印改动后内容）再看测试红绿 —— 正则没改到文件却当成"测试拦不住"
4. **还原后读文件实际内容确认** —— `cd` 之后用相对路径 `cp`，还原会静默失败
5. **改 DI / provider 必须真 boot**（`timeout 60 node dist/main.js`）—— typecheck / 单测 / 围栏全漏 DI 崩溃
6. **机制不明时先埋点取证再改代码**；**交付某能力时必须自查「谁来调用它」** —— 后者是 plan 三次漏写调用方（能力建好却在 UI 上不可达）的根源

## 表归属

| 应用 | 数据库 | 当前 Entity |
|------|--------|-------------|
| server-agent | `agent.db`（SQLite，`~/.meshbot/`，TypeORM 迁移管理） | `CloudIdentity`（含 `device_token` 列，浏览器授权换发的设备凭据）/ `Setting` / `ModelConfig`（含 `source` 列，`cloud` \| `local`，区分云端下发与本地配置）/ `Agent`（一设备多 Agent：`name`/`avatar`/`system_prompt`/`default_model_config_id`/`remote_enabled`/`visibility`，各自独立人格·技能·MCP·记忆·工作区，物理落在 `accounts/<cloudUserId>/agents/<agentId>/`；`remote_enabled`·`visibility` 已建列但本期未消费，留给云端注册）/ `Session`（加 `agent_id` 列，会话归属 Agent，NOT NULL，子会话继承父会话）/ `SessionMessage` / `LlmCall` / `PendingMessage` / `ImAgentSession`（会话映射 + 处理游标 `last_processed_message_id` / 追加游标 `last_appended_message_id`；设备 Agent 反向通道，子项目 B） |
| server-main | Postgres（SQL DDL 文件，DBA 手动执行） | `AppUser` / `Organization` / `Membership` / `Invitation`（云端身份 + 企业/组织；Phase 1）/ `Device` / `DeviceAuthRequest` / `EmailVerification` / `OrgModelConfig`（设备授权登录 + 邮箱验证码 + 组织级模型配置云端化；子项目 A）/ `Conversation`（加 `agent_device_id` 列，人 ↔ 设备 Agent 私聊 DM 标记目标设备）/ `Message`（加 `sender_type` 列，`user` \| `agent`，默认 `user`；设备 Agent 反向通道，子项目 B） / `CloudAgent`（表 `agent`；本机 `remote_enabled` Agent 元数据的云端注册镜像，`(device_id, local_agent_id)` 唯一 + `deleted_at` 软删对账；只上 name/avatar/description，`remote_enabled` 不上云、本地为唯一真相；远程按云端 `agent.id` 寻址；一设备多 Agent 计划二·2b） |
