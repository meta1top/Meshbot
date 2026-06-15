# 本地 Agent 数据按云端账号隔离 —— 设计文档

- 日期:2026-06-15
- 状态:设计已确认,待实现计划(writing-plans)
- 范围:`apps/desktop`(Electron 壳)、`apps/server-agent`、`libs/agent`、`apps/web-agent`

## 1. 背景与问题

本地轨(server-agent + web-agent + desktop)当前被设计为**单用户**(CLAUDE.md:「单进程 + SQLite + 单用户」)。
实测发现:用云端账号 A 登录后再切到账号 B,**两个账号看到同一批本地 Agent 会话**。

根因(均已核对代码):

- `Session` / `SessionMessage` 等实体**没有任何归属字段**,本地会话是一个扁平共享池
  (`apps/server-agent/src/entities/session.entity.ts`)。
- `CloudIdentity` 是**单行镜像**(`id='default'`),登录 B 会 upsert 覆盖 A,从不并存
  (`apps/server-agent/src/services/cloud-identity.service.ts`,常量 `SINGLE_ROW_ID='default'`)。
- 其它本地表(`Setting` / `ModelConfig` / `LlmCall` / `PendingMessage` / `CronJob`)同样无账号归属。
- 文件型状态(提示词 / 技能 / mcp.json / workspace / 日志)也全是机器级单份(见 §3)。

所以这不是 bug,而是「单用户」假设的直接结果。本设计推翻该假设:**一个云端账号对应一套完全独立的本地数据**。

## 2. 目标 / 非目标

**目标**

- 一个 `cloudUserId` = 一套独立的本地 Agent 数据;切换账号即切换到另一套互不可见的数据。
- 隔离覆盖**全部本地状态**:数据库(含 LangGraph checkpointer)、提示词、技能、mcp.json、workspace、日志。
- 切换账号**近乎瞬时、无需重启整个桌面 App**。

**非目标(明确写入,避免范围蔓延)**

- **不是防偷看的安全特性**:同一 OS 用户能读到所有账号目录;**不做静态加密、不做 OS 用户级隔离**。
  本设计是「正确性 / 数据归属」的物理+逻辑分区。
- **不保留免登录本地使用**:登录变为必须(详见 §7 的取舍说明)。
- **不迁移历史数据**:升级后每个账号从空库开始(详见 §8)。
- 进程池 + 路由是**桌面壳专属**;独立 `pnpm dev:server-agent` / cli-agent 仍是单账号单进程。

## 3. 现状关键事实(设计依据)

- 所有按账号隔离的状态都挂在同一个 `meshbotDir` 根下
  (`libs/agent/src/config/meshbot-config.service.ts`):

  | 状态 | 位置 |
  |---|---|
  | 会话/消息/任务/调用 + LangGraph checkpointer 表 | `<meshbotDir>/agent.db` |
  | 提示词 | `<meshbotDir>/prompt/` |
  | 技能 | `<meshbotDir>/skills/` |
  | MCP 配置 | `<meshbotDir>/mcp.json` |
  | Bash 工具工作区 | `<meshbotDir>/workspace/` |
  | 日志 | `<meshbotDir>/logs/` |

- LangGraph 的 `SqliteSaver` checkpointer(`checkpoints` / `writes` 表)就在同一个 `agent.db` 里
  (`apps/server-agent/src/services/checkpointer-cleanup.service.ts` 用同一 DataSource 跑 raw query 清它们)。
  → 因此「按目录隔离」能**自动隔离 checkpointer**,无需去 scope 库管理的表。

- **存在两份 `resolveMeshbotDir`,行为不一致(必须先修)**:
  - `apps/server-agent/src/utils/meshbot-dir.ts` **认 `MESHBOT_HOME`**。
  - `libs/agent/src/config/meshbot-config.service.ts`(`resolveMeshbotDir`)**不认 `MESHBOT_HOME`**,
    只看 isPackaged / repoRoot。
  - 后果:现在即便设了 `MESHBOT_HOME`,DB 会搬,但 mcp.json / skills / prompt / workspace 不会搬。

- JWT secret 本就按 `meshbotDir` 派生(`apps/server-agent/src/strategies/jwt.strategy.ts` 读
  `meshbotDir` 下的 secret)→ 每账号目录天然各有一份 secret,token 自然账号隔离。

- web-agent 的 API client base URL 硬编码 `http://127.0.0.1:3100`
  (`packages/web-common/src/api/client.ts`)→ 反向代理监听该固定端口即可,前端无需改 base URL。

## 4. 设计概览

```
桌面壳 (Electron main) ── Account Supervisor ─┐
   ├─ 控制面:accounts.json(账号清单 + 活跃指针)+ 登录编排   │ 管理(spawn/route)
   ├─ 进程池:每账号一个 server-agent 子进程                    ├─► server-agent#A (ephemeral port, MESHBOT_HOME=accounts/A)
   └─ 反向代理:固定端口 3100 → 转发到活跃账号进程              └─► server-agent#B (ephemeral port, MESHBOT_HOME=accounts/B)

web-agent (浏览器) ── 永远连固定端口 3100(代理) ──► 当前活跃账号的进程
```

**职责切分**

- **server-agent 保持「单账号单进程」**:一个进程一个 `meshbotDir`,内含该账号完整数据。
  本体几乎不改(只受益于 §5 的目录解析统一)。多账号复杂度**不进 server-agent**。
- **Account Supervisor(Electron 主进程新增)**:进程池、控制面、登录编排、反向代理路由。

## 5. 前置改造:统一 meshbotDir 解析(地基)

让 `libs/agent` 的目录解析与 server-agent 一致,**整棵树跟随同一个根**:

- 统一为单一解析逻辑(优先 `MESHBOT_HOME`,再 packaged / repoRoot / homedir 兜底),
  `MeshbotConfigService` 改为使用该统一结果(注入或复用 server-agent 的 `resolveMeshbotDir` 语义)。
- 验收:设 `MESHBOT_HOME=/tmp/x` 后,`getDatabasePath` / `getMcpConfigPath` / `getSkillsDir` /
  `getPromptDir` / `getWorkspaceDir` 全部落在 `/tmp/x` 下。

这是「按目录隔离」成立的前提,必须最先做。

## 6. 目录布局与控制面

```
~/.meshbot/
├── accounts.json              # 控制面
└── accounts/
    ├── <cloudUserId-A>/       # = 进程 A 的 MESHBOT_HOME
    │   ├── agent.db  prompt/  skills/  mcp.json  workspace/  logs/
    └── <cloudUserId-B>/ ...
```

- **分区键 = `cloudUserId`**(org 是该账号内的元数据,不参与分区)。
- **控制面 `accounts.json`** 形如:
  ```json
  {
    "activeAccount": "<cloudUserId>",
    "accounts": [
      { "cloudUserId": "...", "email": "...", "displayName": "..." }
    ]
  }
  ```
  只存路由/展示所需的最小信息;云端 token 仍只存各账号自己的 `agent.db`(沿用现有 CloudAuthService)。
  用 JSON 文件而非额外 DB —— 信息量小、可读、改动小。

## 7. 流程(data flow)

**登录(新账号或已存在账号)**

1. 壳内登录页提交邮箱/密码。
2. Supervisor 调云端鉴权**一次**,获得 `{cloudUserId, cloudToken, ...}`(失败沿用现有错误信封展示)。
   鉴权必须发生在「选定/创建账号目录」之前 —— 解决「先有账号才能起进程、先有鉴权才知账号」的循环依赖。
3. 若 `accounts/<cloudUserId>/` 不存在则创建。
4. 启动该账号的 server-agent 子进程(`MESHBOT_HOME` 指向其目录),并把第 2 步已取得的 `cloudToken`
   经 env/IPC 交给它;进程**不重复登录**,只复用 `CloudAuthService.afterCloudAuth` 的后半段
   (`apps/server-agent/src/services/cloud-auth.service.ts`):写身份镜像进**它自己的** `agent.db`
   + 拉 profile + 签发该账号的本地 JWT。
5. 反向代理指向该进程;`accounts.json` 更新 `activeAccount` 与账号清单。

**切换**

- 从账号清单选一个 → 目标进程已预热则**瞬间改路由**(DB / MCP / checkpointer 均现成);
  未预热则先懒启再路由。
- 浏览器需持有目标账号的本地 JWT(由该账号进程签发);socket.io **重连一次**到新进程。

**登出**

- 停止路由(可选停掉进程);清 `activeAccount`。账号数据留盘,下次登录直接进。

**取舍说明(登录必须)**:这放弃了「免登录本地可用」,与产品「本地优先」slogan 有偏离。
但**已登录后离线仍可用**——身份 + token 缓存在该账号 `agent.db`,「必须」指首次身份建立,
不是每次都要联网。

## 8. 迁移策略:不迁移

- 升级后**不**自动搬运旧数据;每个账号从空 `accounts/<cloudUserId>/` 开始。
- 旧的 `~/.meshbot/` 顶层文件(agent.db / mcp.json / skills / prompt / workspace)**留在盘上、不删、不读**,
  需要时用户可手动找回。
- 文档需提示:升级后会"看不到"旧会话/配置(数据仍在盘上,只是不再被读取)。

## 9. 关键技术点 / 边界情况

- **反向代理固定端口**:监听 3100(web-agent 硬编码端口);各账号进程用 ephemeral port。
  前端 base URL 不变。
- **JWT 账号隔离**:JWT secret 随账号目录各一份 → A 进程签的 token 在 B 进程不通过验证(符合预期,
  增强隔离)。浏览器只持有活跃账号的 token,切换时换成目标账号的 token。
- **切换时的在飞 run**:被切走的账号若有正在跑的 run,其进程仍在(进程池常驻),run 不被打断;
  仅路由改变。若选择停掉旧进程,则需先 abort 在飞 run(沿用现有 abort 机制)。
- **socket.io 重连**:切换后浏览器需重连到新进程并重新订阅活跃会话。
- **内存成本**:多账号常驻 = 多进程内存。策略:只保留最近使用的若干进程常驻,其余懒启/回收。

## 10. 测试策略

- **单元**
  - 统一后的目录解析:设 `MESHBOT_HOME` 后所有路径(db/mcp/skills/prompt/workspace)随之改变。
  - `accounts.json` 读写 + `activeAccount` 指针的增删改。
  - Supervisor 的 spawn / route / 懒启逻辑(以桩进程验证)。
- **集成**
  - 两账号 → 两目录 → 切换 → **断言隔离**:B 下看不到 A 的会话、技能、mcp.json 生效项。
- **前端**(若纳入测试通道,参照 web-common 既有最小 jest 设施)
  - 强制登录闸:未登录跳登录页。
  - 账号切换 UI 取自控制面清单。

## 11. 实现阶段

1. **地基**:统一 `resolveMeshbotDir`,`MeshbotConfigService` 跟随同一根(含单测)。
2. **控制面 + 登录编排上移**:`accounts.json` 读写;登录在壳内编排出 `cloudUserId` 并建目录。
3. **进程池 + 反向代理**:Supervisor 管理每账号子进程 + 固定端口转发(HTTP + WS)。
4. **前端**:强制登录闸 + 账号切换 UI(取自控制面清单)。
5. **隔离集成测试**:两账号端到端验证。

## 12. 风险 / 开放问题

- 反向代理对 WebSocket 转发 + 切换重连的细节(socket.io 握手 / 房间重建)需在实现期验证。
- 进程池的内存/生命周期策略(常驻几个、何时回收)需定一个默认值。
- 独立 `pnpm dev:server-agent` 与 cli-agent 的多账号体验:仅靠手动设 `MESHBOT_HOME`,文档说明即可。
