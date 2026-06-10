# Phase 1：云端身份 + 企业/组织 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉 server-agent 本地密码登录，改为通过云端 server-main 注册/登录 + 创建/加入企业（邮件邀请），本地只存身份镜像与云端 token；server-agent 作为唯一云端客户端代理所有云端调用。

**Architecture:** 方案 A（本地后端代理）。server-main（Postgres）新增 `Organization`/`Membership`/`Invitation` 三张表与对应 Service，配置体系迁到 qriter 式 `loadAppConfig`（Nacos 优先、回退本地 YAML），邮件走阿里云 DirectMail（可插拔，开发态 Log 兜底）。server-agent 新增 `CloudClient`（HTTP 客户端 + 错误码映射）与 `cloud_identity`（SQLite 单行镜像），auth 控制器改为薄代理；本地 JWT 机制保留，payload 换成云端身份。web-agent 登录页 username→email，setup 向导 2 步→3 步（注册→组织→配 LLM），设置页加「组织」区块。

**Tech Stack:** NestJS 11 + TypeORM 0.3 + Postgres/SQLite + Zod + nestjs-i18n + AppError 信封 + Jest（单测/E2E）+ Next.js（web-agent）+ next-intl + react-hook-form。

**实施顺序与依赖：**
- **Part A**（任务 1-3）server-main 基建迁移：配置 loader 移植 + 邮件发送 + 配置 schema。**先做**，后续云端业务依赖它。
- **Part B**（任务 4-9）server-main 组织域：types-main schema → 实体 → 迁移 → Service → Controller → E2E。
- **Part C**（任务 10-14）server-agent 改造：CloudClient → cloud_identity 实体/迁移 → CloudAuthService → 控制器代理 → setup-status。
- **Part D**（任务 15-18）web-agent 前端：types/rest → 登录页 → setup 向导 → 设置页组织区块。
- **Part E**（任务 19）端到端围栏 + 验证。

**通用约定（每个任务都遵守）：**
- 跑测试：根目录 `pnpm test -- <路径或 -t 名称>`（jest root 配置，moduleNameMapper 已配 `@meshbot/*`）。
- 错误码：server-main 用 `MainErrorCode`（2000 段），server-agent 用 `AgentErrorCode`（3000 段），新增 code 不得跳号/重号（`check:error-code` 校验）。
- 提交信息中文，conventional commits 风格。
- Service 跨表写挂 `@Transactional()`，私有事务方法命名 `persist*`/`*InTx`；`@WithLock` 必须在 `@Transactional` 外层。

---

## Part A — server-main 基建迁移（配置 + 邮件）

### Task 1: 移植 config loader 到 libs/common

把 qriter 的 `loadAppConfig`（Nacos + YAML + key 归一化）移植进 meshbot 的 `libs/common`，供 server-main bootstrap 使用。

**Files:**
- Create: `libs/common/src/config/nacos-bootstrap.schema.ts`
- Create: `libs/common/src/config/nacos-source.ts`
- Create: `libs/common/src/config/yaml-source.ts`
- Create: `libs/common/src/config/normalize-keys.ts`
- Create: `libs/common/src/config/config-loader.ts`
- Create: `libs/common/src/config/normalize-keys.spec.ts`
- Modify: `libs/common/src/config/index.ts`
- Modify: `libs/common/package.json`（加 `js-yaml`、`nacos` 依赖 + `@types/js-yaml`）

- [ ] **Step 1: 加依赖**

在 `libs/common/package.json` 的 `dependencies` 加 `"js-yaml": "^4"`、`"nacos": "^2"`，`devDependencies` 加 `"@types/js-yaml": "^4"`，然后根目录 `pnpm install`。

- [ ] **Step 2: 写 normalize-keys 的失败测试**

Create `libs/common/src/config/normalize-keys.spec.ts`：

```ts
import { normalizeKeys } from "./normalize-keys";

describe("normalizeKeys", () => {
  it("kebab-case key 递归转 camelCase，值不变", () => {
    const input = {
      "access-key-id": "ak",
      nested: { "account-name": "noreply@x.com", port: 3200 },
      list: [{ "a-b": 1 }],
    };
    expect(normalizeKeys(input)).toEqual({
      accessKeyId: "ak",
      nested: { accountName: "noreply@x.com", port: 3200 },
      list: [{ aB: 1 }],
    });
  });

  it("已是 camelCase / 无连字符的 key 不变", () => {
    expect(normalizeKeys({ accountName: "x", port: 1 })).toEqual({
      accountName: "x",
      port: 1,
    });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test -- libs/common/src/config/normalize-keys.spec.ts`
Expected: FAIL（`Cannot find module './normalize-keys'`）

- [ ] **Step 4: 写 normalize-keys 实现**

Create `libs/common/src/config/normalize-keys.ts`（移植自 qriter，逻辑不变）：

```ts
/** 单个 key 的 kebab-case → camelCase：`access-key-id` → `accessKeyId`。 */
function kebabToCamel(key: string): string {
  return key.replace(/-+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** 是否是「纯对象」（避免动 Date 等带原型的实例）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 递归把对象 key 的 kebab-case 归一化为 camelCase（值不变）。 */
export function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeKeys);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[kebabToCamel(k)] = normalizeKeys(v);
    }
    return out;
  }
  return value;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test -- libs/common/src/config/normalize-keys.spec.ts`
Expected: PASS

- [ ] **Step 6: 写其余三个 source 文件（无独立单测，由 loader 覆盖）**

Create `libs/common/src/config/nacos-bootstrap.schema.ts`（移植自 qriter，dataId 默认改 meshbot）：

```ts
import { z } from "zod";

/** Nacos 引导配置 schema：namespace / group / dataId 带默认，鉴权可选。 */
export const NacosBootstrapSchema = z.object({
  serverAddr: z.string().min(1),
  namespace: z.string().default("public"),
  group: z.string().default("DEFAULT_GROUP"),
  dataId: z.string().default("meshbot-server-main.yaml"),
  username: z.string().optional(),
  password: z.string().optional(),
});

export type NacosBootstrap = z.infer<typeof NacosBootstrapSchema>;

const FIELD_TO_ENV: Record<string, string> = {
  serverAddr: "NACOS_SERVER_ADDR",
  namespace: "NACOS_NAMESPACE",
  group: "NACOS_GROUP",
  dataId: "NACOS_DATA_ID",
  username: "NACOS_USERNAME",
  password: "NACOS_PASSWORD",
};

/**
 * 从 env 读取 Nacos 引导配置。
 * - 未设 `NACOS_SERVER_ADDR` → 返回 `null`（调用方回退本地 YAML）。
 * - 设了但其它字段非法 → 抛错并指出字段。
 */
export function readNacosBootstrap(
  env: Record<string, string | undefined>,
): NacosBootstrap | null {
  if (!env.NACOS_SERVER_ADDR) return null;
  const parsed = NacosBootstrapSchema.safeParse({
    serverAddr: env.NACOS_SERVER_ADDR,
    namespace: env.NACOS_NAMESPACE,
    group: env.NACOS_GROUP,
    dataId: env.NACOS_DATA_ID,
    username: env.NACOS_USERNAME,
    password: env.NACOS_PASSWORD,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => {
        const field = String(i.path[0]);
        return `  - ${FIELD_TO_ENV[field] ?? `NACOS_${field}`}: ${i.message}`;
      })
      .join("\n");
    throw new Error(`[config-loader] Nacos 引导变量校验失败：\n${issues}`);
  }
  return parsed.data;
}
```

Create `libs/common/src/config/nacos-source.ts`（移植自 qriter，逐字不变）：

```ts
import { load } from "js-yaml";
import { NacosConfigClient } from "nacos";
import type { NacosBootstrap } from "./nacos-bootstrap.schema";

/** 从 Nacos 配置中心拉取配置（dataId 内容为 YAML），解析成嵌套对象。 */
export async function loadNacosConfig(
  bootstrap: NacosBootstrap,
): Promise<Record<string, unknown>> {
  const { serverAddr, namespace, group, dataId, username, password } =
    bootstrap;
  const client = new NacosConfigClient({
    serverAddr,
    namespace,
    ...(username && password ? { username, password } : {}),
  });
  const where = `server=${serverAddr} namespace=${namespace} group=${group} dataId=${dataId}`;

  let content: string | null;
  try {
    await client.ready();
    content = await client.getConfig(dataId, group);
  } catch (err) {
    throw new Error(
      `[config-loader] 从 Nacos 拉取配置失败（${where}）：${String(err)}`,
      { cause: err },
    );
  }
  if (!content) {
    throw new Error(`[config-loader] Nacos 配置为空（${where}）。`);
  }
  const parsed = load(content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `[config-loader] Nacos 配置内容不是合法 YAML map（${where}）。`,
    );
  }
  return parsed as Record<string, unknown>;
}
```

Create `libs/common/src/config/yaml-source.ts`（移植自 qriter，逐字不变）：

```ts
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

/** 深合并两个普通对象：后者覆盖前者，嵌套对象递归合并（数组按整体替换）。 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const prev = out[key];
    const bothPlainObject =
      prev !== null &&
      typeof prev === "object" &&
      !Array.isArray(prev) &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value);
    out[key] = bothPlainObject
      ? deepMerge(
          prev as Record<string, unknown>,
          value as Record<string, unknown>,
        )
      : value;
  }
  return out;
}

/** 读取一组本地 YAML 文件并深合并成嵌套配置对象。文件不存在则跳过。 */
export function loadYamlConfig(paths: string[]): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const filePath of paths) {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const parsed = load(raw);
    if (parsed === null || parsed === undefined) continue;
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `[config-loader] YAML 文件 ${filePath} 顶层必须是对象（map）。`,
      );
    }
    merged = deepMerge(merged, parsed as Record<string, unknown>);
  }
  return merged;
}
```

Create `libs/common/src/config/config-loader.ts`（移植自 qriter，逐字不变）：

```ts
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { z, type ZodType } from "zod";
import { readNacosBootstrap } from "./nacos-bootstrap.schema";
import { loadNacosConfig } from "./nacos-source";
import { normalizeKeys } from "./normalize-keys";
import { loadYamlConfig } from "./yaml-source";

export interface LoadAppConfigOptions {
  cwd?: string;
  envFiles?: string[];
  yamlFiles?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * 引导式配置加载：必须在 `NestFactory.create(AppModule.forRoot(config))` 之前调用。
 * 1. 读 `.env`（写进 process.env，不覆盖已有）—— 提供 Nacos 引导变量与扁平 secret。
 * 2. `NACOS_SERVER_ADDR` 存在 → 从 Nacos 拉嵌套配置；否则读本地 YAML。
 * 3. 用传入的 zod schema 校验嵌套对象，返回强类型嵌套配置。
 */
export async function loadAppConfig<S extends ZodType>(
  schema: S,
  options: LoadAppConfigOptions = {},
): Promise<z.output<S>> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const envFiles = options.envFiles ?? [];
  const yamlFiles = options.yamlFiles ?? [];

  for (const file of envFiles) {
    loadDotenv({ path: path.resolve(cwd, file), processEnv: env, override: false });
  }

  const bootstrap = readNacosBootstrap(env);
  const source: "nacos" | "yaml" = bootstrap ? "nacos" : "yaml";
  const nested = bootstrap
    ? await loadNacosConfig(bootstrap)
    : loadYamlConfig(yamlFiles.map((f) => path.resolve(cwd, f)));

  const normalized = normalizeKeys(nested);

  const parsed = schema.safeParse(normalized);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `[config-loader] 配置校验失败（源=${source}）：\n${issues}\n` +
        "请检查 YAML / Nacos 配置内容或 .env 引导变量是否齐全 / 合法。",
    );
  }

  console.log(`[config-loader] 配置源=${source}，已加载并校验通过`);
  return parsed.data;
}
```

- [ ] **Step 7: 更新 barrel export**

Modify `libs/common/src/config/index.ts` 为：

```ts
export { createEnvValidator } from "./env-schema";
export { loadAppConfig, type LoadAppConfigOptions } from "./config-loader";
export { normalizeKeys } from "./normalize-keys";
```

确认 `libs/common/src/index.ts` 已 `export * from "./config"`（若没有则补上 `export * from "./config";`）。

- [ ] **Step 8: typecheck + 提交**

Run: `pnpm --filter @meshbot/common typecheck && pnpm test -- libs/common/src/config/normalize-keys.spec.ts`
Expected: PASS

```bash
git add libs/common/src/config libs/common/package.json libs/common/src/index.ts pnpm-lock.yaml
git commit -m "feat(common): 移植 loadAppConfig（Nacos/YAML 配置加载）到 libs/common"
```

---

### Task 2: server-main 邮件发送（EmailSender + DirectMail + Log 兜底）

新增可插拔邮件发送器，发组织邀请邮件。放 server-main 而非 libs/main（DirectMail SDK 是 app 级依赖，与 qriter 一致放 app）。

**Files:**
- Create: `apps/server-main/src/email/email-sender.ts`
- Create: `apps/server-main/src/email/email-sender.spec.ts`
- Create: `apps/server-main/src/email/email.module.ts`
- Modify: `apps/server-main/package.json`（加 `@alicloud/dm20151123`、`@alicloud/openapi-client`、`@alicloud/tea-util`）

- [ ] **Step 1: 加依赖**

`apps/server-main/package.json` 的 `dependencies` 加：

```json
"@alicloud/dm20151123": "^1.10.0",
"@alicloud/openapi-client": "^0.4.15",
"@alicloud/tea-util": "^1.4.11",
```

根目录 `pnpm install`。

- [ ] **Step 2: 写邮件发送器的失败测试**

Create `apps/server-main/src/email/email-sender.spec.ts`：

```ts
import { LogEmailSender } from "./email-sender";

describe("LogEmailSender", () => {
  it("sendInvitation 不真实发送，记录日志且不抛错", async () => {
    const sender = new LogEmailSender();
    await expect(
      sender.sendInvitation("bob@test.io", {
        orgName: "Acme",
        inviterName: "Alice",
        code: "abc123",
        expiresAt: new Date("2026-06-18T00:00:00Z"),
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test -- apps/server-main/src/email/email-sender.spec.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 4: 写 email-sender 实现**

Create `apps/server-main/src/email/email-sender.ts`：

```ts
import Dm, { SingleSendMailRequest } from "@alicloud/dm20151123";
import * as OpenApi from "@alicloud/openapi-client";
import * as Util from "@alicloud/tea-util";
import { Logger } from "@nestjs/common";

import type { EmailConfig } from "../config/app-config.schema";

/** 一封组织邀请邮件的内容参数。 */
export interface InvitationMail {
  orgName: string;
  inviterName: string;
  /** 邀请码（invitation.token），收件人在桌面端粘贴加入。 */
  code: string;
  expiresAt: Date;
}

/** 邮件发送端口。Phase 1 只发组织邀请。 */
export interface EmailSender {
  sendInvitation(to: string, mail: InvitationMail): Promise<void>;
}

/** EmailSender 的 DI token。 */
export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

function buildInvitationText(mail: InvitationMail): { subject: string; text: string } {
  const expires = mail.expiresAt.toISOString().slice(0, 10);
  return {
    subject: `${mail.inviterName} 邀请你加入「${mail.orgName}」`,
    text:
      `${mail.inviterName} 邀请你加入企业「${mail.orgName}」。\n\n` +
      `请在 meshbot 桌面端登录后，进入「加入组织」并粘贴以下邀请码：\n\n` +
      `    ${mail.code}\n\n` +
      `邀请码有效期至 ${expires}。若非本人预期，请忽略本邮件。`,
  };
}

/** 阿里云邮件推送 DirectMail 实现（SingleSendMail）。凭证走 config.email。 */
export class DirectMailEmailSender implements EmailSender {
  private readonly client: Dm;
  private readonly accountName: string;
  private readonly fromAlias?: string;

  constructor(config: EmailConfig) {
    const openapi = new OpenApi.Config({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
    });
    openapi.endpoint = config.endpoint;
    this.client = new Dm(openapi);
    this.accountName = config.accountName;
    this.fromAlias = config.from;
  }

  async sendInvitation(to: string, mail: InvitationMail): Promise<void> {
    const { subject, text } = buildInvitationText(mail);
    const request = new SingleSendMailRequest({
      accountName: this.accountName,
      addressType: 1,
      replyToAddress: false,
      toAddress: to,
      subject,
      textBody: text,
      fromAlias: this.fromAlias,
    });
    await this.client.singleSendMailWithOptions(
      request,
      new Util.RuntimeOptions({}),
    );
  }
}

/** 未配置 config.email 时的兜底：把邀请码打到 server 日志（仅开发用）。 */
export class LogEmailSender implements EmailSender {
  private readonly logger = new Logger("LogEmailSender");

  async sendInvitation(to: string, mail: InvitationMail): Promise<void> {
    this.logger.warn(
      `[DEV] 未配置 config.email，邀请邮件不真实发送 —— to=${to} ` +
        `org=${mail.orgName} code=${mail.code}`,
    );
  }
}
```

> 注：`EmailConfig` 类型由 Task 3 创建。Task 顺序保证 Task 3 在编译前完成；若先编译 Task 2 会因缺 `EmailConfig` 失败 —— 因此本任务的 typecheck 放在 Task 3 之后（见 Task 3 Step 5）。本任务只跑该 spec（spec 仅用 `LogEmailSender`，不触达 `EmailConfig` 的运行期）。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test -- apps/server-main/src/email/email-sender.spec.ts`
Expected: PASS

- [ ] **Step 6: 写 email.module.ts**

Create `apps/server-main/src/email/email.module.ts`：

```ts
import { Module } from "@nestjs/common";

import { APP_CONFIG, type AppConfig } from "../config/app-config.schema";
import {
  DirectMailEmailSender,
  EMAIL_SENDER,
  LogEmailSender,
} from "./email-sender";

/**
 * 邮件模块。按 config.email 是否存在选择 DirectMail / Log 实现。
 * 通过 EMAIL_SENDER token 暴露给 InvitationService（Task 7）。
 */
@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.email
          ? new DirectMailEmailSender(config.email)
          : new LogEmailSender(),
    },
  ],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
```

> `APP_CONFIG`/`AppConfig` 由 Task 3 创建。本步骤不单独 typecheck，留到 Task 3 Step 5 一并验证。

- [ ] **Step 7: 提交**

```bash
git add apps/server-main/src/email apps/server-main/package.json pnpm-lock.yaml
git commit -m "feat(server-main): 新增可插拔 EmailSender（阿里 DirectMail + Log 兜底）"
```

---

### Task 3: server-main 配置 schema + bootstrap 切换到 loadAppConfig

把 server-main 从 `EnvSchema` + `ConfigModule` 切到 qriter 式 `AppConfigSchema` + `AppModule.forRoot(config)`，新增 `email` 切片。

**Files:**
- Create: `apps/server-main/src/config/app-config.schema.ts`
- Create: `apps/server-main/src/config/app-config.module.ts`
- Create: `apps/server-main/conf/application.yml`
- Create: `apps/server-main/conf/.gitignore`
- Modify: `apps/server-main/src/main.ts`
- Modify: `apps/server-main/src/app.module.ts`
- Delete: `apps/server-main/src/env.schema.ts`

- [ ] **Step 1: 写 app-config.schema.ts**

Create `apps/server-main/src/config/app-config.schema.ts`：

```ts
import { z } from "zod";

/** 数据库配置 —— 直接映射 TypeORM postgres DataSourceOptions。 */
export const DatabaseConfigSchema = z
  .object({
    type: z.literal("postgres").default("postgres"),
    host: z.string().default("localhost"),
    port: z.coerce.number().int().min(1).max(65535).default(5432),
    username: z.string(),
    password: z.string(),
    database: z.string(),
    synchronize: z.boolean().default(false),
    autoLoadEntities: z.boolean().default(true),
    logging: z.union([z.boolean(), z.array(z.string())]).optional(),
  })
  .passthrough();

/** JWT 签名配置。 */
export const JwtConfigSchema = z.object({
  secret: z.string().min(16, "jwt.secret 至少 16 字符（生产建议 32 字节随机串）"),
  expires: z
    .string()
    .regex(/^\d+[smhd]$/, "jwt.expires 形如 7d / 12h / 60m / 3600s")
    .default("7d"),
});

/** Redis 配置（可选）。未配置 → 锁/缓存/限流走 memory 兜底。 */
export const RedisConfigSchema = z.object({
  host: z.string(),
  port: z.coerce.number().int().min(1).max(65535).default(6379),
  db: z.coerce.number().int().min(0).max(15).default(0),
  password: z.string().optional(),
});

/** 邮件发送配置（可选）—— 阿里云 DirectMail。未配置 → LogEmailSender 兜底。 */
export const EmailConfigSchema = z.object({
  endpoint: z.string().default("dm.aliyuncs.com"),
  accountName: z.string(),
  accessKeyId: z.string(),
  accessKeySecret: z.string(),
  from: z.string().optional(),
});

/** 邀请配置。过期天数。 */
export const InvitationConfigSchema = z.object({
  expiresDays: z.coerce.number().int().min(1).max(30).default(7),
});

export const AppConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3200),
  database: DatabaseConfigSchema,
  jwt: JwtConfigSchema,
  redis: RedisConfigSchema.optional(),
  email: EmailConfigSchema.optional(),
  invitation: InvitationConfigSchema.default({ expiresDays: 7 }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type JwtConfig = z.infer<typeof JwtConfigSchema>;
export type RedisConfig = z.infer<typeof RedisConfigSchema>;
export type EmailConfig = z.infer<typeof EmailConfigSchema>;
export type InvitationConfig = z.infer<typeof InvitationConfigSchema>;

/** 全局 DI token —— 持有强类型嵌套 AppConfig。 */
export const APP_CONFIG = Symbol("APP_CONFIG");
```

- [ ] **Step 2: 写 app-config.module.ts**

Create `apps/server-main/src/config/app-config.module.ts`：

```ts
import { Global, Module } from "@nestjs/common";

import { type AppConfig, APP_CONFIG } from "./app-config.schema";

/**
 * 全局配置模块。持有 loadAppConfig 产出的强类型 AppConfig，
 * 通过 APP_CONFIG token 注入各模块。
 */
@Global()
@Module({})
export class AppConfigModule {
  static forRoot(config: AppConfig) {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
```

- [ ] **Step 3: 写本地开发 YAML + gitignore**

Create `apps/server-main/conf/application.yml`：

```yaml
# server-main 本地开发配置（提交，含 localhost 默认值，pnpm dev 开箱即用）。
# 部署环境在 .env 配置 NACOS_SERVER_ADDR 后，本文件不会被读取（loader 走 Nacos 分支）。
# 个人覆盖：写进 conf/application.local.yml（已 gitignore）。
port: 3200

database:
  type: postgres
  host: localhost
  port: 5432
  username: meshbot
  password: meshbot
  database: meshbot_main
  synchronize: false
  autoLoadEntities: true
  logging:
    - error
    - warn
    - migration

jwt:
  secret: meshbot-main-dev-secret-change-in-prod-min-16
  expires: 7d

invitation:
  expiresDays: 7

# Redis：留空走 memory 兜底；本地起 redis 后再启用。
# redis:
#   host: localhost
#   port: 6379
#   db: 0

# 邮件：留空走 LogEmailSender（邀请码打日志）；接阿里 DirectMail 时填。
# email:
#   endpoint: dm.aliyuncs.com
#   accountName: noreply@your-domain.com
#   accessKeyId: <ak>
#   accessKeySecret: <sk>
#   from: meshbot
```

Create `apps/server-main/conf/.gitignore`：

```
application.local.yml
```

- [ ] **Step 4: 改 main.ts 用 loadAppConfig**

Replace `apps/server-main/src/main.ts` 全文为：

```ts
import {
  ErrorsFilter,
  I18nZodValidationPipe,
  loadAppConfig,
  ResponseInterceptor,
  traceIdMiddleware,
} from "@meshbot/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { I18nService } from "nestjs-i18n";
import { AppConfigSchema } from "./config/app-config.schema";
import { AppModule } from "./app.module";
import { setupSwagger } from "./app.swagger";

async function bootstrap() {
  // 配置加载在 Nest 生命周期之外：从 YAML / Nacos 读成强类型嵌套 AppConfig 并校验。
  const config = await loadAppConfig(AppConfigSchema, {
    cwd: process.cwd(),
    envFiles: [".env"],
    yamlFiles: ["conf/application.yml", "conf/application.local.yml"],
  });

  const app = await NestFactory.create(AppModule.forRoot(config));

  // 标准全局链路（顺序：trace → pipe → interceptor → filter）
  app.use(traceIdMiddleware);
  const i18n = app.get(I18nService);
  const reflector = app.get(Reflector);
  app.useGlobalPipes(new I18nZodValidationPipe(i18n));
  app.useGlobalInterceptors(new ResponseInterceptor(reflector));
  app.useGlobalFilters(new ErrorsFilter(i18n));

  app.setGlobalPrefix("api");

  if (process.env.NODE_ENV !== "production") {
    setupSwagger(app);
  }

  await app.listen(config.port);
  console.log(`server-main running on http://localhost:${config.port}`);
}

bootstrap();
```

- [ ] **Step 5: 改 app.module.ts 为 forRoot(config) 形态**

Replace `apps/server-main/src/app.module.ts` 全文为下面内容（关键改动：`forRoot(config)` 接收配置、`AppConfigModule.forRoot(config)`、`EmailModule`、`OrgModule`（Task 8 加，先 import 占位会编译失败，故本步先不加 OrgModule，Task 8 再补）、TypeORM/Redis/JWT/Throttler 改从 `config` 切片读，删除 `ConfigModule`/`EnvSchema`）：

```ts
import path from "node:path";
import {
  CommonModule,
  type CommonModuleOptions,
  FailOpenThrottlerStorage,
  PlainTextLogger,
  ProxyThrottlerGuard,
  RedisCacheProvider,
  RedisHealthIndicator,
  RedisLockProvider,
} from "@meshbot/common";
import { MainModule } from "@meshbot/main";
import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { TerminusModule } from "@nestjs/terminus";
import {
  type ThrottlerModuleOptions,
  ThrottlerModule,
} from "@nestjs/throttler";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import Redis from "ioredis";
import {
  AcceptLanguageResolver,
  CookieResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  QueryResolver,
} from "nestjs-i18n";
import { SnakeNamingStrategy } from "typeorm-naming-strategies";
import { type AppConfig, APP_CONFIG } from "./config/app-config.schema";
import { AppConfigModule } from "./config/app-config.module";
import { EmailModule } from "./email/email.module";
import { HealthController } from "./health.controller";
import { AuthController } from "./rest/auth.controller";
import { HealthGateway } from "./ws/health.gateway";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { JwtMainStrategy } from "./auth/jwt.strategy";
import { PassportModule } from "@nestjs/passport";

const REDIS_CLIENT = Symbol("REDIS_CLIENT");

class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}
  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

function buildRedis(config: AppConfig): Redis | null {
  if (!config.redis) return null;
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    db: config.redis.db,
    password: config.redis.password,
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  redis.on("error", (err: Error) => {
    new Logger("RedisClient").error(
      `Redis 连接错误（ioredis 将自动重连）：${err.message}`,
    );
  });
  return redis;
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const isProd = process.env.NODE_ENV === "production";
    const redis = buildRedis(config);

    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(config),
        CommonModule.forRoot(
          redis
            ? ({
                lock: new RedisLockProvider(redis),
                cache: new RedisCacheProvider(redis),
              } satisfies CommonModuleOptions)
            : {},
        ),
        I18nModule.forRoot({
          fallbackLanguage: "zh",
          loader: I18nJsonLoader,
          loaderOptions: {
            path: path.join(__dirname, "i18n"),
            watch: !isProd,
          },
          resolvers: [
            new CookieResolver(["locale"]),
            new HeaderResolver(["x-lang"]),
            new AcceptLanguageResolver(),
            new QueryResolver(["lang"]),
          ],
        }),
        TypeOrmModule.forRoot({
          ...config.database,
          namingStrategy: new SnakeNamingStrategy(),
          migrationsRun: !isProd,
          migrations: [path.join(__dirname, "migrations", "*.{js,ts}")],
          ...(isProd
            ? {
                logger: new PlainTextLogger(),
                extra: { options: "-c timezone=UTC" },
              }
            : {}),
        }),
        PassportModule,
        JwtModule.register({
          secret: config.jwt.secret,
          signOptions: { expiresIn: config.jwt.expires as `${number}d` },
        }),
        ThrottlerModule.forRoot({
          throttlers: [
            { name: "short", ttl: 1000, limit: 30 },
            { name: "medium", ttl: 60_000, limit: 300 },
            { name: "long", ttl: 3_600_000, limit: 5000 },
          ],
          ...(redis
            ? {
                storage: new FailOpenThrottlerStorage(
                  new ThrottlerStorageRedisService(redis),
                ),
              }
            : {}),
        } satisfies ThrottlerModuleOptions),
        TerminusModule,
        EmailModule,
        MainModule,
      ],
      controllers: [HealthController, AuthController],
      providers: [
        { provide: REDIS_CLIENT, useValue: redis },
        RedisLifecycle,
        RedisHealthIndicator,
        HealthGateway,
        JwtMainStrategy,
        { provide: APP_GUARD, useClass: ProxyThrottlerGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    };
  }
}
```

> 注：原 `AuthModule`（提供 JwtModule + JwtMainStrategy）的职责已内联进 `forRoot`。删掉 `apps/server-main/src/auth/auth.module.ts` 的 import（保留 jwt.strategy / guard / 装饰器文件）。`auth.controller.ts` 注入的 `ConfigService` 在 Task 6 改为注入 `APP_CONFIG`（先保持现状会编译失败 → 本步同时改 auth.controller，见下）。

修改 `apps/server-main/src/rest/auth.controller.ts`：把 `ConfigService` 注入换成 `APP_CONFIG`：
- 删除 `import { ConfigService } from "@nestjs/config";`
- 加 `import { type AppConfig, APP_CONFIG } from "../config/app-config.schema";` 和 `import { Inject } from "@nestjs/common";`
- 构造函数 `private readonly config: ConfigService` 改为 `@Inject(APP_CONFIG) private readonly config: AppConfig`
- `signResponse` 里 `this.config.get<string>("JWT_EXPIRES") ?? "7d"` 改为 `this.config.jwt.expires`

`jwt.strategy.ts` 与 `jwt-auth.guard.ts` 当前从 `ConfigService` 读 `JWT_SECRET`。把 `jwt.strategy.ts` 构造函数改为注入 `APP_CONFIG`：
- 删 `import { ConfigService } from "@nestjs/config";`
- 加 `import { Inject } from "@nestjs/common";` 与 `import { type AppConfig, APP_CONFIG } from "../config/app-config.schema";`
- 构造函数改 `constructor(@Inject(APP_CONFIG) config: AppConfig) { super({ ..., secretOrKey: config.jwt.secret }); }`

- [ ] **Step 6: 删除 env.schema.ts**

```bash
git rm apps/server-main/src/env.schema.ts apps/server-main/src/auth/auth.module.ts
```

- [ ] **Step 7: typecheck（覆盖 Task 2 + Task 3）**

Run: `pnpm --filter @meshbot/server-main typecheck`
Expected: PASS（无 `EnvSchema` / `ConfigService` 残留引用；若 `health.controller.ts` 或别处引用了 `ConfigService`，同样改注入 `APP_CONFIG` 或删除）

- [ ] **Step 8: 启动冒烟（需要本地 Postgres）**

Run: `pnpm dev:db:up`（启动 Postgres）然后 `pnpm dev:server-main`
Expected: 日志出现 `[config-loader] 配置源=yaml，已加载并校验通过` 与 `server-main running on http://localhost:3200`，无报错。Ctrl-C 退出。

- [ ] **Step 9: 提交**

```bash
git add apps/server-main pnpm-lock.yaml
git commit -m "feat(server-main): 配置体系切到 loadAppConfig（Nacos/YAML）+ 接入 EmailModule"
```

---

## Part B — server-main 组织域

### Task 4: types-main 组织/邀请 Zod schema

跨前后端共享的组织/邀请数据模型放 `libs/types-main`（禁止依赖 NestJS/TypeORM）。

**Files:**
- Create: `libs/types-main/src/org/create-org.schema.ts`
- Create: `libs/types-main/src/org/org.types.ts`
- Create: `libs/types-main/src/org/org.spec.ts`
- Modify: `libs/types-main/src/index.ts`

- [ ] **Step 1: 写 schema 的失败测试**

Create `libs/types-main/src/org/org.spec.ts`：

```ts
import { CreateOrgSchema, AcceptInvitationSchema, CreateInvitationSchema } from "./create-org.schema";

describe("org schemas", () => {
  it("CreateOrgSchema 拒绝空名、接受 1-64 字符", () => {
    expect(CreateOrgSchema.safeParse({ name: "" }).success).toBe(false);
    expect(CreateOrgSchema.safeParse({ name: "Acme" }).success).toBe(true);
    expect(CreateOrgSchema.safeParse({ name: "x".repeat(65) }).success).toBe(false);
  });

  it("CreateInvitationSchema 校验邮箱", () => {
    expect(CreateInvitationSchema.safeParse({ email: "bad" }).success).toBe(false);
    expect(CreateInvitationSchema.safeParse({ email: "b@x.io" }).success).toBe(true);
  });

  it("AcceptInvitationSchema 要求非空 token", () => {
    expect(AcceptInvitationSchema.safeParse({ token: "" }).success).toBe(false);
    expect(AcceptInvitationSchema.safeParse({ token: "abc" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- libs/types-main/src/org/org.spec.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 写 schema 实现**

Create `libs/types-main/src/org/create-org.schema.ts`：

```ts
import { z } from "zod";

/** 创建组织。 */
export const CreateOrgSchema = z.object({
  name: z
    .string()
    .min(1, { message: "validation.required" })
    .max(64, { message: "validation.stringTooLong" }),
});
export type CreateOrgInput = z.infer<typeof CreateOrgSchema>;

/** owner 邀请成员（按邮箱）。 */
export const CreateInvitationSchema = z.object({
  email: z
    .string()
    .email({ message: "validation.invalidEmail" })
    .max(255, { message: "validation.stringTooLong" }),
});
export type CreateInvitationInput = z.infer<typeof CreateInvitationSchema>;

/** 接受邀请（粘贴邀请码）。 */
export const AcceptInvitationSchema = z.object({
  token: z.string().min(1, { message: "validation.required" }),
});
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;
```

> 注：spec §5.1 提到的 `PUT /api/me/active-org`（切活跃组织）Phase 1 UI 不暴露、也无消费方，按 YAGNI 暂不建 schema/端点（建了会触发 `check:dead` 死导出）。留到 Phase 2+ 多组织切换 UI 落地时一起加。

Create `libs/types-main/src/org/org.types.ts`（响应 DTO 形状，前后端共享）：

```ts
/** 组织角色。Phase 1 仅 owner / member。 */
export type OrgRole = "owner" | "member";

/** 邀请状态。 */
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

/** 组织摘要（列表 / profile 用）。 */
export interface OrgSummary {
  id: string;
  name: string;
  role: OrgRole;
}

/** 成员摘要。 */
export interface MemberSummary {
  userId: string;
  email: string;
  displayName: string;
  role: OrgRole;
}

/** 邀请摘要（owner 查看用，含 token 供桌面端复制/重发文案）。 */
export interface InvitationSummary {
  id: string;
  email: string;
  status: InvitationStatus;
  token: string;
  expiresAt: string;
  createdAt: string;
}
```

- [ ] **Step 4: 更新 barrel export**

Modify `libs/types-main/src/index.ts` 追加：

```ts
export * from "./org/create-org.schema";
export * from "./org/org.types";
```

- [ ] **Step 5: 运行测试 + typecheck + 提交**

Run: `pnpm test -- libs/types-main/src/org/org.spec.ts && pnpm --filter @meshbot/types-main typecheck`
Expected: PASS

```bash
git add libs/types-main/src
git commit -m "feat(types-main): 组织/邀请共享 Zod schema 与响应类型"
```

---

### Task 5: libs/main 组织实体 + DTO + 错误码 + AppUser 扩展

**Files:**
- Create: `libs/main/src/entities/organization.entity.ts`
- Create: `libs/main/src/entities/membership.entity.ts`
- Create: `libs/main/src/entities/invitation.entity.ts`
- Modify: `libs/main/src/entities/app-user.entity.ts`（加 `activeOrgId`）
- Modify: `libs/main/src/errors/main.error-codes.ts`（加 4 个 code）
- Modify: `libs/main/src/dto/index.ts`（加组织/邀请 DTO）
- Modify: `libs/main/src/index.ts`（导出新实体 + DTO）

- [ ] **Step 1: 写实体**

Create `libs/main/src/entities/organization.entity.ts`：

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/** 企业/组织（单层）。owner_id 与 Membership.role=owner 冗余，便于直查。 */
@Entity("organization")
export class Organization {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 64 })
  name!: string;

  @Column({ type: "uuid" })
  ownerId!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
```

Create `libs/main/src/entities/membership.entity.ts`：

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/** 用户↔组织 多对多成员关系。唯一索引 (org_id, user_id)。 */
@Entity("membership")
@Index("idx_membership_org_user", ["orgId", "userId"], { unique: true })
@Index("idx_membership_user", ["userId"])
export class Membership {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  orgId!: string;

  @Column({ type: "uuid" })
  userId!: string;

  /** "owner" | "member"。 */
  @Column({ type: "varchar", length: 16 })
  role!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
```

Create `libs/main/src/entities/invitation.entity.ts`：

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/** 组织邀请。token 即邮件邀请码。 */
@Entity("invitation")
@Index("idx_invitation_token", ["token"], { unique: true })
export class Invitation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  orgId!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 64 })
  token!: string;

  /** "pending" | "accepted" | "revoked" | "expired"。 */
  @Column({ type: "varchar", length: 16, default: "pending" })
  status!: string;

  @Column({ type: "uuid" })
  invitedBy!: string;

  @Column({ type: "timestamptz" })
  expiresAt!: Date;

  @Column({ type: "uuid", nullable: true })
  acceptedBy!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  acceptedAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
```

- [ ] **Step 2: 扩展 AppUser**

Modify `libs/main/src/entities/app-user.entity.ts`，在 `displayName` 列之后加：

```ts
  @Column({ type: "uuid", nullable: true })
  activeOrgId!: string | null;
```

- [ ] **Step 3: 加错误码**

Modify `libs/main/src/errors/main.error-codes.ts`，在 `AUTH_INVALID_CREDENTIALS` 之后（对象内）追加（code 紧接 2002 不跳号）：

```ts
  ORG_NOT_FOUND: {
    code: 2003,
    message: "org.notFound",
  },
  ORG_FORBIDDEN: {
    code: 2004,
    message: "org.forbidden",
    httpStatus: 403,
  },
  INVITATION_INVALID: {
    code: 2005,
    message: "org.invitationInvalid",
  },
  INVITATION_EXPIRED: {
    code: 2006,
    message: "org.invitationExpired",
  },
```

- [ ] **Step 4: 加 i18n（错误码 message key 必须有翻译）**

Create `apps/server-main/i18n/zh/org.json`：

```json
{
  "notFound": "组织不存在",
  "forbidden": "无权操作该组织",
  "invitationInvalid": "邀请码无效或已失效",
  "invitationExpired": "邀请码已过期"
}
```

Create `apps/server-main/i18n/en/org.json`：

```json
{
  "notFound": "Organization not found",
  "forbidden": "No permission for this organization",
  "invitationInvalid": "Invitation is invalid or revoked",
  "invitationExpired": "Invitation has expired"
}
```

- [ ] **Step 5: 加 DTO**

Modify `libs/main/src/dto/index.ts`，追加：

```ts
import {
  AcceptInvitationSchema,
  type AcceptInvitationInput,
  CreateInvitationSchema,
  type CreateInvitationInput,
  CreateOrgSchema,
  type CreateOrgInput,
} from "@meshbot/types-main";

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge
export class CreateOrgDto extends createI18nZodDto(CreateOrgSchema) {}
export interface CreateOrgDto extends CreateOrgInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge
export class CreateInvitationDto extends createI18nZodDto(CreateInvitationSchema) {}
export interface CreateInvitationDto extends CreateInvitationInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge
export class AcceptInvitationDto extends createI18nZodDto(AcceptInvitationSchema) {}
export interface AcceptInvitationDto extends AcceptInvitationInput {}
```

- [ ] **Step 6: 导出新实体**

Modify `libs/main/src/index.ts`，追加：

```ts
export * from "./entities/organization.entity";
export * from "./entities/membership.entity";
export * from "./entities/invitation.entity";
```

（`./dto` 已经 `export *`，无需改。）

- [ ] **Step 7: typecheck + 围栏 + 提交**

Run: `pnpm --filter @meshbot/main typecheck && pnpm check:error-code`
Expected: PASS（error-code 围栏：2003-2006 连续无跳号）

```bash
git add libs/main apps/server-main/i18n
git commit -m "feat(main): Organization/Membership/Invitation 实体 + AppUser.activeOrgId + 错误码"
```

---

### Task 6: server-main 组织迁移 + 更新 CLI DataSource entities

**Files:**
- Create: `apps/server-main/src/migrations/1779000000000-OrgSchema.ts`
- Modify: `apps/server-main/test/setup/test-db.ts`（注册新实体 + 新迁移）

- [ ] **Step 1: 写迁移**

Create `apps/server-main/src/migrations/1779000000000-OrgSchema.ts`：

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 组织域 schema：organization / membership / invitation 三张表，
 * 外加 app_user.active_org_id 列。logical FK，无数据库外键约束。
 */
export class OrgSchema1779000000000 implements MigrationInterface {
  name = "OrgSchema1779000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_user"
      ADD COLUMN IF NOT EXISTS "active_org_id" uuid
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "organization" (
        "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
        "name"       varchar(64)  NOT NULL,
        "owner_id"   uuid         NOT NULL,
        "created_at" timestamptz  NOT NULL DEFAULT now(),
        "updated_at" timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_organization" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "membership" (
        "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
        "org_id"     uuid         NOT NULL,
        "user_id"    uuid         NOT NULL,
        "role"       varchar(16)  NOT NULL,
        "created_at" timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_membership" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_membership_org_user" ON "membership" ("org_id", "user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_membership_user" ON "membership" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "invitation" (
        "id"          uuid         NOT NULL DEFAULT gen_random_uuid(),
        "org_id"      uuid         NOT NULL,
        "email"       varchar(255) NOT NULL,
        "token"       varchar(64)  NOT NULL,
        "status"      varchar(16)  NOT NULL DEFAULT 'pending',
        "invited_by"  uuid         NOT NULL,
        "expires_at"  timestamptz  NOT NULL,
        "accepted_by" uuid,
        "accepted_at" timestamptz,
        "created_at"  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_invitation" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitation_token" ON "invitation" ("token")`,
    );
    // 同组织同邮箱仅允许一条 pending（防重复邀请）
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitation_org_email_pending" ON "invitation" ("org_id", "email") WHERE "status" = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "invitation" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "membership" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "organization" CASCADE`);
    await queryRunner.query(`ALTER TABLE "app_user" DROP COLUMN IF EXISTS "active_org_id"`);
  }
}
```

- [ ] **Step 2: 更新 E2E test-db 注册新实体 + 迁移**

Modify `apps/server-main/test/setup/test-db.ts`：
- import 追加：
```ts
import { Membership } from "../../../../libs/main/src/entities/membership.entity";
import { Organization } from "../../../../libs/main/src/entities/organization.entity";
import { Invitation } from "../../../../libs/main/src/entities/invitation.entity";
import { OrgSchema1779000000000 } from "../../src/migrations/1779000000000-OrgSchema";
```
- `entities: [AppUser]` 改为 `entities: [AppUser, Organization, Membership, Invitation]`
- `migrations: [InitialSchema1778869010469]` 改为 `migrations: [InitialSchema1778869010469, OrgSchema1779000000000]`

- [ ] **Step 3: 跑迁移冒烟（需要本地 Postgres）**

Run: `pnpm dev:db:up && pnpm --filter @meshbot/server-main migration run`
Expected: 迁移 `OrgSchema1779000000000` 执行成功，无报错。

> 若 `migration run` 子命令名不同，先跑 `pnpm --filter @meshbot/server-main migration` 看 help。CLI 脚本是 `tsx ../../scripts/typeorm-cli.ts src/data-source.cli.ts`，data-source.cli.ts 用 glob 自动加载 `libs/main/**/*.entity.ts`，无需改它。

- [ ] **Step 4: 提交**

```bash
git add apps/server-main/src/migrations apps/server-main/test/setup/test-db.ts
git commit -m "feat(server-main): 组织域迁移（organization/membership/invitation + active_org_id）"
```

---

### Task 7: OrgService / MembershipService / InvitationService

三个 Service，按 check:repo 各自唯一持有对应 Entity 的 Repository。建组织、邀请、接受邀请涉及跨表写 → `@Transactional()`；接受邀请并发幂等 → `@WithLock` 外层。

**Files:**
- Create: `libs/main/src/services/org.service.ts`
- Create: `libs/main/src/services/membership.service.ts`
- Create: `libs/main/src/services/invitation.service.ts`
- Create: `libs/main/src/services/org.service.spec.ts`
- Modify: `libs/main/src/main.module.ts`（注册新实体 + Service + EmailSender 依赖）
- Modify: `libs/main/src/index.ts`（导出 Service）
- Modify: `libs/main/package.json`（依赖已含 nanoid，用于 token 生成）

- [ ] **Step 1: 写 MembershipService（被 Org/Invitation 复用，先建）**

Create `libs/main/src/services/membership.service.ts`：

```ts
import type { MemberSummary, OrgRole, OrgSummary } from "@meshbot/types-main";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import { AppUser } from "../entities/app-user.entity";
import { Membership } from "../entities/membership.entity";
import { Organization } from "../entities/organization.entity";

/**
 * Membership 的唯一归属 Service。组织成员关系的读写。
 * 注：Organization / AppUser 的读用于拼装摘要，但写各自归属 Service —— 这里
 * 仅注入 Membership 的 Repository（check:repo：跨 Entity 写不在此处）。
 * Organization / AppUser 的 Repository 注入分别在 OrgService / UserService；
 * 本 Service 读它们用 manager 查询（只读、不写），符合「唯一写归属」约束。
 */
@Injectable()
export class MembershipService {
  constructor(
    @InjectRepository(Membership)
    private readonly membershipRepo: Repository<Membership>,
  ) {}

  /** 列出某用户的所有组织（带角色）。 */
  async listOrgsForUser(userId: string): Promise<OrgSummary[]> {
    const rows = await this.membershipRepo
      .createQueryBuilder("m")
      .innerJoin(Organization, "o", "o.id = m.org_id")
      .where("m.user_id = :userId", { userId })
      .select(["o.id AS id", "o.name AS name", "m.role AS role"])
      .getRawMany<{ id: string; name: string; role: OrgRole }>();
    return rows;
  }

  /** 列出某组织的成员（带 email/displayName）。 */
  async listMembers(orgId: string): Promise<MemberSummary[]> {
    const rows = await this.membershipRepo
      .createQueryBuilder("m")
      .innerJoin(AppUser, "u", "u.id = m.user_id")
      .where("m.org_id = :orgId", { orgId })
      .select([
        "m.user_id AS \"userId\"",
        "u.email AS email",
        "u.display_name AS \"displayName\"",
        "m.role AS role",
      ])
      .getRawMany<MemberSummary>();
    return rows;
  }

  /** 用户是否为某组织成员。 */
  async isMember(orgId: string, userId: string): Promise<boolean> {
    const count = await this.membershipRepo.count({ where: { orgId, userId } });
    return count > 0;
  }

  /** 用户在某组织的角色；非成员返回 null。 */
  async roleOf(orgId: string, userId: string): Promise<OrgRole | null> {
    const row = await this.membershipRepo.findOne({ where: { orgId, userId } });
    return (row?.role as OrgRole) ?? null;
  }
}
```

- [ ] **Step 2: 写 OrgService 的失败测试**

Create `libs/main/src/services/org.service.spec.ts`：

```ts
import { AppError } from "@meshbot/common";
import { MainErrorCode } from "../errors/main.error-codes";
import { OrgService } from "./org.service";

/**
 * 单测聚焦 OrgService 的纯逻辑分支（权限校验），用最小手写桩替代 Repository。
 * 完整的建组织 + 事务持久化由 Task 9 E2E 覆盖。
 */
describe("OrgService.assertOwner", () => {
  function build(roleOf: (orgId: string, userId: string) => Promise<string | null>) {
    const membership = { roleOf } as unknown as import("./membership.service").MembershipService;
    return new OrgService(
      {} as never, // orgRepo 不在该用例触达
      {} as never, // userRepo 不在该用例触达
      membership,
    );
  }

  it("非 owner 抛 ORG_FORBIDDEN", async () => {
    const svc = build(async () => "member");
    await expect(svc.assertOwner("org1", "user1")).rejects.toMatchObject({
      errorCode: MainErrorCode.ORG_FORBIDDEN,
    });
  });

  it("owner 通过", async () => {
    const svc = build(async () => "owner");
    await expect(svc.assertOwner("org1", "user1")).resolves.toBeUndefined();
  });

  it("非成员抛 ORG_FORBIDDEN", async () => {
    const svc = build(async () => null);
    await expect(svc.assertOwner("org1", "user1")).rejects.toBeInstanceOf(AppError);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test -- libs/main/src/services/org.service.spec.ts`
Expected: FAIL（找不到 OrgService）

- [ ] **Step 4: 写 OrgService**

Create `libs/main/src/services/org.service.ts`：

```ts
import { AppError, Transactional } from "@meshbot/common";
import type { OrgSummary } from "@meshbot/types-main";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import { AppUser } from "../entities/app-user.entity";
import { Organization } from "../entities/organization.entity";
import { Membership } from "../entities/membership.entity";
import { MainErrorCode } from "../errors/main.error-codes";
import { MembershipService } from "./membership.service";

/**
 * Organization 的唯一归属 Service。建组织（跨表写 organization + membership +
 * app_user.active_org_id）走 @Transactional()。
 *
 * 注：membership / app_user 的写在建组织事务内通过同一事务 manager 完成。为满足
 * check:repo「Entity 唯一写归属」，本 Service 仅 @InjectRepository(Organization)；
 * 其余表用事务 manager（`this.orgRepo.manager`）在事务内插入。
 */
@Injectable()
export class OrgService {
  constructor(
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    @InjectRepository(AppUser)
    private readonly userRepo: Repository<AppUser>,
    private readonly memberships: MembershipService,
  ) {}

  /** 创建组织：建 org + owner membership + 设活跃组织。返回组织摘要。 */
  @Transactional()
  async persistNewOrg(userId: string, name: string): Promise<OrgSummary> {
    return this.createOrgInTx(userId, name);
  }

  private async createOrgInTx(userId: string, name: string): Promise<OrgSummary> {
    const manager = this.orgRepo.manager;
    const org = await manager.save(
      manager.create(Organization, { name, ownerId: userId }),
    );
    await manager.save(
      manager.create(Membership, { orgId: org.id, userId, role: "owner" }),
    );
    await manager.update(AppUser, { id: userId }, { activeOrgId: org.id });
    return { id: org.id, name: org.name, role: "owner" };
  }

  /** 校验是 owner，否则抛 ORG_FORBIDDEN。 */
  async assertOwner(orgId: string, userId: string): Promise<void> {
    const role = await this.memberships.roleOf(orgId, userId);
    if (role !== "owner") {
      throw new AppError(MainErrorCode.ORG_FORBIDDEN);
    }
  }

  /** 取组织，不存在抛 ORG_NOT_FOUND。 */
  async getOrgOrThrow(orgId: string): Promise<Organization> {
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    if (!org) throw new AppError(MainErrorCode.ORG_NOT_FOUND);
    return org;
  }
}
```

> `AppUser` 同时被 `UserService` 与 `OrgService` 注入会触发 check:repo 的 `DUP_OWNER`。为避免：**`OrgService` 不注入 `AppUser` Repository**，改用 `orgRepo.manager.update(AppUser, ...)`（事务 manager 写）。据此修订上面 OrgService：删除 `@InjectRepository(AppUser) userRepo` 字段与构造参数，`createOrgInTx` 已用 `manager.update(AppUser, ...)`。同步修订 org.service.spec.ts 的 `build()`：`new OrgService({} as never, membership)`（只两个参数）。

- [ ] **Step 5: 应用上面注释的修订**

按 Step 4 注释，将 `OrgService` 构造函数改为：

```ts
  constructor(
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    private readonly memberships: MembershipService,
  ) {}
```

并删除未使用的 `import { AppUser } ...`？——不删：`createOrgInTx` 内 `manager.update(AppUser, ...)` 与 `manager.create(Membership, ...)` 仍需引用类。保留 `AppUser` / `Membership` import。

同步把 org.service.spec.ts 中 `build()` 改为：

```ts
    return new OrgService(
      {} as never, // orgRepo
      membership,
    );
```

- [ ] **Step 6: 运行 OrgService 测试确认通过**

Run: `pnpm test -- libs/main/src/services/org.service.spec.ts`
Expected: PASS

- [ ] **Step 7: 写 InvitationService**

Create `libs/main/src/services/invitation.service.ts`：

```ts
import { AppError, Transactional, WithLock } from "@meshbot/common";
import type { InvitationSummary } from "@meshbot/types-main";
import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { randomBytes } from "node:crypto";
import type { Repository } from "typeorm";

import { type AppConfigInvitation, INVITATION_CONFIG } from "./invitation.config";
import { AppUser } from "../entities/app-user.entity";
import { Invitation } from "../entities/invitation.entity";
import { Membership } from "../entities/membership.entity";
import { Organization } from "../entities/organization.entity";
import { MainErrorCode } from "../errors/main.error-codes";

/** 邀请被接受后的结果。 */
export interface AcceptResult {
  orgId: string;
  orgName: string;
}

/**
 * Invitation 的唯一归属 Service。
 * - 建邀请：单表写（仅 invitation），不需 @Transactional。
 * - 接受邀请：跨表写（membership + invitation + 可能的 app_user.active_org_id）→
 *   @Transactional；并发重复接受用 @WithLock（按 token）在事务外层保护幂等。
 */
@Injectable()
export class InvitationService {
  constructor(
    @InjectRepository(Invitation)
    private readonly inviteRepo: Repository<Invitation>,
    @Inject(INVITATION_CONFIG)
    private readonly config: AppConfigInvitation,
  ) {}

  /** owner 创建邀请。返回邀请实体（含 token，供 controller 调 EmailSender）。 */
  async createInvitation(
    orgId: string,
    invitedBy: string,
    email: string,
  ): Promise<Invitation> {
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(
      Date.now() + this.config.expiresDays * 24 * 60 * 60 * 1000,
    );
    // 同组织同邮箱已有 pending → 复用（唯一部分索引也会兜底，这里先查避免抛 DB 错）
    const existing = await this.inviteRepo.findOne({
      where: { orgId, email, status: "pending" },
    });
    if (existing) return existing;
    const invite = this.inviteRepo.create({
      orgId,
      email,
      token,
      status: "pending",
      invitedBy,
      expiresAt,
      acceptedBy: null,
      acceptedAt: null,
    });
    return this.inviteRepo.save(invite);
  }

  /** owner 查看组织的 pending 邀请。 */
  async listPending(orgId: string): Promise<InvitationSummary[]> {
    const rows = await this.inviteRepo.find({
      where: { orgId, status: "pending" },
      order: { createdAt: "DESC" },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      status: r.status as InvitationSummary["status"],
      token: r.token,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** owner 撤销邀请。 */
  async revoke(id: string): Promise<void> {
    await this.inviteRepo.update({ id, status: "pending" }, { status: "revoked" });
  }

  /** 接受邀请。幂等：已是成员直接成功。 */
  @WithLock({ key: "invitation:accept:#{0}", waitTimeout: 5000 })
  async acceptInvitation(token: string, userId: string): Promise<AcceptResult> {
    return this.persistAccept(token, userId);
  }

  @Transactional()
  private async persistAccept(token: string, userId: string): Promise<AcceptResult> {
    const manager = this.inviteRepo.manager;
    const invite = await manager.findOne(Invitation, { where: { token } });
    if (!invite || invite.status === "revoked") {
      throw new AppError(MainErrorCode.INVITATION_INVALID);
    }
    if (invite.status === "accepted") {
      // 幂等：同一邀请重复接受（同一人），返回组织信息
      const org = await manager.findOne(Organization, { where: { id: invite.orgId } });
      if (!org) throw new AppError(MainErrorCode.ORG_NOT_FOUND);
      return { orgId: org.id, orgName: org.name };
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      await manager.update(Invitation, { id: invite.id }, { status: "expired" });
      throw new AppError(MainErrorCode.INVITATION_EXPIRED);
    }

    const org = await manager.findOne(Organization, { where: { id: invite.orgId } });
    if (!org) throw new AppError(MainErrorCode.ORG_NOT_FOUND);

    // 建 membership（幂等：已是成员则跳过插入）
    const already = await manager.count(Membership, {
      where: { orgId: invite.orgId, userId },
    });
    if (already === 0) {
      await manager.save(
        manager.create(Membership, {
          orgId: invite.orgId,
          userId,
          role: "member",
        }),
      );
    }

    await manager.update(
      Invitation,
      { id: invite.id },
      { status: "accepted", acceptedBy: userId, acceptedAt: new Date() },
    );

    // 用户当前无活跃组织 → 设为该组织
    await manager
      .createQueryBuilder()
      .update(AppUser)
      .set({ activeOrgId: invite.orgId })
      .where("id = :userId AND active_org_id IS NULL", { userId })
      .execute();

    return { orgId: org.id, orgName: org.name };
  }
}
```

Create `libs/main/src/services/invitation.config.ts`（邀请配置注入抽象，避免 libs/main 直依赖 server-main 的 AppConfig）：

```ts
/** 邀请配置切片（由 server-main 的 AppConfig.invitation 提供）。 */
export interface AppConfigInvitation {
  expiresDays: number;
}

/** DI token。server-main 在 MainModule 装配时用 useValue 提供。 */
export const INVITATION_CONFIG = Symbol("INVITATION_CONFIG");
```

> check:naming 围栏：`persistAccept` 命中 `persist*` 前缀且挂 `@Transactional()` ✓。check:lock-tx：`@WithLock` 在 `acceptInvitation`（外层），`@Transactional` 在被调的 `persistAccept`（内层）✓。

- [ ] **Step 8: 改 MainModule 注册实体 + Service + 配置**

Replace `libs/main/src/main.module.ts` 全文为：

```ts
import { TxTypeOrmModule } from "@meshbot/common";
import { type DynamicModule, Module } from "@nestjs/common";

import { AppUser } from "./entities/app-user.entity";
import { Invitation } from "./entities/invitation.entity";
import { Membership } from "./entities/membership.entity";
import { Organization } from "./entities/organization.entity";
import {
  type AppConfigInvitation,
  INVITATION_CONFIG,
} from "./services/invitation.config";
import { InvitationService } from "./services/invitation.service";
import { MembershipService } from "./services/membership.service";
import { OrgService } from "./services/org.service";
import { UserService } from "./services/user.service";

/**
 * server-main 业务模块。Entity → Service 一对一归属（check:repo）：
 * - AppUser → UserService
 * - Organization → OrgService
 * - Membership → MembershipService
 * - Invitation → InvitationService
 *
 * forRoot(invitation) 注入邀请配置切片（过期天数）。
 */
@Module({})
export class MainModule {
  static forRoot(invitation: AppConfigInvitation): DynamicModule {
    return {
      module: MainModule,
      imports: [
        TxTypeOrmModule.forFeature([AppUser, Organization, Membership, Invitation]),
      ],
      providers: [
        UserService,
        OrgService,
        MembershipService,
        InvitationService,
        { provide: INVITATION_CONFIG, useValue: invitation },
      ],
      exports: [UserService, OrgService, MembershipService, InvitationService],
    };
  }
}
```

> 因为 MainModule 由静态 `@Module` 变为 `forRoot`，所有 import `MainModule` 的地方要改为 `MainModule.forRoot(config.invitation)`：`apps/server-main/src/app.module.ts` 的 `imports` 把 `MainModule` 改为 `MainModule.forRoot(config.invitation)`；`apps/server-main/test/e2e/auth-flow.spec.ts` 的 `imports` 把 `MainModule` 改为 `MainModule.forRoot({ expiresDays: 7 })`。

- [ ] **Step 9: 导出 Service**

Modify `libs/main/src/index.ts`，追加：

```ts
export { OrgService } from "./services/org.service";
export { MembershipService } from "./services/membership.service";
export {
  InvitationService,
  type AcceptResult,
} from "./services/invitation.service";
export {
  type AppConfigInvitation,
  INVITATION_CONFIG,
} from "./services/invitation.config";
```

- [ ] **Step 10: 确认 common 导出了 WithLock / Transactional**

Run: `grep -rn "WithLock\|Transactional" libs/common/src/index.ts libs/common/src/decorators/index.ts`
Expected: 两者都在 export 中。若 `WithLock` 未从 `@meshbot/common` 顶层导出，在 `libs/common/src/index.ts` 补 `export { WithLock, type WithLockOptions } from "./decorators";`（已存在则跳过）。

- [ ] **Step 11: typecheck + 单测 + 围栏 + 提交**

Run: `pnpm --filter @meshbot/main typecheck && pnpm test -- libs/main/src/services/org.service.spec.ts && pnpm check:repo && pnpm check:naming && pnpm check:lock-tx && pnpm check:tx`
Expected: PASS（check:repo 映射出 Organization→OrgService、Membership→MembershipService、Invitation→InvitationService，无 DUP_OWNER）

```bash
git add libs/main apps/server-main/src/app.module.ts apps/server-main/test/e2e/auth-flow.spec.ts
git commit -m "feat(main): Org/Membership/Invitation Service（建组织事务 + 接受邀请锁幂等）"
```

---

### Task 8: server-main OrgController（端点）

**Files:**
- Create: `apps/server-main/src/rest/org.controller.ts`
- Modify: `apps/server-main/src/app.module.ts`（controllers 加 OrgController）
- Modify: `apps/server-main/src/rest/auth.controller.ts`（profile 端点扩展，见 Step 2）

- [ ] **Step 1: 写 OrgController**

Create `apps/server-main/src/rest/org.controller.ts`：

```ts
import {
  AcceptInvitationDto,
  CreateInvitationDto,
  CreateOrgDto,
  InvitationService,
  MembershipService,
  OrgService,
  UserService,
} from "@meshbot/main";
import type {
  InvitationSummary,
  MemberSummary,
  OrgSummary,
} from "@meshbot/types-main";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from "@nestjs/common";

import { EMAIL_SENDER, type EmailSender } from "../email/email-sender";
import { Inject } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";

/**
 * 组织相关端点。均需登录（全局 JwtAuthGuard）。Controller 只接收 + 委派，
 * 业务在 Org/Membership/Invitation Service。
 */
@Controller("orgs")
export class OrgController {
  constructor(
    private readonly orgs: OrgService,
    private readonly memberships: MembershipService,
    private readonly invitations: InvitationService,
    private readonly users: UserService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  /** 我的组织列表。 */
  @Get()
  async listMine(@CurrentUser() user: JwtMainPayload): Promise<OrgSummary[]> {
    return this.memberships.listOrgsForUser(user.userId);
  }

  /** 创建组织（成为 owner）。 */
  @Post()
  async create(
    @CurrentUser() user: JwtMainPayload,
    @Body() dto: CreateOrgDto,
  ): Promise<OrgSummary> {
    return this.orgs.persistNewOrg(user.userId, dto.name);
  }

  /** 组织成员列表（成员可见）。 */
  @Get(":id/members")
  async members(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") orgId: string,
  ): Promise<MemberSummary[]> {
    await this.assertMember(orgId, user.userId);
    return this.memberships.listMembers(orgId);
  }

  /** 邀请成员（owner 限定），建邀请并发邮件。 */
  @Post(":id/invitations")
  async invite(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") orgId: string,
    @Body() dto: CreateInvitationDto,
  ): Promise<InvitationSummary> {
    await this.orgs.assertOwner(orgId, user.userId);
    const org = await this.orgs.getOrgOrThrow(orgId);
    const inviter = await this.users.findById(user.userId);
    const invite = await this.invitations.createInvitation(
      orgId,
      user.userId,
      dto.email,
    );
    await this.email.sendInvitation(dto.email, {
      orgName: org.name,
      inviterName: inviter?.displayName ?? "管理员",
      code: invite.token,
      expiresAt: invite.expiresAt,
    });
    return {
      id: invite.id,
      email: invite.email,
      status: invite.status as InvitationSummary["status"],
      token: invite.token,
      expiresAt: invite.expiresAt.toISOString(),
      createdAt: invite.createdAt.toISOString(),
    };
  }

  /** 组织 pending 邀请列表（owner 限定）。 */
  @Get(":id/invitations")
  async listInvitations(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") orgId: string,
  ): Promise<InvitationSummary[]> {
    await this.orgs.assertOwner(orgId, user.userId);
    return this.invitations.listPending(orgId);
  }

  /** 重发邀请邮件（owner 限定）。 */
  @Post(":id/invitations/:invitationId/resend")
  async resend(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") orgId: string,
    @Param("invitationId") invitationId: string,
  ): Promise<{ ok: true }> {
    await this.orgs.assertOwner(orgId, user.userId);
    const org = await this.orgs.getOrgOrThrow(orgId);
    const inviter = await this.users.findById(user.userId);
    const list = await this.invitations.listPending(orgId);
    const target = list.find((i) => i.id === invitationId);
    if (target) {
      await this.email.sendInvitation(target.email, {
        orgName: org.name,
        inviterName: inviter?.displayName ?? "管理员",
        code: target.token,
        expiresAt: new Date(target.expiresAt),
      });
    }
    return { ok: true };
  }

  /** 撤销邀请（owner 限定）。 */
  @Delete(":id/invitations/:invitationId")
  async revoke(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") orgId: string,
    @Param("invitationId") invitationId: string,
  ): Promise<{ ok: true }> {
    await this.orgs.assertOwner(orgId, user.userId);
    await this.invitations.revoke(invitationId);
    return { ok: true };
  }

  /** 接受邀请（任何登录用户，粘贴邀请码）。 */
  @Post("invitations/accept")
  async accept(
    @CurrentUser() user: JwtMainPayload,
    @Body() dto: AcceptInvitationDto,
  ): Promise<{ orgId: string; orgName: string }> {
    return this.invitations.acceptInvitation(dto.token, user.userId);
  }

  private async assertMember(orgId: string, userId: string): Promise<void> {
    const ok = await this.memberships.isMember(orgId, userId);
    if (!ok) {
      // 复用 ORG_FORBIDDEN（非成员无权查看）
      await this.orgs.assertOwner(orgId, userId); // owner 也是成员；非成员在此抛 FORBIDDEN
    }
  }
}
```

> `assertMember` 的实现：若已是成员直接返回；否则借 `assertOwner` 抛 `ORG_FORBIDDEN`（owner 必然是成员，故只有真非成员才会走到抛错）。逻辑等价于「非成员 → FORBIDDEN」。

> 注意路由顺序：`@Post("invitations/accept")` 与 `@Post(":id/invitations")` 不冲突（前者第一段是字面量 `invitations`，后者第一段是参数 `:id`）。NestJS/Express 中字面量静态段优先级高于参数段，但为稳妥，`accept` 用的是 `orgs/invitations/accept` 三段、`:id/invitations` 是 `orgs/:id/invitations`，段数一致首段不同，可正常区分。

- [ ] **Step 2: 扩展 auth profile 端点**

Modify `apps/server-main/src/rest/auth.controller.ts`，新增受保护的 `GET /auth/profile` 端点返回 `{ user, activeOrg, memberships }`。在 class 内加方法（需要注入 `UserService`/`MembershipService`，已可从 `@meshbot/main` 拿）：

- import 追加：`MembershipService`（从 `@meshbot/main`），`CurrentUser`（`../auth/current-user.decorator`），`JwtMainPayload`（`../auth/jwt.strategy`），`Get`（`@nestjs/common`）。
- 构造函数注入 `private readonly memberships: MembershipService`。
- 加方法：

```ts
  /** 当前用户 profile：身份 + 活跃组织 + 全部组织。供 server-agent 镜像。 */
  @Get("profile")
  async profile(@CurrentUser() jwt: JwtMainPayload) {
    const user = await this.users.findById(jwt.userId);
    const orgs = await this.memberships.listOrgsForUser(jwt.userId);
    const activeOrg =
      user?.activeOrgId != null
        ? (orgs.find((o) => o.id === user.activeOrgId) ?? null)
        : null;
    return {
      user: user
        ? { id: user.id, email: user.email, displayName: user.displayName }
        : null,
      activeOrg,
      memberships: orgs,
    };
  }
```

- [ ] **Step 3: 注册 OrgController**

Modify `apps/server-main/src/app.module.ts`：`controllers: [HealthController, AuthController]` 改为 `controllers: [HealthController, AuthController, OrgController]`，并 import `OrgController`。

- [ ] **Step 4: typecheck + swagger 围栏 + 提交**

Run: `pnpm --filter @meshbot/server-main typecheck`
Expected: PASS

```bash
git add apps/server-main/src/rest apps/server-main/src/app.module.ts
git commit -m "feat(server-main): OrgController（建组织/邀请/接受/成员）+ profile 扩展"
```

---

### Task 9: 组织域 E2E（Postgres）

端到端覆盖：注册 → 建组织 → 邀请 → 第二用户注册 → 接受 → 成员列表 + owner 限定 + 过期负向。

**Files:**
- Create: `apps/server-main/test/e2e/org-flow.spec.ts`

- [ ] **Step 1: 写 E2E（仿 auth-flow.spec.ts 的 bootstrap，含 EmailModule/OrgController）**

Create `apps/server-main/test/e2e/org-flow.spec.ts`：

```ts
import "reflect-metadata";
import path from "node:path";
import {
  CommonModule,
  ErrorsFilter,
  I18nZodValidationPipe,
  ResponseInterceptor,
  traceIdMiddleware,
} from "@meshbot/common";
import { MainModule } from "@meshbot/main";
import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  AcceptLanguageResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  I18nService,
} from "nestjs-i18n";
import request from "supertest";

import { JwtAuthGuard } from "../../src/auth/jwt-auth.guard";
import { JwtMainStrategy } from "../../src/auth/jwt.strategy";
import { AuthController } from "../../src/rest/auth.controller";
import { OrgController } from "../../src/rest/org.controller";
import { EMAIL_SENDER, type EmailSender, type InvitationMail } from "../../src/email/email-sender";
import { createTestDb, isPostgresReachable, type TestDbContext } from "../setup/test-db";

const I18N_PATH = path.join(__dirname, "..", "..", "i18n");

/** 测试用 EmailSender：捕获最后一次邀请，断言 code。 */
class CaptureEmailSender implements EmailSender {
  last: { to: string; mail: InvitationMail } | null = null;
  async sendInvitation(to: string, mail: InvitationMail): Promise<void> {
    this.last = { to, mail };
  }
}

@Module({
  providers: [{ provide: EMAIL_SENDER, useClass: CaptureEmailSender }],
  exports: [EMAIL_SENDER],
})
class TestEmailModule {}

describe("server-main org e2e", () => {
  let app: INestApplication;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[org-flow] ${skipReason}`);
      return;
    }
    dbCtx = await createTestDb();

    const moduleRef = await Test.createTestingModule({
      imports: [
        CommonModule.forRoot({}),
        I18nModule.forRoot({
          fallbackLanguage: "zh",
          loader: I18nJsonLoader,
          loaderOptions: { path: I18N_PATH },
          resolvers: [new HeaderResolver(["x-lang"]), new AcceptLanguageResolver()],
        }),
        TypeOrmModule.forRoot(dbCtx.dataSourceOptions),
        PassportModule,
        JwtModule.register({
          secret: "e2e-test-secret",
          signOptions: { expiresIn: "1h" },
        }),
        TestEmailModule,
        MainModule.forRoot({ expiresDays: 7 }),
      ],
      controllers: [AuthController, OrgController],
      providers: [JwtMainStrategy, { provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.use(traceIdMiddleware);
    const i18n = app.get(I18nService);
    const reflector = app.get(Reflector);
    app.useGlobalPipes(new I18nZodValidationPipe(i18n));
    app.useGlobalInterceptors(new ResponseInterceptor(reflector));
    app.useGlobalFilters(new ErrorsFilter(i18n));
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (dbCtx) await dbCtx.cleanup();
  });

  function maybeSkip(): boolean {
    if (skipReason) {
      console.warn(`[org-flow] skipping: ${skipReason}`);
      return true;
    }
    return false;
  }

  async function registerAndToken(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/api/auth/register")
      .send({ email, password: "password1", displayName: email.split("@")[0] });
    return res.body.data.token as string;
  }

  it("建组织 → 邀请 → 第二用户接受 → 成员列表含两人", async () => {
    if (maybeSkip()) return;
    const aliceToken = await registerAndToken("alice@org.io");

    // 建组织
    const orgRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ name: "Acme" });
    expect(orgRes.body).toMatchObject({ success: true });
    const orgId = orgRes.body.data.id as string;
    expect(orgRes.body.data.role).toBe("owner");

    // profile 含活跃组织
    const profileRes = await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${aliceToken}`);
    expect(profileRes.body.data.activeOrg.id).toBe(orgId);

    // 邀请 bob
    const inviteRes = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/invitations`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ email: "bob@org.io" });
    expect(inviteRes.body).toMatchObject({ success: true });
    const code = inviteRes.body.data.token as string;
    expect(code).toBeTruthy();

    // bob 注册 + 接受
    const bobToken = await registerAndToken("bob@org.io");
    const acceptRes = await request(app.getHttpServer())
      .post("/api/orgs/invitations/accept")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ token: code });
    expect(acceptRes.body).toMatchObject({ success: true });
    expect(acceptRes.body.data.orgName).toBe("Acme");

    // 成员列表含两人
    const membersRes = await request(app.getHttpServer())
      .get(`/api/orgs/${orgId}/members`)
      .set("Authorization", `Bearer ${aliceToken}`);
    const emails = membersRes.body.data.map((m: { email: string }) => m.email).sort();
    expect(emails).toEqual(["alice@org.io", "bob@org.io"]);
  });

  it("非 owner 邀请 → ORG_FORBIDDEN（403）", async () => {
    if (maybeSkip()) return;
    const carolToken = await registerAndToken("carol@org.io");
    const orgRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${carolToken}`)
      .send({ name: "CarolOrg" });
    const orgId = orgRes.body.data.id as string;

    const daveToken = await registerAndToken("dave@org.io");
    const res = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/invitations`)
      .set("Authorization", `Bearer ${daveToken}`)
      .send({ email: "x@org.io" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 2004 });
  });

  it("接受不存在的邀请码 → INVITATION_INVALID", async () => {
    if (maybeSkip()) return;
    const eveToken = await registerAndToken("eve@org.io");
    const res = await request(app.getHttpServer())
      .post("/api/orgs/invitations/accept")
      .set("Authorization", `Bearer ${eveToken}`)
      .send({ token: "nonexistent" });
    expect(res.body).toMatchObject({ success: false, code: 2005 });
  });
});
```

- [ ] **Step 2: 跑 E2E（需 Postgres）**

Run: `pnpm dev:db:up && pnpm test -- apps/server-main/test/e2e/org-flow.spec.ts`
Expected: 3 个用例 PASS（Postgres 不可达则整体 skip，不算失败）。

- [ ] **Step 3: 提交**

```bash
git add apps/server-main/test/e2e/org-flow.spec.ts
git commit -m "test(server-main): 组织域 E2E（建组织/邀请/接受/owner 限定/负向）"
```

---

## Part C — server-agent 改造

### Task 10: server-agent CloudClient（云端 HTTP 客户端 + 错误码映射）

**Files:**
- Create: `apps/server-agent/src/cloud/cloud-client.service.ts`
- Create: `apps/server-agent/src/cloud/cloud-client.service.spec.ts`
- Create: `apps/server-agent/src/cloud/cloud.types.ts`
- Modify: `apps/server-agent/src/errors/agent.error-codes.ts`（加 `CLOUD_UNREACHABLE`）
- Modify: `apps/server-agent/src/env.schema.ts`（加 `MESHBOT_CLOUD_URL`）
- Modify: `apps/server-agent/i18n/zh/auth.json` + `apps/server-agent/i18n/en/auth.json`（加 cloud key）

- [ ] **Step 1: 加错误码 + i18n + env**

Modify `apps/server-agent/src/errors/agent.error-codes.ts`，在 `AUTH_UNAUTHORIZED` 后追加（紧接 3003，不跳号）：

```ts
  CLOUD_UNREACHABLE: {
    code: 3004,
    message: "cloud.unreachable",
    httpStatus: 503,
  },
```

Modify `apps/server-agent/i18n/zh/auth.json`：加一段（与现有 JSON 合并，顶层 key `cloud`）。先看现有结构（auth.json 是扁平 `{ "alreadyRegistered": ... }` 还是嵌套）。当前 zh/auth.json 内容为 `{"alreadyRegistered":..,"invalidCredentials":..,"unauthorized":..}` 扁平。错误码 message 是 `cloud.unreachable` → i18n 命名空间是文件名 `auth` 时 key 为 `auth.cloud.unreachable`。但现有错误码 `auth.alreadyRegistered` 对应 `auth.json` 里的 `alreadyRegistered`，说明命名空间=文件名、key=点号后路径。因此 `cloud.unreachable` 应放到一个新文件 `apps/server-agent/i18n/zh/cloud.json`：

Create `apps/server-agent/i18n/zh/cloud.json`：

```json
{
  "unreachable": "无法连接云端服务，请检查网络后重试"
}
```

Create `apps/server-agent/i18n/en/cloud.json`：

```json
{
  "unreachable": "Cannot reach cloud service, check your network and retry"
}
```

Modify `apps/server-agent/src/env.schema.ts`，在 `MESHBOT_JWT_SECRET` 后加：

```ts
  /** 云端 server-main 基址（方案 A：server-agent 代理云端调用）。默认本地 3200。 */
  MESHBOT_CLOUD_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:3200"),
```

- [ ] **Step 2: 写 cloud.types.ts**

Create `apps/server-agent/src/cloud/cloud.types.ts`：

```ts
/** 云端 server-main 返回的认证响应 data 部分。 */
export interface CloudAuthData {
  token: string;
  expiresIn: string;
  user: { id: string; email: string; displayName: string };
}

/** 云端 profile data 部分。 */
export interface CloudProfileData {
  user: { id: string; email: string; displayName: string } | null;
  activeOrg: { id: string; name: string; role: string } | null;
  memberships: Array<{ id: string; name: string; role: string }>;
}

/** 云端组织摘要。 */
export interface CloudOrgSummary {
  id: string;
  name: string;
  role: string;
}
```

- [ ] **Step 3: 写 CloudClient 的失败测试**

Create `apps/server-agent/src/cloud/cloud-client.service.spec.ts`：

```ts
import { AppError } from "@meshbot/common";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { CloudClientService } from "./cloud-client.service";

/** 用注入的 fetch 桩验证：信封解包、错误码透传、不可达映射。 */
function makeClient(fetchImpl: typeof fetch): CloudClientService {
  return new CloudClientService("http://cloud.test", fetchImpl);
}

describe("CloudClientService", () => {
  it("成功信封返回 data", async () => {
    const client = makeClient(
      (async () =>
        new Response(JSON.stringify({ success: true, code: 0, data: { token: "t" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );
    const data = await client.post<{ token: string }>("/api/auth/login", { email: "a" });
    expect(data).toEqual({ token: "t" });
  });

  it("业务错误信封透传云端 code/message 为 AppError", async () => {
    const client = makeClient(
      (async () =>
        new Response(
          JSON.stringify({ success: false, code: 2002, message: "邮箱或密码错误" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    );
    await expect(client.post("/api/auth/login", {})).rejects.toMatchObject({
      name: "AppError",
    });
  });

  it("网络异常映射 CLOUD_UNREACHABLE", async () => {
    const client = makeClient(
      (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    );
    await expect(client.post("/api/auth/login", {})).rejects.toMatchObject({
      errorCode: AgentErrorCode.CLOUD_UNREACHABLE,
    });
  });

  it("云端 401 触发 unauthorized 处理器并抛 AUTH_UNAUTHORIZED", async () => {
    const client = makeClient(
      (async () =>
        new Response(JSON.stringify({ success: false, code: 3003 }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );
    const onUnauthorized = jest.fn();
    client.setUnauthorizedHandler(onUnauthorized);
    await expect(client.get("/api/orgs", "stale-token")).rejects.toMatchObject({
      errorCode: AgentErrorCode.AUTH_UNAUTHORIZED,
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm test -- apps/server-agent/src/cloud/cloud-client.service.spec.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 5: 写 CloudClient 实现**

Create `apps/server-agent/src/cloud/cloud-client.service.ts`：

```ts
import { AppError, type ErrorCode } from "@meshbot/common";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AgentErrorCode } from "../errors/agent.error-codes";

/** 云端响应信封形状。 */
interface CloudEnvelope<T> {
  success: boolean;
  code: number;
  message?: string;
  data?: T;
}

/** 注入用 token：可被测试替换的 fetch 与 baseUrl。 */
export const CLOUD_FETCH = Symbol("CLOUD_FETCH");

/**
 * 云端 server-main 的 HTTP 客户端（方案 A）。
 * - 自动附带云端 token（由调用方传入，因 token 持久化在 CloudIdentity，
 *   CloudAuthService 取出后传进来，避免循环依赖）。
 * - 解开信封：success=true 返回 data；success=false 透传云端 code/message 为 AppError。
 * - 网络层异常（连接失败 / 非 JSON）→ CLOUD_UNREACHABLE。
 */
@Injectable()
export class CloudClientService {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  /** 云端返回 401（token 失效）时的回调，由 AuthModule 接线为清空本地身份。 */
  private onUnauthorized?: () => Promise<void> | void;

  constructor(
    baseUrlOrConfig: string | ConfigService,
    @Inject(CLOUD_FETCH) fetchImpl?: typeof fetch,
  ) {
    // 运行期由 NestJS 注入 ConfigService；测试直接传 baseUrl 字符串 + fetch
    this.baseUrl =
      typeof baseUrlOrConfig === "string"
        ? baseUrlOrConfig
        : baseUrlOrConfig.getOrThrow<string>("MESHBOT_CLOUD_URL");
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  /** 注册 401 处理器（spec §8：云端 token 失效 → 清本地身份 → 前端落回 needs-login）。 */
  setUnauthorizedHandler(handler: () => Promise<void> | void): void {
    this.onUnauthorized = handler;
  }

  async post<T>(path: string, body: unknown, token?: string): Promise<T> {
    return this.request<T>("POST", path, body, token);
  }

  async get<T>(path: string, token?: string): Promise<T> {
    return this.request<T>("GET", path, undefined, token);
  }

  async del<T>(path: string, token?: string): Promise<T> {
    return this.request<T>("DELETE", path, undefined, token);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    token?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AppError(AgentErrorCode.CLOUD_UNREACHABLE);
    }

    // 云端 token 失效（passport guard 返回真实 401）→ 清本地身份后抛未授权
    if (res.status === 401) {
      await this.onUnauthorized?.();
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }

    let envelope: CloudEnvelope<T>;
    try {
      envelope = (await res.json()) as CloudEnvelope<T>;
    } catch {
      throw new AppError(AgentErrorCode.CLOUD_UNREACHABLE);
    }

    if (envelope.success) {
      return envelope.data as T;
    }
    // 透传云端业务错误码（2000 段）为本地 AppError，保留 message 直接展示
    const cloudErr: ErrorCode = {
      code: envelope.code,
      message: envelope.message ?? "cloud error",
      httpStatus: 200,
    };
    throw new AppError(cloudErr);
  }
}
```

> 注：`AppError` 接受任意 `ErrorCode` 对象，云端的 `message` 已是翻译后的文本，本地 ErrorsFilter 翻译命中失败时会 fallback 原文，正好直接展示云端中文/英文消息。

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test -- apps/server-agent/src/cloud/cloud-client.service.spec.ts`
Expected: PASS

- [ ] **Step 7: 围栏 + 提交**

Run: `pnpm check:error-code`
Expected: PASS（3004 紧接 3003）

```bash
git add apps/server-agent/src/cloud apps/server-agent/src/errors apps/server-agent/src/env.schema.ts apps/server-agent/i18n
git commit -m "feat(server-agent): CloudClient（云端 HTTP 代理 + 错误码映射）+ CLOUD_UNREACHABLE"
```

---

### Task 11: server-agent cloud_identity 实体 + 迁移（替换 users 表）

**Files:**
- Create: `apps/server-agent/src/entities/cloud-identity.entity.ts`
- Create: `apps/server-agent/src/migrations/1780000000000-CloudIdentity.ts`
- Modify: `apps/server-agent/src/app.module.ts`（entities 去掉 User、加 CloudIdentity）
- Delete: `apps/server-agent/src/entities/user.entity.ts`

- [ ] **Step 1: 写 CloudIdentity 实体**

Create `apps/server-agent/src/entities/cloud-identity.entity.ts`：

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * 云端身份的本地镜像（单机单行，id 固定 'default'）。
 * 持久化云端 token，供 server-agent 后台调云端（方案 A）。
 */
@Entity("cloud_identity")
export class CloudIdentity {
  @PrimaryColumn({ type: "text" })
  id!: string;

  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ type: "text" })
  email!: string;

  @Column({ name: "display_name", type: "text" })
  displayName!: string;

  @Column({ name: "org_id", type: "text", nullable: true })
  orgId!: string | null;

  @Column({ name: "org_name", type: "text", nullable: true })
  orgName!: string | null;

  @Column({ type: "text", nullable: true })
  role!: string | null;

  @Column({ name: "cloud_token", type: "text" })
  cloudToken!: string;

  @Column({ name: "cloud_token_expires_at", type: "text", nullable: true })
  cloudTokenExpiresAt!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
```

- [ ] **Step 2: 写迁移（建 cloud_identity + drop users）**

Create `apps/server-agent/src/migrations/1780000000000-CloudIdentity.ts`：

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 云端身份镜像表 + 退役本地 users 表。
 * Phase 1 去掉本地密码登录，身份真相源在云端；本地仅存镜像 + 云端 token。
 * 既有单机 users 行无云端对应物，直接 drop（用户重新走云端登录）。
 */
export class CloudIdentity1780000000000 implements MigrationInterface {
  name = "CloudIdentity1780000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cloud_identity" (
        "id"                     TEXT PRIMARY KEY NOT NULL,
        "cloud_user_id"          TEXT NOT NULL,
        "email"                  TEXT NOT NULL,
        "display_name"           TEXT NOT NULL,
        "org_id"                 TEXT,
        "org_name"               TEXT,
        "role"                   TEXT,
        "cloud_token"            TEXT NOT NULL,
        "cloud_token_expires_at" TEXT,
        "created_at"             DATETIME NOT NULL DEFAULT (datetime('now')),
        "updated_at"             DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_username"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cloud_identity"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id"            TEXT PRIMARY KEY NOT NULL,
        "username"      TEXT NOT NULL,
        "password_hash" TEXT NOT NULL,
        "created_at"    DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_username" ON "users" ("username")`,
    );
  }
}
```

- [ ] **Step 3: app.module entities 替换**

Modify `apps/server-agent/src/app.module.ts`：
- import 删 `import { User } from "./entities/user.entity";`，加 `import { CloudIdentity } from "./entities/cloud-identity.entity";`
- `entities: [...]` 数组里 `User` 替换为 `CloudIdentity`

> 删除 `user.entity.ts` 放到 Task 12（AuthService 重写后才没有引用），此步先不删文件。

- [ ] **Step 4: 启动迁移冒烟**

Run: `pnpm dev:server-agent`（启动后 Ctrl-C）
Expected: 启动日志显示迁移 `CloudIdentity1780000000000` 执行；无报错。（注意：会 drop 本地 users 表，开发库可接受。）

- [ ] **Step 5: 提交**

```bash
git add apps/server-agent/src/entities/cloud-identity.entity.ts apps/server-agent/src/migrations apps/server-agent/src/app.module.ts
git commit -m "feat(server-agent): cloud_identity 镜像表 + 迁移（退役本地 users 表）"
```

---

### Task 12: server-agent CloudIdentity Service + CloudAuthService（重写本地 auth）

**Files:**
- Create: `apps/server-agent/src/services/cloud-identity.service.ts`
- Create: `apps/server-agent/src/services/cloud-auth.service.ts`
- Create: `apps/server-agent/src/services/cloud-auth.service.spec.ts`
- Modify: `apps/server-agent/src/auth.module.ts`（重写 providers）
- Modify: `apps/server-agent/src/strategies/jwt.strategy.ts`（payload 用 cloudUserId）
- Delete: `apps/server-agent/src/services/auth.service.ts`
- Delete: `apps/server-agent/src/entities/user.entity.ts`

- [ ] **Step 1: 写 CloudIdentityService（CloudIdentity 唯一归属）**

Create `apps/server-agent/src/services/cloud-identity.service.ts`：

```ts
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import { CloudIdentity } from "../entities/cloud-identity.entity";

const SINGLE_ROW_ID = "default";

/** CloudIdentity（单行镜像）的唯一归属 Service。 */
@Injectable()
export class CloudIdentityService {
  constructor(
    @InjectRepository(CloudIdentity)
    private readonly repo: Repository<CloudIdentity>,
  ) {}

  /** 取当前身份镜像；未登录返回 null。 */
  async get(): Promise<CloudIdentity | null> {
    return this.repo.findOne({ where: { id: SINGLE_ROW_ID } });
  }

  /** upsert 身份 + token + 活跃组织镜像。 */
  async upsert(fields: {
    cloudUserId: string;
    email: string;
    displayName: string;
    cloudToken: string;
    cloudTokenExpiresAt: string | null;
    orgId: string | null;
    orgName: string | null;
    role: string | null;
  }): Promise<void> {
    await this.repo.save({ id: SINGLE_ROW_ID, ...fields });
  }

  /** 仅刷新活跃组织镜像（profile 拉到后调用）。 */
  async updateActiveOrg(
    orgId: string | null,
    orgName: string | null,
    role: string | null,
  ): Promise<void> {
    await this.repo.update({ id: SINGLE_ROW_ID }, { orgId, orgName, role });
  }

  /** 清空身份（登出 / 云端 token 失效）。 */
  async clear(): Promise<void> {
    await this.repo.delete({ id: SINGLE_ROW_ID });
  }
}
```

- [ ] **Step 2: 写 CloudAuthService 的失败测试**

Create `apps/server-agent/src/services/cloud-auth.service.spec.ts`：

```ts
import { CloudAuthService } from "./cloud-auth.service";

/** 用桩验证：登录调云端 login + profile，upsert 镜像，签本地 JWT。 */
describe("CloudAuthService.login", () => {
  it("登录成功：调云端、写镜像、返回本地 access_token", async () => {
    const cloud = {
      post: jest.fn().mockResolvedValue({
        token: "cloud-jwt",
        expiresIn: "7d",
        user: { id: "u1", email: "a@x.io", displayName: "Alice" },
      }),
      get: jest.fn().mockResolvedValue({
        user: { id: "u1", email: "a@x.io", displayName: "Alice" },
        activeOrg: { id: "o1", name: "Acme", role: "owner" },
        memberships: [{ id: "o1", name: "Acme", role: "owner" }],
      }),
    };
    const identity = { upsert: jest.fn().mockResolvedValue(undefined) };
    const jwt = { sign: jest.fn().mockReturnValue("local-jwt") };

    const svc = new CloudAuthService(
      cloud as never,
      identity as never,
      jwt as never,
    );
    const out = await svc.login({ email: "a@x.io", password: "p" });

    expect(cloud.post).toHaveBeenCalledWith("/api/auth/login", {
      email: "a@x.io",
      password: "p",
    });
    expect(identity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ cloudUserId: "u1", orgId: "o1", cloudToken: "cloud-jwt" }),
    );
    expect(out).toEqual({ access_token: "local-jwt" });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test -- apps/server-agent/src/services/cloud-auth.service.spec.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 4: 写 CloudAuthService**

Create `apps/server-agent/src/services/cloud-auth.service.ts`：

```ts
import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { CloudClientService } from "../cloud/cloud-client.service";
import type {
  CloudAuthData,
  CloudProfileData,
} from "../cloud/cloud.types";
import { CloudIdentityService } from "./cloud-identity.service";

/** 本地 access_token 响应（与旧 LoginResponse 兼容，前端不改契约）。 */
export interface LocalTokenResponse {
  access_token: string;
}

interface Credentials {
  email: string;
  password: string;
}

interface RegisterInput extends Credentials {
  displayName: string;
}

/**
 * 云端认证编排（方案 A）：代理云端 register/login，写本地身份镜像，
 * 签发本地 JWT 给浏览器。云端 token 只存 CloudIdentity，不下发浏览器。
 */
@Injectable()
export class CloudAuthService {
  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly jwt: JwtService,
  ) {}

  async register(input: RegisterInput): Promise<LocalTokenResponse> {
    const auth = await this.cloud.post<CloudAuthData>(
      "/api/auth/register",
      input,
    );
    return this.afterCloudAuth(auth);
  }

  async login(input: Credentials): Promise<LocalTokenResponse> {
    const auth = await this.cloud.post<CloudAuthData>("/api/auth/login", input);
    return this.afterCloudAuth(auth);
  }

  async logout(): Promise<void> {
    await this.identity.clear();
  }

  /** 云端 auth 成功后：拉 profile、写镜像、签本地 JWT。 */
  private async afterCloudAuth(
    auth: CloudAuthData,
  ): Promise<LocalTokenResponse> {
    const profile = await this.cloud.get<CloudProfileData>(
      "/api/auth/profile",
      auth.token,
    );
    await this.identity.upsert({
      cloudUserId: auth.user.id,
      email: auth.user.email,
      displayName: auth.user.displayName,
      cloudToken: auth.token,
      cloudTokenExpiresAt: null,
      orgId: profile.activeOrg?.id ?? null,
      orgName: profile.activeOrg?.name ?? null,
      role: profile.activeOrg?.role ?? null,
    });
    const access_token = this.jwt.sign({
      sub: auth.user.id,
      email: auth.user.email,
    });
    return { access_token };
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test -- apps/server-agent/src/services/cloud-auth.service.spec.ts`
Expected: PASS

- [ ] **Step 6: 改 jwt.strategy payload**

Replace `apps/server-agent/src/strategies/jwt.strategy.ts` 的 `validate`：

```ts
  validate(payload: { sub: string; email: string }) {
    return { id: payload.sub, email: payload.email };
  }
```

- [ ] **Step 7: 重写 auth.module.ts**

Replace `apps/server-agent/src/auth.module.ts` 全文为：

```ts
import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import { CloudClientService } from "./cloud/cloud-client.service";
import { CLOUD_FETCH } from "./cloud/cloud-client.service";
import { CloudIdentity } from "./entities/cloud-identity.entity";
import { CloudAuthService } from "./services/cloud-auth.service";
import { CloudIdentityService } from "./services/cloud-identity.service";
import { JWT_SECRET, JwtStrategy } from "./strategies/jwt.strategy";

@Module({
  imports: [
    TxTypeOrmModule.forFeature([CloudIdentity]),
    PassportModule,
    JwtModule.register({
      secret: JWT_SECRET,
      signOptions: { expiresIn: "7d" },
    }),
  ],
  providers: [
    CloudIdentityService,
    CloudAuthService,
    JwtStrategy,
    { provide: CLOUD_FETCH, useValue: globalThis.fetch },
    {
      provide: CloudClientService,
      inject: [ConfigService, CLOUD_FETCH, CloudIdentityService],
      useFactory: (
        config: ConfigService,
        fetchImpl: typeof fetch,
        identity: CloudIdentityService,
      ) => {
        const client = new CloudClientService(config, fetchImpl);
        // spec §8：云端 token 失效 → 清本地身份 → setup-status 落回 needs-login
        client.setUnauthorizedHandler(() => identity.clear());
        return client;
      },
    },
  ],
  exports: [CloudIdentityService, CloudAuthService, CloudClientService, JwtModule],
})
export class AuthModule {}
```

- [ ] **Step 8: 删除旧 AuthService + User 实体**

```bash
git rm apps/server-agent/src/services/auth.service.ts apps/server-agent/src/entities/user.entity.ts
```

- [ ] **Step 9: typecheck（会暴露 controller 仍引用旧 AuthService → Task 13 修）**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 报错集中在 `controllers/auth.controller.ts` 与 `controllers/setup.controller.ts` 引用了已删的 `AuthService`。这些在 Task 13 修复。**本任务暂不要求 typecheck 通过**，先提交 service 层。

- [ ] **Step 10: 提交**

```bash
git add apps/server-agent/src/services/cloud-identity.service.ts apps/server-agent/src/services/cloud-auth.service.ts apps/server-agent/src/services/cloud-auth.service.spec.ts apps/server-agent/src/auth.module.ts apps/server-agent/src/strategies/jwt.strategy.ts
git commit -m "feat(server-agent): CloudIdentityService + CloudAuthService（云端登录编排，本地 JWT 签发）"
```

---

### Task 13: server-agent 控制器代理（auth/org/setup-status）

**Files:**
- Modify: `apps/server-agent/src/controllers/auth.controller.ts`
- Create: `apps/server-agent/src/controllers/cloud-org.controller.ts`
- Modify: `apps/server-agent/src/controllers/setup.controller.ts`
- Modify: `apps/server-agent/src/dto/auth.dto.ts`
- Modify: `apps/server-agent/src/app.module.ts`（注册 CloudOrgController）

- [ ] **Step 1: 改本地 auth DTO（username→email + displayName）**

Replace `apps/server-agent/src/dto/auth.dto.ts` 全文为：

```ts
import { IsEmail, IsNotEmpty, IsString, MinLength } from "class-validator";

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @IsNotEmpty()
  displayName!: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
```

- [ ] **Step 2: 重写本地 auth.controller**

Replace `apps/server-agent/src/controllers/auth.controller.ts` 全文为：

```ts
import { Body, Controller, Get, Post, Req } from "@nestjs/common";

import { LoginDto, RegisterDto } from "../dto/auth.dto";
import { Public } from "../guards/jwt-auth.guard";
import { CloudAuthService } from "../services/cloud-auth.service";
import { CloudIdentityService } from "../services/cloud-identity.service";

@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly cloudAuth: CloudAuthService,
    private readonly identity: CloudIdentityService,
  ) {}

  @Public()
  @Post("register")
  register(@Body() dto: RegisterDto) {
    return this.cloudAuth.register(dto);
  }

  @Public()
  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.cloudAuth.login(dto);
  }

  @Post("logout")
  async logout() {
    await this.cloudAuth.logout();
    return { ok: true };
  }

  /** 当前用户 profile（读本地镜像，不每次打云端）。401 由 guard 处理。 */
  @Get("profile")
  async profile(@Req() req: { user?: { id: string; email: string } }) {
    const id = await this.identity.get();
    if (!id) {
      return { id: "", email: "", displayName: "", org: null };
    }
    return {
      id: id.cloudUserId,
      email: id.email,
      displayName: id.displayName,
      org: id.orgId
        ? { id: id.orgId, name: id.orgName, role: id.role }
        : null,
    };
  }
}
```

> profile 仍受 JWT 保护（无 `@Public()`）。前端 `fetchProfile` 用本地 JWT 调它；401（无本地 JWT）→ AuthGuard 走 setup-status 分流，与现状一致。

- [ ] **Step 3: 写 CloudOrgController（代理云端组织端点）**

Create `apps/server-agent/src/controllers/cloud-org.controller.ts`：

```ts
import { Body, Controller, Get, Param, Post } from "@nestjs/common";

import { CloudClientService } from "../cloud/cloud-client.service";
import type {
  CloudOrgSummary,
  CloudProfileData,
} from "../cloud/cloud.types";
import { CloudIdentityService } from "../services/cloud-identity.service";

/**
 * 云端组织端点的本地代理（方案 A）：用持久化的云端 token 调 server-main，
 * 组织变更后刷新本地活跃组织镜像。所有方法受本地 JWT 保护。
 */
@Controller("api/orgs")
export class CloudOrgController {
  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
  ) {}

  private async token(): Promise<string> {
    const id = await this.identity.get();
    return id?.cloudToken ?? "";
  }

  /** 我的组织列表。 */
  @Get()
  async list(): Promise<CloudOrgSummary[]> {
    return this.cloud.get<CloudOrgSummary[]>("/api/orgs", await this.token());
  }

  /** 创建组织，成功后刷新活跃组织镜像。 */
  @Post()
  async create(@Body() body: { name: string }): Promise<CloudOrgSummary> {
    const token = await this.token();
    const org = await this.cloud.post<CloudOrgSummary>("/api/orgs", body, token);
    await this.refreshActiveOrg(token);
    return org;
  }

  /** 接受邀请，成功后刷新活跃组织镜像。 */
  @Post("invitations/accept")
  async accept(
    @Body() body: { token: string },
  ): Promise<{ orgId: string; orgName: string }> {
    const token = await this.token();
    const res = await this.cloud.post<{ orgId: string; orgName: string }>(
      "/api/orgs/invitations/accept",
      body,
      token,
    );
    await this.refreshActiveOrg(token);
    return res;
  }

  /** owner 邀请成员（代理）。 */
  @Post(":id/invitations")
  async invite(
    @Param("id") orgId: string,
    @Body() body: { email: string },
  ) {
    return this.cloud.post(
      `/api/orgs/${orgId}/invitations`,
      body,
      await this.token(),
    );
  }

  /** owner 查看 pending 邀请。 */
  @Get(":id/invitations")
  async invitations(@Param("id") orgId: string) {
    return this.cloud.get(
      `/api/orgs/${orgId}/invitations`,
      await this.token(),
    );
  }

  /** 成员列表。 */
  @Get(":id/members")
  async members(@Param("id") orgId: string) {
    return this.cloud.get(`/api/orgs/${orgId}/members`, await this.token());
  }

  /** 拉云端 profile，把活跃组织写回本地镜像。 */
  private async refreshActiveOrg(token: string): Promise<void> {
    const profile = await this.cloud.get<CloudProfileData>(
      "/api/auth/profile",
      token,
    );
    await this.identity.updateActiveOrg(
      profile.activeOrg?.id ?? null,
      profile.activeOrg?.name ?? null,
      profile.activeOrg?.role ?? null,
    );
  }
}
```

- [ ] **Step 4: 重写 setup.controller（四态）**

Replace `apps/server-agent/src/controllers/setup.controller.ts` 全文为：

```ts
import { PROVIDERS } from "@meshbot/types-agent";
import { Controller, Get } from "@nestjs/common";

import { Public } from "../guards/jwt-auth.guard";
import { CloudIdentityService } from "../services/cloud-identity.service";
import { ModelConfigService } from "../services/model-config.service";

/** setup-status 四态：needs-login → needs-org → needs-model → ready。 */
@Controller("api")
export class SetupController {
  constructor(
    private readonly modelConfigService: ModelConfigService,
    private readonly identity: CloudIdentityService,
  ) {}

  @Public()
  @Get("setup-status")
  async getSetupStatus() {
    const id = await this.identity.get();
    if (!id) {
      return { step: "needs-login", needsSetup: true };
    }
    if (!id.orgId) {
      return { step: "needs-org", needsSetup: true };
    }
    const hasModels = await this.modelConfigService.hasEnabledModels();
    if (!hasModels) {
      return { step: "needs-model", needsSetup: true };
    }
    return { step: "ready", needsSetup: false };
  }

  @Public()
  @Get("providers")
  getProviders() {
    return PROVIDERS;
  }
}
```

- [ ] **Step 5: 注册 CloudOrgController + 调整 app.module**

Modify `apps/server-agent/src/app.module.ts`：
- import `CloudOrgController`
- `controllers` 数组加 `CloudOrgController`

- [ ] **Step 6: typecheck 通过 + 提交**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: PASS（旧 AuthService 引用已全部替换）

```bash
git add apps/server-agent/src/controllers apps/server-agent/src/dto/auth.dto.ts apps/server-agent/src/app.module.ts
git commit -m "feat(server-agent): auth/org 控制器改为云端代理 + setup-status 四态"
```

---

### Task 14: server-agent 围栏全绿 + 启动联调

**Files:** 无新增；修复围栏暴露的问题。

- [ ] **Step 1: 跑全部围栏**

Run: `pnpm check:repo && pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:dead && pnpm check:error-code`
Expected: 全 PASS。重点看 check:repo 的 Entity→Service 映射：`CloudIdentity → CloudIdentityService`、`User` 已消失。若 check:dead 报 `CloudOrgSummary` 等导出未用，确认确实被 controller import（已用）。

- [ ] **Step 2: 双端联调（需 Postgres）**

Run: 终端 1 `pnpm dev:db:up && pnpm dev:server-main`；终端 2 `pnpm dev:server-agent`。
用 curl 验证代理链路：

```bash
# 注册（经 server-agent 代理到云端）
curl -s -X POST http://127.0.0.1:3100/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@test.io","password":"password1","displayName":"Alice"}'
# Expected: {"success":true,...,"data":{"access_token":"<local-jwt>"}}

# 用返回的 access_token 调 setup-status → needs-org
curl -s http://127.0.0.1:3100/api/setup-status
# Expected: data.step == "needs-org"

# 建组织（带 Authorization）
TOKEN=<上一步 access_token>
curl -s -X POST http://127.0.0.1:3100/api/orgs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Acme"}'
# Expected: data.role == "owner"

# setup-status → needs-model
curl -s http://127.0.0.1:3100/api/setup-status
# Expected: data.step == "needs-model"
```

Expected: 各步如注释。失败则按错误码定位（云端不可达 = 3004）。

- [ ] **Step 3: 提交（若有围栏修复）**

```bash
git add -A
git commit -m "chore(server-agent): Phase 1 围栏全绿 + 双端联调修复"
```

---

## Part D — web-agent 前端

### Task 15: web-agent 共享类型 + rest 客户端改造

**Files:**
- Modify: `libs/types-agent/src/auth.ts`（email 登录/注册 schema + 四态 + org 类型）
- Modify: `apps/web-agent/src/rest/auth.ts`
- Modify: `apps/web-agent/src/lib/profile-client.ts`（UserInfo 加 org）
- Create: `apps/web-agent/src/rest/org.ts`

- [ ] **Step 1: 改 types-agent/auth.ts**

Replace `libs/types-agent/src/auth.ts` 全文为：

```ts
import { z } from "zod";

/** 注册（云端身份）。 */
export const registerSchema = z.object({
  email: z.string().email("login.validation.emailInvalid"),
  password: z.string().min(8, "login.validation.passwordTooShort").max(72),
  displayName: z.string().min(1, "login.validation.displayNameRequired").max(64),
});
export type RegisterInput = z.infer<typeof registerSchema>;

/** 登录。 */
export const loginSchema = z.object({
  email: z.string().email("login.validation.emailInvalid"),
  password: z.string().min(1, "login.validation.passwordRequired"),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** 创建组织。 */
export const createOrgSchema = z.object({
  name: z.string().min(1, "setup.validation.orgNameRequired").max(64),
});
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

/** 加入组织（粘贴邀请码）。 */
export const joinOrgSchema = z.object({
  token: z.string().min(1, "setup.validation.inviteCodeRequired"),
});
export type JoinOrgInput = z.infer<typeof joinOrgSchema>;

/** setup-status 四态。 */
export type SetupStep = "needs-login" | "needs-org" | "needs-model" | "ready";

export interface AuthStatus {
  step: SetupStep;
  needsSetup: boolean;
}

export interface LoginResponse {
  access_token: string;
}

/** 活跃组织摘要。 */
export interface OrgInfo {
  id: string;
  name: string;
  role: "owner" | "member";
}

/** 当前用户（含活跃组织）。 */
export interface UserInfo {
  id: string;
  email: string;
  displayName: string;
  org: OrgInfo | null;
}

/** 成员摘要。 */
export interface MemberInfo {
  userId: string;
  email: string;
  displayName: string;
  role: "owner" | "member";
}

/** 邀请摘要。 */
export interface InvitationInfo {
  id: string;
  email: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  token: string;
  expiresAt: string;
  createdAt: string;
}
```

> 删除了旧的 `RegisterDto`/`LoginDto`/`AuthResponse`（CLI 用）。若 `apps/cli-agent` 引用它们，改为 import 新 `registerSchema`/`loginSchema`，或在 cli-agent 内自带本地副本。Step 5 验证 cli-agent typecheck。

- [ ] **Step 2: 改 rest/auth.ts**

Replace `apps/web-agent/src/rest/auth.ts` 全文为：

```ts
"use client";

import type {
  AuthStatus,
  LoginInput,
  LoginResponse,
  RegisterInput,
} from "@meshbot/types-agent";
import { apiClient, setAccessToken } from "@meshbot/web-common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { profileQueryKey } from "@/lib/profile-client";

export const authStatusQueryKey = ["auth", "status"] as const;

function useClientMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const { data } = await apiClient.get<AuthStatus>("/api/setup-status");
  return data;
}

export async function login(input: LoginInput): Promise<LoginResponse> {
  const { data } = await apiClient.post<LoginResponse>("/api/auth/login", input);
  setAccessToken(data.access_token);
  return data;
}

export async function register(input: RegisterInput): Promise<LoginResponse> {
  const { data } = await apiClient.post<LoginResponse>(
    "/api/auth/register",
    input,
  );
  setAccessToken(data.access_token);
  return data;
}

export function useAuthStatus() {
  const mounted = useClientMounted();
  return useQuery({
    queryKey: authStatusQueryKey,
    queryFn: fetchAuthStatus,
    enabled: mounted,
    retry: 2,
    retryDelay: 600,
    networkMode: "always",
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: login,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: profileQueryKey });
      queryClient.invalidateQueries({ queryKey: authStatusQueryKey });
    },
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: register,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: profileQueryKey });
      queryClient.invalidateQueries({ queryKey: authStatusQueryKey });
    },
  });
}

export { fetchProfile, ProfileUnauthorizedError } from "@/lib/profile-client";
```

- [ ] **Step 3: 写 rest/org.ts**

Create `apps/web-agent/src/rest/org.ts`：

```ts
"use client";

import type {
  CreateOrgInput,
  InvitationInfo,
  JoinOrgInput,
  MemberInfo,
  OrgInfo,
} from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authStatusQueryKey } from "@/rest/auth";
import { profileQueryKey } from "@/lib/profile-client";

export async function createOrg(input: CreateOrgInput): Promise<OrgInfo> {
  const { data } = await apiClient.post<OrgInfo>("/api/orgs", input);
  return data;
}

export async function joinOrg(
  input: JoinOrgInput,
): Promise<{ orgId: string; orgName: string }> {
  const { data } = await apiClient.post<{ orgId: string; orgName: string }>(
    "/api/orgs/invitations/accept",
    input,
  );
  return data;
}

export async function fetchMembers(orgId: string): Promise<MemberInfo[]> {
  const { data } = await apiClient.get<MemberInfo[]>(
    `/api/orgs/${orgId}/members`,
  );
  return data;
}

export async function fetchInvitations(
  orgId: string,
): Promise<InvitationInfo[]> {
  const { data } = await apiClient.get<InvitationInfo[]>(
    `/api/orgs/${orgId}/invitations`,
  );
  return data;
}

export async function inviteMember(
  orgId: string,
  email: string,
): Promise<InvitationInfo> {
  const { data } = await apiClient.post<InvitationInfo>(
    `/api/orgs/${orgId}/invitations`,
    { email },
  );
  return data;
}

export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createOrg,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: profileQueryKey });
      qc.invalidateQueries({ queryKey: authStatusQueryKey });
    },
  });
}

export function useJoinOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: joinOrg,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: profileQueryKey });
      qc.invalidateQueries({ queryKey: authStatusQueryKey });
    },
  });
}

export function useMembers(orgId: string | null) {
  return useQuery({
    queryKey: ["org", orgId, "members"],
    queryFn: () => fetchMembers(orgId as string),
    enabled: orgId != null,
  });
}

export function useInvitations(orgId: string | null, isOwner: boolean) {
  return useQuery({
    queryKey: ["org", orgId, "invitations"],
    queryFn: () => fetchInvitations(orgId as string),
    enabled: orgId != null && isOwner,
  });
}

export function useInviteMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => inviteMember(orgId, email),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org", orgId, "invitations"] });
    },
  });
}
```

- [ ] **Step 4: profile-client.ts 类型对齐**

`apps/web-agent/src/lib/profile-client.ts` 已 import `UserInfo`（现在含 `org` 字段），无需改逻辑（`body.data` 直接是新 `UserInfo`）。确认无残留对 `username` 的引用。

- [ ] **Step 5: typecheck（web-agent + cli-agent）**

Run: `pnpm --filter @meshbot/types-agent typecheck && pnpm --filter @meshbot/web-agent typecheck`
Expected: web-agent PASS。若 `apps/cli-agent` 引用了删除的 `RegisterDto`/`LoginDto`/`AuthResponse`，按 Step 1 注释修复其 import（用 `registerSchema`/`loginSchema`）。

- [ ] **Step 6: 提交**

```bash
git add libs/types-agent/src/auth.ts apps/web-agent/src/rest apps/web-agent/src/lib/profile-client.ts
git commit -m "feat(web-agent): 共享类型 email 化 + 四态 setup + org rest 客户端"
```

---

### Task 16: web-agent 登录页（username→email）

**Files:**
- Modify: `apps/web-agent/src/app/login/page.tsx`
- Modify: `apps/web-agent/src/components/auth-guard.tsx`（四态路由分流）
- Modify: `apps/web-agent/messages/zh.json` + `en.json`（login 段加 email key + 注册链接）

- [ ] **Step 1: 改登录页字段 + 加注册入口**

Modify `apps/web-agent/src/app/login/page.tsx`：
- import `loginSchema`（已是新 email schema）。
- `defaultValues` 改为 `{ email: "", password: "" }`。
- 第一个 `FormItem name="username"` 改为 `name="email"`，label 文案 key 改 `t("email")`，`Input` 的 `type="email"` `autoComplete="email"` `placeholder={t("emailPlaceholder")}`。
- `onSubmit` 的参数类型 `LoginInput` 现在是 `{ email, password }`，无需改。
- 在登录按钮下方加「没有账号？去注册」链接（新用户从这里进 `/setup` 注册步）。import `Link from "next/link"`，在 `</Form>` 之后加：

```tsx
            <p className="mt-3 text-center text-xs text-muted-foreground">
              {t("noAccount")}{" "}
              <Link href="/setup" className="text-primary hover:underline">
                {t("goRegister")}
              </Link>
            </p>
```

- [ ] **Step 2: AuthGuard 四态分流**

Modify `apps/web-agent/src/components/auth-guard.tsx`：当前 `fetchSetupStatus().then(...)` 用 `setup.needsSetup` 二分（→ /setup 或 /login）。四态下改为按 `step` 分流：
- `needs-org` / `needs-model` → 强制 `/setup`（继续向导）
- `needs-login` → 新用户默认进 `/setup`（注册是首启第一步），但**允许停留在 `/login`**（已有账号登录），两页互有链接跳转
- `ready` 但本地无 JWT → `/login`（重新登录拿本地 JWT）

把 `.then((setup) => {...})` 内主体替换为：

```ts
        if (cancelled) {
          return;
        }
        const step = setup.step;
        if (step === "needs-org" || step === "needs-model") {
          if (pathname !== "/setup") {
            setResolved(false);
            router.replace("/setup");
            return;
          }
        } else if (step === "needs-login") {
          // 新用户默认进 /setup 注册；允许停留 /login（已有账号登录）
          if (pathname !== "/setup" && pathname !== "/login") {
            setResolved(false);
            router.replace("/setup");
            return;
          }
        } else if (pathname !== "/login") {
          // ready 但本地无 JWT → 去 /login 重新登录
          setResolved(false);
          router.replace("/login");
          return;
        }
        setResolved(true);
```

- [ ] **Step 3: 加 i18n key**

Modify `apps/web-agent/messages/zh.json` 的 `login` 段：把 `account`/`accountPlaceholder` 换/补为 `email`/`emailPlaceholder`，加注册链接文案，并在 `validation` 加 `emailInvalid`、`passwordRequired`：

```json
"login": {
  "title": "登录",
  "subtitle": "欢迎使用",
  "email": "邮箱",
  "emailPlaceholder": "you@example.com",
  "password": "密码",
  "loginFailed": "登录失败，请重试",
  "signIn": "登录",
  "signingIn": "登录中...",
  "noAccount": "没有账号？",
  "goRegister": "去注册",
  "validation": {
    "emailInvalid": "邮箱格式不正确",
    "passwordRequired": "请输入密码",
    "passwordTooShort": "密码至少 8 位",
    "displayNameRequired": "请输入显示名"
  }
}
```

对应 `apps/web-agent/messages/en.json` 的 `login` 段同步加英文。

- [ ] **Step 4: typecheck + i18n 围栏 + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm exec tsx scripts/sync-locales.ts -- --check`
Expected: PASS + zh/en 对称

```bash
git add apps/web-agent/src/app/login/page.tsx apps/web-agent/src/components/auth-guard.tsx apps/web-agent/messages
git commit -m "feat(web-agent): 登录页邮箱登录 + AuthGuard 四态分流"
```

---

### Task 17: web-agent setup 向导（注册 → 组织 → 配 LLM 三步）

**Files:**
- Modify: `apps/web-agent/src/app/setup/page.tsx`
- Create: `apps/web-agent/src/components/setup/org-step.tsx`
- Modify: `apps/web-agent/messages/zh.json` + `en.json`（setup 段加 org 文案）

- [ ] **Step 1: 写 OrgStep 组件**

Create `apps/web-agent/src/components/setup/org-step.tsx`：

```tsx
"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import {
  type CreateOrgInput,
  createOrgSchema,
  type JoinOrgInput,
  joinOrgSchema,
} from "@meshbot/types-agent";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useCreateOrg, useJoinOrg } from "@/rest/org";

type Tab = "create" | "join";

/** setup 第二步：创建组织 或 粘贴邀请码加入。完成后 onDone 触发刷新分流。 */
export function OrgStep({ onDone }: { onDone: () => void }) {
  const t = useTranslations("setup");
  const [tab, setTab] = useState<Tab>("create");
  const createSchema = useSchema(createOrgSchema);
  const joinSchema = useSchema(joinOrgSchema);
  const createOrg = useCreateOrg();
  const joinOrg = useJoinOrg();

  const onCreate = async (values: CreateOrgInput) => {
    await createOrg.mutateAsync(values);
    onDone();
  };
  const onJoin = async (values: JoinOrgInput) => {
    await joinOrg.mutateAsync(values);
    onDone();
  };

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle>{t("orgTitle")}</CardTitle>
        <CardDescription>{t("orgDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="pt-3">
        <div className="mb-4 flex gap-2">
          <Button
            type="button"
            variant={tab === "create" ? "default" : "outline"}
            onClick={() => setTab("create")}
          >
            {t("orgCreateTab")}
          </Button>
          <Button
            type="button"
            variant={tab === "join" ? "default" : "outline"}
            onClick={() => setTab("join")}
          >
            {t("orgJoinTab")}
          </Button>
        </div>

        {tab === "create" ? (
          <Form
            schema={createSchema}
            defaultValues={{ name: "" }}
            onSubmit={onCreate}
            className="flex flex-col gap-4"
          >
            <FormItem name="name" label={t("orgName")}>
              <Input placeholder={t("orgNamePlaceholder")} />
            </FormItem>
            {createOrg.error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {createOrg.error instanceof Error
                    ? createOrg.error.message
                    : t("orgCreateFailed")}
                </AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={createOrg.isPending}>
              {createOrg.isPending ? t("orgCreating") : t("orgCreateAndContinue")}
            </Button>
          </Form>
        ) : (
          <Form
            schema={joinSchema}
            defaultValues={{ token: "" }}
            onSubmit={onJoin}
            className="flex flex-col gap-4"
          >
            <FormItem name="token" label={t("orgInviteCode")}>
              <Input placeholder={t("orgInviteCodePlaceholder")} />
            </FormItem>
            {joinOrg.error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {joinOrg.error instanceof Error
                    ? joinOrg.error.message
                    : t("orgJoinFailed")}
                </AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={joinOrg.isPending}>
              {joinOrg.isPending ? t("orgJoining") : t("orgJoinAndContinue")}
            </Button>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: 改 setup/page.tsx 接入三步**

Modify `apps/web-agent/src/app/setup/page.tsx`：
- `SetupStep` 类型从 `"register" | "model"` 改为 `"register" | "org" | "model"`。
- register 表单字段从 username/confirmPassword 改为 email/password/displayName（沿用 `registerSchema` 新形状；移除 confirmPassword 逻辑或保留前端二次确认——为简化，去掉 confirmPassword，直接用 `registerSchema`）。
- `onSubmit`：`registerMutation.mutateAsync({ email, password, displayName })` 成功后 `setStep("org")`。
- 由 `authStatus.step` 驱动跳步的 effect 改为：`needs-org`→`org`、`needs-model`→`model`：

```tsx
  useEffect(() => {
    if (!authStatus) return;
    if (authStatus.step === "needs-org") setStep("org");
    else if (authStatus.step === "needs-model") setStep("model");
  }, [authStatus]);
```

- 在 `step === "register"` 与 `step === "model"` 之间渲染：

```tsx
          {step === "org" && (
            <OrgStep
              onDone={() => {
                queryClient.invalidateQueries({ queryKey: ["auth", "status"] });
                setStep("model");
              }}
            />
          )}
```

（import `OrgStep` from `@/components/setup/org-step`，import `useQueryClient` 已有。）

具体 register 表单替换：把现有 username `FormField`/`confirmPassword` 段替换为 email + password + displayName 三个 `FormField`（沿用现有 react-hook-form + zodResolver(registerSchema) 模式；defaultValues `{ email: "", password: "", displayName: "" }`；移除 `setupRegisterSchema` 的 confirmPassword refine，直接 `zodResolver(registerSchema)`）。

在 register 步的提交按钮下方加「已有账号？登录」链接（与 /login 的注册链接互为反向，配合 AuthGuard 的 needs-login 允许 /setup 与 /login 互跳）。import `Link from "next/link"`，在 register `Card` 的表单后加：

```tsx
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  {t("haveAccount")}{" "}
                  <Link href="/login" className="text-primary hover:underline">
                    {t("goLogin")}
                  </Link>
                </p>
```

- [ ] **Step 3: 加 setup i18n**

Modify `apps/web-agent/messages/zh.json` 的 `setup` 段追加（org 步骤 + email 注册文案 + validation）：

```json
"email": "邮箱",
"emailPlaceholder": "you@example.com",
"displayName": "显示名",
"displayNamePlaceholder": "你的名字",
"haveAccount": "已有账号？",
"goLogin": "去登录",
"orgTitle": "创建或加入组织",
"orgDescription": "创建一个新企业，或用邀请码加入已有企业",
"orgCreateTab": "创建组织",
"orgJoinTab": "加入组织",
"orgName": "组织名称",
"orgNamePlaceholder": "如：Acme 公司",
"orgCreating": "创建中...",
"orgCreateAndContinue": "创建并继续",
"orgCreateFailed": "创建组织失败",
"orgInviteCode": "邀请码",
"orgInviteCodePlaceholder": "粘贴邮件里的邀请码",
"orgJoining": "加入中...",
"orgJoinAndContinue": "加入并继续",
"orgJoinFailed": "加入失败，请检查邀请码",
"validation": {
  "confirmPasswordRequired": "请再次输入密码",
  "passwordNotMatch": "两次密码不一致",
  "orgNameRequired": "请输入组织名称",
  "inviteCodeRequired": "请输入邀请码"
}
```

（`validation` 段与现有合并，保留已有 key。）en.json 同步加英文。

- [ ] **Step 4: typecheck + i18n 围栏 + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm exec tsx scripts/sync-locales.ts -- --check`
Expected: typecheck PASS；sync-locales 无 `missing` / `asymmetric`（zh/en 对称）。

```bash
git add apps/web-agent/src/app/setup/page.tsx apps/web-agent/src/components/setup/org-step.tsx apps/web-agent/messages
git commit -m "feat(web-agent): setup 向导三步（注册→组织→配 LLM）"
```

---

### Task 18: web-agent 设置页「组织」区块（成员 + 邀请）

提供 owner 邀请 B 的入口与成员查看。挂在侧栏一个新入口 `/settings/org`。

**Files:**
- Create: `apps/web-agent/src/app/settings/org/page.tsx`
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`（侧栏加「组织」导航项）
- Modify: `apps/web-agent/messages/zh.json` + `en.json`（org 设置页文案 + appShell.org）

- [ ] **Step 1: 写组织设置页**

Create `apps/web-agent/src/app/settings/org/page.tsx`：

```tsx
"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
} from "@meshbot/design";
import { useAtomValue } from "jotai";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { currentUserAtom } from "@/atoms/auth";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { useInvitations, useInviteMember, useMembers } from "@/rest/org";

export default function OrgSettingsPage() {
  const t = useTranslations("orgSettings");
  const user = useAtomValue(currentUserAtom);
  const org = user?.org ?? null;
  const isOwner = org?.role === "owner";

  const { data: members = [] } = useMembers(org?.id ?? null);
  const { data: invitations = [] } = useInvitations(org?.id ?? null, isOwner);
  const invite = useInviteMember(org?.id ?? "");
  const [email, setEmail] = useState("");

  const onInvite = async () => {
    if (!email) return;
    await invite.mutateAsync(email);
    setEmail("");
  };

  if (!org) {
    return (
      <AppShellLayout>
        <div className="p-6 text-sm text-muted-foreground">{t("noOrg")}</div>
      </AppShellLayout>
    );
  }

  return (
    <AppShellLayout>
      <div className="mx-auto flex max-w-[680px] flex-col gap-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("membersTitle", { org: org.name })}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {members.map((m) => (
              <div
                key={m.userId}
                className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0"
              >
                <span>
                  {m.displayName} <span className="text-muted-foreground">({m.email})</span>
                </span>
                <span className="text-xs text-muted-foreground">{m.role}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {isOwner && (
          <Card>
            <CardHeader>
              <CardTitle>{t("inviteTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder={t("invitePlaceholder")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Button onClick={onInvite} disabled={invite.isPending}>
                  {invite.isPending ? t("inviting") : t("invite")}
                </Button>
              </div>
              {invite.error && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {invite.error instanceof Error
                      ? invite.error.message
                      : t("inviteFailed")}
                  </AlertDescription>
                </Alert>
              )}
              {invitations.length > 0 && (
                <div className="flex flex-col gap-1 pt-2">
                  <p className="text-xs font-semibold text-muted-foreground">
                    {t("pendingTitle")}
                  </p>
                  {invitations.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between py-1 text-sm"
                    >
                      <span>{inv.email}</span>
                      <span className="text-xs text-muted-foreground">
                        {t("code")}: {inv.token}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AppShellLayout>
  );
}
```

- [ ] **Step 2: 侧栏加「组织」入口**

Modify `apps/web-agent/src/components/layouts/app-shell-layout.tsx`：仿现有 `isScheduledActive`/`SidebarNavItem` 模式，加一个指向 `/settings/org` 的导航项（用 lucide `Users` 图标）。在 import 加 `Users`，在 schedule 导航项附近加：

```tsx
        <SidebarNavItem
          icon={<Users className="h-4 w-4" />}
          label={t("org")}
          active={pathname === "/settings/org"}
          onClick={() => router.push("/settings/org")}
        />
```

（`t` 是 `useTranslations("appShell")`；`pathname`/`router` 已有。具体按现有 SidebarNavItem props 对齐——若其 props 名不同，参照同文件已有 `isScheduledActive` 项的写法。）

- [ ] **Step 3: 加 i18n**

Modify `apps/web-agent/messages/zh.json`：`appShell` 段加 `"org": "组织"`；新增顶层 `orgSettings` 段：

```json
"orgSettings": {
  "noOrg": "你还没有加入任何组织",
  "membersTitle": "{org} · 成员",
  "inviteTitle": "邀请成员",
  "invitePlaceholder": "对方邮箱",
  "invite": "发送邀请",
  "inviting": "发送中...",
  "inviteFailed": "邀请失败，请重试",
  "pendingTitle": "待处理邀请",
  "code": "邀请码",
  "noOrgHint": ""
}
```

en.json 同步加英文。

- [ ] **Step 4: typecheck + i18n 围栏 + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm exec tsx scripts/sync-locales.ts -- --check`
Expected: PASS + 对称。

```bash
git add apps/web-agent/src/app/settings apps/web-agent/src/components/layouts/app-shell-layout.tsx apps/web-agent/messages
git commit -m "feat(web-agent): 设置页组织区块（成员列表 + owner 邀请）"
```

---

## Part E — 端到端验证

### Task 19: 全量围栏 + 端到端手测 + 最终提交

**Files:** 无新增。

- [ ] **Step 1: 全量类型检查 + 测试 + 围栏**

Run: `pnpm typecheck && pnpm test && pnpm check`
Expected: 全 PASS（Postgres 不可达的 E2E 整体 skip 不算失败；本地无 Postgres 时先 `pnpm dev:db:up`）。

- [ ] **Step 2: 端到端手测（双端 + UI）**

启动 `pnpm dev:db:up`、`pnpm dev:server-main`、`pnpm dev:server-agent`、`pnpm dev:web-agent`。在浏览器（3001）走完整流程：

- [ ] 首次打开 → 跳 `/setup` 注册步（邮箱/密码/显示名）→ 注册成功
- [ ] 进入「组织」步 → 创建组织「Acme」→ 进入配 LLM 步
- [ ] 配一个模型 → 进入主界面
- [ ] 侧栏「组织」→ 成员列表含自己（owner）
- [ ] owner 邀请 `bob@test.io` → 后端日志（LogEmailSender）打出邀请码
- [ ] 退出登录（若有入口）/ 清 localStorage → 用第二账号注册 → 组织步选「加入组织」→ 粘贴上一步邀请码 → 加入成功 → 配模型 → 进入
- [ ] 第一账号的组织成员列表现在含两人

Expected: 全部如期。记录任何偏差并修复。

- [ ] **Step 3: 最终提交**

```bash
git add -A
git commit -m "chore: Phase 1 云端身份 + 企业/组织 端到端验证通过"
```

---

## 附录：Phase 1 完成定义（DoD）

- [ ] server-agent 无本地密码登录；`users` 表已退役，身份走云端。
- [ ] server-main 有 organization/membership/invitation 三表 + Service + Controller + E2E 绿。
- [ ] 注册 → 建/入组织（邮件邀请码）→ 配 LLM → 进入，全链路打通。
- [ ] 方案 A 落地：云端 token 仅存 `cloud_identity`，浏览器只持本地 JWT。
- [ ] server-main 配置走 loadAppConfig（Nacos/YAML），邮件走可插拔 EmailSender。
- [ ] `pnpm typecheck && pnpm test && pnpm check` 全绿。
