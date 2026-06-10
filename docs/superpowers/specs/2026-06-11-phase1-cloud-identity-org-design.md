# Phase 1 设计：云端身份 + 企业/组织

> 状态：已与产品对齐，待实施
> 日期：2026-06-11

## 0. 背景与总体规划

meshbot 从「纯本地优先」转向「本地 Agent + 云端协同」：本地 Agent 不变（Agent 逻辑永远在本地跑），但身份体系搬到云端（server-main），并在其上逐步构建 Slack 式 IM 与 Jira 式任务面板。

总体分 5 个阶段，依赖关系如下：

```
Phase 1  云端身份 + 企业/组织（本文档）
  ├─► Phase 2  IM 骨架（云端消息中继 + 频道/私信 + 在线状态）
  │     └─► Phase 3  Agent 感知消息 + 出回复/处理建议
  └─► Phase 4  云端任务面板（Project/Task/指派，经云端 MCP 暴露给 Agent）
        └─► Phase 5  任务闭环（指派 → B 的 Agent 拉取处理 → B 确认 → 提交产物）
```

Phase 4 不依赖 Phase 2/3，理论上可并行，但建议串行推进。每个阶段独立走 spec → plan → 实现循环。

**架构红线**：server-main 只做身份、中继与协同元数据，**不跑 Agent 逻辑**。

## 1. 范围

### 做

1. **去掉本地密码登录体系**：server-agent 的 `User`（username/passwordHash）实体、本地 register/login 退役。
2. **云端身份**：身份真相源在 server-main（`AppUser`，邮箱 + 密码）。server-agent 通过云端 API 登录，本地只存身份镜像 + 云端 token。
3. **企业/组织**：server-main 新增 `Organization` / `Membership` / `Invitation`。「企业」与「组织」是同一层（单层 Organization）。注册后必须创建组织（成为 owner）或通过邮件邀请加入。
4. **邮件邀请**：server-main 增加可插拔 EmailSender（阿里云 DirectMail + 开发态 Log 兜底，参考 qriter 实现）。邮件**只发邀请码**（含「在桌面端登录后粘贴加入」指引），不做 web-main 落地页。
5. **server-main 基建对齐 qriter**：配置体系从 `env.schema.ts` 迁到 Nacos/YAML bootstrap 模式（`loadAppConfig` 进 `libs/common`），Postgres + Redis 不变。
6. **本地 LLM 配置步骤保留**：`ModelConfig` 流程不动，挪到「有组织之后」。

### 不做（留给后续阶段或暂缓）

- IM / 消息中继（Phase 2）、Agent 感知消息（Phase 3）、任务面板与云端 MCP（Phase 4/5）。
- token 刷新机制：Phase 1 用 7 天 JWT，过期重新登录。
- 离线模式：LLM 本身是远端模型（DeepSeek 等），无网无法工作，故登录强制联网；但已登录用户读本地镜像进入主界面不受云端可达性影响。
- 组织内 admin 角色：仅 `owner` / `member`。
- 多活跃组织 UI：数据模型支持多对多，UX 只暴露单一活跃组织（切换 API 备好，UI 不做）。
- web-main 邀请落地页。

## 2. 关键决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 云端 token 拓扑 | **方案 A：本地后端代理** —— server-agent 是唯一云端客户端，持有并持久化云端 token；浏览器只拿本地 JWT | 单一 token 持有者；Phase 2/3 中 server-agent 需后台调云端，现在统一；web-agent / desktop / cli-agent 三端同路；云端 token 不进浏览器存储 |
| 离线行为 | 无离线模式 | LLM 是远端的，离线本就不可用；简化设计 |
| 组织建模 | Membership 多对多表 + 单活跃组织 | 低成本，未来扩展多组织无需迁移 |
| 活跃组织存储 | 云端 `app_user.active_org_id` | 跨设备一致；服务端可校验归属，不信任客户端 |
| 加入机制 | 邮件邀请（只发邀请码） | 不依赖 web-main；落地页留以后 |
| 配置中心 | Nacos（回退本地 YAML） | 与 qriter 部署体系对齐 |
| 邮件服务 | 阿里云 DirectMail（`@alicloud/dm20151123`），可插拔接口 + Log 兜底 | 与 qriter 一致，开发态零依赖 |

## 3. 端到端引导流程（setup-status 状态机）

```
启动
  │  本地有有效云端 token?
  ├── 否 ──► [needs-login] 注册 / 登录页（经 server-agent 代理打云端）
  │                │ 登录/注册成功
  │                ▼
  ├── 是 ──► 有活跃组织?
  │            ├── 否 ──► [needs-org]
  │            │            ├─ 创建组织（成为 owner）
  │            │            └─ 粘贴邀请码加入
  │            └── 是 ▼
  │          有启用的 ModelConfig?
  │            ├── 否 ──► [needs-model] 配置 LLM（现有 ModelForm 复用）
  │            └── 是 ──► [ready] 进入本地 Agent
```

邀请接受始终是一次**已登录云端用户**的动作，邮件只负责投递邀请码。

## 4. 数据模型

### 4.1 云端（server-main / Postgres）

Entity + 归属 Service 放 `libs/main`，Zod schema 放 `libs/types-main`。迁移遵守云端轨规范：幂等 SQL（`IF NOT EXISTS`）+ 索引 `CONCURRENTLY` + snake_case + 无数据库外键（逻辑外键）。

**`app_user`（已有，扩展）**

| 列 | 说明 |
|---|---|
| id / email / password_hash / display_name / created_at / updated_at | 不变 |
| `active_org_id`（新增，uuid，nullable，逻辑外键 → organization） | 单活跃组织 |

**`organization`（新）**

| 列 | 类型/约束 | 说明 |
|---|---|---|
| id | uuid PK | |
| name | varchar(64) | 不要求唯一，Phase 1 不做 slug |
| owner_id | uuid，逻辑外键 → app_user | 与 Membership.role=owner 冗余，便于直查 |
| created_at / updated_at | timestamptz | |

**`membership`（新，多对多）**

| 列 | 类型/约束 | 说明 |
|---|---|---|
| id | uuid PK | |
| org_id / user_id | uuid，逻辑外键 | 唯一索引 (org_id, user_id) |
| role | varchar | `'owner' \| 'member'` |
| created_at | timestamptz | |

**`invitation`（新）**

| 列 | 类型/约束 | 说明 |
|---|---|---|
| id | uuid PK | |
| org_id | uuid，逻辑外键 | |
| email | varchar(255) | 唯一部分索引 (org_id, email) WHERE status='pending'，防重复邀请 |
| token | varchar，unique | 随机 32 字节 hex；邮件邀请码即此值 |
| status | varchar | `'pending' \| 'accepted' \| 'revoked' \| 'expired'` |
| invited_by | uuid，逻辑外键 → app_user | |
| expires_at | timestamptz | 默认创建后 7 天 |
| accepted_by / accepted_at | nullable | 接受时回填；accepted_by 允许 ≠ 邀请邮箱对应账号 |
| created_at | timestamptz | |

### 4.2 本地（server-agent / SQLite，TypeORM 迁移）

**`users` 表退役 → 新表 `cloud_identity`（单行）**

| 列 | 说明 |
|---|---|
| id（PK，固定 `'default'`） | 单用户单行 |
| cloud_user_id / email / display_name | 云端身份镜像 |
| org_id / org_name / role | 活跃组织镜像（刷新时机：登录成功时、组织相关代理调用成功后） |
| cloud_token / cloud_token_expires_at | 云端 JWT 持久化处，永不下发浏览器 |
| created_at / updated_at | |

- 迁移 drop `users` 表（旧本地凭证无云端对应物，不迁移）。
- `ModelConfig` / `Setting` / `Session` / `SessionMessage` 等其余本地表全部不动。

### 4.3 本地 token 双层结构

浏览器 ↔ server-agent 保留现有本地 JWT 机制（jwt.strategy / guard / `@Public()` 复用）：云端登录成功后，server-agent 用本地 secret 签本地 JWT 给浏览器，payload 改为 `{sub: cloudUserId, email}`。云端 JWT 只存于 `cloud_identity`，由 server-agent 调云端时自带。

## 5. API 设计

### 5.1 云端（server-main，`{success, code, message, data}` 信封 + 限流）

**Auth**
- `POST /api/auth/register`、`POST /api/auth/login` — 已有，不动
- `GET /api/auth/profile` — 扩展返回 `{ user, activeOrg, memberships[] }`

**组织（新 OrgController；OrgService / MembershipService / InvitationService 在 libs/main，各自唯一持有对应 Repository）**
- `POST /api/orgs` `{name}` — 建组织。事务内：插 organization + owner membership + 回填 active_org_id（跨表写 `@Transactional()`，命名遵守 `persist*` / `*InTx` 约定）
- `GET /api/orgs` — 我的组织列表（带 role）
- `PUT /api/me/active-org` `{orgId}` — 切活跃组织（校验 membership；Phase 1 UI 不暴露）
- `GET /api/orgs/:id/members` — 成员列表（本组织成员可见）
- `POST /api/orgs/:id/invitations` `{email}` — owner 限定。事务内建 invitation；**事务提交后**发邮件（发信失败不回滚，状态保持 pending 可重发）
- `GET /api/orgs/:id/invitations` — owner 查看待处理邀请
- `POST /api/orgs/:id/invitations/:invitationId/resend` — owner 重发邀请邮件
- `DELETE /api/invitations/:id` — owner 撤销（status → revoked）
- `POST /api/invitations/accept` `{token}` — 已登录用户接受：校验 pending + 未过期 → 建 membership（已是成员则幂等成功）→ 标记 accepted → 用户无活跃组织则设为此组织。`@WithLock`（按 token）在 `@Transactional` 外层，防并发重复接受

**新错误码（main 2000 段）**：`ORG_NOT_FOUND` / `ORG_FORBIDDEN` / `INVITATION_INVALID` / `INVITATION_EXPIRED`。

### 5.2 本地代理（server-agent，替换现有 auth 控制器）

- `POST /api/auth/register` / `POST /api/auth/login` — 代理云端同名接口：云端 JWT → 调云端 profile → upsert `cloud_identity` → 签本地 JWT 返回浏览器（浏览器 localStorage 行为不变）
- `GET /api/auth/profile` — 读本地镜像（不每次打云端）
- `GET /api/setup-status` — 四态：`needs-login` / `needs-org` / `needs-model` / `ready`
- `POST /api/orgs`、`GET /api/orgs`、`POST /api/invitations/accept`、`POST /api/orgs/:id/invitations`、`GET /api/orgs/:id/members`、`GET /api/orgs/:id/invitations`、resend、revoke — 薄代理（controller-thin，转发逻辑在 Service 层）
- `POST /api/auth/logout` — 清 `cloud_identity` 行

**CloudClient（server-agent 新核心组件）**：云端 HTTP 客户端服务。base URL 取 `MESHBOT_CLOUD_URL`（默认 `http://127.0.0.1:3200`）；自动附加云端 token；解开云端信封并把云端错误码映射为本地错误码透传；云端 401 → 清本地云端 token（setup-status 落回 needs-login）；云端不可达 → 本地新错误码 `CLOUD_UNREACHABLE`（agent 3000 段）。

### 5.3 关键时序

**登录**：浏览器 → server-agent `POST /api/auth/login` → CloudClient → 云端 login → 云端 JWT → 云端 profile → upsert cloud_identity → 签本地 JWT → 浏览器。

**邀请**：A（owner）桌面端发邀请 → server-agent 代理 → 云端建 invitation + DirectMail 发邀请码给 B。B：注册/登录桌面端 → onboarding「加入组织」粘贴邀请码 → server-agent 代理 accept → membership 建立。

## 6. server-main 基建对齐（qriter 模式）

参考实现：`/Users/grant/Meta1/qriter/apps/server`（config loader 在其 libs/common）。

1. **配置 bootstrap**：`main.ts` 在 NestFactory 之前 `loadAppConfig(Schema, { envFiles: [".env"], yamlFiles: ["conf/application.yml", "conf/application.local.yml"] })`。有 `NACOS_SERVER_ADDR` 则从 Nacos 拉 YAML（dataId 默认 `meshbot-server-main.yaml`，namespace/group/username/password 可配），否则回退本地 YAML。Zod 校验后以嵌套对象分发（`APP_CONFIG` token + 各模块切片）。`loadAppConfig` / `nacos-source` 移植进 meshbot 的 `libs/common`。
2. **EmailSender**：接口 `sendInvitation(to, { orgName, inviterName, code, expiresAt })`。实现：`DirectMailEmailSender`（`@alicloud/dm20151123` + `@alicloud/openapi-client`，singleSendMail，配置 endpoint/accountName/accessKeyId/accessKeySecret/fromAlias）与 `LogEmailSender`（打日志）。factory 按 `config.email` 是否存在选择。纯文本邮件，Phase 1 不做模板系统。
3. **Postgres / Redis**：连接参数改从配置切片读取（替代 `DATABASE_URL` 单变量）；Redis 仍可选、缺省回退内存。现有迁移机制保留。
4. **配置切片**：`database` / `redis` / `jwt` / `email`（阿里 DM）/ `invitation`（过期天数等）。

## 7. 前端改造（web-agent）

- **登录页**：username → email + password。表单走 `Form/FormItem + useSchema`（共享 Zod schema 在 `libs/types-main`，本地代理接口复用同一套 schema），文案走 next-intl。
- **Setup 向导** 2 步 → 3 步，由四态 setup-status 驱动：
  1. 注册（email / password / displayName）— `needs-login`
  2. 组织（新增）— `needs-org`：tab「创建组织」（名称）/「加入组织」（粘贴邀请码）
  3. 配置 LLM — `needs-model`：现有 ModelForm 原样复用
- **AuthGuard**：保持「profile 401 → 查 setup-status → 分流」骨架，分流目标 2 态 → 4 态。
- **设置页新增「组织」区块**：成员列表（成员可见）；邀请成员（输 email）、待处理邀请列表 / 重发 / 撤销（owner 限定）。

## 8. 错误处理

- **云端不可达**（`CLOUD_UNREACHABLE`）：登录/注册/组织操作 toast 提示「无法连接云端服务」；已登录用户进主界面不受影响（profile 读本地镜像）。
- **云端 token 过期/失效**：CloudClient 收云端 401 → 清 cloud_token → 前端落回 `needs-login` 重新登录。
- **邀请发信失败**：invitation 保持 pending，owner 设置页可见并可重发。
- **接受邀请的边界**：过期 → `INVITATION_EXPIRED`；已撤销/不存在 → `INVITATION_INVALID`；已是成员 → 幂等成功。

## 9. 测试

- **单测（Jest）**：OrgService / MembershipService / InvitationService（accept 的幂等、过期、撤销分支）、CloudClient（token 注入、401 清理、错误码映射、不可达）、EmailSender factory 分支。
- **E2E（server-main，Postgres service）**：注册 → 登录 → 建组织 → 邀请 → 第二用户注册 → accept → 成员列表全链路；owner 限定与过期邀请负向用例。
- **静态围栏**：commit 前 `pnpm check` 全套（repo 归属 / tx 命名 / 锁-事务 / 死导出 / 错误码）。

## 10. 既有用户升级路径

- server-agent 迁移 drop `users` 表：升级后 setup-status 返回 `needs-login`，用云端账号重新注册/登录（旧本地凭证不迁移）。
- `ModelConfig` / `Session` 等本地数据全保留：重登后跳过配模型，会话历史无损。

## 11. 配置变更清单

| 端 | 变更 |
|---|---|
| server-agent | 新增 `MESHBOT_CLOUD_URL`（默认 `http://127.0.0.1:3200`） |
| server-main | 配置体系迁 Nacos/YAML bootstrap；新增 `email`（阿里 DM 凭证）、`invitation` 切片；`conf/application.yml` 提供 localhost 开发默认值 |
| libs/common | 新增 `loadAppConfig` / Nacos source（移植自 qriter 模式） |
