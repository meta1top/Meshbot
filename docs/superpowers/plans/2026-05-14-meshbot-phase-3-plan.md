# meshbot Phase 3 实施 Plan — 缺口收尾 + server-main 最小业务闭环

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Spec**: [2026-05-14-meshbot-phase-3-design.md](../specs/2026-05-14-meshbot-phase-3-design.md)
- **Date**: 2026-05-14
- **Status**: ✅ 已完成（2026-05-16）

> **实施差异（2026-05-16）**：实施 B7 期间用户明确「不照搬  业务」。本 plan 原 B3 / B4 / B5 / B6 / B7 / B8 中描述的 Organization / Membership / Invite / AgentRegistration 全部从 libs/main 剥离。最终落地的 server-main 业务只剩 AppUser + register / login（2 endpoint）作为框架基线示范；真实业务由 meshbot 自行迭代。框架要素（TypeORM + TxTypeOrmModule + I18nZodValidationPipe + I18nExceptionFilter + JWT + 迁移文件 + 静态围栏）全部按 plan 完成。 仅作为框架 / 流程 / 规则的参考，不照抄业务。
>
> 各 task 实际产出见 `.claude/CLAUDE.md` Phase 3 章节；落到磁盘的代码以仓库当前 HEAD 为准，下文为原 plan 存档。

- **Goal**: 把 meshbot 云端轨从"框架就位"推到"最小业务闭环可走通"，同时清掉 Phase 2 已知缺口。
- **Reference repo**: `/Users/grant//platform`（）— **仅参考框架 / 流程 / 规则**（TypeORM 模式、迁移规范、静态围栏、i18n 桥接思路）。**不照搬业务**（Member / Invite / Org 等领域设计 meshbot 自行迭代）。
- **不在范围**: Redis、server-main Docker 化、cli-agent 发布、Sentry/OTel、真实邮件、web-main UI、完整 RBAC。详见 spec §1.4。

---

## Architecture 摘要

```
infra/dev/docker-compose.dev.yml         # Postgres 16-alpine（dev）
├─ libs/types-main/                      # Zod schema（auth/org/member/agent）
├─ libs/main/                            # 业务模块（4 entity + 4 service + MainModule）
│   └─ TxTypeOrmModule.forFeature(...)
├─ libs/common/
│   └─ src/dto/i18n-zod-validation.pipe.ts  # 【新】Zod ↔ nestjs-i18n 桥
└─ apps/server-main/
    ├─ src/
    │   ├─ app.module.ts                 # TypeOrmModule.forRootAsync(Postgres) + MainModule + AuthModule
    │   ├─ auth/                         # JwtStrategy(name="jwt-main") + JwtAuthGuard + @Public
    │   ├─ rest/                         # 4 controllers（auth/org/member/agent）
    │   ├─ data-source.cli.ts            # TypeORM CLI 用
    │   └─ main.ts                       # 全局 I18nZodValidationPipe
    └─ migrations/<ts>-InitialSchema.ts  # 4 张表 + 索引 + check 约束

apps/server-agent/                       # Track C: 脱 synchronize:true
└─ migrations/<ts>-InitialSchemaSqlite.ts
```

**3 个轨道 / 13 个 task**：
- **Track A**（缺口收尾，3 task）: A1 / A2 / A3
- **Track B**（server-main 业务闭环，8 task）: B1 / B2 / B3 / B4 / B5 / B6 / B7 / B8
- **Track C**（迁移规约落地，2 task）: C1 / C2

**Task 依赖关系**:
```
A1（pipe）─┐
           ├─→ B5（controllers，需要 pipe 才能正确翻译校验报错）
B1（pg）──┤
B2（typeorm）─→ B4（service）─→ B5（controller）─→ B6（migration）─→ B7（e2e）
           B3（schema）─→ B5
B8（i18n）─→ B5（B5 throw AppError 时用到这些 key）
C1（agent migrations）独立
C2（migration scripts）─→ B6 / C1（提供工具链）
A2 → A3（A3 改硬失败前 A2 必须 burn down）
```

建议执行顺序：**A1 → B1 → B2 → B3 → C2 → B4 → B8 → B5 → B6 → B7 → C1 → A2 → A3**。

---

## Track A — Phase 2 缺口收尾

### Task A1: I18nZodValidationPipe（Zod ↔ nestjs-i18n 桥）

**问题**: `nestjs-zod` 抛 `ZodValidationException`，而 `nestjs-i18n` 的 `I18nValidationExceptionFilter` 走 `class-validator` 的 `ValidationError[]` shape，两者不识别 → `createI18nZodDto` 派生的 DTO 当前 production **不会触发校验**，i18n key 也不被翻译。

**Files**:
- Create: `libs/common/src/dto/i18n-zod-validation.pipe.ts`
- Modify: `libs/common/src/dto/index.ts`（导出）
- Modify: `libs/common/src/index.ts`
- Modify: `apps/server-agent/src/main.ts`（全局注册）
- Modify: `apps/server-main/src/main.ts`（全局注册）
- Modify: `libs/common/src/dto/create-i18n-zod-dto.ts`（删除 JSDoc 中 "production 不会触发校验" 警告段）
- Modify: `apps/server-agent/test/e2e/dto-i18n.spec.ts`（强制翻译断言）

- [ ] **Step 1: 实现 I18nZodValidationPipe**

  `libs/common/src/dto/i18n-zod-validation.pipe.ts`：

  ```ts
  import {
    Injectable,
    type ArgumentMetadata,
    BadRequestException,
    type PipeTransform,
  } from "@nestjs/common";
  import { I18nContext, I18nService } from "nestjs-i18n";
  import type { ZodIssue } from "zod";
  import type { ZodDtoClass } from "./create-zod-dto";

  /**
   * Zod DTO 校验 + i18n 翻译桥。
   *
   * - 输入 `metatype` 必须是 `createI18nZodDto`/`createZodDto` 派生类（带 `.schema`）。
   * - 校验失败时，把 `issue.message`（i18n key 如 "validation.required"）通过
   *   `I18nService.translate` 翻译为当前 lang 文案，再统一抛 `BadRequestException`。
   * - 非 DTO 参数（普通 metatype）原样放行，不破坏其它 Pipe 链。
   *
   * 替代 nestjs-i18n 自带 `I18nValidationPipe`（只识别 class-validator）。
   */
  @Injectable()
  export class I18nZodValidationPipe implements PipeTransform {
    constructor(private readonly i18n: I18nService) {}

    transform(value: unknown, metadata: ArgumentMetadata) {
      const cls = metadata.metatype as ZodDtoClass<any> | undefined;
      if (!cls || typeof cls !== "function" || !("schema" in cls)) return value;

      const parsed = cls.schema.safeParse(value);
      if (parsed.success) return parsed.data;

      const lang = I18nContext.current()?.lang ?? "zh";
      const errors = parsed.error.issues.map((issue: ZodIssue) => ({
        path: issue.path.join("."),
        message: this.tryTranslate(issue.message, lang, issue),
      }));
      throw new BadRequestException({
        statusCode: 400,
        message: "Validation failed",
        errors,
      });
    }

    private tryTranslate(raw: string, lang: string, issue: ZodIssue): string {
      if (!raw || !raw.includes(".")) return raw;
      try {
        return this.i18n.translate(raw, {
          lang,
          args: {
            min: (issue as any).minimum,
            max: (issue as any).maximum,
            received: (issue as any).received,
          },
        }) as string;
      } catch {
        return raw;
      }
    }
  }
  ```

- [ ] **Step 2: 全局注册**

  `apps/server-agent/src/main.ts` 与 `apps/server-main/src/main.ts` 替换 `new I18nValidationPipe(...)`：

  ```ts
  import { I18nZodValidationPipe } from "@meshbot/common";
  import { I18nService } from "nestjs-i18n";
  // ...
  app.useGlobalPipes(new I18nZodValidationPipe(app.get(I18nService)));
  ```

  `I18nValidationExceptionFilter` 仍可保留（兜底 class-validator 路径），但项目当前没有 class-validator DTO，可选移除。

- [ ] **Step 3: 修正 createI18nZodDto JSDoc**

  删除 `libs/common/src/dto/create-i18n-zod-dto.ts` 中 "⚠️ Phase 2 已知缺口" 整段，改为一句"通过 `I18nZodValidationPipe` 全局生效"。

- [ ] **Step 4: 强化 e2e 断言**

  `apps/server-agent/test/e2e/dto-i18n.spec.ts`：

  - 去掉容忍 raw-key 的正则
  - 中文请求：断言 response.body.errors[0].message === "必填字段"（或对应 zh key 翻译值）
  - 英文请求（`?lang=en` / `accept-language: en`）：断言对应 en 翻译值

- [ ] **Step 5: pipe 单测**

  `libs/common/src/dto/i18n-zod-validation.pipe.spec.ts`：mock `I18nService.translate`，覆盖
  ① 校验通过 → 返回 parsed data
  ② 校验失败 → translate 被调用 → 抛 400
  ③ 非 DTO metatype → 原样返回
  ④ translate 抛错 → 兜底返回原 key

**Acceptance**:
- `pnpm test -- i18n-zod-validation.pipe` 全绿
- `pnpm test -- dto-i18n` 中英双语翻译断言通过
- `pnpm typecheck` 全绿

---

### Task A2: 60 个 web-agent missing i18n key burn down

**Files**:
- Modify: `apps/web-agent/i18n/zh/common.json`
- Modify: `apps/web-agent/i18n/en/common.json`

- [ ] **Step 1: 自动补占位**

  ```bash
  pnpm sync:locales -- --write
  ```

  审查 diff 中新加的 key（约 60 条）—— 不应有 orphan/asymmetric。

- [ ] **Step 2: 按 namespace 人工补全**

  按 namespace 分批：`metrics.*` / `chat.*` / `panels.*` / `sidebar.*` / `overview.*`。每条 key 中英双语统一风格：

  - zh：动词在前，简洁，6–12 字
  - en：句首大写，含完整名词，不缩写

- [ ] **Step 3: 验证**

  ```bash
  pnpm sync:locales -- --check    # exit 0
  pnpm typecheck                  # 翻译 key 引用类型推断仍通过
  pnpm dev:web-agent              # 手动浏览 5 个页面，断言无 fallback 文案
  ```

**Acceptance**:
- `pnpm sync:locales -- --check` 退出码 0
- web-agent 主流程页面无 fallback raw key 显示

**依赖**: 无 — 与 A1 / B* 并行进行。但必须先于 A3。

---

### Task A3: pre-commit `sync:locales` 软告警 → 硬失败

**Files**:
- Modify: `.husky/pre-commit`

- [ ] **Step 1: 移除短路兜底**

  当前 pre-commit 类似：
  ```bash
  pnpm sync:locales -- --check || echo "[pre-commit] locale 不一致（软告警）"
  ```
  改为：
  ```bash
  echo "[pre-commit] enforcing i18n key alignment..."
  pnpm sync:locales -- --check
  ```

- [ ] **Step 2: 验证**

  - 本地故意删一个 key 试触发 → pre-commit 应阻断 commit
  - 跑 A2 后 baseline 干净 → 正常 commit 不被阻断

**Acceptance**:
- pre-commit 路径 ≤ 25s（hard ceiling）
- 故意制造 missing/orphan key 时 pre-commit exit ≠ 0

**依赖**: A2 必须先完成，否则团队全员被堵在 commit 门外。

---

## Track B — server-main 最小业务闭环

### Task B1: dev infra（Postgres docker-compose）

**Files**:
- Create: `infra/dev/docker-compose.dev.yml`
- Create: `infra/dev/README.md`
- Modify: `package.json`（根，新增 `dev:db:*` 脚本）
- Create: `apps/server-main/.env.development.example`
- Modify: `.gitignore`（加 `apps/server-main/.env.development*`，保留 `.example`）

- [ ] **Step 1: 写 docker-compose**

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

- [ ] **Step 2: 根 package.json 脚本**

  ```json
  "dev:db:up": "docker compose -f infra/dev/docker-compose.dev.yml up -d",
  "dev:db:down": "docker compose -f infra/dev/docker-compose.dev.yml down",
  "dev:db:reset": "docker compose -f infra/dev/docker-compose.dev.yml down -v && pnpm dev:db:up",
  "dev:db:logs": "docker compose -f infra/dev/docker-compose.dev.yml logs -f postgres"
  ```

- [ ] **Step 3: .env.development.example**

  ```bash
  PORT=3200
  DATABASE_URL=postgresql://meshbot:meshbot@localhost:5432/meshbot_main
  JWT_SECRET=meshbot-main-dev-secret-change-in-prod
  JWT_EXPIRES=7d
  NODE_ENV=development
  ```

- [ ] **Step 4: infra/dev/README.md**

  写明：端口冲突时改 `5433:5432` + 同步 .env；reset 命令会清数据；`dev:db:logs` 排查健康检查。

- [ ] **Step 5: 冒烟**

  ```bash
  pnpm dev:db:up
  docker exec meshbot-dev-postgres pg_isready -U meshbot -d meshbot_main
  ```

**Acceptance**:
- `pnpm dev:db:up` 起容器 ≤ 10s
- 健康检查通过；`psql postgresql://meshbot:meshbot@localhost:5432/meshbot_main -c "SELECT 1"` 返回 1

---

### Task B2: server-main 接入 Postgres + TypeORM

**Files**:
- Modify: `apps/server-main/package.json`（依赖）
- Modify: `apps/server-main/src/app.module.ts`
- Create: `apps/server-main/src/data-source.cli.ts`
- Create: `apps/server-main/src/config/database.config.ts`

- [ ] **Step 1: 加依赖**

  ```bash
  pnpm --filter @meshbot/server-main add @nestjs/typeorm typeorm pg typeorm-naming-strategies @nestjs/config @nestjs/jwt @nestjs/passport passport passport-jwt bcrypt nanoid
  pnpm --filter @meshbot/server-main add -D @types/passport-jwt @types/bcrypt
  ```

  Common：加 `TxTypeOrmModule` 已经在 `libs/common` 提供，无需新依赖。

- [ ] **Step 2: TypeORM forRootAsync**

  `apps/server-main/src/app.module.ts`：

  ```ts
  import { ConfigModule, ConfigService } from "@nestjs/config";
  import { TypeOrmModule } from "@nestjs/typeorm";
  import { SnakeNamingStrategy } from "typeorm-naming-strategies";
  // ...

  @Module({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, envFilePath: [".env.development", ".env"] }),
      TypeOrmModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (cfg: ConfigService) => ({
          type: "postgres",
          url: cfg.getOrThrow<string>("DATABASE_URL"),
          autoLoadEntities: true,
          namingStrategy: new SnakeNamingStrategy(),
          synchronize: false,
          migrationsRun: false,
          logging: process.env.NODE_ENV !== "production" ? ["error", "warn"] : ["error"],
        }),
      }),
      I18nModule.forRoot({ ... 保留现状 ... }),
      AuthModule,                     // Task B5
      MainModule,                     // Task B4，import 自 @meshbot/main
    ],
    controllers: [HealthController],
  })
  export class AppModule {}
  ```

- [ ] **Step 3: data-source.cli.ts**

  `apps/server-main/src/data-source.cli.ts`（仅给 TypeORM CLI 用，不参与 runtime）：

  ```ts
  import "reflect-metadata";
  import { config } from "dotenv";
  import { DataSource } from "typeorm";
  import { SnakeNamingStrategy } from "typeorm-naming-strategies";

  config({ path: ".env.development" });

  export default new DataSource({
    type: "postgres",
    url: process.env.DATABASE_URL,
    entities: [__dirname + "/../../../libs/main/src/entities/*.entity.{ts,js}"],
    migrations: [__dirname + "/../migrations/*.{ts,js}"],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  });
  ```

- [ ] **Step 4: nest-cli.json assets**

  确保 `apps/server-main/nest-cli.json` 把 `i18n/**/*` 和 `migrations/**/*.js` 拷到 dist（参考 server-agent 配置）。

- [ ] **Step 5: typecheck**

  ```bash
  pnpm --filter @meshbot/server-main typecheck
  ```

**Acceptance**:
- typecheck 通过
- `pnpm dev:server-main` 在 Postgres 起来后可启动（autoload entities 暂空，不会报错）

---

### Task B3: libs/types-main schema 扩展

**Files**:
- Create: `libs/types-main/src/auth/register-user.schema.ts`
- Create: `libs/types-main/src/auth/login.schema.ts`
- Create: `libs/types-main/src/organization/create-org.schema.ts`
- Create: `libs/types-main/src/membership/invite-member.schema.ts`
- Create: `libs/types-main/src/membership/accept-invite.schema.ts`
- Create: `libs/types-main/src/agent/register-agent.schema.ts`
- Modify: `libs/types-main/src/index.ts`
- Delete or rename: `libs/types-main/src/sample/register-agent.schema.ts`（迁到 `agent/`）

- [ ] **Step 1: register-user schema**

  ```ts
  import { z } from "zod";
  export const RegisterUserSchema = z.object({
    email: z.string().email({ message: "validation.invalidEmail" })
                     .max(255, { message: "validation.stringTooLong" }),
    password: z.string()
              .min(8, { message: "validation.passwordTooShort" })
              .max(72, { message: "validation.stringTooLong" }),
    displayName: z.string()
                 .min(1, { message: "validation.required" })
                 .max(64, { message: "validation.stringTooLong" }),
  });
  export type RegisterUserInput = z.infer<typeof RegisterUserSchema>;
  ```

- [ ] **Step 2: login / create-org / invite-member / accept-invite / register-agent**

  逐个建。要点：
  - **所有 message 写 i18n key**（spec §1.2 表 + §4.B8）。
  - `slug`: `z.string().regex(/^[a-z][a-z0-9-]{2,62}$/, { message: "validation.invalidSlug" })`
  - `fingerprint`: `z.string().min(16).max(128)`
  - `deviceInfo`: `z.record(z.string(), z.unknown())`（jsonb）
  - `token`(accept-invite): `z.string().length(43)`（nanoid 32 字节 base64url）

- [ ] **Step 3: 重导出 + 删 sample**

  `libs/types-main/src/index.ts`：

  ```ts
  export * from "./auth/register-user.schema";
  export * from "./auth/login.schema";
  export * from "./organization/create-org.schema";
  export * from "./membership/invite-member.schema";
  export * from "./membership/accept-invite.schema";
  export * from "./agent/register-agent.schema";
  ```

  把 `src/sample/register-agent.schema.ts` 移动到 `src/agent/register-agent.schema.ts`（业务字段：`name`/`fingerprint`/`deviceInfo`）。

**Acceptance**:
- `pnpm --filter @meshbot/types-main build` 全绿
- `pnpm check:dead` 不报 orphan export

---

### Task B4: libs/main 业务模块（4 entity + 4 service + MainModule）

**Files**: 新建 lib `libs/main/`
- `libs/main/package.json` (`@meshbot/main`)
- `libs/main/tsconfig.json`
- `libs/main/src/index.ts`
- `libs/main/src/main.module.ts`
- `libs/main/src/entities/{app-user,organization,membership,agent-registration}.entity.ts`
- `libs/main/src/services/{user,organization,membership,agent-registration}.service.ts`
- `libs/main/src/dto/{register-user,login,create-org,invite-member,accept-invite,register-agent}.dto.ts`
- `libs/main/src/errors/main.error-codes.ts`
- Modify: `pnpm-workspace.yaml`（如未通配 `libs/*` 则加入）
- Modify: `tsconfig.json`（paths）/ `turbo.json`

- [ ] **Step 1: package.json / tsconfig**

  仿 `libs/agent/package.json`（同样的 peer deps：nestjs / typeorm / @meshbot/common / @meshbot/types-main）。

- [ ] **Step 2: 4 个 Entity**

  字段以 spec §2.4 为准。要点：

  - `AppUser` 表名注解显式 `@Entity("app_user")`（避免 SnakeNamingStrategy 把 `AppUser` 转成 `app_user_entity` 之类边角）。
  - 主键：`@PrimaryGeneratedColumn("uuid")`
  - 所有时间戳：`@CreateDateColumn({ type: "timestamptz" })` / `@UpdateDateColumn`
  - **不挂 `@ManyToOne` / `@JoinColumn`**（项目约定 logical FK，spec §"数据库规范"）
  - Membership 多列唯一索引用 `@Index(['organizationId', 'userId'], { unique: true, where: '"user_id" IS NOT NULL' })` 写部分唯一

- [ ] **Step 3: 4 个 Service（Entity 唯一归属）**

  | Service | InjectRepository |
  |---------|------------------|
  | `UserService` | `AppUser` |
  | `OrganizationService` | `Organization` |
  | `MembershipService` | `Membership` |
  | `AgentRegistrationService` | `AgentRegistration` |

  其他 Service 需要拿对方数据，**走方法调用而不是注入 Repository**（围栏 `check:repo`）。

  关键方法签名（注意命名 + 装饰器顺序，参考  的 `createFirstMemberInTx`）：

  ```ts
  // UserService
  registerUser(input: RegisterUserInput): Promise<AppUser>
  loginUser(input: LoginInput): Promise<AppUser>      // 校验密码
  findById(id: string): Promise<AppUser | null>

  // OrganizationService
  @WithLock("org:create:#{0.email}")           // 锁 owner email 防重复点
  @Transactional()
  async createOrgWithOwnerInTx(
    ownerUserId: string,
    input: CreateOrgInput,
  ): Promise<Organization>
  // → 插 Organization → 调 membershipService.createOwnerMembershipInTx()

  listUserOrgs(userId: string): Promise<Organization[]>

  // MembershipService
  @Transactional()
  createOwnerMembershipInTx(orgId: string, userId: string): Promise<Membership>

  @WithLock("invite:#{0}")
  @Transactional()
  async inviteMemberInTx(orgId: string, inviterId: string, email: string): Promise<{ token: string }>
  // → check inviter is owner → 检查重复 pending → nanoid(32) → 插 pending Membership

  @WithLock("invite:accept:#{0.token}")
  @Transactional()
  async acceptInviteInTx(input: AcceptInviteInput): Promise<{ orgId: string }>
  // → 找 invite by token → 验邮箱匹配 → upsert user → activate membership

  requireOwner(orgId: string, userId: string): Promise<void>   // 抛 AppError
  requireMember(orgId: string, userId: string): Promise<void>

  // AgentRegistrationService
  @WithLock("agent:fingerprint:#{1.fingerprint}")
  @Transactional()
  async registerAgentInTx(orgId: string, input: RegisterAgentInput): Promise<AgentRegistration>
  // → upsert by fingerprint（更新 lastSeenAt + deviceInfo）

  listOrgAgents(orgId: string): Promise<AgentRegistration[]>
  ```

  **私有 @Transactional 方法命名**: 严格 `*InTx`（`check:naming` 围栏）。锁必须包事务（`check:lock-tx`）。

- [ ] **Step 4: MainModule**

  ```ts
  @Module({
    imports: [
      TxTypeOrmModule.forFeature([
        AppUser, Organization, Membership, AgentRegistration,
      ]),
    ],
    providers: [
      UserService, OrganizationService, MembershipService, AgentRegistrationService,
    ],
    exports: [
      UserService, OrganizationService, MembershipService, AgentRegistrationService,
    ],
  })
  export class MainModule {}
  ```

- [ ] **Step 5: 错误码定义**

  `libs/main/src/errors/main.error-codes.ts`（参考  的 `defineErrorCode`，meshbot Phase 2 已抽好 AppError 基础设施则直接复用；否则简化用 `new BadRequestException({ key: "auth.invalidCredentials" })`，让 i18n filter 翻译）。

  覆盖：`auth.emailAlreadyExists` / `auth.invalidCredentials` / `org.slugAlreadyExists` / `org.notOrgOwner` / `org.notOrgMember` / `member.alreadyMember` / `member.inviteTokenInvalid` / `member.inviteEmailMismatch` / `agent.fingerprintConflict`。

- [ ] **Step 6: 单元测试**

  每个 Service 一份 `*.service.spec.ts`，用真 Postgres + 隔离 schema（参考 B7 测试策略，B7 写主基建，本步先 stub 1 个最小 spec 验证 module 起来）。

**Acceptance**:
- `pnpm --filter @meshbot/main build` 全绿
- `pnpm check:repo` / `pnpm check:tx` / `pnpm check:lock-tx` / `pnpm check:naming` 全绿
- 至少 1 个 stub spec 跑通（验证 MainModule 加载）

---

### Task B5: AuthModule + 4 个 Controller

**Files**:
- Create: `apps/server-main/src/auth/auth.module.ts`
- Create: `apps/server-main/src/auth/jwt.strategy.ts`
- Create: `apps/server-main/src/auth/jwt-auth.guard.ts`
- Create: `apps/server-main/src/auth/public.decorator.ts`
- Create: `apps/server-main/src/auth/current-user.decorator.ts`
- Create: `apps/server-main/src/rest/auth.controller.ts`
- Create: `apps/server-main/src/rest/organization.controller.ts`
- Create: `apps/server-main/src/rest/membership.controller.ts`
- Create: `apps/server-main/src/rest/agent.controller.ts`
- Modify: `apps/server-main/src/app.module.ts`（注册 AuthModule + MainModule + 全局 JwtAuthGuard）

- [ ] **Step 1: AuthModule 基建**

  - `JwtStrategy`：Passport strategy 名 `"jwt-main"`（与 server-agent 的 `"jwt"` 分隔）。从 `Authorization: Bearer <token>` 取；secret 从 `ConfigService.getOrThrow("JWT_SECRET")`；validate 返回 `{ userId, email }`。
  - `JwtAuthGuard extends AuthGuard("jwt-main")`：override `canActivate` 检 `@Public()` reflector → 跳过；其它走默认。
  - `@Public()` = `SetMetadata("isPublic", true)`。
  - `@CurrentUser()` = `createParamDecorator((_, ctx) => ctx.switchToHttp().getRequest().user)`。

  全局注册 `JwtAuthGuard`：`{ provide: APP_GUARD, useClass: JwtAuthGuard }`。

- [ ] **Step 2: AuthController**

  ```ts
  @Controller("auth")
  export class AuthController {
    constructor(private users: UserService, private jwt: JwtService) {}

    @Public()
    @Post("register")
    @ApiOperation({ summary: "注册新用户" })
    @ApiOkResponse({ schema: { example: { token: "...", expiresIn: "7d" } } })
    async register(@Body() dto: RegisterUserDto) {
      const user = await this.users.registerUser(dto);
      return this.signToken(user);
    }

    @Public()
    @Post("login")
    async login(@Body() dto: LoginDto) {
      const user = await this.users.loginUser(dto);
      return this.signToken(user);
    }

    private signToken(user: AppUser) {
      const token = this.jwt.sign({ userId: user.id, email: user.email });
      return { token, expiresIn: process.env.JWT_EXPIRES ?? "7d" };
    }
  }
  ```

  Controller 严格瘦身：业务在 service，controller 只做 DTO 接收 + 签 token + 返回。

- [ ] **Step 3: Organization / Membership / Agent Controller**

  按 spec §2.5 endpoint 表写。要点：

  - 用 `createI18nZodDto(<Schema>)` 派生 DTO（Phase 2 + A1 后已可生效）。
  - 用 `@CurrentUser() user: { userId: string; email: string }` 取登录态。
  - Owner-only：在 controller 入口调 `membershipService.requireOwner(orgId, user.userId)`（service 抛 i18n key 错误）。
  - 所有端点配 `@ApiOperation` / `@ApiOkResponse` / `@ApiBody`（围栏 `swagger-api-declaration`）。

  ```ts
  @Controller("orgs")
  export class OrganizationController {
    constructor(
      private orgs: OrganizationService,
      private members: MembershipService,
      private agents: AgentRegistrationService,
    ) {}

    @Post()
    create(@CurrentUser() u: CurrentUser, @Body() dto: CreateOrgDto) {
      return this.orgs.createOrgWithOwnerInTx(u.userId, dto);
    }

    @Get()
    list(@CurrentUser() u: CurrentUser) {
      return this.orgs.listUserOrgs(u.userId);
    }

    @Post(":id/members/invite")
    async invite(
      @CurrentUser() u: CurrentUser,
      @Param("id") orgId: string,
      @Body() dto: InviteMemberDto,
    ) {
      await this.members.requireOwner(orgId, u.userId);
      return this.members.inviteMemberInTx(orgId, u.userId, dto.email);
    }

    @Post(":id/agents")
    async registerAgent(
      @CurrentUser() u: CurrentUser,
      @Param("id") orgId: string,
      @Body() dto: RegisterAgentDto,
    ) {
      await this.members.requireMember(orgId, u.userId);
      return this.agents.registerAgentInTx(orgId, dto);
    }

    @Get(":id/agents")
    async listAgents(@CurrentUser() u: CurrentUser, @Param("id") orgId: string) {
      await this.members.requireMember(orgId, u.userId);
      return this.agents.listOrgAgents(orgId);
    }
  }
  ```

  `MembershipController`：仅 `@Public() @Post("accept-invite")`（其它已在 OrganizationController 下挂载）。

- [ ] **Step 4: AppModule 装配**

  ```ts
  imports: [ConfigModule, TypeOrmModule.forRootAsync(...), I18nModule.forRoot(...), AuthModule, MainModule]
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }]
  controllers: [HealthController, AuthController, OrganizationController, MembershipController]
  ```

- [ ] **Step 5: typecheck + 围栏**

  ```bash
  pnpm --filter @meshbot/server-main typecheck
  pnpm check
  ```

**Acceptance**:
- typecheck + check 全绿
- `pnpm dev:server-main` 启动后 `GET /api/health` 仍可用（无需 token，需要 `@Public()`）
- 任意 protected endpoint 无 token 返回 401

---

### Task B6: 首批迁移文件（InitialSchema）

**Files**:
- Create: `apps/server-main/migrations/<timestamp>-InitialSchema.ts`
- Modify: `apps/server-main/src/app.module.ts`（TypeOrmModule `migrationsRun: true`，dev 起动自动跑迁移；production 通过 CLI 跑）

- [ ] **Step 1: 跑生成（C2 先就位才能跑）**

  ```bash
  pnpm dev:db:up
  pnpm migration:generate:main -- --name InitialSchema
  ```

- [ ] **Step 2: 人工 review + 改造**

  TypeORM 默认生成的 migration **不带** `IF NOT EXISTS` / `CONCURRENTLY`，需要手工改：

  - `CREATE TABLE` → `CREATE TABLE IF NOT EXISTS`
  - `CREATE INDEX` → `CREATE INDEX CONCURRENTLY IF NOT EXISTS`（注意：CONCURRENTLY 不能在事务里跑，必须把 `up` 内 query 拆成多个 `queryRunner.query` 调用，或者迁移类设 `transaction = false`）
  - 显式添加 CHECK 约束（`role IN ('owner','member')` / `status IN ('pending','active')`）：TypeORM 6 用 `@Check` decorator on Entity，可由生成器写入
  - 显式添加部分唯一索引：`CREATE UNIQUE INDEX ... WHERE user_id IS NOT NULL`
  - 时间戳 `DEFAULT now()`（生成器一般已加，确认）
  - `down` 写 `DROP TABLE IF EXISTS ... CASCADE`

  注：若要使用 `@Check` decorator，需先在 Entity 加上 `@Check("role IN ('owner','member')")`（Step 3 回去补），然后 regenerate。

- [ ] **Step 3: 切到 migrationsRun:true（dev）**

  `app.module.ts` 改 `migrationsRun: true`，让本地启动自动跑。production 改回 false 由 CLI 控制。

  > 也可统一一直用 CLI 跑（`pnpm migration:run:main` after `dev:db:up`），更显式；选哪条由实施时决定。**推荐：dev 自动跑 + production CLI 跑**。

- [ ] **Step 4: 冒烟**

  ```bash
  pnpm dev:db:reset
  pnpm dev:server-main           # 启动期间日志应见 "InitialSchema executed"
  psql $DATABASE_URL -c "\dt"   # 应见 4 张表
  psql $DATABASE_URL -c "\d+ membership"  # 看 check 约束 + 部分唯一索引
  ```

**Acceptance**:
- `pnpm dev:db:reset && pnpm dev:server-main` 自动建好 4 张表
- check 约束、部分唯一索引、所有索引 (`organization_id` / `slug` / `email` / `fingerprint` / `invite_token`) 均存在

---

### Task B7: 测试套（单元 + e2e）

**Files**:
- Create: `apps/server-main/test/jest-e2e.json`
- Create: `apps/server-main/test/setup/test-db.ts`（隔离 schema 工具）
- Create: `apps/server-main/test/e2e/main-flow.spec.ts`
- Create: `libs/main/src/services/*.service.spec.ts`（4 个）
- Modify: `apps/server-main/package.json`（`test:e2e` 脚本）
- Modify: 根 `jest.config.ts`（含 server-main 单测）/ 根 `package.json`（`test:e2e` 聚合）

- [ ] **Step 1: 隔离 schema 测试工具**

  `apps/server-main/test/setup/test-db.ts`：

  ```ts
  import { randomBytes } from "node:crypto";
  import { DataSource } from "typeorm";

  /** 每个 test suite 一个随机 schema；跑迁移；afterAll DROP */
  export async function createTestDataSource() {
    const schema = `test_${randomBytes(4).toString("hex")}`;
    const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!;
    const ds = new DataSource({ /* 配置同 data-source.cli.ts，外加 schema */ });
    await ds.initialize();
    await ds.query(`CREATE SCHEMA "${schema}"`);
    await ds.query(`SET search_path TO "${schema}"`);
    await ds.runMigrations();
    return { ds, schema, async cleanup() { await ds.query(`DROP SCHEMA "${schema}" CASCADE`); await ds.destroy(); } };
  }
  ```

- [ ] **Step 2: 4 个 service 单测**

  覆盖（每个 service 3–5 个 case）：

  - UserService: `registerUser` 成功 / `registerUser` email 冲突抛 i18n 错误 / `loginUser` 密码错抛错 / `loginUser` 成功返回 user
  - OrganizationService: `createOrgWithOwnerInTx` 在事务内同时插 org + owner membership / slug 重复抛错 / `listUserOrgs` 只返当前 user 的 org
  - MembershipService: invite 创建 pending + token / 重复 pending invite 拒绝 / `acceptInvite` 一次性、第二次抛错 / `acceptInvite` 邮箱不匹配抛错 / `requireOwner` 非 owner 抛错
  - AgentRegistrationService: 第一次注册 / 同 fingerprint 第二次更新 lastSeenAt / 不同 org 同 fingerprint 行为（按 spec：fingerprint 全局 UNIQUE，跨 org 冲突 → 抛错或更新；本任务期间敲定，记录在 spec §6.2 Q7）

- [ ] **Step 3: e2e 全链路**

  `apps/server-main/test/e2e/main-flow.spec.ts`：

  ```ts
  // 1) POST /api/auth/register Alice → 拿 token_a
  // 2) POST /api/auth/login Alice → 拿 token_a2
  // 3) POST /api/orgs (token_a) { name, slug } → orgId
  // 4) GET  /api/orgs (token_a) → 含 orgId
  // 5) POST /api/orgs/:id/members/invite (token_a) { email: bob } → inviteToken
  // 6) POST /api/orgs/accept-invite (public) { token, password, displayName } → 200
  // 7) POST /api/auth/login Bob → token_b
  // 8) POST /api/orgs/:id/agents (token_b) { name, fingerprint, deviceInfo } → agent
  // 9) GET  /api/orgs/:id/agents (token_b) → 含 agent
  // 错误路径：non-member POST /agents → 403 / i18n 翻译断言
  ```

- [ ] **Step 4: package.json**

  ```json
  // apps/server-main/package.json
  "test": "jest --config ../../jest.config.ts --selectProjects @meshbot/main @meshbot/server-main",
  "test:e2e": "jest --config test/jest-e2e.json"
  ```

  根 `package.json`：

  ```json
  "test:e2e": "pnpm --filter @meshbot/server-main test:e2e"
  ```

- [ ] **Step 5: CI 友好**

  e2e 在缺 Postgres 时 skip（`beforeAll` 探测：`pg_isready` 失败 → `it.skip`），避免 contributor 不起 docker 就跑挂。

**Acceptance**:
- `pnpm test` 含 server-main 单测，全绿
- `pnpm test:e2e` 8 个 endpoint 全链路通过
- 中文 / 英文请求至少各 1 个错误路径断言翻译生效

---

### Task B8: i18n 资源扩充

**Files**:
- Create: `apps/server-main/i18n/zh/auth.json`、`org.json`、`member.json`、`agent.json`、`validation.json`
- Create: `apps/server-main/i18n/en/*.json`（镜像）

- [ ] **Step 1: key 清单**

  按 spec §4.B8 + B4 错误码列表汇总：

  ```
  auth.json:       invalidEmail / passwordTooShort / emailAlreadyExists / invalidCredentials
  org.json:        slugAlreadyExists / notOrgOwner / notOrgMember / orgNotFound / invalidSlug
  member.json:     alreadyMember / pendingInviteExists / inviteEmailMismatch /
                   inviteTokenInvalid / inviteTokenExpired
  agent.json:      fingerprintConflict / agentNotFound
  validation.json: required / stringTooShort / stringTooLong / invalidUuid /
                   invalidEmail / invalidUrl / invalidSlug
  ```

- [ ] **Step 2: 中英双语**

  zh + en 镜像，统一句式风格。所有 Zod schema message 用到的 key 必须有；service throw 的 key 必须有。

- [ ] **Step 3: 验证**

  ```bash
  pnpm sync:locales -- --check    # server-main namespace 也得在 sync 范围内（确认 scripts/sync-locales.ts 已扫到，必要时改）
  ```

**Acceptance**:
- `sync:locales --check` 通过
- e2e 中文 / 英文错误响应翻译正确

---

## Track C — 迁移规约落地

### Task C1: server-agent 脱 synchronize:true

**Files**:
- Create: `apps/server-agent/src/data-source.cli.ts`
- Create: `apps/server-agent/migrations/<ts>-InitialSchemaSqlite.ts`
- Modify: `apps/server-agent/src/app.module.ts`（`synchronize: false, migrationsRun: true`）
- Modify: `apps/server-agent/nest-cli.json`（assets 拷 migrations）

- [ ] **Step 1: dump 当前 schema**

  跑一个临时 server-agent，`synchronize: true` 把 `~/.meshbot/agent.db` 建好，然后 `sqlite3 agent.db .schema > /tmp/agent.schema.sql` 抄出来。

- [ ] **Step 2: 写 InitialSchemaSqlite.ts**

  TypeORM migration class 内 `queryRunner.query(...)` 把 DDL 串起来。SQLite 适配：

  - 用 `TEXT` 不用 `VARCHAR(n)`（SQLite 不强制长度）
  - 用 `INTEGER`/`TEXT` 替代 `BOOLEAN`/`UUID`（前者一般 entity 端是 `string` 已 ok）
  - 不用 `CONCURRENTLY`
  - 保留 `IF NOT EXISTS`
  - 时间戳 `DEFAULT CURRENT_TIMESTAMP`

- [ ] **Step 3: 切配置**

  `apps/server-agent/src/app.module.ts`：

  ```ts
  synchronize: false,
  migrationsRun: true,
  migrations: [__dirname + "/../migrations/*.{ts,js}"],
  ```

  保留 `prepareDatabase` WAL pragma 回调（Phase 1 工作不丢）。

- [ ] **Step 4: 冒烟（破坏性）**

  ⚠️ 此步会要求开发者删本地 `~/.meshbot/agent.db` 重建。在 README + PR 描述里大字标注。

  ```bash
  rm ~/.meshbot/agent.db
  pnpm dev:server-agent
  # 日志见 "InitialSchemaSqlite executed"
  sqlite3 ~/.meshbot/agent.db ".tables"  # 3 张表
  ```

  自动化测试（jest）：用临时 path `mkdtemp` + sqlite，断言迁移跑完后表存在。

**Acceptance**:
- 全新机器 `pnpm dev:server-agent` 自动建表
- 已有 db 的开发者按 README 说明删 db 重建后正常工作
- 单测覆盖迁移路径

---

### Task C2: migration 脚本统一（pnpm migration:* + archive）

**Files**:
- Modify: 根 `package.json`
- Create: `scripts/archive-migrations.ts`（移植  `archive-migrations` skill 对应实现，目标 dir 参数化）

- [ ] **Step 1: 根脚本**

  ```json
  "migration:generate:main": "typeorm-ts-node-commonjs migration:generate -d apps/server-main/src/data-source.cli.ts",
  "migration:run:main": "typeorm-ts-node-commonjs migration:run -d apps/server-main/src/data-source.cli.ts",
  "migration:revert:main": "typeorm-ts-node-commonjs migration:revert -d apps/server-main/src/data-source.cli.ts",
  "migration:show:main": "typeorm-ts-node-commonjs migration:show -d apps/server-main/src/data-source.cli.ts",
  "migration:generate:agent": "typeorm-ts-node-commonjs migration:generate -d apps/server-agent/src/data-source.cli.ts",
  "migration:run:agent": "typeorm-ts-node-commonjs migration:run -d apps/server-agent/src/data-source.cli.ts",
  "migration:revert:agent": "typeorm-ts-node-commonjs migration:revert -d apps/server-agent/src/data-source.cli.ts",
  "migration:show:agent": "typeorm-ts-node-commonjs migration:show -d apps/server-agent/src/data-source.cli.ts",
  "migration:archive:main": "tsx scripts/archive-migrations.ts apps/server-main",
  "migration:archive:agent": "tsx scripts/archive-migrations.ts apps/server-agent"
  ```

  加 dev dep：`typeorm` 已经在 server-main / server-agent 引入；根 `tsx` 已有。

- [ ] **Step 2: archive-migrations.ts**

  接收 app dir，把 `migrations/*.{ts,sql}` 移到 `migrations/archive/`，跳过已 archive 的（ 已有同名 skill，对照实现）。

- [ ] **Step 3: scripts/README.md 增条目**

  描述每个 `migration:*` 的作用 + 何时用。

**Acceptance**:
- `pnpm migration:show:main` 列出当前迁移
- `pnpm migration:generate:main -- --name Test` 生成空迁移 → `migration:revert:main` 撤销 → 干净退出
- `pnpm migration:archive:main` 把 migrations 文件搬到 archive

**依赖**: C2 是 B6 / C1 的工具前置。建议 C2 与 B2 并行，B6 / C1 之前完成。

---

## Phase 3 完工验收清单

执行完所有任务后，按以下顺序验证：

```bash
# 1. 静态围栏
pnpm typecheck
pnpm check                              # 5 围栏（tx / naming / lock-tx / repo / dead）
pnpm sync:locales -- --check            # 硬失败模式
pnpm sync:skills -- --check

# 2. 单元 + e2e
pnpm test
pnpm test:e2e

# 3. 端到端最小业务闭环
pnpm dev:db:up
pnpm dev:server-main &
# 8 个 endpoint：手工 curl 走一遍 spec §1.3
curl -X POST http://localhost:3200/api/auth/register -H 'content-type: application/json' \
     -d '{"email":"alice@test.io","password":"alicepass1","displayName":"Alice"}'
# ... 7 个其余端点

# 4. server-agent 脱 synchronize 验证
rm ~/.meshbot/agent.db
pnpm dev:server-agent
sqlite3 ~/.meshbot/agent.db ".tables"   # 应见 3 张表

# 5. i18n 翻译验证
curl -X POST http://localhost:3200/api/auth/register?lang=zh -d '{}' | jq '.errors'
# 期望：[{"path":"email","message":"必填字段"}, ...]
curl -X POST http://localhost:3200/api/auth/register?lang=en -d '{}' | jq '.errors'
# 期望：[{"path":"email","message":"Required field"}, ...]
```

**Phase 3 退出**：以上全绿 → 更新 `CLAUDE.md` 标记 Phase 3 ✅ 已完成，把 spec §1.4 提到的 Phase 4 backlog 抄到 CLAUDE.md。

---

## 风险与缓解（执行期监控）

| 风险 | 缓解 |
|------|------|
| `nestjs-zod` v4 API 变化（A1） | 优先按当前安装版本写；遇 breaking 看 release notes + 加 unit 覆盖 |
| Postgres 5432 端口冲突 | infra/dev/README 说明改 5433；env 同步 |
| TypeORM CLI 与 SnakeNamingStrategy 列名一致性 | 跑完迁移立刻 `\d+ <table>` 验证列名为 snake_case |
| CONCURRENTLY 索引迁移事务问题 | migration class 设 `transaction = false`，多 queryRunner.query 分发 |
| invite token 走响应 / 日志泄漏 | 测试用例覆盖；CHANGELOG 注明 dev-only |
| server-agent 既有 db 与新迁移冲突 | README 大字标注"删 db 重建"；PR 上提示 reviewer |
| 多租户隔离漏洞 | E2E 双 user 交叉访问对方 org 用例覆盖（B7 Step 3 错误路径） |

---

## 下一步

完成后进入 **Phase 4**（CI/CD + Docker 化 server-main + Redis + cli-agent 发布工具链 + 监控）。spec §6.3 已列衔接清单。
