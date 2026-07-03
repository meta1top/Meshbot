# 云端浏览器授权登录(Device Token)+ 配置云端化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本地登录改为"点击 → 浏览器云端授权",产出长期可吊销 device token;注册(含邮箱验证)、组织、模型配置、设备管理收敛到 web-main;组织级模型配置云端真源 + 本地只读缓存。

**Architecture:** server-main 新增 device / device_auth_request / email_verification / org_model_config 四张表与授权状态机,认证层扩展为双凭据(浏览器 JWT + Agent device token,以 `mbd_` 前缀区分);server-agent 把密码代理登录换成"start → 浏览器 → loopback 回调/粘贴码 → exchange"编排,并新增模型配置同步;web-main 从空壳补齐账号/授权/管理页面;web-agent 登录页改浏览器授权,组织管理与模型编辑收敛到云端。

**Tech Stack:** NestJS + TypeORM(Postgres / better-sqlite3)、Zod + nestjs-zod、Next.js + next-intl + react-query + jotai、socket.io。

**Spec:** `docs/superpowers/specs/2026-07-02-cloud-auth-device-token-design.md`

## Global Constraints

- 提交信息中文、conventional commits;每个 task 结束单独 commit。
- 每次 commit 前:`pnpm check`(静态围栏)必须全绿;涉及前端 `t()` 新 key 时,同 commit 内跑 `pnpm sync:locales -- --write` 并**手工填入 zh/en 文案**(pre-commit 强制 `--check`,空占位提交后要尽快补齐,禁止裸字符串)。
- 新 named export 必须同 commit 内有消费方(`check:dead` 围栏);schema/类型与首个消费者放同一个 task。
- 错误码:libs/main 段 2000-2999(下一可用 **2022**);server-agent 段 3000-3999(下一可用 **3015**);新增码必须同步 `apps/server-*/i18n/{zh,en}/*.json`。
- server-main DDL:纯 SQL 追加文件 `apps/server-main/migrations/<YYYYMMDDHHmm>-<summary>.sql`,幂等、snake_case、逻辑外键、雪花 `varchar(20)` 主键、文件不可变;服务不自动建表。
- server-agent SQLite:TypeORM 迁移 `apps/server-agent/src/migrations/<ts>-<Name>.ts`,`migrationsRun:true` 启动自动执行;SQLite 无 DROP COLUMN,down 保留列。
- 事务/锁:跨表写 `@Transactional()`(私有方法命名 `*InTx`/`*InDb`/`persist*`),锁包事务,禁反向。
- Entity 唯一归属 Service;Controller/Gateway 禁注 Repository。
- Device token 格式:`mbd_` + 32 字节 base64url(43 字符);库中只存 SHA-256 hex。
- code_verifier:32 字节 base64url;code_challenge = SHA-256(verifier) hex。user_code:`randomBytes(9).toString("base64url")`(12 字符)。
- 授权请求 TTL 10 分钟,exchange 尝试上限 5 次;验证码 6 位数字、10 分钟有效、60 秒重发冷却、错 5 次作废。
- 公开方法中文 JSDoc;禁止 `if` 前一行注释。

## 任务总览(依赖顺序)

| Phase | Task | 内容 |
|---|---|---|
| 1 云端后端 | 1 | DDL 迁移 + 四个 Entity + MainModule 注册 |
| | 2 | SecretCryptoService(AES-256-GCM)+ MainModule 密钥装配 |
| | 3 | DeviceService(签发/校验/吊销/切组织) |
| | 4 | DeviceAuthService(start/approve/exchange 状态机) |
| | 5 | EmailVerificationService + UserService 邮箱验证改造 + EmailSender 扩展 |
| | 6 | OrgModelConfigService(组织级模型配置 CRUD + Agent 下发) |
| | 7 | 共享 schema + REST controllers(device-auth / devices / auth 改造 / model-config) |
| | 8 | 双凭据认证(HTTP Guard + ws/im 握手) |
| | 9 | server-main e2e(授权全流程 / 邮箱验证 / 模型配置权限) |
| 2 本地后端 | 10 | SQLite 迁移(device_token / model_configs.source)+ Entity 更新 |
| | 11 | DeviceAuthorizeService + AuthController 改造(start/callback/complete/poll) |
| | 12 | cloud-client / im-relay 凭据切换 + 401 重授权事件 |
| | 13 | ModelConfigSyncService + 本地模型配置只读化 |
| | 14 | 裁剪 cloud-org 代理(保留 orgs 列表/切换/成员) |
| 3 web-main | 15 | 前端基建(依赖 / apiClient / providers / AuthGuard) |
| | 16 | 登录 / 注册(含邮箱验证)页 |
| | 17 | /authorize 设备授权确认页(含无组织引导) |
| | 18 | 管理页:组织成员邀请 / 设备 / 模型配置 |
| 4 web-agent | 19 | 登录页改浏览器授权 + 删注册页 + AuthGuard 分流调整 |
| | 20 | 组织页删除、模型配置只读化、workspace-rail 调整 |
| | 21 | desktop:外链开系统浏览器 |
| 5 收尾 | 22 | 文档(CLAUDE.md 表归属 / nacos-example)+ 全量回归 + boot 验证 + 手动冒烟 |

---

## Phase 1:云端后端(server-main + libs/main)

### Task 1: DDL 迁移 + 新 Entity + MainModule 注册

**Files:**
- Create: `apps/server-main/migrations/202607031000-device-auth-email-verify-model-config.sql`
- Create: `libs/main/src/entities/device.entity.ts`
- Create: `libs/main/src/entities/device-auth-request.entity.ts`
- Create: `libs/main/src/entities/email-verification.entity.ts`
- Create: `libs/main/src/entities/org-model-config.entity.ts`
- Modify: `libs/main/src/entities/app-user.entity.ts`(加 `emailVerifiedAt`)
- Modify: `libs/main/src/main.module.ts`(TxTypeOrmModule.forFeature 追加 4 个 Entity)
- Modify: `libs/main/src/index.ts`(导出新 Entity)
- Modify: `apps/server-main/test/setup/test-db.ts`(entities 数组追加)
- Test: `apps/server-main/test/e2e/device-ddl.spec.ts`

**Interfaces:**
- Produces: Entity 类 `Device` / `DeviceAuthRequest` / `EmailVerification` / `OrgModelConfig`,后续 Task 3-6 的 Service 注入使用;`AppUser.emailVerifiedAt: Date | null`。

- [ ] **Step 1: 写失败测试(表存在性)**

`apps/server-main/test/e2e/device-ddl.spec.ts`:

```ts
import { createTestDb, isPostgresReachable, type TestDbContext } from "../setup/test-db";
import { DataSource } from "typeorm";

describe("device/auth DDL", () => {
  let ctx: TestDbContext;
  let ds: DataSource;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) return;
    ctx = await createTestDb();
    ds = new DataSource(ctx.dataSourceOptions);
    await ds.initialize();
  });
  afterAll(async () => {
    await ds?.destroy();
    await ctx?.cleanup();
  });

  it("新表与新列存在", async () => {
    if (!ds) return;
    const tables = await ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`,
    );
    const names = tables.map((t: { table_name: string }) => t.table_name);
    expect(names).toEqual(
      expect.arrayContaining(["device", "device_auth_request", "email_verification", "org_model_config"]),
    );
    const col = await ds.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'app_user' AND column_name = 'email_verified_at'`,
    );
    expect(col).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest apps/server-main/test/e2e/device-ddl.spec.ts`
Expected: FAIL(`toEqual arrayContaining` 不满足——新表不存在)。Postgres 不可达时 suite skip,需本地起 Postgres 再执行。

- [ ] **Step 3: 写 DDL 文件**

`apps/server-main/migrations/202607031000-device-auth-email-verify-model-config.sql`:

```sql
-- 设备授权登录(device token)+ 注册邮箱验证 + 组织级模型配置(子项目 A)。
-- DBA 手动执行;幂等;snake_case;逻辑外键;id 雪花 varchar(20)。

-- 已授权设备:token 只存 SHA-256 hex,吊销置 revoked_at。
CREATE TABLE IF NOT EXISTS "device" (
  "id"            varchar(20)  NOT NULL,
  "user_id"       varchar(20)  NOT NULL,
  "org_id"        varchar(20),
  "name"          varchar(128) NOT NULL,
  "platform"      varchar(32)  NOT NULL DEFAULT '',
  "token_hash"    varchar(64)  NOT NULL,
  "last_seen_at"  timestamptz,
  "revoked_at"    timestamptz,
  "created_at"    timestamptz  NOT NULL DEFAULT now(),
  "updated_at"    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_device" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_device_token_hash" ON "device" ("token_hash");
CREATE INDEX IF NOT EXISTS "ix_device_user" ON "device" ("user_id");

-- 授权流程中间态:pending → approved → consumed;过期由 expires_at 判定。
CREATE TABLE IF NOT EXISTS "device_auth_request" (
  "id"               varchar(20)  NOT NULL,
  "status"           varchar(16)  NOT NULL DEFAULT 'pending',
  "device_name"      varchar(128) NOT NULL,
  "platform"         varchar(32)  NOT NULL DEFAULT '',
  "code_challenge"   varchar(64)  NOT NULL,
  "redirect_uri"     varchar(255),
  "user_code"        varchar(32),
  "user_id"          varchar(20),
  "attempts"         int          NOT NULL DEFAULT 0,
  "expires_at"       timestamptz  NOT NULL,
  "created_at"       timestamptz  NOT NULL DEFAULT now(),
  "updated_at"       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_device_auth_request" PRIMARY KEY ("id")
);

-- 注册邮箱验证码。
CREATE TABLE IF NOT EXISTS "email_verification" (
  "id"          varchar(20)  NOT NULL,
  "email"       varchar(255) NOT NULL,
  "code"        varchar(8)   NOT NULL,
  "attempts"    int          NOT NULL DEFAULT 0,
  "expires_at"  timestamptz  NOT NULL,
  "created_at"  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_email_verification" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ix_email_verification_email" ON "email_verification" ("email");

-- app_user 邮箱验证时间;存量用户回填为已验证。
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamptz;
UPDATE "app_user" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;

-- 组织级模型配置;api_key 应用层 AES-256-GCM 加密。
CREATE TABLE IF NOT EXISTS "org_model_config" (
  "id"              varchar(20)  NOT NULL,
  "org_id"          varchar(20)  NOT NULL,
  "name"            varchar(64)  NOT NULL,
  "provider_type"   varchar(32)  NOT NULL,
  "model"           varchar(128) NOT NULL,
  "api_key_enc"     text         NOT NULL,
  "base_url"        varchar(255) NOT NULL DEFAULT '',
  "context_window"  int          NOT NULL DEFAULT 128000,
  "enabled"         boolean      NOT NULL DEFAULT true,
  "created_at"      timestamptz  NOT NULL DEFAULT now(),
  "updated_at"      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_org_model_config" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ix_org_model_config_org" ON "org_model_config" ("org_id");
```

- [ ] **Step 4: 写四个 Entity + AppUser 加列**

`libs/main/src/entities/device.entity.ts`:

```ts
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index, UpdateDateColumn } from "typeorm";

/** 已授权设备(device token 载体,token 只存哈希) */
@Entity("device")
@Index("uq_device_token_hash", ["tokenHash"], { unique: true })
@Index("ix_device_user", ["userId"])
export class Device extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 }) userId!: string;
  @Column({ type: "varchar", length: 20, nullable: true }) orgId!: string | null;
  @Column({ type: "varchar", length: 128 }) name!: string;
  @Column({ type: "varchar", length: 32, default: "" }) platform!: string;
  @Column({ type: "varchar", length: 64 }) tokenHash!: string;
  @Column({ type: "timestamptz", nullable: true }) lastSeenAt!: Date | null;
  @Column({ type: "timestamptz", nullable: true }) revokedAt!: Date | null;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
```

`libs/main/src/entities/device-auth-request.entity.ts`:

```ts
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, UpdateDateColumn } from "typeorm";

export type DeviceAuthStatus = "pending" | "approved" | "consumed";

/** 设备授权请求中间态(TTL 10 分钟) */
@Entity("device_auth_request")
export class DeviceAuthRequest extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 16, default: "pending" }) status!: DeviceAuthStatus;
  @Column({ type: "varchar", length: 128 }) deviceName!: string;
  @Column({ type: "varchar", length: 32, default: "" }) platform!: string;
  @Column({ type: "varchar", length: 64 }) codeChallenge!: string;
  @Column({ type: "varchar", length: 255, nullable: true }) redirectUri!: string | null;
  @Column({ type: "varchar", length: 32, nullable: true }) userCode!: string | null;
  @Column({ type: "varchar", length: 20, nullable: true }) userId!: string | null;
  @Column({ type: "int", default: 0 }) attempts!: number;
  @Column({ type: "timestamptz" }) expiresAt!: Date;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
```

`libs/main/src/entities/email-verification.entity.ts`:

```ts
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 注册邮箱验证码(6 位数字,10 分钟有效) */
@Entity("email_verification")
@Index("ix_email_verification_email", ["email"])
export class EmailVerification extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 255 }) email!: string;
  @Column({ type: "varchar", length: 8 }) code!: string;
  @Column({ type: "int", default: 0 }) attempts!: number;
  @Column({ type: "timestamptz" }) expiresAt!: Date;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
}
```

`libs/main/src/entities/org-model-config.entity.ts`:

```ts
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index, UpdateDateColumn } from "typeorm";

/** 组织级模型配置(api_key 应用层加密存 apiKeyEnc) */
@Entity("org_model_config")
@Index("ix_org_model_config_org", ["orgId"])
export class OrgModelConfig extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 }) orgId!: string;
  @Column({ type: "varchar", length: 64 }) name!: string;
  @Column({ type: "varchar", length: 32 }) providerType!: string;
  @Column({ type: "varchar", length: 128 }) model!: string;
  @Column({ type: "text" }) apiKeyEnc!: string;
  @Column({ type: "varchar", length: 255, default: "" }) baseUrl!: string;
  @Column({ type: "int", default: 128_000 }) contextWindow!: number;
  @Column({ type: "boolean", default: true }) enabled!: boolean;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
```

`app-user.entity.ts` 在 `activeOrgId` 之后追加:

```ts
  @Column({ type: "timestamptz", nullable: true }) emailVerifiedAt!: Date | null;
```

- [ ] **Step 5: 注册进 MainModule 与 test-db**

`libs/main/src/main.module.ts` 的 `TxTypeOrmModule.forFeature([...])` 数组追加 `Device, DeviceAuthRequest, EmailVerification, OrgModelConfig`;`libs/main/src/index.ts` 导出四个 Entity;`apps/server-main/test/setup/test-db.ts` 的 entities 数组同步追加(相对路径 import,与现有条目一致)。

- [ ] **Step 6: 跑测试通过 + 围栏 + 提交**

Run: `pnpm jest apps/server-main/test/e2e/device-ddl.spec.ts` → PASS;`pnpm check` → 全绿(新 Entity 暂无归属 Service,check:repo 只查注入冲突,不报;Task 3-6 补齐归属)。

```bash
git add apps/server-main/migrations/ libs/main/src/entities/ libs/main/src/main.module.ts libs/main/src/index.ts apps/server-main/test/
git commit -m "feat(server-main): 设备授权/邮箱验证/组织模型配置 DDL 与 Entity"
```

---

### Task 2: SecretCryptoService(AES-256-GCM)

**Files:**
- Create: `libs/main/src/services/secret-crypto.service.ts`
- Modify: `libs/main/src/main.module.ts`(forRoot 增加 security 参数 + provider)
- Modify: `libs/main/src/tokens.ts`(新增 `SECURITY_CONFIG` token)
- Modify: `apps/server-main/src/config/app-config.schema.ts`(新增 `security.encryptionKey`)
- Modify: `apps/server-main/src/app.module.ts`(把 `config.security` 传给 `MainModule.forRoot`)
- Modify: `apps/server-main/src/main.ts`(生产环境 dev 密钥 fail-fast)
- Modify: `apps/server-main/nacos-example.yml`(补 `security.encryption-key` 样例)
- Test: `libs/main/src/services/secret-crypto.service.spec.ts`

**Interfaces:**
- Produces: `SecretCryptoService.encrypt(plain: string): string` / `decrypt(sealed: string): string`(密文格式 `iv.tag.data` 三段 base64url);`MainModule.forRoot(invitation, security: { encryptionKey: string })`;`SECURITY_CONFIG` DI token。
- Consumes: 无(独立工具 Service)。

- [ ] **Step 1: 写失败测试**

`libs/main/src/services/secret-crypto.service.spec.ts`:

```ts
import { SecretCryptoService } from "./secret-crypto.service";

describe("SecretCryptoService", () => {
  const svc = new SecretCryptoService({ encryptionKey: "0123456789abcdef0123456789abcdef" });

  it("加解密往返", () => {
    const sealed = svc.encrypt("sk-test-123");
    expect(sealed).not.toContain("sk-test-123");
    expect(svc.decrypt(sealed)).toBe("sk-test-123");
  });

  it("同明文两次加密产生不同密文(随机 IV)", () => {
    expect(svc.encrypt("a")).not.toBe(svc.encrypt("a"));
  });

  it("密文被篡改时抛错", () => {
    const sealed = svc.encrypt("secret");
    const parts = sealed.split(".");
    parts[2] = Buffer.from("tampered!!").toString("base64url");
    expect(() => svc.decrypt(parts.join("."))).toThrow();
  });

  it("密钥长度不足 32 字符时构造抛错", () => {
    expect(() => new SecretCryptoService({ encryptionKey: "short" })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest libs/main/src/services/secret-crypto.service.spec.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`libs/main/src/services/secret-crypto.service.ts`:

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { SECURITY_CONFIG } from "../tokens";

export interface SecurityConfig {
  encryptionKey: string;
}

/** 对称加密工具:AES-256-GCM,密文 `iv.tag.data` 三段 base64url */
@Injectable()
export class SecretCryptoService {
  private readonly key: Buffer;

  constructor(@Optional() @Inject(SECURITY_CONFIG) config?: SecurityConfig) {
    const raw = config?.encryptionKey ?? "";
    if (raw.length < 32) throw new Error("security.encryptionKey 至少 32 字符");
    this.key = createHash("sha256").update(raw).digest();
  }

  /** 加密明文,返回可入库字符串 */
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64url")}.${tag.toString("base64url")}.${data.toString("base64url")}`;
  }

  /** 解密入库密文;篡改/密钥不符抛错 */
  decrypt(sealed: string): string {
    const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }
}
```

`libs/main/src/tokens.ts` 追加:

```ts
export const SECURITY_CONFIG = Symbol("SECURITY_CONFIG");
```

`main.module.ts` 的 `forRoot` 签名改为 `forRoot(invitation: AppConfigInvitation, security: SecurityConfig)`,providers 追加 `SecretCryptoService` 与 `{ provide: SECURITY_CONFIG, useValue: security }`,exports 追加 `SecretCryptoService`。

`app-config.schema.ts` 追加:

```ts
export const SecurityConfigSchema = z.object({
  encryptionKey: z.string().min(32, "security.encryptionKey 至少 32 字符")
    .default("dev-encryption-key-do-not-use-prod!"),
});
// AppConfigSchema 内:
security: SecurityConfigSchema.default({}),
```

`app.module.ts`:`MainModule.forRoot(config.invitation, config.security)`。`main.ts` 仿 jwt dev-secret 检查:生产环境 `security.encryptionKey` 等于内置 dev 值时抛错拒启。`nacos-example.yml` 补:

```yaml
security:
  encryption-key: "replace-with-32+char-random-string"
```

同步修改所有调用 `MainModule.forRoot(...)` 的 e2e 装配(`apps/server-main/test/e2e/*.spec.ts`),传 `{ encryptionKey: "e2e-encryption-key-0123456789abcdef" }`。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm jest libs/main/src/services/secret-crypto.service.spec.ts` → PASS;`pnpm typecheck`(确认 forRoot 签名改动全部调用点已更新);`pnpm check`。

```bash
git add libs/main/src apps/server-main/src apps/server-main/nacos-example.yml apps/server-main/test
git commit -m "feat(server-main): AES-256-GCM SecretCryptoService 与加密密钥配置"
```

---

### Task 3: DeviceService

**Files:**
- Create: `libs/main/src/services/device.service.ts`
- Modify: `libs/main/src/errors/main.error-codes.ts`(2027 DEVICE_TOKEN_INVALID / 2028 DEVICE_NOT_FOUND)
- Modify: `apps/server-main/i18n/{zh,en}/auth.json` + `device.json`(新建)
- Modify: `libs/main/src/main.module.ts` / `libs/main/src/index.ts`(注册导出)
- Test: `libs/main/src/services/device.service.spec.ts`

**Interfaces:**
- Produces:
  - `DeviceService.issueDevice(input: { userId; orgId: string | null; name: string; platform: string }): Promise<{ device: Device; token: string }>`(token 形如 `mbd_<base64url>`,仅此一次返回明文)
  - `DeviceService.verifyToken(token: string): Promise<Device>`(未找到/已吊销抛 `DEVICE_TOKEN_INVALID`,顺带低频更新 lastSeenAt:距上次 >5 分钟才写库)
  - `DeviceService.listByUser(userId: string): Promise<Device[]>`
  - `DeviceService.revoke(userId: string, deviceId: string): Promise<void>`(非本人设备抛 `DEVICE_NOT_FOUND`)
  - `DeviceService.updateOrg(deviceId: string, orgId: string): Promise<void>`
  - `DEVICE_TOKEN_PREFIX = "mbd_"`(导出常量,Task 8 Guard 用)
- Consumes: `Device` Entity(Task 1)。

- [ ] **Step 1: 写失败测试**

`libs/main/src/services/device.service.spec.ts`(mock repo 模式,参考 `invitation.service.spec` 风格;repo 用内存数组桩):

```ts
import { AppError } from "@meshbot/common";
import type { Device } from "../entities/device.entity";
import { DEVICE_TOKEN_PREFIX, DeviceService, hashDeviceToken } from "./device.service";

function makeRepo(rows: Device[]) {
  return {
    create: jest.fn((v: Partial<Device>) => ({ ...v }) as Device),
    save: jest.fn(async (v: Device) => {
      v.id ??= `d${rows.length + 1}`;
      rows.push(v);
      return v;
    }),
    findOne: jest.fn(async ({ where }: { where: Partial<Device> }) =>
      rows.find((r) =>
        Object.entries(where).every(([k, val]) => (r as never as Record<string, unknown>)[k] === val),
      ) ?? null),
    find: jest.fn(async ({ where }: { where: Partial<Device> }) => rows.filter((r) => r.userId === where.userId)),
    update: jest.fn(async (cond: Partial<Device>, patch: Partial<Device>) => {
      for (const r of rows) if (r.id === cond.id) Object.assign(r, patch);
    }),
  };
}

describe("DeviceService", () => {
  it("issueDevice 返回带前缀明文 token,库里只存哈希", async () => {
    const rows: Device[] = [];
    const svc = new DeviceService(makeRepo(rows) as never);
    const { device, token } = await svc.issueDevice({ userId: "u1", orgId: "o1", name: "Mac", platform: "darwin" });
    expect(token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    expect(device.tokenHash).toBe(hashDeviceToken(token));
    expect(rows[0].tokenHash).not.toContain(token.slice(4, 20));
  });

  it("verifyToken 命中返回设备,吊销后抛 DEVICE_TOKEN_INVALID", async () => {
    const rows: Device[] = [];
    const svc = new DeviceService(makeRepo(rows) as never);
    const { token } = await svc.issueDevice({ userId: "u1", orgId: "o1", name: "Mac", platform: "darwin" });
    const dev = await svc.verifyToken(token);
    expect(dev.userId).toBe("u1");
    rows[0].revokedAt = new Date();
    await expect(svc.verifyToken(token)).rejects.toMatchObject({ name: "AppError" });
  });

  it("verifyToken 未知 token 抛错", async () => {
    const svc = new DeviceService(makeRepo([]) as never);
    await expect(svc.verifyToken("mbd_unknown")).rejects.toBeInstanceOf(AppError);
  });

  it("revoke 只能吊销本人设备", async () => {
    const rows: Device[] = [];
    const svc = new DeviceService(makeRepo(rows) as never);
    await svc.issueDevice({ userId: "u1", orgId: null, name: "Mac", platform: "darwin" });
    await expect(svc.revoke("u2", rows[0].id)).rejects.toBeInstanceOf(AppError);
    await svc.revoke("u1", rows[0].id);
    expect(rows[0].revokedAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest libs/main/src/services/device.service.spec.ts` → FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`libs/main/src/services/device.service.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { Device } from "../entities/device.entity";
import { MainErrorCode } from "../errors/main.error-codes";

export const DEVICE_TOKEN_PREFIX = "mbd_";
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/** 计算 device token 的入库哈希 */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 设备(device token)归属 Service:签发、校验、吊销、切组织 */
@Injectable()
export class DeviceService {
  constructor(@InjectRepository(Device) private readonly deviceRepo: Repository<Device>) {}

  /** 签发新设备与 token;明文 token 仅此一次返回 */
  async issueDevice(input: {
    userId: string; orgId: string | null; name: string; platform: string;
  }): Promise<{ device: Device; token: string }> {
    const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const device = await this.deviceRepo.save(
      this.deviceRepo.create({ ...input, tokenHash: hashDeviceToken(token), lastSeenAt: new Date() }),
    );
    return { device, token };
  }

  /** 校验 token,返回设备;未知/已吊销抛 DEVICE_TOKEN_INVALID;低频回写 lastSeenAt */
  async verifyToken(token: string): Promise<Device> {
    const device = await this.deviceRepo.findOne({ where: { tokenHash: hashDeviceToken(token) } });
    if (!device || device.revokedAt) throw new AppError(MainErrorCode.DEVICE_TOKEN_INVALID);
    const stale = !device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS;
    if (stale) await this.deviceRepo.update({ id: device.id }, { lastSeenAt: new Date() });
    return device;
  }

  /** 列出用户全部设备(含已吊销,前端区分展示) */
  async listByUser(userId: string): Promise<Device[]> {
    return this.deviceRepo.find({ where: { userId } });
  }

  /** 吊销本人设备;非本人抛 DEVICE_NOT_FOUND */
  async revoke(userId: string, deviceId: string): Promise<void> {
    const device = await this.deviceRepo.findOne({ where: { id: deviceId } });
    if (!device || device.userId !== userId) throw new AppError(MainErrorCode.DEVICE_NOT_FOUND);
    if (!device.revokedAt) await this.deviceRepo.update({ id: deviceId }, { revokedAt: new Date() });
  }

  /** 设备切换当前激活组织 */
  async updateOrg(deviceId: string, orgId: string): Promise<void> {
    await this.deviceRepo.update({ id: deviceId }, { orgId });
  }
}
```

`main.error-codes.ts` 追加:

```ts
DEVICE_TOKEN_INVALID: { code: 2027, message: "auth.deviceTokenInvalid", httpStatus: 401 },
DEVICE_NOT_FOUND: { code: 2028, message: "device.notFound", httpStatus: 404 },
```

(2022-2026 留给 Task 4/5 的授权与验证码错误,本 task 先占 2027/2028,check:error-code 的 GAP 规则若要求连续,则 Task 3-5 的错误码在**本 task 一次性全部加齐**:2022 AUTH_EMAIL_NOT_VERIFIED / 2023 AUTH_VERIFICATION_INVALID / 2024 AUTH_VERIFICATION_COOLDOWN / 2025 DEVICE_AUTH_REQUEST_INVALID / 2026 DEVICE_AUTH_EXPIRED / 2027 / 2028,i18n 文案同步补 zh/en。)

i18n:`apps/server-main/i18n/zh/auth.json` 补 `deviceTokenInvalid: "设备凭据无效或已被吊销"`、`emailNotVerified: "邮箱未验证"`、`verificationInvalid: "验证码错误或已失效"`、`verificationCooldown: "发送太频繁,请稍后再试"`;新建 `apps/server-main/i18n/zh/device.json`:`{"notFound": "设备不存在", "authRequestInvalid": "授权请求无效", "authRequestExpired": "授权请求已过期"}`;en 对应翻译。

`main.module.ts` providers/exports 追加 `DeviceService`;`index.ts` 导出 `DeviceService, DEVICE_TOKEN_PREFIX, hashDeviceToken`。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm jest libs/main/src/services/device.service.spec.ts` → PASS;`pnpm check`。

```bash
git add libs/main/src apps/server-main/i18n
git commit -m "feat(server-main): DeviceService 设备凭据签发/校验/吊销 + 新错误码"
```

---

### Task 4: DeviceAuthService(授权状态机)

**Files:**
- Create: `libs/main/src/services/device-auth.service.ts`
- Modify: `libs/main/src/main.module.ts` / `index.ts`
- Test: `libs/main/src/services/device-auth.service.spec.ts`

**Interfaces:**
- Produces:
  - `start(input: { deviceName; platform; codeChallenge; redirectUri: string | null }): Promise<DeviceAuthRequest>`(status=pending,expiresAt=now+10min)
  - `getForAuthorize(requestId: string): Promise<{ id; deviceName; platform; status }>`(过期/不存在抛 `DEVICE_AUTH_REQUEST_INVALID`/`DEVICE_AUTH_EXPIRED`)
  - `approve(requestId: string, userId: string): Promise<{ userCode: string; redirectUri: string | null }>`(pending→approved,生成 userCode;非 pending 抛 invalid)
  - `exchange(input: { requestId; userCode; codeVerifier }): Promise<{ userId: string }>`(approved→consumed;校验 userCode、challenge=sha256(verifier)、TTL、attempts≤5;verifier 不匹配直接置 consumed 作废)
- Consumes: `DeviceAuthRequest` Entity(Task 1)。设备签发由 controller 编排(exchange 返回 userId 后调 `DeviceService.issueDevice`),保持单一归属。

- [ ] **Step 1: 写失败测试**

`libs/main/src/services/device-auth.service.spec.ts`(repo 桩同 Task 3 风格):

```ts
import { createHash, randomBytes } from "node:crypto";
import type { DeviceAuthRequest } from "../entities/device-auth-request.entity";
import { DeviceAuthService } from "./device-auth.service";

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("hex");

function makeRepo(rows: DeviceAuthRequest[]) {
  return {
    create: jest.fn((v: Partial<DeviceAuthRequest>) => ({ attempts: 0, ...v }) as DeviceAuthRequest),
    save: jest.fn(async (v: DeviceAuthRequest) => { v.id ??= `r${rows.length + 1}`; rows.push(v); return v; }),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
    update: jest.fn(async (cond: { id: string }, patch: Partial<DeviceAuthRequest>) => {
      for (const r of rows) if (r.id === cond.id) Object.assign(r, patch);
    }),
  };
}

async function startApproved(rows: DeviceAuthRequest[]) {
  const svc = new DeviceAuthService(makeRepo(rows) as never);
  const req = await svc.start({ deviceName: "Mac", platform: "darwin", codeChallenge: challenge, redirectUri: "http://127.0.0.1:7727/api/auth/callback" });
  const { userCode } = await svc.approve(req.id, "u1");
  return { svc, req, userCode };
}

describe("DeviceAuthService", () => {
  it("start→approve→exchange 全流程返回批准人", async () => {
    const rows: DeviceAuthRequest[] = [];
    const { svc, req, userCode } = await startApproved(rows);
    const result = await svc.exchange({ requestId: req.id, userCode, codeVerifier: verifier });
    expect(result.userId).toBe("u1");
    expect(rows[0].status).toBe("consumed");
  });

  it("exchange 二次兑换抛 invalid(consumed 不可重复)", async () => {
    const rows: DeviceAuthRequest[] = [];
    const { svc, req, userCode } = await startApproved(rows);
    await svc.exchange({ requestId: req.id, userCode, codeVerifier: verifier });
    await expect(svc.exchange({ requestId: req.id, userCode, codeVerifier: verifier }))
      .rejects.toMatchObject({ name: "AppError" });
  });

  it("verifier 不匹配立即作废整个请求", async () => {
    const rows: DeviceAuthRequest[] = [];
    const { svc, req, userCode } = await startApproved(rows);
    await expect(svc.exchange({ requestId: req.id, userCode, codeVerifier: "wrong-verifier" })).rejects.toBeTruthy();
    expect(rows[0].status).toBe("consumed");
  });

  it("userCode 错误累计 5 次后作废", async () => {
    const rows: DeviceAuthRequest[] = [];
    const { svc, req } = await startApproved(rows);
    for (let i = 0; i < 5; i++) {
      await expect(svc.exchange({ requestId: req.id, userCode: "bad", codeVerifier: verifier })).rejects.toBeTruthy();
    }
    expect(rows[0].status).toBe("consumed");
  });

  it("过期请求 getForAuthorize 抛 DEVICE_AUTH_EXPIRED", async () => {
    const rows: DeviceAuthRequest[] = [];
    const { svc, req } = await startApproved(rows);
    rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(svc.getForAuthorize(req.id)).rejects.toMatchObject({ name: "AppError" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest libs/main/src/services/device-auth.service.spec.ts` → FAIL。

- [ ] **Step 3: 实现**

`libs/main/src/services/device-auth.service.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { DeviceAuthRequest } from "../entities/device-auth-request.entity";
import { MainErrorCode } from "../errors/main.error-codes";

const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_EXCHANGE_ATTEMPTS = 5;

/** 设备授权请求状态机:pending → approved → consumed */
@Injectable()
export class DeviceAuthService {
  constructor(
    @InjectRepository(DeviceAuthRequest) private readonly requestRepo: Repository<DeviceAuthRequest>,
  ) {}

  /** 本地 Agent 发起授权请求(公开端点调用,无身份) */
  async start(input: {
    deviceName: string; platform: string; codeChallenge: string; redirectUri: string | null;
  }): Promise<DeviceAuthRequest> {
    return this.requestRepo.save(this.requestRepo.create({
      ...input, status: "pending", expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    }));
  }

  /** 授权确认页读取请求信息(已登录用户) */
  async getForAuthorize(requestId: string) {
    const req = await this.findValid(requestId);
    return { id: req.id, deviceName: req.deviceName, platform: req.platform, status: req.status };
  }

  /** 用户批准授权:生成一次性 userCode */
  async approve(requestId: string, userId: string): Promise<{ userCode: string; redirectUri: string | null }> {
    const req = await this.findValid(requestId);
    if (req.status !== "pending") throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    const userCode = randomBytes(9).toString("base64url");
    await this.requestRepo.update({ id: req.id }, { status: "approved", userId, userCode });
    return { userCode, redirectUri: req.redirectUri };
  }

  /** 本地 Agent 兑换:校验 userCode + code_verifier,成功置 consumed 并返回批准人 */
  async exchange(input: { requestId: string; userCode: string; codeVerifier: string }): Promise<{ userId: string }> {
    const req = await this.findValid(input.requestId);
    if (req.status !== "approved" || !req.userId || !req.userCode) {
      throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    }
    const challenge = createHash("sha256").update(input.codeVerifier).digest("hex");
    if (challenge !== req.codeChallenge) {
      await this.requestRepo.update({ id: req.id }, { status: "consumed" });
      throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    }
    if (input.userCode !== req.userCode) {
      const attempts = req.attempts + 1;
      const patch: Partial<DeviceAuthRequest> = { attempts };
      if (attempts >= MAX_EXCHANGE_ATTEMPTS) patch.status = "consumed";
      await this.requestRepo.update({ id: req.id }, patch);
      throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    }
    await this.requestRepo.update({ id: req.id }, { status: "consumed" });
    return { userId: req.userId };
  }

  private async findValid(requestId: string): Promise<DeviceAuthRequest> {
    const req = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!req) throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    if (req.expiresAt.getTime() < Date.now()) throw new AppError(MainErrorCode.DEVICE_AUTH_EXPIRED);
    return req;
  }
}
```

`main.module.ts` providers/exports 追加 `DeviceAuthService`;`index.ts` 导出。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm jest libs/main/src/services/device-auth.service.spec.ts` → PASS;`pnpm check`。

```bash
git add libs/main/src
git commit -m "feat(server-main): DeviceAuthService 授权请求状态机(start/approve/exchange)"
```

---

### Task 5: EmailVerificationService + 注册邮箱验证改造

**Files:**
- Create: `libs/main/src/services/email-verification.service.ts`
- Modify: `libs/main/src/services/user.service.ts`(login 校验 emailVerifiedAt;新增 `markEmailVerified`)
- Modify: `libs/main/src/services/invitation.service.ts`(`persistAccept` 内把用户视同已验证)
- Modify: `apps/server-main/src/email/email-sender.ts`(接口加 `sendVerificationCode`)
- Modify: `libs/main/src/main.module.ts` / `index.ts`
- Test: `libs/main/src/services/email-verification.service.spec.ts`、修改 `user.service` 相关既有测试

**Interfaces:**
- Produces:
  - `EmailVerificationService.issueCode(email: string): Promise<string>`(返回 6 位数字码;60 秒内重复调用抛 `AUTH_VERIFICATION_COOLDOWN`;发信由 controller 编排)
  - `EmailVerificationService.verifyCode(email: string, code: string): Promise<void>`(过期/错误抛 `AUTH_VERIFICATION_INVALID`;错 5 次作废该码)
  - `UserService.markEmailVerified(userId: string): Promise<void>`
  - `UserService.loginUser` 追加:`emailVerifiedAt` 为空抛 `AUTH_EMAIL_NOT_VERIFIED`
  - `EmailSender` 接口追加 `sendVerificationCode(to: string, code: string): Promise<void>`(DirectMail 与 Log 两个实现都补;纯文本模板:主题「meshbot 邮箱验证码」,正文含 6 位码与 10 分钟时效)
- Consumes: `EmailVerification` Entity、`MainErrorCode`(Task 3 已加齐 2022-2024)。

- [ ] **Step 1: 写失败测试**

`libs/main/src/services/email-verification.service.spec.ts`:

```ts
import type { EmailVerification } from "../entities/email-verification.entity";
import { EmailVerificationService } from "./email-verification.service";

function makeRepo(rows: EmailVerification[]) {
  return {
    create: jest.fn((v: Partial<EmailVerification>) => ({ attempts: 0, ...v }) as EmailVerification),
    save: jest.fn(async (v: EmailVerification) => { v.id ??= `e${rows.length + 1}`; rows.push(v); return v; }),
    findOne: jest.fn(async ({ where, order }: never) => {
      const list = rows.filter((r) => r.email === (where as { email: string }).email);
      return list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
    }),
    update: jest.fn(async (cond: { id: string }, patch: Partial<EmailVerification>) => {
      for (const r of rows) if (r.id === cond.id) Object.assign(r, patch);
    }),
    delete: jest.fn(async (cond: { email: string }) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].email === cond.email) rows.splice(i, 1);
    }),
  };
}

describe("EmailVerificationService", () => {
  it("issueCode 生成 6 位数字码并落库", async () => {
    const rows: EmailVerification[] = [];
    const svc = new EmailVerificationService(makeRepo(rows) as never);
    const code = await svc.issueCode("a@x.io");
    expect(code).toMatch(/^\d{6}$/);
    expect(rows[0].email).toBe("a@x.io");
  });

  it("60 秒内重发抛冷却错误", async () => {
    const rows: EmailVerification[] = [];
    const svc = new EmailVerificationService(makeRepo(rows) as never);
    await svc.issueCode("a@x.io");
    await expect(svc.issueCode("a@x.io")).rejects.toMatchObject({ name: "AppError" });
  });

  it("verifyCode 正确码通过并清理记录", async () => {
    const rows: EmailVerification[] = [];
    const svc = new EmailVerificationService(makeRepo(rows) as never);
    const code = await svc.issueCode("a@x.io");
    await expect(svc.verifyCode("a@x.io", code)).resolves.toBeUndefined();
    expect(rows).toHaveLength(0);
  });

  it("错误码累计 5 次后即使输对也失效", async () => {
    const rows: EmailVerification[] = [];
    const svc = new EmailVerificationService(makeRepo(rows) as never);
    const code = await svc.issueCode("a@x.io");
    for (let i = 0; i < 5; i++) await expect(svc.verifyCode("a@x.io", "000000")).rejects.toBeTruthy();
    await expect(svc.verifyCode("a@x.io", code)).rejects.toBeTruthy();
  });

  it("过期码验证失败", async () => {
    const rows: EmailVerification[] = [];
    const svc = new EmailVerificationService(makeRepo(rows) as never);
    const code = await svc.issueCode("a@x.io");
    rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(svc.verifyCode("a@x.io", code)).rejects.toBeTruthy();
  });
});
```

补充 `user.service` 用例(在既有 `user.service.spec.ts` 或新建):`loginUser` 对 `emailVerifiedAt: null` 的用户抛 `AUTH_EMAIL_NOT_VERIFIED`;`markEmailVerified` 调 `update({id},{emailVerifiedAt: Date}) `。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest libs/main/src/services/email-verification.service.spec.ts` → FAIL。

- [ ] **Step 3: 实现**

`libs/main/src/services/email-verification.service.ts`:

```ts
import { randomInt } from "node:crypto";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { EmailVerification } from "../entities/email-verification.entity";
import { MainErrorCode } from "../errors/main.error-codes";

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

/** 注册邮箱验证码:签发(带冷却)与校验(带尝试上限) */
@Injectable()
export class EmailVerificationService {
  constructor(
    @InjectRepository(EmailVerification) private readonly verifyRepo: Repository<EmailVerification>,
  ) {}

  /** 签发 6 位验证码;60 秒冷却内重复签发抛错 */
  async issueCode(email: string): Promise<string> {
    const latest = await this.latest(email);
    if (latest && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new AppError(MainErrorCode.AUTH_VERIFICATION_COOLDOWN);
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.verifyRepo.save(this.verifyRepo.create({
      email, code, expiresAt: new Date(Date.now() + CODE_TTL_MS), createdAt: new Date(),
    }));
    return code;
  }

  /** 校验验证码;通过后删除该邮箱全部记录 */
  async verifyCode(email: string, code: string): Promise<void> {
    const latest = await this.latest(email);
    const expired = !latest || latest.expiresAt.getTime() < Date.now();
    if (expired || latest.attempts >= MAX_ATTEMPTS) throw new AppError(MainErrorCode.AUTH_VERIFICATION_INVALID);
    if (latest.code !== code) {
      await this.verifyRepo.update({ id: latest.id }, { attempts: latest.attempts + 1 });
      throw new AppError(MainErrorCode.AUTH_VERIFICATION_INVALID);
    }
    await this.verifyRepo.delete({ email });
  }

  private latest(email: string): Promise<EmailVerification | null> {
    return this.verifyRepo.findOne({ where: { email }, order: { createdAt: "DESC" } });
  }
}
```

`user.service.ts`:

```ts
async loginUser(input: LoginInput): Promise<AppUser> {
  const user = await this.userRepo.findOne({ where: { email: input.email } });
  if (!user) throw new AppError(MainErrorCode.AUTH_INVALID_CREDENTIALS);
  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) throw new AppError(MainErrorCode.AUTH_INVALID_CREDENTIALS);
  if (!user.emailVerifiedAt) throw new AppError(MainErrorCode.AUTH_EMAIL_NOT_VERIFIED);
  return user;
}

/** 标记邮箱已验证 */
async markEmailVerified(userId: string): Promise<void> {
  await this.userRepo.update({ id: userId }, { emailVerifiedAt: new Date() });
}
```

`invitation.service.ts` 的 `persistAccept` 在写 membership 后追加(邀请邮件即邮箱所有权证明):

```ts
await appUserRepo.update({ id: userId, emailVerifiedAt: IsNull() }, { emailVerifiedAt: new Date() });
```

`email-sender.ts`:接口追加 `sendVerificationCode(to, code)`;`DirectMailEmailSender` 实现(主题 `meshbot 邮箱验证码`,正文 `你的验证码是 ${code},10 分钟内有效。若非本人操作请忽略。`);`LogEmailSender` 打日志。既有 `CaptureEmailSender`(e2e 替身)同步实现并记录 `lastVerification`。

`main.module.ts` providers/exports 追加 `EmailVerificationService`;`index.ts` 导出。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm jest libs/main/src/services/email-verification.service.spec.ts libs/main/src/services/user.service.spec.ts apps/server-main/test/e2e/auth-flow.e2e.spec.ts`(auth-flow 里 register→login 需先补验证步骤,若失败按新流程更新该 e2e:register 后从 CaptureEmailSender 取码 → verify → login)→ PASS;`pnpm check`。

```bash
git add libs/main/src apps/server-main/src/email apps/server-main/test
git commit -m "feat(server-main): 注册邮箱验证(验证码签发/校验/登录拦截/邀请视同已验证)"
```

---

### Task 6: OrgModelConfigService

**Files:**
- Create: `libs/main/src/services/org-model-config.service.ts`
- Modify: `libs/main/src/main.module.ts` / `index.ts`
- Test: `libs/main/src/services/org-model-config.service.spec.ts`

**Interfaces:**
- Produces:
  - `listForAdmin(orgId): Promise<OrgModelConfigView[]>`(`apiKeyMasked`:只留末 4 位,如 `****ab12`)
  - `create(orgId, input: OrgModelConfigInput): Promise<OrgModelConfigView>`(apiKey 加密入库)
  - `update(orgId, id, input: Partial<OrgModelConfigInput>): Promise<OrgModelConfigView>`(apiKey 传空/缺省=不改)
  - `remove(orgId, id): Promise<void>`
  - `listForAgent(orgId): Promise<AgentModelConfig[]>`(解密后的完整配置,仅 enabled;shape:`{ id; providerType; name; model; apiKey; baseUrl; contextWindow; enabled }`,与本地 ModelConfig 对齐)
  - 类型 `OrgModelConfigInput` / `AgentModelConfig` / `OrgModelConfigView`(Task 7 放进 `libs/types`,本 task 先在 service 文件内定义并导出,Task 7 迁移)
- Consumes: `OrgModelConfig` Entity、`SecretCryptoService`(Task 2)。跨组织越权在 controller 层用 `assertOwner`/`assertMember` 处理,service 内所有查询都带 `orgId` 条件。

- [ ] **Step 1: 写失败测试**

`libs/main/src/services/org-model-config.service.spec.ts`:

```ts
import { SecretCryptoService } from "./secret-crypto.service";
import { OrgModelConfigService } from "./org-model-config.service";
import type { OrgModelConfig } from "../entities/org-model-config.entity";

const crypto = new SecretCryptoService({ encryptionKey: "0123456789abcdef0123456789abcdef" });

function makeRepo(rows: OrgModelConfig[]) {
  return {
    create: jest.fn((v: Partial<OrgModelConfig>) => ({ enabled: true, baseUrl: "", contextWindow: 128000, ...v }) as OrgModelConfig),
    save: jest.fn(async (v: OrgModelConfig) => { v.id ??= `m${rows.length + 1}`; if (!rows.includes(v)) rows.push(v); return v; }),
    find: jest.fn(async ({ where }: never) => rows.filter((r) => r.orgId === (where as { orgId: string }).orgId)),
    findOne: jest.fn(async ({ where }: never) => {
      const w = where as { id: string; orgId: string };
      return rows.find((r) => r.id === w.id && r.orgId === w.orgId) ?? null;
    }),
    delete: jest.fn(async (cond: { id: string }) => {
      const i = rows.findIndex((r) => r.id === cond.id);
      if (i >= 0) rows.splice(i, 1);
    }),
  };
}

describe("OrgModelConfigService", () => {
  const input = { name: "默认", providerType: "anthropic", model: "claude-sonnet-5", apiKey: "sk-abcd1234", baseUrl: "", contextWindow: 200000, enabled: true };

  it("create 加密入库,listForAdmin 打码,listForAgent 解密", async () => {
    const rows: OrgModelConfig[] = [];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    await svc.create("o1", input);
    expect(rows[0].apiKeyEnc).not.toContain("sk-abcd1234");
    const admin = await svc.listForAdmin("o1");
    expect(admin[0].apiKeyMasked).toBe("****1234");
    const agent = await svc.listForAgent("o1");
    expect(agent[0].apiKey).toBe("sk-abcd1234");
  });

  it("update 不传 apiKey 时保留旧密钥", async () => {
    const rows: OrgModelConfig[] = [];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    const created = await svc.create("o1", input);
    await svc.update("o1", created.id, { name: "改名" });
    const agent = await svc.listForAgent("o1");
    expect(agent[0].apiKey).toBe("sk-abcd1234");
    expect(agent[0].name).toBe("改名");
  });

  it("listForAgent 过滤 enabled=false", async () => {
    const rows: OrgModelConfig[] = [];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    const created = await svc.create("o1", input);
    await svc.update("o1", created.id, { enabled: false });
    expect(await svc.listForAgent("o1")).toHaveLength(0);
  });

  it("跨组织 update/remove 抛 DEVICE_NOT_FOUND 级别的未找到错误", async () => {
    const rows: OrgModelConfig[] = [];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    const created = await svc.create("o1", input);
    await expect(svc.update("o2", created.id, { name: "x" })).rejects.toMatchObject({ name: "AppError" });
    await expect(svc.remove("o2", created.id)).rejects.toMatchObject({ name: "AppError" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest libs/main/src/services/org-model-config.service.spec.ts` → FAIL。

- [ ] **Step 3: 实现**

`libs/main/src/services/org-model-config.service.ts`:

```ts
import { AppError, CommonErrorCode } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { OrgModelConfig } from "../entities/org-model-config.entity";
import { SecretCryptoService } from "./secret-crypto.service";

export interface OrgModelConfigInput {
  name: string; providerType: string; model: string;
  apiKey?: string; baseUrl?: string; contextWindow?: number; enabled?: boolean;
}
export interface OrgModelConfigView {
  id: string; orgId: string; name: string; providerType: string; model: string;
  apiKeyMasked: string; baseUrl: string; contextWindow: number; enabled: boolean;
  createdAt: Date; updatedAt: Date;
}
export interface AgentModelConfig {
  id: string; providerType: string; name: string; model: string;
  apiKey: string; baseUrl: string; contextWindow: number; enabled: boolean;
}

/** 组织级模型配置归属 Service;写侧仅 owner(controller 断言),apiKey 加密存储 */
@Injectable()
export class OrgModelConfigService {
  constructor(
    @InjectRepository(OrgModelConfig) private readonly configRepo: Repository<OrgModelConfig>,
    private readonly crypto: SecretCryptoService,
  ) {}

  /** 管理端列表(apiKey 打码) */
  async listForAdmin(orgId: string): Promise<OrgModelConfigView[]> {
    const rows = await this.configRepo.find({ where: { orgId } });
    return rows.map((r) => this.toView(r));
  }

  /** 新建配置 */
  async create(orgId: string, input: OrgModelConfigInput): Promise<OrgModelConfigView> {
    if (!input.apiKey) throw new AppError(CommonErrorCode.VALIDATION_FAILED);
    const row = await this.configRepo.save(this.configRepo.create({
      orgId, name: input.name, providerType: input.providerType, model: input.model,
      apiKeyEnc: this.crypto.encrypt(input.apiKey), baseUrl: input.baseUrl ?? "",
      contextWindow: input.contextWindow ?? 128_000, enabled: input.enabled ?? true,
    }));
    return this.toView(row);
  }

  /** 更新配置;apiKey 缺省表示不换 */
  async update(orgId: string, id: string, input: Partial<OrgModelConfigInput>): Promise<OrgModelConfigView> {
    const row = await this.findOwned(orgId, id);
    if (input.name !== undefined) row.name = input.name;
    if (input.providerType !== undefined) row.providerType = input.providerType;
    if (input.model !== undefined) row.model = input.model;
    if (input.baseUrl !== undefined) row.baseUrl = input.baseUrl;
    if (input.contextWindow !== undefined) row.contextWindow = input.contextWindow;
    if (input.enabled !== undefined) row.enabled = input.enabled;
    if (input.apiKey) row.apiKeyEnc = this.crypto.encrypt(input.apiKey);
    return this.toView(await this.configRepo.save(row));
  }

  /** 删除配置 */
  async remove(orgId: string, id: string): Promise<void> {
    await this.findOwned(orgId, id);
    await this.configRepo.delete({ id });
  }

  /** Agent 下发:解密、仅 enabled */
  async listForAgent(orgId: string): Promise<AgentModelConfig[]> {
    const rows = await this.configRepo.find({ where: { orgId } });
    return rows.filter((r) => r.enabled).map((r) => ({
      id: r.id, providerType: r.providerType, name: r.name, model: r.model,
      apiKey: this.crypto.decrypt(r.apiKeyEnc), baseUrl: r.baseUrl,
      contextWindow: r.contextWindow, enabled: r.enabled,
    }));
  }

  private async findOwned(orgId: string, id: string): Promise<OrgModelConfig> {
    const row = await this.configRepo.findOne({ where: { id, orgId } });
    if (!row) throw new AppError(CommonErrorCode.NOT_FOUND);
    return row;
  }

  private toView(r: OrgModelConfig): OrgModelConfigView {
    const tail = (() => {
      try { return this.crypto.decrypt(r.apiKeyEnc).slice(-4); } catch { return "????"; }
    })();
    return {
      id: r.id, orgId: r.orgId, name: r.name, providerType: r.providerType, model: r.model,
      apiKeyMasked: `****${tail}`, baseUrl: r.baseUrl, contextWindow: r.contextWindow,
      enabled: r.enabled, createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }
}
```

`main.module.ts` providers/exports 追加 `OrgModelConfigService`;`index.ts` 导出 service 与三个类型。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm jest libs/main/src/services/org-model-config.service.spec.ts` → PASS;`pnpm check`。

```bash
git add libs/main/src
git commit -m "feat(server-main): OrgModelConfigService 组织级模型配置(加密存储/打码/Agent 下发)"
```

---

### Task 7: 共享 schema + REST controllers

**Files:**
- Create: `libs/types/src/device-auth/device-auth.schema.ts`(跨域:本地轨也消费)
- Modify: `libs/types/src/index.ts`(具名导出)
- Create: `libs/types-main/src/auth/verify-email.schema.ts`
- Create: `libs/types-main/src/model-config/org-model-config.schema.ts`
- Modify: `libs/types-main/src/index.ts`
- Modify: `libs/main/src/dto/index.ts`(新 DTO)
- Create: `apps/server-main/src/rest/device-auth.controller.ts`
- Create: `apps/server-main/src/rest/device.controller.ts`
- Create: `apps/server-main/src/rest/org-model-config.controller.ts`
- Modify: `apps/server-main/src/rest/auth.controller.ts`(register 发码 / verify-email / resend-code / login)
- Modify: `apps/server-main/src/app.module.ts`(注册新 controller)
- Test: `apps/server-main/test/device-auth-controller.routes.spec.ts`(路由级,mock service)

**Interfaces:**
- Produces(REST,全部经全局 envelope):
  - `POST /api/device-auth/start` `@Public`,body `DeviceAuthStartDto{deviceName,platform,codeChallenge,redirectUri?}` → `{ requestId, verifyUrl }`(verifyUrl = `${config.webMainBase}/authorize?request=<id>`)
  - `GET /api/device-auth/requests/:id`(JWT)→ `{ id, deviceName, platform, status }`
  - `POST /api/device-auth/approve`(JWT),body `{ requestId }` → `{ userCode, redirectUri }`(**编排**:`deviceAuth.approve` 之后不发设备,发设备在 exchange)
  - `POST /api/device-auth/exchange` `@Public`,body `{ requestId, userCode, codeVerifier, deviceName?, platform? }` → `{ deviceToken, user: {id,email,displayName}, orgId }`(编排:`deviceAuth.exchange` → 取 user(含 activeOrgId)→ `deviceService.issueDevice({userId, orgId: user.activeOrgId, name: 请求里的 deviceName, platform})`)
  - `GET /api/devices`(JWT)→ `DeviceView[]{id,name,platform,lastSeenAt,revokedAt,createdAt,current:false}`
  - `DELETE /api/devices/:id`(JWT)→ `{ ok: true }`
  - `POST /api/devices/switch-org`(**device token**,Task 8 生效),body `{ orgId }` → `{ ok: true }`(assertMember + `deviceService.updateOrg` + `userService.setActiveOrg`)
  - `GET /api/agent/model-configs`(**device token**)→ `AgentModelConfig[]`(orgId 取自 device)
  - `GET/POST /api/orgs/:id/model-configs`、`PATCH/DELETE /api/orgs/:id/model-configs/:configId`(JWT + `assertOwner`)
  - `POST /api/auth/register` 改:创建用户后 `emailVerification.issueCode` + `emailSender.sendVerificationCode`,**不再 signResponse**,返回 `{ needVerify: true }`
  - `POST /api/auth/verify-email` `@Public` `@Throttle 10/60s`,body `{ email, code }` → 校验 → `markEmailVerified` → `signResponse(user)`(验证即登录)
  - `POST /api/auth/resend-code` `@Public` `@Throttle 3/60s`,body `{ email }` → `{ ok: true }`(用户不存在也静默 ok,防枚举)
- Zod schema(`libs/types/src/device-auth/device-auth.schema.ts`):

```ts
import { z } from "zod";

export const DeviceAuthStartSchema = z.object({
  deviceName: z.string().min(1, { message: "validation.required" }).max(128, { message: "validation.stringTooLong" }),
  platform: z.string().max(32, { message: "validation.stringTooLong" }).default(""),
  codeChallenge: z.string().length(64, { message: "validation.invalidFormat" }),
  redirectUri: z.string().url({ message: "validation.invalidFormat" }).max(255).optional(),
});
export type DeviceAuthStartInput = z.infer<typeof DeviceAuthStartSchema>;

export const DeviceAuthApproveSchema = z.object({ requestId: z.string().min(1) });
export type DeviceAuthApproveInput = z.infer<typeof DeviceAuthApproveSchema>;

export const DeviceAuthExchangeSchema = z.object({
  requestId: z.string().min(1),
  userCode: z.string().min(1).max(32),
  codeVerifier: z.string().min(16).max(128),
});
export type DeviceAuthExchangeInput = z.infer<typeof DeviceAuthExchangeSchema>;

export const DeviceSwitchOrgSchema = z.object({ orgId: z.string().min(1) });
export type DeviceSwitchOrgInput = z.infer<typeof DeviceSwitchOrgSchema>;

export interface DeviceAuthStartResult { requestId: string; verifyUrl: string }
export interface DeviceAuthExchangeResult {
  deviceToken: string;
  user: { id: string; email: string; displayName: string };
  orgId: string | null;
}
export interface DeviceView {
  id: string; name: string; platform: string;
  lastSeenAt: string | null; revokedAt: string | null; createdAt: string;
}
```

- `libs/types-main` 两个 schema:`VerifyEmailSchema{email,code(6位)}`、`ResendCodeSchema{email}`、`OrgModelConfigCreateSchema{name,providerType,model,apiKey,baseUrl?,contextWindow?,enabled?}`、`OrgModelConfigUpdateSchema = CreateSchema.partial()`(message 全用 `validation.*` i18n key)。
- Consumes: Task 3-6 全部 Service + `EMAIL_SENDER` + `APP_CONFIG.webMainBase`。

- [ ] **Step 1: 写失败路由测试**

`apps/server-main/test/device-auth-controller.routes.spec.ts`(参考 `org-controller.routes.spec.ts` 的 mock service 装配):对 start/approve/exchange 各写一条 happy-path(service 全 jest.fn mock,断言编排调用顺序与响应字段),对 exchange 断言其内部先 `deviceAuth.exchange` 再 `users.findById` 再 `devices.issueDevice`。

- [ ] **Step 2: 跑测试确认失败** → FAIL(controller 不存在)。

- [ ] **Step 3: 实现三个新 controller + auth.controller 改造**

`device-auth.controller.ts` 核心:

```ts
@Controller("device-auth")
export class DeviceAuthController {
  constructor(
    private readonly deviceAuth: DeviceAuthService,
    private readonly devices: DeviceService,
    private readonly users: UserService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public() @Post("start") @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200)
  async start(@Body() dto: DeviceAuthStartDto): Promise<DeviceAuthStartResult> {
    const req = await this.deviceAuth.start({
      deviceName: dto.deviceName, platform: dto.platform ?? "",
      codeChallenge: dto.codeChallenge, redirectUri: dto.redirectUri ?? null,
    });
    return { requestId: req.id, verifyUrl: `${this.config.webMainBase}/authorize?request=${req.id}` };
  }

  @Get("requests/:id")
  getRequest(@Param("id") id: string) {
    return this.deviceAuth.getForAuthorize(id);
  }

  @Post("approve") @HttpCode(200)
  approve(@CurrentUser() u: JwtMainPayload, @Body() dto: DeviceAuthApproveDto) {
    return this.deviceAuth.approve(dto.requestId, u.userId);
  }

  @Public() @Post("exchange") @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200)
  async exchange(@Body() dto: DeviceAuthExchangeDto): Promise<DeviceAuthExchangeResult> {
    const { userId } = await this.deviceAuth.exchange(dto);
    const user = await this.users.findById(userId);
    if (!user) throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    const request = await this.deviceAuth.getForAuthorize(dto.requestId).catch(() => null);
    const { token } = await this.devices.issueDevice({
      userId, orgId: user.activeOrgId,
      name: request?.deviceName ?? "unknown", platform: request?.platform ?? "",
    });
    return { deviceToken: token, user: { id: user.id, email: user.email, displayName: user.displayName }, orgId: user.activeOrgId };
  }
}
```

(注:`getForAuthorize` 对 consumed 状态不抛错——`findValid` 只查过期;exchange 后再取 deviceName 合法。)

`device.controller.ts`:`GET /devices`(map 成 `DeviceView`,Date→ISO 字符串)、`DELETE /devices/:id`、`POST /devices/switch-org`(`@CurrentUser()` 拿 Task 8 双凭据 payload,`payload.deviceId` 存在才允许,否则 403;`memberships.assertMember(dto.orgId, u.userId)` → `devices.updateOrg` → `users.setActiveOrg`)。本 task 先写 HTTP 形状,device token 识别 Task 8 落地(在此之前该端点用 JWT 调用会因缺 deviceId 走 403 分支,测试覆盖)。

`org-model-config.controller.ts`:5 个端点全部先 `await this.orgs.assertOwner(orgId, u.userId)` 再委派 service;`GET /api/agent/model-configs` 放同文件 `@Controller("agent")` 或独立 `agent-config.controller.ts`(推荐独立),从 `@CurrentUser()` 取 `orgId`(device token 请求时即 device.orgId),无 org 抛 `ORG_NOT_FOUND`。

`auth.controller.ts`:register 移除 signResponse 改发码;新增 `verifyEmail` / `resendCode`(编排 `EmailVerificationService` + `UserService` + `EMAIL_SENDER`,resend 对未知邮箱静默 `{ok:true}`);DTO 加 `VerifyEmailDto` / `ResendCodeDto`。

`app.module.ts` controllers 数组追加三个新 controller。i18n 若新增 key 同步 `apps/server-main/i18n`。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm jest apps/server-main/test/device-auth-controller.routes.spec.ts` → PASS;既有 `auth-flow` e2e 已在 Task 5 更新;`pnpm check`(check:dead:新 schema 已被 DTO/controller 消费)。

```bash
git add libs/types libs/types-main libs/main/src/dto apps/server-main/src apps/server-main/test
git commit -m "feat(server-main): 设备授权/设备管理/模型配置 REST 与共享 schema,注册改验证码流程"
```

---

### Task 8: 双凭据认证(HTTP Guard + ws/im)

**Files:**
- Modify: `apps/server-main/src/auth/jwt-auth.guard.ts`(device token 分支)
- Modify: `apps/server-main/src/auth/current-user.decorator.ts`(payload 类型加 `deviceId?`)
- Modify: `apps/server-main/src/auth/jwt.strategy.ts`(`JwtMainPayload` 加可选 `deviceId`)
- Modify: `libs/common/src/ws/ws-jwt.middleware.ts`(支持 async verifier)
- Modify: `apps/server-main/src/ws/im.gateway.ts`(`jwtVerify` 识别 `mbd_` 前缀走 DeviceService)
- Test: `apps/server-main/test/device-token-guard.spec.ts`

**Interfaces:**
- Produces: 全部现有 JWT 保护端点同时接受 `Authorization: Bearer mbd_...`;成功后 `req.user = { userId, email, orgId, deviceId }`(orgId 来自 `device.orgId`)。`ws/im` 握手 `auth.token` 同样支持 device token。
- Consumes: `DeviceService.verifyToken`(Task 3)、`UserService.findById`。

- [ ] **Step 1: 写失败测试**

`apps/server-main/test/device-token-guard.spec.ts`:最小 Nest app(一个 `@Get("whoami")` 测试 controller 返回 `@CurrentUser()`),装配 JwtAuthGuard + mock `DeviceService`(`verifyToken` 对 `mbd_good` 返回 `{id:"d1",userId:"u1",orgId:"o1",revokedAt:null}`,对 `mbd_bad` 抛 AppError)+ mock `UserService.findById` 返回 `{id:"u1",email:"a@x.io"}`。断言:
1. `Bearer mbd_good` → 200,body.data = `{userId:"u1",email:"a@x.io",orgId:"o1",deviceId:"d1"}`
2. `Bearer mbd_bad` → 401
3. 常规 JWT 仍然工作(签一个 jwt-main token → 200)
4. 无凭据 → 401

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现**

`jwt-auth.guard.ts` 改造:

```ts
@Injectable()
export class JwtAuthGuard extends AuthGuard(JWT_MAIN_STRATEGY_NAME) {
  constructor(
    private readonly reflector: Reflector,
    private readonly devices: DeviceService,
    private readonly users: UserService,
  ) { super(); }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (bearer.startsWith(DEVICE_TOKEN_PREFIX)) {
      const device = await this.devices.verifyToken(bearer);
      const user = await this.users.findById(device.userId);
      if (!user) throw new AppError(MainErrorCode.DEVICE_TOKEN_INVALID);
      req.user = { userId: user.id, email: user.email, orgId: device.orgId, deviceId: device.id };
      return true;
    }
    return super.canActivate(context) as Promise<boolean>;
  }
}
```

(`DeviceService.verifyToken` 抛的 `DEVICE_TOKEN_INVALID` httpStatus=401,经 ErrorsFilter 输出 401。Guard 有了依赖注入,e2e 装配处 `{provide: APP_GUARD, useClass: JwtAuthGuard}` 不变——Nest 自动解析构造依赖;各 e2e 需确保 MainModule 已 import。)

`JwtMainPayload` 加 `deviceId?: string`。

`ws-jwt.middleware.ts`:`jwtVerify` 参数类型放宽为 `(token: string) => unknown | Promise<unknown>`,赋值改 `socket.data.user = await Promise.resolve(jwtVerify(token))`(中间件本就是回调式,包一层 async IIFE 并 catch)。

`im.gateway.ts`:

```ts
protected jwtVerify(token: string): unknown | Promise<unknown> {
  if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
    return this.devices.verifyToken(token).then((d) => ({ userId: d.userId, orgId: d.orgId, deviceId: d.id }));
  }
  return this.jwt.verify(token);
}
```

构造函数注入 `DeviceService`。`onAuthedConnect` 里 orgId 解析:payload 带 orgId(device 连接)直接用,否则按现状查 `userService.findById(...).activeOrgId`。

- [ ] **Step 4: 跑测试通过 + 回归 + 提交**

Run: `pnpm jest apps/server-main/test/device-token-guard.spec.ts apps/server-main/test/e2e` → PASS(既有 e2e 不回归);`pnpm check`。

```bash
git add apps/server-main/src libs/common/src/ws apps/server-main/test
git commit -m "feat(server-main): 双凭据认证——HTTP Guard 与 ws/im 握手支持 device token"
```

---

### Task 9: server-main e2e(授权全流程)

**Files:**
- Create: `apps/server-main/test/e2e/device-auth-flow.e2e.spec.ts`
- Create: `apps/server-main/test/e2e/org-model-config-flow.e2e.spec.ts`

**Interfaces:**
- Consumes: Task 1-8 全部;装配复制 `org-flow.spec.ts` 模式(MainModule.forRoot 带 encryptionKey,controllers 加 DeviceAuthController/DeviceController/OrgModelConfigController/AgentConfigController)。

- [ ] **Step 1: 写授权全流程 e2e**

`device-auth-flow.e2e.spec.ts` 场景(单 it 串联或分步 it,共享 app):
1. register(a@x.io)→ `{needVerify:true}`;从 CaptureEmailSender 取验证码 → verify-email → 拿 JWT。
2. 建组织(POST /api/orgs)。
3. 模拟本地:生成 verifier/challenge → `POST /api/device-auth/start`(带 redirectUri)→ 拿 requestId + verifyUrl 含 `/authorize?request=`。
4. 带 JWT `GET /api/device-auth/requests/:id` → deviceName 正确。
5. 带 JWT `POST /api/device-auth/approve` → 拿 userCode + redirectUri 回显。
6. 无凭据 `POST /api/device-auth/exchange`(requestId+userCode+verifier)→ 拿 `deviceToken`(mbd_ 前缀)+ orgId。
7. `GET /api/auth/profile` 带 `Bearer <deviceToken>` → 200,userId 正确。
8. `GET /api/devices` 带 JWT → 1 台设备。
9. `POST /api/devices/switch-org` 带 deviceToken → ok(先再建一个 org 并加入)。
10. `DELETE /api/devices/:id` 带 JWT → ok;再用 deviceToken 打 profile → 401。
11. 负面:错误 userCode 兑换 5 次后正确码也失效;过期请求(直接 update expires_at)兑换失败。

`org-model-config-flow.e2e.spec.ts` 场景:owner 建配置 → listForAdmin 打码 → 成员(邀请加入的第二用户)POST 被 403(ORG_FORBIDDEN)→ agent 端点用 device token 拿到解密 apiKey → disable 后 agent 列表为空。

- [ ] **Step 2: 跑通过 + 提交**

Run: `pnpm jest apps/server-main/test/e2e/device-auth-flow.e2e.spec.ts apps/server-main/test/e2e/org-model-config-flow.e2e.spec.ts` → PASS;`pnpm test`(全量不回归);`pnpm check`。

```bash
git add apps/server-main/test
git commit -m "test(server-main): 设备授权与组织模型配置 e2e 全流程"
```

---

## Phase 2:本地后端(server-agent)

### Task 10: SQLite 迁移 + Entity 更新

**Files:**
- Create: `apps/server-agent/src/migrations/1780800000000-DeviceTokenAndModelSource.ts`
- Modify: `apps/server-agent/src/entities/cloud-identity.entity.ts`(加 `deviceToken`)
- Modify: `apps/server-agent/src/entities/model-config.entity.ts`(加 `source`)
- Test: `apps/server-agent/src/migrations/__tests__/device-token-migration.spec.ts`

**Interfaces:**
- Produces: `CloudIdentity.deviceToken: string | null`(列 `device_token`);`ModelConfig.source: "cloud" | "local"`(列 `source`,默认 `'local'`,存量行回填 `'local'`)。`cloudToken` 列保留不删(SQLite 限制),字段标注 `@deprecated`。

- [ ] **Step 1: 写失败迁移测试**

`apps/server-agent/src/migrations/__tests__/device-token-migration.spec.ts`(参考同目录既有迁移测试:内存 better-sqlite3 DataSource 跑全部迁移):断言 `cloud_identity` 有 `device_token` 列、`model_configs` 有 `source` 列且默认值 `'local'`(`PRAGMA table_info`)。

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现迁移与 Entity**

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

export class DeviceTokenAndModelSource1780800000000 implements MigrationInterface {
  name = "DeviceTokenAndModelSource1780800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cloud_identity" ADD COLUMN "device_token" TEXT`);
    await queryRunner.query(`ALTER TABLE "model_configs" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'local'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 DROP COLUMN;保留列(与既有迁移一致)
  }
}
```

Entity:`CloudIdentity` 加 `@Column({ name: "device_token", type: "text", nullable: true }) deviceToken!: string | null;`,`cloudToken` JSDoc 标 `@deprecated 旧密码代理流程遗留,仅迁移期兼容`;`ModelConfig` 加 `@Column({ type: "text", default: "local" }) source!: "cloud" | "local";`。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm jest apps/server-agent/src/migrations` → PASS;`pnpm check`。

```bash
git add apps/server-agent/src/migrations apps/server-agent/src/entities
git commit -m "feat(server-agent): SQLite 迁移——cloud_identity.device_token 与 model_configs.source"
```

---

### Task 11: DeviceAuthorizeService + AuthController 改造

**Files:**
- Create: `apps/server-agent/src/services/device-authorize.service.ts`
- Modify: `apps/server-agent/src/controllers/auth.controller.ts`(删 register/login,加 authorize 端点族)
- Modify: `apps/server-agent/src/services/cloud-auth.service.ts`(删 register/login/afterCloudAuth;token 来源改 deviceToken;switchOrg 改打 `/api/devices/switch-org`)
- Modify: `apps/server-agent/src/auth.module.ts`(providers 加 DeviceAuthorizeService)
- Modify: `apps/server-agent/src/errors/agent.error-codes.ts`(3015 AUTH_NO_PENDING_REQUEST)
- Modify: `apps/server-agent/i18n/{zh,en}/auth.json`
- Modify: `libs/types-agent/src/auth.ts`(删 loginSchema/registerSchema 前置留到 Task 19 前端一起删;本 task 先不动,避免 web-agent 编译断)
- Test: `apps/server-agent/src/services/device-authorize.service.spec.ts`;更新 `cloud-auth.service.spec.ts`

**Interfaces:**
- Produces(Service):
  - `DeviceAuthorizeService.start(): Promise<{ requestId: string; authorizeUrl: string }>`
    生成 `verifier = randomBytes(32).toString("base64url")`、`challenge = sha256(verifier) hex`;读 `<meshbotDir>/agent.port` 文件拿实际端口(读不到回退 7727)拼 `redirectUri = http://127.0.0.1:<port>/api/auth/callback`;调云端 `POST /api/device-auth/start`;把 `{ verifier, createdAt }` 存入内存 `pending: Map<requestId, PendingAuth>`(容量上限 10,超时 10 分钟惰性清理);返回 requestId + 云端 verifyUrl。
  - `DeviceAuthorizeService.complete(requestId: string, userCode: string): Promise<{ access_token: string }>`
    取 pending verifier(无则抛 `AUTH_NO_PENDING_REQUEST`)→ 云端 exchange → 拿 deviceToken → `GET /api/auth/profile`(Bearer deviceToken)拿 activeOrg/memberships → `identity.upsert({...含 deviceToken, cloudToken: "", cloudTokenExpiresAt: null})` → `runtime.createRuntime(userId)` → 签本地 JWT `{sub, email}` → 记入 `completed: Map<requestId, string>`(access_token,供 poll 一次性取走)→ `emitter.emit(AUTH_EVENTS.authorized, { cloudUserId })` → 返回。
  - `DeviceAuthorizeService.completeByCode(userCode: string): Promise<{ access_token: string }>`(手动粘贴:取**最新**一条 pending 调 complete)
  - `DeviceAuthorizeService.poll(requestId: string): Promise<{ status: "pending" } | { status: "done"; access_token: string }>`(completed 命中即取走删除)
  - `AUTH_EVENTS = { authorized: "auth.authorized", reauthRequired: "auth.reauth_required" }`(新建 `apps/server-agent/src/services/auth.events.ts`)
- Produces(REST,`api/auth`):
  - `POST authorize/start` `@Public` → `{ requestId, authorizeUrl }`
  - `GET callback?request=<id>&code=<userCode>` `@Public` → 调 complete,返回极简 HTML(`<meta charset>` + 成功/失败文案 + "可关闭此页返回应用"),`@SkipResponseEnvelope`
  - `POST authorize/complete` `@Public`,body `{ code }` → completeByCode → `{ access_token }`
  - `POST authorize/poll` `@Public`,body `{ requestId }` → poll 结果
  - 删除 `POST register` / `POST login`;`logout` / `profile` 保留
- Modify(CloudAuthService):`getProfile`/`switchOrg`/`trySyncActiveOrg` 内 token 读取从 `identity.cloudToken` 改为 `identity.deviceToken`(空则抛 `AUTH_UNAUTHORIZED`);`switchOrg` 改调 `POST /api/devices/switch-org {orgId}`(device token),成功后 `identity.updateActiveOrg` + `imRelay` 重连逻辑保持。
- Consumes: `CloudClientService`(Task 12 前先沿用 post/get 显式传 token)、`CloudIdentityService`、`AccountRuntimeRegistry`、`JwtService`、`EventEmitter2`、libs/types 的 `DeviceAuthStartResult`/`DeviceAuthExchangeResult`。

- [ ] **Step 1: 写失败测试**

`device-authorize.service.spec.ts`(沿用 `new Service(mock as never)` 风格):

```ts
import { EventEmitter2 } from "@nestjs/event-emitter";
import { DeviceAuthorizeService } from "./device-authorize.service";

function build() {
  const cloud = {
    post: jest.fn(async (path: string) => {
      if (path === "/api/device-auth/start") return { requestId: "r1", verifyUrl: "http://cloud/authorize?request=r1" };
      if (path === "/api/device-auth/exchange") return {
        deviceToken: "mbd_tok", user: { id: "u1", email: "a@x.io", displayName: "A" }, orgId: "o1",
      };
      throw new Error(`unexpected ${path}`);
    }),
    get: jest.fn(async () => ({
      user: { id: "u1", email: "a@x.io", displayName: "A" },
      activeOrg: { id: "o1", name: "Org", role: "owner" }, memberships: [],
    })),
  };
  const identity = { upsert: jest.fn(async () => undefined) };
  const runtime = { createRuntime: jest.fn(async () => undefined) };
  const jwt = { sign: jest.fn(() => "local-jwt") };
  const emitter = new EventEmitter2();
  const svc = new DeviceAuthorizeService(cloud as never, identity as never, runtime as never, jwt as never, emitter);
  return { svc, cloud, identity, runtime, jwt, emitter };
}

describe("DeviceAuthorizeService", () => {
  it("start 发起云端请求并缓存 verifier", async () => {
    const { svc, cloud } = build();
    const r = await svc.start();
    expect(r).toEqual({ requestId: "r1", authorizeUrl: "http://cloud/authorize?request=r1" });
    const body = cloud.post.mock.calls[0][1] as { codeChallenge: string; redirectUri: string };
    expect(body.codeChallenge).toMatch(/^[0-9a-f]{64}$/);
    expect(body.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/auth\/callback$/);
  });

  it("complete 兑换后写镜像、建运行时、签本地 JWT、发事件", async () => {
    const { svc, cloud, identity, runtime, jwt, emitter } = build();
    const events: unknown[] = [];
    emitter.on("auth.authorized", (p) => events.push(p));
    await svc.start();
    const r = await svc.complete("r1", "code-1");
    expect(r).toEqual({ access_token: "local-jwt" });
    const exchangeBody = cloud.post.mock.calls[1][1] as { codeVerifier: string; userCode: string };
    expect(exchangeBody.userCode).toBe("code-1");
    expect(identity.upsert).toHaveBeenCalledWith(expect.objectContaining({ cloudUserId: "u1", deviceToken: "mbd_tok", orgId: "o1" }));
    expect(runtime.createRuntime).toHaveBeenCalledWith("u1");
    expect(jwt.sign).toHaveBeenCalledWith({ sub: "u1", email: "a@x.io" });
    expect(events).toEqual([{ cloudUserId: "u1" }]);
  });

  it("poll 在 complete 前 pending,后 done 且一次性", async () => {
    const { svc } = build();
    await svc.start();
    expect(await svc.poll("r1")).toEqual({ status: "pending" });
    await svc.complete("r1", "code-1");
    expect(await svc.poll("r1")).toEqual({ status: "done", access_token: "local-jwt" });
    expect(await svc.poll("r1")).toEqual({ status: "pending" });
  });

  it("无 pending 时 complete 抛 AUTH_NO_PENDING_REQUEST", async () => {
    const { svc } = build();
    await expect(svc.complete("nope", "c")).rejects.toMatchObject({ name: "AppError" });
  });

  it("completeByCode 用最新 pending", async () => {
    const { svc } = build();
    await svc.start();
    await expect(svc.completeByCode("code-1")).resolves.toEqual({ access_token: "local-jwt" });
  });
});
```

同步更新 `cloud-auth.service.spec.ts`:删 register/login 用例;switchOrg 断言改打 `/api/devices/switch-org` 且 Bearer 用 deviceToken;getProfile token 来源断言改 deviceToken。

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现**

`device-authorize.service.ts` 骨架(pending/completed 双 Map;`identity.upsert` 需扩一个 `deviceToken` 字段——`CloudIdentityService.upsert` 的入参对象加 `deviceToken?: string | null`,实现里透传):

```ts
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { JwtService } from "@nestjs/jwt";
import type { DeviceAuthExchangeResult, DeviceAuthStartResult } from "@meshbot/types";
import { AccountRuntimeRegistry } from "../account/account-runtime.registry";
import { CloudClientService } from "../cloud/cloud-client.service";
import type { CloudProfileData } from "../cloud/cloud.types";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { getMeshbotDir } from "../utils/meshbot-dir";
import { PREFERRED_PORT } from "../utils/resolve-port";
import { CloudIdentityService } from "./cloud-identity.service";
import { AUTH_EVENTS } from "./auth.events";

interface PendingAuth { verifier: string; createdAt: number }
const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX = 10;

/** 浏览器授权登录编排:start → (浏览器) → callback/粘贴码 → exchange → 本地登录完成 */
@Injectable()
export class DeviceAuthorizeService {
  private readonly pending = new Map<string, PendingAuth>();
  private readonly completed = new Map<string, string>();

  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly runtime: AccountRuntimeRegistry,
    private readonly jwt: JwtService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** 发起授权:返回浏览器要打开的云端授权页 URL */
  async start(): Promise<{ requestId: string; authorizeUrl: string }> {
    this.evictStale();
    const verifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(verifier).digest("hex");
    const result = await this.cloud.post<DeviceAuthStartResult>("/api/device-auth/start", {
      deviceName: this.deviceName(), platform: process.platform,
      codeChallenge, redirectUri: `http://127.0.0.1:${this.actualPort()}/api/auth/callback`,
    });
    this.pending.set(result.requestId, { verifier, createdAt: Date.now() });
    return { requestId: result.requestId, authorizeUrl: result.verifyUrl };
  }

  /** 用一次性授权码完成兑换与本地登录 */
  async complete(requestId: string, userCode: string): Promise<{ access_token: string }> {
    const p = this.pending.get(requestId);
    if (!p) throw new AppError(AgentErrorCode.AUTH_NO_PENDING_REQUEST);
    const ex = await this.cloud.post<DeviceAuthExchangeResult>("/api/device-auth/exchange", {
      requestId, userCode, codeVerifier: p.verifier,
    });
    this.pending.delete(requestId);
    const profile = await this.cloud.get<CloudProfileData>("/api/auth/profile", ex.deviceToken);
    await this.identity.upsert({
      cloudUserId: ex.user.id, email: ex.user.email, displayName: ex.user.displayName,
      deviceToken: ex.deviceToken, cloudToken: "", cloudTokenExpiresAt: null,
      orgId: profile.activeOrg?.id ?? null, orgName: profile.activeOrg?.name ?? null,
      role: profile.activeOrg?.role ?? null,
    });
    await this.runtime.createRuntime(ex.user.id);
    const access_token = this.jwt.sign({ sub: ex.user.id, email: ex.user.email });
    this.completed.set(requestId, access_token);
    this.emitter.emit(AUTH_EVENTS.authorized, { cloudUserId: ex.user.id });
    return { access_token };
  }

  /** 手动粘贴码(SSH/回调失败):对最新 pending 兑换 */
  async completeByCode(userCode: string): Promise<{ access_token: string }> {
    const latest = [...this.pending.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt)[0];
    if (!latest) throw new AppError(AgentErrorCode.AUTH_NO_PENDING_REQUEST);
    return this.complete(latest[0], userCode);
  }

  /** 前端轮询取本地 token(一次性) */
  async poll(requestId: string): Promise<{ status: "pending" } | { status: "done"; access_token: string }> {
    const token = this.completed.get(requestId);
    if (!token) return { status: "pending" };
    this.completed.delete(requestId);
    return { status: "done", access_token: token };
  }

  private actualPort(): number {
    try {
      const raw = readFileSync(path.join(getMeshbotDir(), "agent.port"), "utf8");
      const parsed = JSON.parse(raw) as { port?: number };
      if (parsed.port) return parsed.port;
    } catch { /* 回退偏好端口 */ }
    return PREFERRED_PORT;
  }

  private deviceName(): string {
    return `${process.env.USER ?? "meshbot"}@${require("node:os").hostname()}`;
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (now - p.createdAt > PENDING_TTL_MS) this.pending.delete(id);
    while (this.pending.size >= PENDING_MAX) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      this.pending.delete(oldest[0]);
    }
  }
}
```

(`getMeshbotDir` 若无现成导出,复用 jwt.strategy 里 meshbotDir 的解析逻辑抽出;import os 用顶部 `import os from "node:os"`,示意代码中 `require` 处按此改。)

`auth.controller.ts` 改造(callback 返回 HTML 用 `@Res()` 或返回 string + `@Header("Content-Type","text/html; charset=utf-8")` + `@SkipResponseEnvelope`):

```ts
@Public() @Post("authorize/start") @HttpCode(200)
startAuthorize() { return this.deviceAuthorize.start(); }

@Public() @Get("callback") @SkipResponseEnvelope()
@Header("Content-Type", "text/html; charset=utf-8")
async callback(@Query("request") requestId: string, @Query("code") code: string): Promise<string> {
  try {
    await this.deviceAuthorize.complete(requestId, code);
    return "<!doctype html><meta charset='utf-8'><title>meshbot</title><p>授权成功,请关闭此页并返回 meshbot。</p>";
  } catch {
    return "<!doctype html><meta charset='utf-8'><title>meshbot</title><p>授权失败或已过期,请回到 meshbot 重试。</p>";
  }
}

@Public() @Post("authorize/complete") @HttpCode(200)
completeAuthorize(@Body() dto: AuthorizeCompleteDto) { return this.deviceAuthorize.completeByCode(dto.code); }

@Public() @Post("authorize/poll") @HttpCode(200)
pollAuthorize(@Body() dto: AuthorizePollDto) { return this.deviceAuthorize.poll(dto.requestId); }
```

DTO(`apps/server-agent/src/dto/auth.dto.ts` 或既有 dto 文件):`AuthorizeCompleteSchema = z.object({ code: z.string().min(1) })`、`AuthorizePollSchema = z.object({ requestId: z.string().min(1) })`,class+interface 合并模式。删 `RegisterDto/LoginDto` 引用(schema 本体在 libs/types-agent,Task 19 一并清理)。

错误码:`AUTH_NO_PENDING_REQUEST: { code: 3015, message: "auth.noPendingRequest" }` + i18n zh `"没有进行中的授权请求,请重新发起登录"` / en。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm jest apps/server-agent/src/services/device-authorize.service.spec.ts apps/server-agent/src/services/cloud-auth.service.spec.ts` → PASS;`pnpm check`。

```bash
git add apps/server-agent/src libs/types-agent apps/server-agent/i18n
git commit -m "feat(server-agent): 浏览器授权登录编排(start/callback/complete/poll),下线密码代理登录"
```

---

### Task 12: cloud-client / im-relay 凭据切换 + 重授权事件

**Files:**
- Modify: `apps/server-agent/src/cloud/im-relay-client.service.ts`(connect 用 deviceToken;connect_error 增发事件)
- Modify: `apps/server-agent/src/services/cloud-im.service.ts` / `services/drive-gateway.service.ts` / 其他经 `identity.get(...).cloudToken` 取凭据的调用点(grep `cloudToken` 全部改 `deviceToken`)
- Modify: `apps/server-agent/src/auth.module.ts`(CloudClient 的 `setUnauthorizedHandler` 加发事件)
- Modify: `apps/server-agent/src/ws/events.gateway.ts`(`@OnEvent(AUTH_EVENTS.reauthRequired)` → emitEnvelope)
- Modify: `libs/types/src/events/global-event.ts`(新增事件类型常量 `AUTH_WS_EVENTS = { authorized: "auth.authorized", reauthRequired: "auth.reauth_required" }`,前端 Task 19 消费)
- Test: 更新 `im-relay-client.service.spec.ts`、`events.gateway.spec.ts`

**Interfaces:**
- Produces: 所有 agent→cloud 调用统一凭据 `identity.deviceToken`;401/吊销时 `identity.setLoggedOut` + `emitter.emit(AUTH_EVENTS.reauthRequired, { cloudUserId })` + `ws/events` 下行 `{type:"auth.reauth_required"}`,前端提示重新授权。
- Consumes: Task 10 `deviceToken` 列、Task 11 `AUTH_EVENTS`。

- [ ] **Step 1: 更新测试(失败先行)**

`im-relay-client.service.spec.ts`:身份桩改为 `{ deviceToken: "mbd_x", orgId: "o1" }`;断言 `ioFactory` 收到 `auth.token === "mbd_x"`;`connect_error("unauthorized")` 后断言 `setLoggedOut` 且 `emitter.emit` 收到 `auth.reauth_required`。
`events.gateway.spec.ts`:补 `AUTH_EVENTS.reauthRequired` → envelope `{type:"auth.reauth_required"}` 转发用例。

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现**

`im-relay-client.service.ts`:`connect` 里 `if (!identity?.deviceToken || !identity.orgId) return;`,`auth: { token: identity.deviceToken }`;`connect_error` 分支在 `setLoggedOut` 后追加 `this.emitter.emit(AUTH_EVENTS.reauthRequired, { cloudUserId })`。
`auth.module.ts` unauthorized handler 同样追加 emit(handler 里已有 identity/account,注入 emitter)。
全仓 grep `\.cloudToken`(apps/server-agent):`cloud-im.service` / `drive-gateway.service` / `cloud-org.service` / `our-market.source` 等取凭据处统一改 `deviceToken`。
`events.gateway.ts` 追加:

```ts
@OnEvent(AUTH_EVENTS.reauthRequired)
onReauthRequired(payload: { cloudUserId: string }): void {
  this.emitEnvelope(AUTH_WS_EVENTS.reauthRequired, payload);
}
```

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm jest apps/server-agent/src/cloud apps/server-agent/src/ws apps/server-agent/src/services` → PASS;`pnpm check`。

```bash
git add apps/server-agent/src libs/types/src
git commit -m "feat(server-agent): 云端调用凭据切换 device token,吊销触发重授权事件"
```

---

### Task 13: ModelConfigSyncService + 本地模型配置只读化

**Files:**
- Create: `apps/server-agent/src/services/model-config-sync.service.ts`
- Modify: `apps/server-agent/src/services/model-config.service.ts`(新增 `replaceCloudConfigs`;删 create/update/remove 的 REST 暴露后按 check:dead 决定去留)
- Modify: `apps/server-agent/src/controllers/model-config.controller.ts`(删 POST/PATCH/DELETE,保留 GET)
- Modify: `apps/server-agent/src/session.module.ts`(providers 加 SyncService)
- Modify: `apps/server-agent/src/controllers/setup.controller.ts`(needs-model 语义:提示云端配置)
- Test: `apps/server-agent/src/services/model-config-sync.service.spec.ts`

**Interfaces:**
- Produces:
  - `ModelConfigService.replaceCloudConfigs(configs: AgentModelConfigLike[]): Promise<void>` — `@Transactional()` 私有实现 `persistCloudConfigs`:`repo.delete({ source: "cloud" })` 后逐条 `repo.save(repo.create({ ...c, source: "cloud" }))`(ScopedRepository 自动盖 cloudUserId;跨行为求原子跨表判定——同表多行删+插,挂事务防同步中途崩溃留半态)
  - `ModelConfigSyncService.syncNow(cloudUserId: string): Promise<boolean>`(拉 `GET /api/agent/model-configs`(deviceToken)→ replaceCloudConfigs,in `account.run(cloudUserId, ...)`;成功 true,失败 false 仅告警日志)
  - 触发点:`@OnEvent(ACCOUNT_EVENTS.runtimeCreated)` 立即同步;`onApplicationBootstrap` 对 `identity.listLoggedIn()` 逐个同步;定时器 30 分钟(失败退避 1→2→4→…→30 分钟,`timer.unref()`)
- Consumes: `CloudClientService`、`CloudIdentityService`、`AccountContextService`、`ModelConfigService`(Task 6 云端 `AgentModelConfig` shape)。
- 不变式:`libs/agent` 的 `readActiveModelConfig` 裸 SQL 只按 `cloud_user_id + enabled` 过滤,云端行落库后自动生效,无需改。**云端首次同步成功之前不动 `source='local'` 存量行**——`replaceCloudConfigs` 只删 cloud 行,天然满足。

- [ ] **Step 1: 写失败测试**

`model-config-sync.service.spec.ts`:mock cloud(`get` 返回 2 条 AgentModelConfig)、identity(`get` 返回 `{deviceToken:"mbd_x"}`)、modelConfig(`replaceCloudConfigs: jest.fn()`)、真 `AccountContextService`。断言:
1. `syncNow("u1")` → cloud.get 以 deviceToken 调用;replaceCloudConfigs 收到 2 条且在 u1 上下文内(mock 里 `ctx.get()` 断言)。
2. cloud.get 抛错 → syncNow 返回 false 不 throw。
3. `identity.get` 无 deviceToken → 直接 false,不打网络。
另写 `ModelConfigService.replaceCloudConfigs` 单测(内存桩 repo):存量 `source:'local'` 行保留、旧 cloud 行被替换。

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现**

`model-config-sync.service.ts` 核心:

```ts
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const BACKOFF_BASE_MS = 60 * 1000;

@Injectable()
export class ModelConfigSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private failCount = 0;
  private readonly logger = new Logger(ModelConfigSyncService.name);

  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
    private readonly modelConfig: ModelConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const identities = await this.identity.listLoggedIn();
    for (const id of identities) await this.syncNow(id.cloudUserId);
    this.schedule(SYNC_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  @OnEvent(ACCOUNT_EVENTS.runtimeCreated)
  async onRuntimeCreated(payload: { cloudUserId: string }): Promise<void> {
    await this.syncNow(payload.cloudUserId);
  }

  /** 拉取云端组织模型配置并整体替换本地 cloud 来源缓存;失败静默返回 false */
  async syncNow(cloudUserId: string): Promise<boolean> {
    try {
      const id = await this.identity.get(cloudUserId);
      if (!id?.deviceToken) return false;
      const configs = await this.cloud.get<AgentModelConfig[]>("/api/agent/model-configs", id.deviceToken);
      await this.account.run(cloudUserId, () => this.modelConfig.replaceCloudConfigs(configs));
      this.failCount = 0;
      return true;
    } catch (err) {
      this.failCount += 1;
      this.logger.warn(`模型配置同步失败(第 ${this.failCount} 次): ${String(err)}`);
      return false;
    }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(async () => {
      const identities = await this.identity.listLoggedIn().catch(() => []);
      let allOk = identities.length > 0;
      for (const id of identities) allOk = (await this.syncNow(id.cloudUserId)) && allOk;
      const backoff = allOk ? SYNC_INTERVAL_MS : Math.min(BACKOFF_BASE_MS * 2 ** this.failCount, SYNC_INTERVAL_MS);
      this.schedule(backoff);
    }, delay);
    this.timer.unref();
  }
}
```

(`ACCOUNT_EVENTS.runtimeCreated` 的 payload 若现状不含 cloudUserId,则在 `account-runtime.registry.ts` emit 时带上——确认后补。`AgentModelConfig` 类型从 `@meshbot/main` import 会破坏轨道边界,**在 `libs/types` 的 device-auth 同目录新增 `model-sync.schema.ts` 定义 `AgentModelConfig` interface**,云端 service(Task 6)与此处共用。)

`ModelConfigService`:

```ts
/** 整体替换云端来源缓存行(本地 source='local' 行不动) */
async replaceCloudConfigs(configs: AgentModelConfig[]): Promise<void> {
  return this.persistCloudConfigs(configs);
}

@Transactional()
private async persistCloudConfigs(configs: AgentModelConfig[]): Promise<void> {
  await this.repo.delete({ source: "cloud" });
  for (const c of configs) {
    await this.repo.save(this.repo.create({
      providerType: c.providerType, name: c.name, model: c.model, apiKey: c.apiKey,
      baseUrl: c.baseUrl, enabled: c.enabled, contextWindow: c.contextWindow, source: "cloud",
    }));
  }
}
```

`model-config.controller.ts`:删 `@Post()` / `@Patch(":id")` / `@Delete(":id")`,保留 `@Get()`;`ModelConfigService.create/update/remove` 若无剩余消费方,连同 DTO 一起删除(check:dead 会盯)。`setup.controller.ts` 的 needs-model 判定保留(hasEnabledModels),前端文案 Task 20 改。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm jest apps/server-agent/src/services/model-config-sync.service.spec.ts apps/server-agent/src/services/model-config.service.spec.ts` → PASS;`pnpm check`(check:tx 对 persistCloudConfigs 命名/装饰器围栏)。

```bash
git add apps/server-agent/src libs/types/src
git commit -m "feat(server-agent): 云端模型配置同步(整体替换 source=cloud 缓存),本地配置只读化"
```

---

### Task 14: 裁剪 cloud-org 代理

**Files:**
- Modify: `apps/server-agent/src/controllers/cloud-org.controller.ts`(只留 `GET /`、`POST /switch`、`GET /:id/members`)
- Modify: `apps/server-agent/src/services/cloud-org.service.ts`(删 createOrg/acceptInvitation/invite/listInvitations/resendInvitation/revokeInvitation)
- Modify: `apps/server-agent/src/services/cloud-org.service.spec.ts`
- Modify: `apps/server-agent/src/dto/org.dto.ts`(删不再用的 DTO)

**Interfaces:**
- Produces: 保留端点不变(IM 成员选择器、组织切换、org 列表依赖);管理操作(建组织/邀请)全部转移到 web-main(Task 18)。
- 注意:`listMine`/`listMembers` 的凭据来源已在 Task 12 切到 deviceToken。

- [ ] **Step 1: 更新测试** — 删除对应用例,补"已删方法不存在"不必测;确保保留方法用例仍绿。
- [ ] **Step 2: 实现删除**,同步清 dto 与 i18n orphan key(`pnpm sync:locales -- --write` 后人工审)。
- [ ] **Step 3: 全量跑 server-agent 测试 + 围栏 + 提交**

Run: `pnpm jest apps/server-agent` → PASS;`pnpm check`(check:dead 确认无死导出)。

```bash
git add apps/server-agent/src
git commit -m "refactor(server-agent): 裁剪组织管理代理,保留列表/切换/成员(IM 依赖)"
```

---

## Phase 3:web-main 前端

> 前端任务的验证方式:`pnpm typecheck` + `pnpm lint` + `pnpm sync:locales -- --check` + `pnpm dev:web-main`(配合 `pnpm dev:server-main`)手动走查;无既有前端测试基建,不强行新增。所有可见字符串走 `useTranslations`,zh/en 同步补全。

### Task 15: web-main 前端基建

**Files:**
- Modify: `apps/web-main/package.json`(补依赖)
- Create: `apps/web-main/src/lib/api.ts`(独立 axios client)
- Create: `apps/web-main/src/lib/auth-storage.ts`(token 存取)
- Create: `apps/web-main/src/components/providers.tsx`(QueryClientProvider)
- Create: `apps/web-main/src/components/auth-guard.tsx`
- Create: `apps/web-main/src/rest/auth.ts`(profile/login/register/verify/resend hooks)
- Modify: `apps/web-main/src/app/layout.tsx`(挂 Providers)
- Modify: `apps/web-main/src/app/page.tsx`(已登录跳 /settings/org,未登录跳 /login)

**Interfaces:**
- Produces:
  - `mainApi`(axios 实例):baseURL = `NEXT_PUBLIC_SERVER_MAIN_URL ?? ""`;请求拦截注入 `Bearer <localStorage["meshbot_main_token"]>`;响应拦截解 envelope(`success:false` 抛 `ApiError(message, code)`);401 清 token 跳 `/login?next=<当前路径>`(`/login`、`/register`、`/authorize`、`/share` 页面除外)
  - `getMainToken() / setMainToken(t) / clearMainToken()`(key `meshbot_main_token`,与 web-agent 的 `meshbot_access_token` 隔离)
  - `useProfile(): UseQueryResult<Profile>`(`GET /api/auth/profile`,`Profile = { user: {id,email,displayName}, activeOrg: {id,name,role} | null, memberships: {id,name,role}[] }`)
  - `useLogin() / useRegister() / useVerifyEmail() / useResendCode()`(mutation hooks;login/verify 成功 `setMainToken(data.token)` 并 invalidate profile)
  - `<AuthGuard>`:profile 401 → `router.replace("/login?next=...")`;pending 渲染 spinner
- Consumes: server-main REST(Task 7)。web-main 不用 `@meshbot/web-common` 的 apiClient(那是 agent 域,401 硬跳与 token key 都不同)。

- [ ] **Step 1: 补依赖**

`apps/web-main/package.json` dependencies 追加(版本对齐 web-agent 现值):`@tanstack/react-query`、`axios`、`react-hook-form`、`@hookform/resolvers`、`zod`、`@meshbot/types-main`(workspace:*)。Run `pnpm install`。

- [ ] **Step 2: 实现 api / storage / providers / guard / rest**

`src/lib/auth-storage.ts`:

```ts
const MAIN_TOKEN_KEY = "meshbot_main_token";

export function getMainToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(MAIN_TOKEN_KEY);
}
export function setMainToken(token: string): void {
  window.localStorage.setItem(MAIN_TOKEN_KEY, token);
}
export function clearMainToken(): void {
  window.localStorage.removeItem(MAIN_TOKEN_KEY);
}
```

`src/lib/api.ts`:

```ts
import axios from "axios";
import { clearMainToken, getMainToken } from "./auth-storage";

export class ApiError extends Error {
  constructor(message: string, public readonly code: number) { super(message); this.name = "ApiError"; }
}

const PUBLIC_PATHS = ["/login", "/register", "/authorize", "/share"];

export const mainApi = axios.create({
  baseURL: process.env.NEXT_PUBLIC_SERVER_MAIN_URL ?? "",
});

mainApi.interceptors.request.use((config) => {
  const token = getMainToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

mainApi.interceptors.response.use(
  (res) => {
    const body = res.data as { success?: boolean; data?: unknown; message?: string; code?: number };
    if (body && typeof body === "object" && "success" in body) {
      if (!body.success) throw new ApiError(body.message ?? "request failed", body.code ?? -1);
      res.data = body.data;
    }
    return res;
  },
  (err) => {
    if (err.response?.status === 401 && typeof window !== "undefined") {
      clearMainToken();
      const path = window.location.pathname;
      if (!PUBLIC_PATHS.some((p) => path.startsWith(p))) {
        window.location.href = `/login?next=${encodeURIComponent(path + window.location.search)}`;
      }
    }
    return Promise.reject(err);
  },
);
```

`src/rest/auth.ts`(react-query hooks;profile 用 `useQuery({queryKey:["main","profile"], retry:false})`;login/register/verify/resend mutations 按 Interfaces 描述)。`src/components/providers.tsx` 建 `QueryClient` 包 children;`layout.tsx` 里 `IntlProvider` 内套 `<Providers>`。`auth-guard.tsx` 客户端组件按 Interfaces 行为实现。`page.tsx` 改为客户端重定向组件(profile 成功 → `/settings/org`,失败 → `/login`)。

- [ ] **Step 3: i18n + 验证 + 提交**

`pnpm sync:locales -- --write` 后为新增 key 填 zh/en 文案;`pnpm typecheck && pnpm lint`;`pnpm dev:web-main` 起服打开 `http://localhost:3002` 确认重定向到 /login(404 是预期,页面 Task 16)。

```bash
git add apps/web-main pnpm-lock.yaml
git commit -m "feat(web-main): 前端基建——独立 apiClient/token 存储/QueryClient/AuthGuard"
```

---

### Task 16: 登录 / 注册(含邮箱验证)页

**Files:**
- Create: `apps/web-main/src/app/login/page.tsx`
- Create: `apps/web-main/src/app/register/page.tsx`
- Create: `apps/web-main/src/components/auth/auth-shell.tsx`(左品牌右表单壳,参考 web-agent `auth-shell-layout.tsx` 简化版)
- Modify: `apps/web-main/messages/{zh,en}.json`

**Interfaces:**
- Produces: `/login?next=`(邮箱+密码 → `useLogin` → 成功跳 next ?? `/settings/org`;`AUTH_EMAIL_NOT_VERIFIED`(code 2022)错误 → 跳 `/register?step=verify&email=...`);`/register`(两步:表单 → 验证码;verify 成功即持 token,跳 next ?? `/settings/org`)。
- Consumes: Task 15 hooks;`RegisterUserSchema`(`@meshbot/types-main`)+ `useSchema`(`@meshbot/design/hooks`)+ `Form/FormItem`(`@meshbot/design/form`)。

- [ ] **Step 1: 实现登录页**

结构复刻 web-agent login(品牌壳 + Form/FormItem + useSchema),schema 用 `libs/types-main` 的 `LoginSchema`(已存在 `auth/login.schema.ts`);错误处理:catch `ApiError`,`code === 2022` 时 `router.push(\`/register?step=verify&email=${encodeURIComponent(values.email)}\`)`,其余 toast/inline 展示 message;底部链接:「没有账号?注册」→ `/register`。

- [ ] **Step 2: 实现注册页(register → verify 两步)**

step 1:`RegisterUserSchema` 表单(email/password/displayName + confirmPassword `.extend().refine()`,复刻 web-agent register 页模式)→ `useRegister` 成功 → step verify。
step 2:6 位验证码输入(`Input` + 提交按钮 + 「重新发送(60s 倒计时)」按钮调 `useResendCode`)→ `useVerifyEmail` 成功(响应含 token,`setMainToken`)→ `router.replace(next ?? "/settings/org")`。URL `?step=verify&email=` 直达 step 2(登录页 2022 分流入口)。

- [ ] **Step 3: i18n + 手动走查 + 提交**

`pnpm sync:locales -- --write` 补 `login.*` / `register.*` 命名空间 zh/en 文案;起 dev:server-main + dev:web-main,真实走一遍注册→取码(LogEmailSender 日志里)→验证→登录;`pnpm typecheck && pnpm lint`。

```bash
git add apps/web-main
git commit -m "feat(web-main): 登录/注册页(含邮箱验证码两步流)"
```

---

### Task 17: /authorize 设备授权确认页

**Files:**
- Create: `apps/web-main/src/app/authorize/page.tsx`
- Create: `apps/web-main/src/components/auth/org-onboarding.tsx`(无组织时内联建组织/接受邀请)
- Create: `apps/web-main/src/rest/device-auth.ts`
- Create: `apps/web-main/src/rest/org.ts`(createOrg / acceptInvitation,web-main 域)
- Modify: `apps/web-main/messages/{zh,en}.json`

**Interfaces:**
- Produces: `/authorize?request=<id>` 页面状态机:
  1. 未登录(profile 401)→ `router.replace(/login?next=/authorize?request=<id>)`(AuthGuard 行为,页面挂 guard)
  2. 已登录、`useDeviceAuthRequest(requestId)`(`GET /api/device-auth/requests/:id`)加载设备信息;过期/无效 → 错误卡片 + 「回到应用重试」文案
  3. 无组织(profile.activeOrg == null)→ 渲染 `<OrgOnboarding>`(建组织 or 粘贴邀请码,复用 `CreateOrgSchema`/`AcceptInvitationSchema` from types-main;成功 invalidate profile)
  4. 有组织 → 确认卡片:「设备 <b>{deviceName}</b>({platform})请求接入你的账号,当前组织:{activeOrg.name}」+ 授权/拒绝按钮
  5. 授权 → `useApproveDevice`(`POST /api/device-auth/approve`)→ 拿 `{userCode, redirectUri}`:有 redirectUri 先尝试 `window.location.href = \`${redirectUri}?request=${id}&code=${userCode}\``;页面同时立即展示授权码块(等宽字体 + 复制按钮)+ 文案「若桌面端没有自动完成,请把此码粘贴到应用中」
  6. 拒绝 → 直接提示可关闭页面(不调接口;请求 10 分钟自然过期,YAGNI)
- Consumes: Task 15 基建、Task 7 REST。

- [ ] **Step 1: 实现 rest hooks 与页面**(按状态机逐态渲染,页面为 client 组件,`useSearchParams` 取 request)
- [ ] **Step 2: i18n(`authorize.*` 命名空间)+ 手动走查**:server-agent 起本地(Task 11 已可 start)→ 浏览器完整走 authorize → loopback 回调成功 + 手动粘贴两条路都验证。
- [ ] **Step 3: 提交**

```bash
git add apps/web-main
git commit -m "feat(web-main): /authorize 设备授权确认页(含无组织引导与粘贴码兜底)"
```

---

### Task 18: 管理页(组织成员邀请 / 设备 / 模型配置)

**Files:**
- Create: `apps/web-main/src/app/settings/layout.tsx`(左侧导航:组织/设备/模型 + 顶栏用户菜单含登出/切组织)
- Create: `apps/web-main/src/app/settings/org/page.tsx`
- Create: `apps/web-main/src/app/settings/devices/page.tsx`
- Create: `apps/web-main/src/app/settings/models/page.tsx`
- Create: `apps/web-main/src/rest/{devices,model-config}.ts`;扩展 `src/rest/org.ts`(members/invitations/invite/resend/revoke/switchOrg)
- Modify: `apps/web-main/messages/{zh,en}.json`

**Interfaces:**
- Produces:
  - `/settings/org`:成员表(Table)、owner 才见邀请表单(`Form/FormItem` + `CreateInvitationSchema`)与待处理邀请列表(重发/撤销);移植 web-agent `settings/org/page.tsx` 的结构,API 前缀换 `/api/orgs/...`(直连 server-main)
  - `/settings/devices`:设备表(名称/平台/最近活跃/状态),行操作「吊销」(二次确认,吊销后标灰);`useDevices`(`GET /api/devices`)、`useRevokeDevice`(`DELETE /api/devices/:id`)
  - `/settings/models`:配置卡片列表(name/provider/model/apiKeyMasked/enabled 开关)+ 新建/编辑表单(`OrgModelConfigCreateSchema`,provider 下拉复用 `PROVIDERS` from `@meshbot/web-common`;编辑时 apiKey 留空=不换,placeholder 显示 apiKeyMasked)+ 删除(确认);非 owner 只读呈现(隐藏写按钮)
  - 切组织:顶栏菜单列 memberships,点选 → `POST /api/auth/switch-org` → 重签 token 落 storage → invalidate 全部查询
- Consumes: Task 7 REST、Task 15 基建。

- [ ] **Step 1: 实现 settings layout + org 页**(移植 web-agent 组织页,i18n 命名空间 `orgSettings`)
- [ ] **Step 2: 实现 devices 页**(空态文案「还没有已授权的设备」)
- [ ] **Step 3: 实现 models 页**(表单校验走 useSchema;enabled 开关即时 PATCH)
- [ ] **Step 4: i18n + 手动走查 + 提交**

走查:owner 邀请成员(邮件日志)、第二账号接受邀请、成员视角 models 只读、吊销设备后 server-agent 侧收到 401 事件(配合 Task 12 联调)。

```bash
git add apps/web-main
git commit -m "feat(web-main): 组织/设备/模型配置管理页与组织切换"
```

---

## Phase 4:web-agent + desktop

### Task 19: web-agent 登录页改浏览器授权

**Files:**
- Modify: `apps/web-agent/src/app/login/page.tsx`(重写)
- Delete: `apps/web-agent/src/app/register/page.tsx`、`apps/web-agent/src/components/setup/org-step.tsx`
- Modify: `apps/web-agent/src/rest/auth.ts`(删 login/register,加 startAuthorize/pollAuthorize/completeAuthorize)
- Modify: `apps/web-agent/src/components/auth-guard.tsx`(needs-org 分流删除,未登录一律 /login)
- Modify: `apps/server-agent/src/controllers/setup.controller.ts` 若 auth-status 仍返回 needs-org 分支,同步简化
- Modify: `libs/types-agent/src/auth.ts`(删 loginSchema/registerSchema/createOrgSchema/joinOrgSchema;保留 inviteMemberSchema 若 IM 仍用成员类型——`MemberInfo`/`OrgInfo` 类型保留)
- Modify: `apps/web-agent/messages/{zh,en}.json`
- Test: 手动走查(见 Step 4)

**Interfaces:**
- Produces: 登录页新交互:
  1. 主按钮「通过浏览器登录」→ `POST /api/auth/authorize/start` → `window.open(authorizeUrl, "_blank")` + 进入等待态(spinner + 「已在浏览器打开授权页…」)
  2. 等待态每 2 秒 `POST /api/auth/authorize/poll {requestId}`,`done` → `setAccessToken(access_token)` + `addAccount(...)`(解 JWT sub/email,复用现 login 的写法)→ invalidate profile → `router.replace("/")`;超时 10 分钟回初始态
  3. 折叠区「无法自动完成?手动输入授权码」→ Input + 提交 → `POST /api/auth/authorize/complete {code}` → 同上落 token
  4. 底部链接「注册账号」→ `href={cloudWebUrl}/register`(cloudWebUrl 见下)
- **cloudWebUrl 获取**:web-agent 不知道云端地址(见探索结论),由 start 响应携带——`DeviceAuthorizeService.start` 返回值已含 authorizeUrl,登录页从中 `new URL(authorizeUrl).origin` 推导注册链接;设置页跳转(Task 20)同理,通过新增 `GET /api/auth/cloud-web-url` `@Public` 端点(server-agent 读 start 同源逻辑:调云端拿?不必——server-agent 直接用 `MESHBOT_CLOUD_URL` 推 webMainBase 不可靠,**改为**:server-main `GET /api/meta` `@Public` 返回 `{ webMainBase }`,server-agent 代理并缓存)。**简化决策:本 task 只做登录页(用 authorizeUrl.origin),Task 20 的跳转链接同样先经一次 authorize/start?否——** 新增 server-agent `GET api/auth/cloud-web-url`:`cloud.get("/api/meta")` 透传 `{ webMainBase }`,server-main 侧在 Task 7 的遗留补充里加 `MetaController`(`@Public GET /api/meta` 返回 `{ webMainBase: config.webMainBase }`)。此端点本 task 一并补上(server-main + server-agent + 前端 hook `useCloudWebUrl`)。
- Consumes: Task 11 REST、Task 12 `AUTH_WS_EVENTS.reauthRequired`(AuthGuard 或 shell 层监听:收到后 toast「云端授权已失效,请重新登录」+ 跳 /login;在 `use-global-events.ts` 的 dispatch 加 case)。

- [ ] **Step 1: server 侧补 meta 端点**(server-main `MetaController` + server-agent 代理 + 各自路由测试各 1 条)
- [ ] **Step 2: 重写登录页 + rest/auth.ts**(删 login/register 函数与 hooks;`use-global-events.ts` 加 `AUTH_WS_EVENTS.reauthRequired` case → handler 清 token 跳 /login)
- [ ] **Step 3: 删注册页与 org-step,AuthGuard 简化**(未登录 → /login;`fetchAuthStatus` 的 needs-org 分支移除;`setup.controller.ts` 对应简化,保留 needs-model 信息)
- [ ] **Step 4: i18n + 手动走查 + 提交**

走查(dev:server-main + dev:server-agent + dev:web-agent + dev:web-main 四进程):完整闭环——web-agent 点浏览器登录 → web-main 授权 → loopback 回调 → web-agent 自动进入主界面;再走一遍手动粘贴码;登出重登;云端吊销设备 → web-agent 收到重授权提示。`pnpm typecheck && pnpm lint && pnpm sync:locales -- --check`。

```bash
git add apps/web-agent apps/server-agent apps/server-main libs/types-agent libs/types
git commit -m "feat(web-agent): 登录改浏览器云端授权(自动回调+轮询+粘贴码兜底),删本地注册"
```

---

### Task 20: 组织页删除 / 模型配置只读化 / workspace-rail

**Files:**
- Delete: `apps/web-agent/src/app/(shell)/settings/org/page.tsx`
- Modify: `apps/web-agent/src/components/shell/workspace-rail.tsx`(组织切换保留;「组织」入口改外链 `${cloudWebUrl}/settings/org`)
- Modify: `apps/web-agent/src/components/model-setup-gate.tsx`(改提示卡:「组织还没有可用模型,请在云端配置」+ 外链 `${cloudWebUrl}/settings/models` + 「刷新」按钮触发重新拉 model-configs)
- Delete: `apps/web-agent/src/components/setup/{model-form,model-step,provider-card}.tsx`
- Modify: `apps/web-agent/src/rest/model-config.ts`(删 create;保留 fetchModelConfigs/useModelConfigs)
- Modify: `apps/web-agent/src/rest/org.ts`(删 createOrg/joinOrg/invite/invitations 相关,保留 fetchOrgs/switchOrg/fetchMembers)
- Modify: `apps/web-agent/messages/{zh,en}.json`(删 orphan、加新 key)

**Interfaces:**
- Consumes: `useCloudWebUrl`(Task 19)。
- 保留不动:IM 组件的 `useMembers`、org 切换 `useOrgs/switchOrg`(对应 server-agent 保留端点,Task 14)。

- [ ] **Step 1: 逐项删改**(先删页面与组件,再顺着 typecheck 报错清 rest/hooks/imports)
- [ ] **Step 2: ModelSetupGate 新提示卡实现**(空态插画可省,文案 + 两按钮)
- [ ] **Step 3: i18n 清理 + 验证 + 提交**

`pnpm sync:locales -- --write` 后人工删 orphan(orgSettings/modelForm 等整组);`pnpm typecheck && pnpm lint`;dev 走查:模型列表只读展示(来自云端同步)、组织切换可用、组织管理外链正确。

```bash
git add apps/web-agent
git commit -m "refactor(web-agent): 组织管理与模型编辑收敛云端,本地只读展示+外链"
```

---

### Task 21: desktop 外链开系统浏览器

**Files:**
- Modify: `apps/desktop/src/main.ts`

**Interfaces:**
- Produces: 渲染进程内 `window.open(外部 http(s) URL)` / target=_blank → 系统默认浏览器;应用自身 origin 的弹窗保持默认行为。

- [ ] **Step 1: 实现**

`createWindow` 内 `win.loadURL(agentUrl)` 之前加:

```ts
win.webContents.setWindowOpenHandler(({ url }) => {
  const isExternal = /^https?:\/\//.test(url) && !url.startsWith(agentUrl);
  if (isExternal) {
    void shell.openExternal(url);
    return { action: "deny" };
  }
  return { action: "allow" };
});
```

(`shell` 从 `electron` import 追加。)

- [ ] **Step 2: 验证 + 提交**

`pnpm dev:desktop`(配四进程)点登录按钮确认系统浏览器打开;`pnpm typecheck`。

```bash
git add apps/desktop/src/main.ts
git commit -m "feat(desktop): 外部链接改系统浏览器打开(授权页依赖)"
```

---

## Phase 5:收尾

### Task 22: 文档 + 全量回归 + boot 验证 + 手动冒烟

**Files:**
- Modify: `.claude/CLAUDE.md`(表归属:server-main 追加 `Device / DeviceAuthRequest / EmailVerification / OrgModelConfig`;server-agent 行说明 CloudIdentity 含 device_token)
- Modify: `docs/architecture.md` 若有认证/登录章节则同步(无则跳过)

- [ ] **Step 1: 文档更新**
- [ ] **Step 2: 全量回归(读完整输出,不 tail)**

```bash
pnpm typecheck
pnpm test            # 根 jest:libs/common + server-agent + server-main
pnpm check:strict
pnpm sync:locales -- --check
```

Expected: 全绿;`libs/agent` vitest 基线失败(9 个预存在)不计入回归判定,以失败集合 diff 判断。

- [ ] **Step 3: boot 验证(DI 改动多,必须真启动)**

```bash
pnpm dev:server-main   # 起来无 DI 错误,读完整启动日志
pnpm dev:server-agent  # 同上;确认迁移自动执行、ModelConfigSync 启动日志正常
```

- [ ] **Step 4: 手动冒烟清单(四进程联调)**

1. 云端注册(web-main)→ 邮箱验证码(dev 用 LogEmailSender 日志取码)→ 登录 → 建组织 → 配 2 条模型配置。
2. web-agent 点「通过浏览器登录」→ 浏览器授权 → 自动回调完成 → 主界面可用;`~/.meshbot` SQLite 里 cloud_identity.device_token 有值。
3. 模型配置已同步(设置页只读可见,source=cloud);发起一次 Agent 会话对话成功(走云端下发的 Key)。
4. 手动粘贴码路径:再授权一台(隐身窗),复制授权码粘贴完成。
5. web-main 设备页吊销设备 → web-agent 收到「需要重新授权」提示,IM 断开;重新授权恢复。
6. 断网(停 server-main)→ web-agent 重启后 Agent 本地会话仍可用(模型走缓存),IM 不可用不崩。
7. 邀请第二账号入组织 → 接受(此路径注册视同已验证)→ 成员视角 models 只读。

- [ ] **Step 5: 提交收尾**

```bash
git add .claude/CLAUDE.md docs
git commit -m "docs: 子项目A收尾——表归属与架构文档更新"
```

---

## Self-Review 记录(写完计划后自查)

1. **Spec 覆盖**:授权流程(T4/7/11/17/19)、device token 双凭据(T3/8/12)、邮箱验证(T5/7/16)、组织级模型配置+加密(T2/6/7/18)、本地缓存同步+source 列(T10/13)、组织管理迁移(T14/18/20)、设备管理与吊销(T7/18/12)、web-agent 收敛(T19/20)、desktop 外链(T21)、兼容迁移(存量 email_verified_at 回填 T1;存量本地模型不清空 T13;旧 cloudToken 弃用重新授权 T10/12)、错误处理(TTL/attempts T4/5;401 事件 T12;离线缓存 T13)、测试策略(各 task TDD + T9 e2e + T22 boot/冒烟)。spec 全部条目有对应 task。
2. **Spec 偏差(有意,执行时以此为准)**:① server-agent 保留 `GET /api/orgs`、`POST /api/orgs/switch`、`GET /api/orgs/:id/members` 三个代理端点——spec 写"组织管理代理一并删除",但 IM 成员选择器与本地组织切换依赖它们,只删管理操作(创建/邀请/接受);② 角色模型现状只有 `owner|member`,spec 中"owner/admin 可写"落地为 owner 可写。
3. **类型一致性**:`DeviceAuthStartResult{requestId,verifyUrl}`(T7)↔ T11 消费;`DeviceAuthExchangeResult{deviceToken,user,orgId}`(T7)↔ T11;`AgentModelConfig`(T6 定义、T13 消费,统一放 `libs/types`);`AUTH_EVENTS`(T11 定义、T12/13 消费);`DEVICE_TOKEN_PREFIX`(T3 定义、T8 消费);`AUTH_WS_EVENTS`(T12 定义、T19 消费)。
4. **执行顺序注意**:T8 之前 device token 打不通任何端点(T7 的 agent 端点在 T8 后才可用),e2e(T9)必须在 T8 后;Phase 2 依赖 Phase 1 完成(本地调云端真实联调在 T19 走查);T19 依赖 T11+T17。



