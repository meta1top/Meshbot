# meshbot Phase 3：缺口收尾 + server-main 最小业务闭环

- 日期：2026-05-14
- 范围：meshbot Phase 3（继 Phase 2 工程化 harness 之后）
- 形态：一份大 spec，内部 3 个轨道；后续单份 plan 拆 ~14 个 task

---

## 1. 总体目标与范围

### 1.1 目标

把 meshbot **云端轨**从 Phase 2 的"框架仅就位"推到"**最小业务闭环可走通**"，同时清掉 Phase 2 已知缺口。

### 1.2 三条轨道

| 轨道 | 主题 | 估算 task |
|------|------|-----------|
| **A** | Phase 2 缺口收尾（i18n bridge + 60 web-agent missing keys burn down + pre-commit `sync:locales --check` 改硬失败） | 3 |
| **B** | server-main 最小业务闭环（User / Organization / Membership / AgentRegistration 共 4 实体 + Postgres + 迁移 + JWT + 5 路由 8 个 endpoint） | 8 |
| **C** | migrations-ddl 规约落地（server-main 迁移文件规范 + server-agent 评估脱 `synchronize:true`） | 2 |
| **共享** | `infra/dev/docker-compose.dev.yml` 起 Postgres 单容器 | 1 |

合计 ~14 task。

### 1.3 Phase 3 最小业务闭环（验收清单）

1. `docker compose -f infra/dev/docker-compose.dev.yml up -d` 起 Postgres@5432
2. `pnpm dev:server-main` 自动跑迁移建立 schema
3. `POST /api/auth/register` 创建 User
4. `POST /api/auth/login` 拿 JWT
5. `POST /api/orgs` 创建 Organization（自动作为创建者的 owner Membership）
6. `POST /api/orgs/:id/members/invite` 通过 email 创建 pending invite（不实际发邮件，返回 token）
7. `POST /api/orgs/:id/agents` 把本地 Agent 注册到 org
8. `GET /api/orgs/:id/agents` 列出 org 下所有已注册 Agent

### 1.4 不做什么

- **不做 Redis** — `@WithLock` / `@Cacheable` 继续用 MemoryProvider；Phase 4 切 Redis
- **不做 Docker 化 server-main 本身** — 只起 Postgres dev infra
- **不做** 发布工具链 / cli-agent npm publish / electron release（Phase 4）
- **不做** 监控接入 Sentry / OTel（Phase 4 / Phase 5）
- **不做** 真实邮件发送（invite token 仅返回响应；Phase 4 接 SES）
- **不做** server-main 前端 UI（web-main 仍是空骨架；用 curl/Postman 测）
- **不做** ts-jest config 迁移 / pre-commit 调优等小琐事（Phase 4 顺手做）
- **不做** 完整多租户 RBAC — Membership 只区分 owner / member 两个 role

### 1.5 Phase 3 退出标志

- 8 个端点全部跑通（curl + e2e test 双重验证）
- `pnpm check` 5 围栏全绿（含 server-main 新业务代码）
- `pnpm test` 含 server-main e2e 测试
- `sync:locales --check` 通过（60 个 key 全部 burn down）
- pre-commit `sync:locales` 改硬失败模式
- server-agent + server-main 都通过迁移文件管理 schema（脱 synchronize:true）

---

## 2. 资产矩阵 + 实体模型 + Endpoint + dev infra

### 2.1 Track A — 缺口收尾（3 task）

| # | 资产 | Phase 3 动作 |
|---|------|--------------|
| A1 | `I18nZodValidationPipe` | 新建 `libs/common/src/dto/i18n-zod-validation.pipe.ts`：截获 `ZodValidationException`，遍历 `issues[]`，用 `I18nService.translate(issue.message, { lang })` 翻译后重新抛出 |
| A2 | 60 web-agent missing i18n keys | `pnpm sync:locales -- --write` 补占位 → 手工填中英文 → `--check` 验证 |
| A3 | pre-commit `sync:locales` 软告警→硬失败 | 改 `.husky/pre-commit`：移除 `\|\| echo` 短路 |

### 2.2 Track B — server-main 最小业务闭环（8 task）

| # | 资产 | 内容 |
|---|------|------|
| B1 | `infra/dev/docker-compose.dev.yml` | Postgres 16-alpine + 卷挂载 + 健康检查 + 端口 5432 |
| B2 | server-main Postgres 接入 | `TypeOrmModule.forRootAsync` + `SnakeNamingStrategy` + `synchronize:false` + `migrationsRun:false` |
| B3 | `libs/types-main` schema 扩展 | RegisterUser / Login / CreateOrg / InviteMember / AcceptInvite / RegisterAgent Schema |
| B4 | `libs/main` 业务模块（新建 lib） | 4 entity + 4 service + 1 module；Entity 唯一归属各自 service |
| B5 | server-main `MainModule` + auth + 5 controllers | JWT auth（与 server-agent 独立 secret + strategy 名）+ 4 controllers |
| B6 | 首批迁移文件 | InitialSchema：建 4 张表 + 索引 + check 约束；幂等 SQL |
| B7 | server-main e2e 测试套 | unit 覆盖每个 service；e2e 用 supertest + 真 Postgres 测试 schema 跑 8 个 endpoint |
| B8 | i18n 资源扩充 | server-main `i18n/{zh,en}/{auth,org,member,agent,validation}.json` |

### 2.3 Track C — 迁移规约落地（2 task）

| # | 资产 | 内容 |
|---|------|------|
| C1 | server-agent 脱 `synchronize:true` | 抽 InitialSchemaSqlite 迁移（幂等 SQL）；DataSource 切 `synchronize:false, migrationsRun:true`；nest-cli assets 拷 migrations |
| C2 | `pnpm migration:*` 脚本统一 | `migration:generate:{main,agent}` / `migration:run:{main,agent}` / `migration:revert:{main,agent}` / `migration:show:{main,agent}`；data-source.cli.ts per app；archive 脚本搬运 |

### 2.4 实体字段模型

#### `app_user`
- `id` uuid PK
- `email` varchar(255) UNIQUE NOT NULL
- `password_hash` varchar(255) NOT NULL
- `display_name` varchar(64) NOT NULL
- `created_at` / `updated_at` timestamptz NOT NULL DEFAULT now()
- Index: `email`

#### `organization`
- `id` uuid PK
- `name` varchar(64) NOT NULL
- `slug` varchar(64) UNIQUE NOT NULL，kebab-case `^[a-z][a-z0-9-]{2,62}$`
- `owner_user_id` uuid NOT NULL（逻辑外键 → app_user.id）
- `created_at` / `updated_at`
- Index: `slug`, `owner_user_id`

#### `membership`
- `id` uuid PK
- `organization_id` uuid NOT NULL（逻辑外键 → organization.id）
- `user_id` uuid NULL（pending invite 时为 null）
- `invite_email` varchar(255) NULL
- `invite_token` varchar(64) NULL（pending invite 时填，base64url 32 字节）
- `role` varchar(16) NOT NULL CHECK (`role IN ('owner','member')`)
- `status` varchar(16) NOT NULL CHECK (`status IN ('pending','active')`)
- `created_at` / `updated_at`
- Index: `organization_id`, `user_id`, `invite_token`
- 业务约束：(`organization_id`, `user_id`) UNIQUE WHERE user_id IS NOT NULL；(`organization_id`, `invite_email`) UNIQUE WHERE status='pending'

#### `agent_registration`
- `id` uuid PK
- `organization_id` uuid NOT NULL（逻辑外键 → organization.id）
- `name` varchar(64) NOT NULL
- `fingerprint` varchar(128) UNIQUE NOT NULL
- `device_info` jsonb NOT NULL
- `last_seen_at` timestamptz NULL（Phase 4 心跳后更新）
- `created_at` / `updated_at`
- Index: `organization_id`, `fingerprint`

### 2.5 API Endpoint 表（5 路由 = 8 endpoint）

| Method + Path | 鉴权 | DTO | 业务 |
|---------------|------|-----|------|
| `POST /api/auth/register` | Public | RegisterUserDto (email, password, displayName) | 创建 User，返回 JWT |
| `POST /api/auth/login` | Public | LoginDto (email, password) | 校验，返回 JWT |
| `POST /api/orgs` | Auth | CreateOrgDto (name, slug) | 创建 org + 自动 owner Membership |
| `GET /api/orgs` | Auth | — | 列出当前 user 加入的所有 org |
| `POST /api/orgs/:id/members/invite` | Auth(owner) | InviteMemberDto (email) | 创建 pending Membership + 返回 invite token |
| `POST /api/orgs/accept-invite` | Public | AcceptInviteDto (token, email, password, displayName) | 创建 User（若不存在）+ activate Membership |
| `POST /api/orgs/:id/agents` | Auth(member) | RegisterAgentDto (name, fingerprint, deviceInfo) | upsert agent by fingerprint |
| `GET /api/orgs/:id/agents` | Auth(member) | — | 列出 org 下所有 agent |

### 2.6 dev infra

`infra/dev/docker-compose.dev.yml`：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: meshbot-dev-postgres
    environment:
      POSTGRES_USER: meshbot
      POSTGRES_PASSWORD: meshbot
      POSTGRES_DB: meshbot_main
    ports:
      - "5432:5432"
    volumes:
      - meshbot-dev-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U meshbot -d meshbot_main"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  meshbot-dev-postgres-data:
```

根 `package.json` 加：

```json
"dev:db:up": "docker compose -f infra/dev/docker-compose.dev.yml up -d",
"dev:db:down": "docker compose -f infra/dev/docker-compose.dev.yml down",
"dev:db:reset": "docker compose -f infra/dev/docker-compose.dev.yml down -v && pnpm dev:db:up"
```

`apps/server-main/.env.development.example`：

```bash
PORT=3200
DATABASE_URL=postgresql://meshbot:meshbot@localhost:5432/meshbot_main
JWT_SECRET=meshbot-main-dev-secret-change-in-prod
JWT_EXPIRES=7d
```

---

## 3. Track A 详细设计（缺口收尾）

### A1 — I18nZodValidationPipe

**问题**：`nestjs-zod` 抛 `ZodValidationException`（带 `issues[]`），`nestjs-i18n` 的 `I18nValidationExceptionFilter` 走 `class-validator` 的 `ValidationError[]` shape，两者不识别 → Zod 校验 message 的 i18n key 不被翻译。

**实现**：`libs/common/src/dto/i18n-zod-validation.pipe.ts`：

```typescript
import { Injectable, type ArgumentMetadata, BadRequestException, type PipeTransform } from "@nestjs/common";
import { I18nContext, I18nService } from "nestjs-i18n";
import type { ZodIssue } from "zod";

import type { ZodDtoClass } from "./create-zod-dto";

@Injectable()
export class I18nZodValidationPipe implements PipeTransform {
  constructor(private readonly i18n: I18nService) {}

  transform(value: unknown, metadata: ArgumentMetadata) {
    const cls = metadata.metatype as ZodDtoClass<any> | undefined;
    if (!cls || typeof cls !== "function" || !("schema" in cls)) return value;

    const result = cls.schema.safeParse(value);
    if (result.success) return result.data;

    const lang = I18nContext.current()?.lang ?? "zh";
    const errors = result.error.issues.map((issue: ZodIssue) => ({
      path: issue.path.join("."),
      message: this.tryTranslate(issue.message, lang, issue),
    }));
    throw new BadRequestException({
      statusCode: 400,
      message: "Validation failed",
      errors,
    });
  }

  private tryTranslate(rawMessage: string, lang: string, issue: ZodIssue): string {
    if (!rawMessage) return "";
    if (!rawMessage.includes(".")) return rawMessage;
    try {
      return this.i18n.translate(rawMessage, {
        lang,
        args: {
          min: (issue as any).minimum,
          max: (issue as any).maximum,
          received: (issue as any).received,
        },
      });
    } catch {
      return rawMessage;
    }
  }
}
```

**全局注册**（`apps/server-{agent,main}/src/main.ts`）：

```typescript
app.useGlobalPipes(new I18nZodValidationPipe(app.get(I18nService)));
```

**集成测改造**（`apps/server-agent/test/e2e/dto-i18n.spec.ts`）：去掉 Phase 2 容忍正则，改为强制断言 `必填字段` / `Required field`。

### A2 — 60 missing key burn down

1. `pnpm sync:locales -- --write` 自动补占位
2. 人工填中英文（按 namespace 批量：metrics / chat / panels / sidebar 等）
3. `pnpm sync:locales -- --check` 验证 exit 0

### A3 — pre-commit `sync:locales` 改硬失败

`.husky/pre-commit` 移除 `|| echo` 短路：

```bash
echo "[pre-commit] enforcing i18n key alignment..."
pnpm sync:locales -- --check
```

依赖：A2 必须先完成，否则全员被堵在门外。

---

## 4. Track B 详细设计（server-main 业务闭环）

### B1 — dev infra

见 §2.6。

### B2 — Postgres + TypeORM

`apps/server-main/src/app.module.ts`：

```typescript
TypeOrmModule.forRootAsync({
  useFactory: () => ({
    type: "postgres",
    url: process.env.DATABASE_URL,
    entities: [__dirname + "/**/*.entity.{ts,js}"],
    migrations: [__dirname + "/../migrations/*.{ts,js}"],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    migrationsRun: false,
    logging: process.env.NODE_ENV !== "production" ? ["error", "warn"] : ["error"],
  }),
})
```

新增依赖：`typeorm-naming-strategies`, `pg`, `@nestjs/config`。

### B3 — libs/types-main schema

```
src/
├── auth/{register-user,login}.schema.ts
├── organization/create-org.schema.ts
├── membership/{invite-member,accept-invite}.schema.ts
└── agent/register-agent.schema.ts
```

所有 message 字段必须是 i18n key（如 `"validation.required"`、`"auth.invalidEmail"`）。Phase 1 的 `sample/register-agent.schema.ts` 迁到 `agent/` 或删除。

### B4 — libs/main 业务模块（新建 lib）

```
libs/main/
├── package.json (@meshbot/main)
├── tsconfig.json
└── src/
    ├── index.ts
    ├── main.module.ts
    ├── entities/{app-user,organization,membership,agent-registration}.entity.ts
    ├── services/{user,organization,membership,agent-registration}.service.ts
    └── dto/{register-user,login,create-org,invite-member,accept-invite,register-agent}.dto.ts
```

Entity 唯一归属（`check:repo` 围栏遵守）：

| Entity | 归属 Service |
|--------|--------------|
| AppUser | UserService |
| Organization | OrganizationService |
| Membership | MembershipService |
| AgentRegistration | AgentRegistrationService |

跨 service 协同走方法调用（MembershipService 注入 UserService，不注 AppUser repository）。`TxTypeOrmModule.forFeature([...])` 在 `MainModule` 注册一次。

### B5 — MainModule + auth + controllers

**Auth**（与 server-agent 独立）：
- `apps/server-main/src/auth/`：`auth.module.ts` / `jwt.strategy.ts` / `jwt-auth.guard.ts`
- `JWT_SECRET` 从 env 读取（生产必须配；不允许默认值兜底）
- Passport strategy 名 `"jwt-main"`（server-agent 用 `"jwt"`）
- payload: `{ userId, email }`

**Controllers**（`apps/server-main/src/rest/`，遵守 `controller-thin` + `swagger-api-declaration`）：
- `auth.controller.ts` — register / login
- `organization.controller.ts` — create / list orgs
- `membership.controller.ts` — invite / accept-invite
- `agent.controller.ts` — register / list agents

**权限**：默认走 JwtAuthGuard；`@Public()` 装饰器豁免（register / login / accept-invite）。Org 内 owner-only 权限在 service 内手工 check Membership.role；Phase 3 不引入复杂自定义装饰器。

### B6 — 首批迁移文件

```bash
pnpm migration:generate:main --name InitialSchema
```

生成后人工 review：
- `CREATE TABLE IF NOT EXISTS`
- `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
- 列名 snake_case（SnakeNamingStrategy 已处理）
- check 约束（role / status）显式写
- timestamptz DEFAULT now()

文件名：`apps/server-main/migrations/<timestamp>-InitialSchema.ts`

**额外**：`apps/server-main/src/data-source.cli.ts` — TypeORM CLI 用的 DataSource，仅生成迁移，不参与 runtime。

### B7 — 测试套

**单元测试**（每个 service）：用真 Postgres 测试 schema 隔离（`meshbot_main_test_<random>`）。`beforeAll` 跑迁移，`afterAll` `DROP SCHEMA CASCADE`。覆盖：
- register / login（密码哈希、唯一冲突）
- createOrg 自动建 owner Membership
- invite token 一次性使用
- agent fingerprint 幂等 upsert

**E2E 测试**：`apps/server-main/test/e2e/main-flow.spec.ts` — 单 spec 跑完 8 个 endpoint 完整链路（register → login → createOrg → invite → acceptInvite → registerAgent → listAgents）。

### B8 — i18n 资源扩充

`apps/server-main/i18n/zh/`（en 镜像）：

```
auth.json: invalidEmail / passwordTooShort / emailAlreadyExists /
           invalidCredentials / inviteTokenInvalid / inviteTokenExpired
org.json: slugAlreadyExists / notOrgOwner / notOrgMember / orgNotFound
member.json: alreadyMember / pendingInviteExists / inviteEmailMismatch
agent.json: fingerprintConflict / agentNotFound
validation.json (扩充): required / stringTooShort / stringTooLong /
                       invalidUuid / invalidEmail / invalidUrl
```

---

## 5. Track C 详细设计（迁移规约落地）

### C1 — server-agent 脱 synchronize:true

1. 生成 `apps/server-agent/migrations/<ts>-InitialSchemaSqlite.ts`（dump 现有 3 表 DDL）
2. 人工 review + SQLite 适配（去 CONCURRENTLY，保留 IF NOT EXISTS，用 TEXT 列类型）
3. DataSource 切 `synchronize: false, migrationsRun: true`
4. `nest-cli.json` assets 拷 migrations 到 dist
5. 冒烟：删除既有 db → 启动 → 自动跑迁移 → register/login 验证

**幂等保护**：开发者已有数据库时，`CREATE TABLE IF NOT EXISTS` + TypeORM 自动管理 `migrations` 表跟踪，启动正常。

### C2 — pnpm migration:* 脚本

根 `package.json` 新增（main + agent 各一套）：

```json
"migration:generate:main": "typeorm-ts-node-commonjs migration:generate -d apps/server-main/src/data-source.cli.ts",
"migration:run:main": "typeorm-ts-node-commonjs migration:run -d apps/server-main/src/data-source.cli.ts",
"migration:revert:main": "typeorm-ts-node-commonjs migration:revert -d apps/server-main/src/data-source.cli.ts",
"migration:show:main": "typeorm-ts-node-commonjs migration:show -d apps/server-main/src/data-source.cli.ts",
"migration:generate:agent": "typeorm-ts-node-commonjs migration:generate -d apps/server-agent/src/data-source.cli.ts",
"migration:run:agent": "typeorm-ts-node-commonjs migration:run -d apps/server-agent/src/data-source.cli.ts",
"migration:revert:agent": "typeorm-ts-node-commonjs migration:revert -d apps/server-agent/src/data-source.cli.ts"
```

`archive:migrations` 脚本搬运  版本（已被 `.cursor/rules/archive-migrations.mdc` 引用）。

---

## 6. 风险 / 未决 / Phase 4 衔接

### 6.1 已知风险

| # | 风险 | 缓解 |
|---|------|------|
| R1 | `I18nZodValidationPipe` 与 nestjs-zod v4 兼容 | A1 集成测强制翻译断言，兼容性破坏立刻可见 |
| R2 | server-main 与 server-agent JWT 串台 | 两端 Passport strategy 名独立（`"jwt-main"` vs `"jwt"`） |
| R3 | 逻辑外键 join 4 表 | service 层显式 check 关联存在；E2E 用孤儿数据覆盖 |
| R4 | server-agent 脱 synchronize 影响本地既有数据 | 幂等迁移；冲突时教开发者删 db 重建 |
| R5 | dev Postgres 端口 5432 冲突 | 文档建议改 `5433:5432`，env 同步改 |
| R6 | 多租户数据隔离 | controller/service 显式 inject `req.user` 后查 Membership 过滤；E2E 双 user 交叉验证 |
| R7 | invite token 走响应有安全风险 | Phase 3 仅 dev 可接受；Phase 4 真发邮件时改不带 token |

### 6.2 未决问题

**Phase 3 开始前敲定**（默认值）：

- Q1：Postgres 16
- Q2：JWT HS256
- Q3：bcrypt cost 12
- Q4：invite token 用 base64url 32 字节
- Q5：org slug 校验 `^[a-z][a-z0-9-]{2,62}$`

**Phase 3 实施中**：

- Q6：org owner 数量 — 允许多个，创建时自动 1 个
- Q7：agent fingerprint 冲突 — upsert（更新 lastSeenAt + deviceInfo）

**Phase 4 开始前**（推迟）：

- 版本号策略（changesets / release-please / 各自 semver）
- cli-agent 发布形态
- server-main 部署目标（docker / k8s / Serverless）
- 监控选型（Sentry / OTel）

### 6.3 Phase 4 衔接

| Phase 4 任务 | Phase 3 准备 |
|--------------|--------------|
| Docker 化 server-main | dev docker-compose 模板已有；只需 production Dockerfile |
| Redis 接入 `@WithLock` / `@Cacheable` | Phase 1 抽象已就位；换实现 |
| cli-agent / desktop 发布工具链 | 版本号策略和 release 流统一规划 |
| GitHub Actions CI | pre-commit 命令组已就绪 |
| 邮件发送 | server-main i18n + auth scope 已成 |
| 监控接入 | 两端基础设施稳定，加 hook 不破坏 |

### 6.4 Phase 3 退出标志

- `pnpm typecheck` / `pnpm test` / `pnpm check`（5 围栏） / `pnpm sync:locales -- --check`（**硬失败模式**） / `pnpm sync:skills -- --check` 全通过
- `infra/dev/docker-compose.dev.yml` 起 Postgres 跑通
- server-main 8 个端点 e2e 测全过
- server-agent 脱 `synchronize:true`，迁移文件管理
- `I18nZodValidationPipe` 全局注册，集成测断言中/英翻译实际生效
- 60 个 web-agent missing key 全部 burn down
- CLAUDE.md 标记 Phase 3 ✅ 已完成，Phase 4 backlog 更新

---

## 7. 下一步

本 spec 通过后，进入 **writing-plans skill**，为 Phase 3 撰写详细实施 plan，把 ~14 个 task 展开到可直接进入实施的颗粒度。
