# meshbot Phase 2 Implementation Plan

> **Status (2026-05-16)**：已完成，本文件保留为历史存档。底部"Phase 3 待办"中"User / Organization / AgentRegistration / Device"等领域举例是 Phase 2 时对 Phase 3 的预测；实施期已决定**不照搬  业务**，Phase 3 实际只落了 `AppUser`（注册 / 登录框架基线）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Phase 1 地基转化为日常开发流的工程化体验：i18n 全栈接入 + 前端表单层（useSchema + Form/FormItem）+ 13 条规约 .claude/.cursor 双套 harness + check:dead 围栏 + pre-commit + Phase 1 cleanup backlog 全清空。

**Architecture:** 三轨并行（A i18n + 表单层 / B harness / C cleanup）。规约单一来源 `.cursor/rules/*.mdc`，sync-skills.ts 派生 `.claude/skills/`。后端 nestjs-i18n + Zod 校验通过 I18nValidationPipe 自动翻译；前端 next-intl + useSchema 递归翻译 schema 中的 message key。

**Tech Stack:** nestjs-i18n, nestjs-zod, next-intl 4.x, react-hook-form, @hookform/resolvers/zod, husky, lint-staged, ts-morph.

**Spec:** [docs/superpowers/specs/2026-05-14-meshbot-phase-2-design.md](../specs/2026-05-14-meshbot-phase-2-design.md)

---

## File Structure

新增/修改的文件（按 Task 分组）：

```
# Track A — i18n + 前端表单层
apps/server-agent/
  i18n/                                              [NEW]
    zh/{common.json,auth.json,validation.json}
    en/{common.json,auth.json,validation.json}
  src/app.module.ts                                  [MODIFY] I18nModule.forRoot + I18nValidationPipe
  src/services/auth.service.ts                      [MODIFY] 硬编码中文 → i18n key
  src/main.ts                                        [MODIFY] useGlobalPipes(I18nValidationPipe)

apps/server-main/
  i18n/{zh,en}/common.json                          [NEW] 最小种子
  src/app.module.ts                                  [NEW] 含 I18nModule.forRoot 骨架
  src/main.ts                                        [NEW] bootstrap
  package.json                                       [MODIFY] 加 deps

apps/web-main/
  messages/{zh,en}.json                              [NEW] 最小种子
  src/i18n/config.ts                                 [NEW] 镜像 web-agent
  src/components/intl-provider.tsx                   [NEW] 镜像 web-agent
  src/app/layout.tsx                                 [MODIFY] 包 IntlProvider
  package.json                                       [MODIFY] 加 next-intl

libs/common/src/dto/
  create-i18n-zod-dto.ts                            [NEW] nestjs-zod 包装
  index.ts                                           [MODIFY] re-export

packages/design/src/
  hooks/use-schema.ts                                [NEW] Zod schema 递归翻译
  hooks/index.ts                                     [NEW] barrel
  components/form/form.tsx                           [NEW] Form / FormItem 高层封装
  components/form/index.ts                           [NEW] barrel
  index.ts                                           [MODIFY] re-export

scripts/sync-locales.ts                              [NEW] 扫描 t() 同步 JSON

# Track B — harness
.cursor/rules/                                       [NEW × 13]
  service-tx-lock-cache.mdc / service-repo-access.mdc / controller-thin.mdc
  swagger-api-declaration.mdc / shared-data-model.mdc / web-form-convention.mdc
  dev-workflow.mdc / bypass-mode-safety.mdc
  check-transactional.mdc / check-method-naming.mdc / check-lock-tx.mdc
  check-repo-access.mdc / check-dead-exports.mdc
.cursor/rules/frontend-i18n.mdc                      [DELETE] 被 web-form-convention 取代

.claude/skills/<name>/SKILL.md                       [NEW × 13] sync-skills 派生

scripts/sync-skills.ts                               [NEW] mdc → SKILL.md
scripts/check-dead-exports.ts                        [NEW] 围栏，从  拷贝改造
docs/audits/dead-fence/                              [NEW] baseline JSON

.husky/pre-commit                                    [NEW] husky hook
package.json                                         [MODIFY] husky/lint-staged 配置 + scripts

apps/web-agent/scripts/post-build.js                 [NEW] no-op-safe
apps/web-main/scripts/post-build.js                  [NEW]

# Track C — cleanup
apps/server-agent/src/auth/                          [DELETE] 整个目录
apps/server-agent/src/app.module.ts                  [MODIFY] 删 LocalAuthModule import
libs/types-agent/src/ai/providers.ts                 [NEW] PROVIDERS 迁入
packages/web-common/src/providers/index.ts           [MODIFY] re-export from types-agent
apps/server-agent/src/controllers/setup.controller.ts [MODIFY] import from types-agent
apps/server-agent/package.json                       [MODIFY] 删 web-common 依赖
libs/shared/                                         [DELETE] 整个目录
scripts/README.md                                    [MODIFY] 加 --force-report 段
libs/common/src/common.module.ts                     [MODIFY] forRoot JSDoc
libs/common/src/lock/index.ts                        [MODIFY] 隐藏 LockInitializer
libs/common/src/cache/index.ts                       [MODIFY] 隐藏 CacheInitializer
apps/server-agent/test/e2e/dto-i18n.spec.ts          [NEW] 集成测
```

---

## 全局前提：依赖安装

执行任何 Task 前，先一次性装依赖：

```bash
cd /Users/grant/Meta1/meshbot
pnpm add -w nestjs-i18n nestjs-zod
pnpm add -w -D husky lint-staged
# react-hook-form / @hookform/resolvers 看 web-agent 现状（已装则跳过）
pnpm list react-hook-form @hookform/resolvers 2>&1 | head
# 若缺：pnpm add --filter @meshbot/design react-hook-form @hookform/resolvers
```

---

## Track A — i18n + 前端表单层（6 task）

### Task A1: server-agent 接入 nestjs-i18n

**Files:**
- Create: `apps/server-agent/i18n/zh/common.json` / `auth.json` / `validation.json`
- Create: `apps/server-agent/i18n/en/common.json` / `auth.json` / `validation.json`
- Modify: `apps/server-agent/src/app.module.ts`
- Modify: `apps/server-agent/src/services/auth.service.ts`
- Modify: `apps/server-agent/src/main.ts`
- Modify: `apps/server-agent/package.json`

#### Step A1.1: 加依赖

- [ ] 修改 `apps/server-agent/package.json` dependencies，追加：

```json
"nestjs-i18n": "^10.5.1",
"nestjs-zod": "^4.3.1"
```

- [ ] 运行 `pnpm install`

#### Step A1.2: 创建 i18n 资源文件

- [ ] 创建 `apps/server-agent/i18n/zh/auth.json`：

```json
{
  "alreadyRegistered": "已存在注册用户，不允许重复注册",
  "invalidCredentials": "用户名或密码错误"
}
```

- [ ] 创建 `apps/server-agent/i18n/en/auth.json`：

```json
{
  "alreadyRegistered": "A user is already registered; duplicate registration is not allowed",
  "invalidCredentials": "Invalid username or password"
}
```

- [ ] 创建 `apps/server-agent/i18n/zh/common.json`：

```json
{
  "ok": "成功",
  "internalError": "服务器内部错误"
}
```

- [ ] 创建 `apps/server-agent/i18n/en/common.json`：

```json
{
  "ok": "OK",
  "internalError": "Internal server error"
}
```

- [ ] 创建 `apps/server-agent/i18n/zh/validation.json`：

```json
{
  "required": "必填字段",
  "stringTooShort": "长度至少 {min}",
  "stringTooLong": "长度最多 {max}",
  "invalidUuid": "格式不正确",
  "invalidEmail": "邮箱格式不正确"
}
```

- [ ] 创建 `apps/server-agent/i18n/en/validation.json`：

```json
{
  "required": "Required field",
  "stringTooShort": "Must be at least {min} characters",
  "stringTooLong": "Must be at most {max} characters",
  "invalidUuid": "Invalid format",
  "invalidEmail": "Invalid email"
}
```

#### Step A1.3: 在 AppModule 接入 I18nModule

- [ ] 修改 `apps/server-agent/src/app.module.ts`，在 imports 顶部新增 import：

```typescript
import { AcceptLanguageResolver, CookieResolver, HeaderResolver, I18nJsonLoader, I18nModule, QueryResolver } from "nestjs-i18n";
import path from "node:path";
```

- [ ] 在 `imports: [...]` 数组里，在 `CommonModule.forRoot()` 之后新增：

```typescript
I18nModule.forRoot({
  fallbackLanguage: "zh",
  loader: I18nJsonLoader,
  loaderOptions: {
    path: path.join(__dirname, "..", "i18n"),
    watch: process.env.NODE_ENV === "development",
  },
  resolvers: [
    new CookieResolver(["locale"]),
    new HeaderResolver(["x-lang"]),
    new AcceptLanguageResolver(),
    new QueryResolver(["lang"]),
  ],
}),
```

注：`path.join(__dirname, "..", "i18n")` 假设 nest build 后 dist 路径与 i18n 同级。如果 nest-cli 配置 assets 没拷 i18n，需要先在 `apps/server-agent/nest-cli.json` 的 `compilerOptions.assets` 添加 `["i18n/**/*"]`。

- [ ] 修改 `apps/server-agent/nest-cli.json`，在 `compilerOptions` 加 assets（若已有则合并）：

```bash
cat apps/server-agent/nest-cli.json
```

参考内容应类似：

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [{ "include": "../i18n/**/*", "outDir": "dist/apps/server-agent" }]
  }
}
```

#### Step A1.4: 全局注册 I18nValidationPipe

- [ ] 修改 `apps/server-agent/src/main.ts`，import + 在 bootstrap 里加 `useGlobalPipes(new I18nValidationPipe())`：

```typescript
import { I18nValidationExceptionFilter, I18nValidationPipe } from "nestjs-i18n";

// 在 bootstrap() 内（NestFactory.create 之后）：
app.useGlobalPipes(new I18nValidationPipe());
app.useGlobalFilters(new I18nValidationExceptionFilter({ detailedErrors: false }));
```

#### Step A1.5: 改造 auth.service.ts 用 i18n key

- [ ] 修改 `apps/server-agent/src/services/auth.service.ts`：把硬编码错误信息改为 i18n key。

打开文件后，在构造函数添加 I18nService 注入；replace 调用：

```typescript
import { I18nService } from "nestjs-i18n";

// constructor 加：
constructor(
  @InjectRepository(User)
  private readonly userRepo: Repository<User>,
  private readonly jwtService: JwtService,
  private readonly i18n: I18nService,
) {}

// register() 内：
throw new ConflictException(
  await this.i18n.translate("auth.alreadyRegistered"),
);

// login() 内（两处 "用户名或密码错误"）：
throw new UnauthorizedException(
  await this.i18n.translate("auth.invalidCredentials"),
);
```

#### Step A1.6: 冒烟启动 + 验证

- [ ] 运行：

```bash
cd /Users/grant/Meta1/meshbot
pnpm --filter @meshbot/server-agent build
pnpm tsc --noEmit -p apps/server-agent/tsconfig.json
```

预期：0 errors。

- [ ] 启动 server-agent，curl 测翻译：

```bash
timeout 20s pnpm dev:server-agent &
sleep 5
# 第一次注册（占位用户名）
curl -s -X POST http://localhost:3100/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"smoke","password":"abc12345"}'
# 第二次必失败，应返回中文错误
curl -s -X POST http://localhost:3100/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"smoke2","password":"abc12345"}'
# 切英文
curl -s -X POST http://localhost:3100/api/auth/register \
  -H "Content-Type: application/json" \
  -H "Accept-Language: en" \
  -d '{"username":"smoke3","password":"abc12345"}'
```

预期：第 2 个 curl 返 `"已存在注册用户"`；第 3 个返 `"A user is already registered..."`。

- [ ] 清理：`pkill -f server-agent; rm -f ~/.meshbot/agent.db*`

#### Step A1.7: 提交

- [ ] 提交：

```bash
git add apps/server-agent pnpm-lock.yaml
git commit -m "feat(server-agent): integrate nestjs-i18n with zh/en resources

I18nModule.forRoot 配 CookieResolver/HeaderResolver/AcceptLanguageResolver/QueryResolver；
全局 I18nValidationPipe + I18nValidationExceptionFilter；
auth.service 硬编码中文换成 i18n key。
nest-cli.json assets 拷 i18n 到 dist。"
```

---

### Task A2: server-main 起最小 i18n 骨架

**目的**：server-main 还没业务代码，但 i18n 框架现在就上，Phase 3 起业务时直接受益。最小骨架包含 main.ts + app.module.ts + 一个 health 端点。

**Files:**
- Create: `apps/server-main/i18n/zh/common.json`, `apps/server-main/i18n/en/common.json`
- Create: `apps/server-main/src/main.ts`
- Create: `apps/server-main/src/app.module.ts`
- Create: `apps/server-main/src/health.controller.ts`
- Create: `apps/server-main/nest-cli.json`
- Modify: `apps/server-main/package.json`
- Modify: `apps/server-main/tsconfig.json` (若存在)

#### Step A2.1: package.json + nest-cli.json

- [ ] 修改 `apps/server-main/package.json` 加 dependencies：

```json
"@nestjs/common": "^11",
"@nestjs/core": "^11",
"@nestjs/platform-express": "^11",
"nestjs-i18n": "^10.5.1",
"reflect-metadata": "*"
```

- [ ] 创建 `apps/server-main/nest-cli.json`：

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [{ "include": "../i18n/**/*", "outDir": "dist/apps/server-main" }]
  }
}
```

#### Step A2.2: i18n 种子

- [ ] 创建 `apps/server-main/i18n/zh/common.json`：

```json
{
  "appName": "meshbot 云协同",
  "ok": "成功"
}
```

- [ ] 创建 `apps/server-main/i18n/en/common.json`：

```json
{
  "appName": "meshbot Cloud",
  "ok": "OK"
}
```

#### Step A2.3: AppModule + health controller + main

- [ ] 创建 `apps/server-main/src/app.module.ts`：

```typescript
import path from "node:path";
import { Module } from "@nestjs/common";
import {
  AcceptLanguageResolver,
  CookieResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  QueryResolver,
} from "nestjs-i18n";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: "zh",
      loader: I18nJsonLoader,
      loaderOptions: {
        path: path.join(__dirname, "..", "i18n"),
        watch: process.env.NODE_ENV === "development",
      },
      resolvers: [
        new CookieResolver(["locale"]),
        new HeaderResolver(["x-lang"]),
        new AcceptLanguageResolver(),
        new QueryResolver(["lang"]),
      ],
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] 创建 `apps/server-main/src/health.controller.ts`：

```typescript
import { Controller, Get } from "@nestjs/common";
import { I18nService } from "nestjs-i18n";

@Controller("health")
export class HealthController {
  constructor(private readonly i18n: I18nService) {}

  @Get()
  async check(): Promise<{ status: string; message: string }> {
    return {
      status: "up",
      message: await this.i18n.translate("common.ok"),
    };
  }
}
```

- [ ] 创建 `apps/server-main/src/main.ts`：

```typescript
import { NestFactory } from "@nestjs/core";
import { I18nValidationExceptionFilter, I18nValidationPipe } from "nestjs-i18n";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new I18nValidationPipe());
  app.useGlobalFilters(new I18nValidationExceptionFilter({ detailedErrors: false }));
  app.setGlobalPrefix("api");
  const port = process.env.PORT ?? 3200;
  await app.listen(port);
  console.log(`server-main running on http://localhost:${port}`);
}

bootstrap();
```

- [ ] 检查 / 创建 `apps/server-main/tsconfig.json`（参考 server-agent 模式）：

```bash
cat apps/server-agent/tsconfig.json
```

镜像内容到 server-main，只改路径相关字段。

#### Step A2.4: dev:server-main script

- [ ] 修改根 `package.json` 的 scripts，确认有：

```json
"dev:server-main": "NODE_ENV=development NODE_NO_WARNINGS=1 NODE_OPTIONS='--enable-source-maps' nest start server-main --watch",
"build:server-main": "nest build server-main",
"start:server-main": "NODE_OPTIONS='--enable-source-maps' node dist/apps/server-main/main"
```

#### Step A2.5: 冒烟

- [ ] 运行：

```bash
pnpm install
pnpm --filter @meshbot/server-main build
timeout 15s pnpm dev:server-main &
sleep 5
curl -s http://localhost:3200/api/health
curl -s -H "Accept-Language: en" http://localhost:3200/api/health
pkill -f server-main
```

预期：第一个返中文 `"成功"`，第二个返 `"OK"`。

#### Step A2.6: 提交

- [ ] 提交：

```bash
git add apps/server-main pnpm-lock.yaml package.json
git commit -m "feat(server-main): bootstrap with I18nModule + health endpoint

最小可启动骨架；Phase 3 业务在此基础上扩展。
health controller 验证 i18n 翻译链路（cookie/header/accept-language/query 四种 resolver 全配齐）。"
```

---

### Task A3: web-main 接入 next-intl 镜像

**Files:**
- Create: `apps/web-main/messages/zh.json`, `apps/web-main/messages/en.json`
- Create: `apps/web-main/src/i18n/config.ts`
- Create: `apps/web-main/src/components/intl-provider.tsx`
- Modify: `apps/web-main/src/app/layout.tsx`
- Modify: `apps/web-main/package.json`

#### Step A3.1: package.json deps

- [ ] 修改 `apps/web-main/package.json` 加 `"next-intl": "^4.11.0"` 到 dependencies（与 web-agent 版本一致）。运行 `pnpm install`。

#### Step A3.2: messages 种子

- [ ] 创建 `apps/web-main/messages/zh.json`：

```json
{
  "common": {
    "appTitle": "meshbot 云协同",
    "switchToLightTheme": "切换到浅色",
    "switchToDarkTheme": "切换到深色"
  }
}
```

- [ ] 创建 `apps/web-main/messages/en.json`：

```json
{
  "common": {
    "appTitle": "meshbot Cloud",
    "switchToLightTheme": "Switch to light theme",
    "switchToDarkTheme": "Switch to dark theme"
  }
}
```

#### Step A3.3: i18n/config.ts（镜像 web-agent）

- [ ] 创建 `apps/web-main/src/i18n/config.ts`（与 `apps/web-agent/src/i18n/config.ts` 字面一致）：

```typescript
export const locales = ["zh", "en"] as const;

export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = "zh";

export const localeCookieName = "locale";

export function isAppLocale(
  value: string | undefined | null,
): value is AppLocale {
  return Boolean(value && locales.includes(value as AppLocale));
}
```

#### Step A3.4: intl-provider.tsx（镜像 web-agent）

- [ ] 创建 `apps/web-main/src/components/intl-provider.tsx`（与 `apps/web-agent/src/components/intl-provider.tsx` 字面一致）。完整内容见 web-agent 该文件，可直接拷贝：

```bash
cp apps/web-agent/src/components/intl-provider.tsx apps/web-main/src/components/intl-provider.tsx
```

无需改任何代码（路径都是相对的）。

#### Step A3.5: 在 layout.tsx 包 IntlProvider

- [ ] 查看 `apps/web-main/src/app/layout.tsx` 当前内容：

```bash
cat apps/web-main/src/app/layout.tsx
```

- [ ] 在文件顶部 import：

```typescript
import { IntlProvider } from "@/components/intl-provider";
```

- [ ] 找到 `<body>` 元素，把 children 用 `<IntlProvider>` 包起来：

```tsx
<body>
  <IntlProvider>
    {children}
  </IntlProvider>
</body>
```

#### Step A3.6: 冒烟

- [ ] 运行：

```bash
pnpm --filter @meshbot/web-main typecheck
pnpm --filter @meshbot/web-main build
```

预期：0 errors。

#### Step A3.7: 提交

```bash
git add apps/web-main pnpm-lock.yaml
git commit -m "feat(web-main): mirror web-agent's next-intl setup

messages/{zh,en}.json 种子 + i18n/config.ts + IntlProvider，与 web-agent 完全对齐。
Phase 3 业务前端在此基础上添加 t() 调用即可。"
```

---

### Task A4: createI18nZodDto in libs/common

**Files:**
- Create: `libs/common/src/dto/create-i18n-zod-dto.ts`
- Modify: `libs/common/src/dto/index.ts`
- Modify: `libs/common/package.json` (加 nestjs-zod)

#### Step A4.1: 加依赖

- [ ] 修改 `libs/common/package.json` peerDependencies（或 dependencies）加：

```json
"nestjs-zod": "^4"
```

放 peerDependencies 更合理（与 nestjs-i18n 同级，由 app 提供运行时）。`pnpm install` 应已在 Task A1 时装好 nestjs-zod。

#### Step A4.2: createI18nZodDto

- [ ] 创建 `libs/common/src/dto/create-i18n-zod-dto.ts`：

```typescript
import { createZodDto as createZodDtoBase } from "nestjs-zod";
import type { ZodTypeAny } from "zod";
import type { ZodDtoClass } from "./create-zod-dto";

/**
 * i18n 感知 DTO。
 *
 * Zod schema 的 message 写 i18n key（如 `"validation.stringTooShort"`），
 * 由全局 `I18nValidationPipe` 在 request 时翻译。
 *
 * 用法：
 * ```ts
 * import { createI18nZodDto } from "@meshbot/common";
 * import { RegisterAgentSchema } from "@meshbot/types-main";
 *
 * export class RegisterAgentDto extends createI18nZodDto(RegisterAgentSchema) {}
 *
 * \@Post("register")
 * register(\@Body() dto: RegisterAgentDto) { ... }
 * ```
 *
 * 注：与 Phase 1 的 `createZodDto`（无 i18n 简化版）共存。
 * 新代码默认用 `createI18nZodDto`；纯校验场景可继续用 `createZodDto`。
 * 返回类型复用 Phase 1 的 ZodDtoClass<TSchema>，保持 API 一致。
 */
export function createI18nZodDto<TSchema extends ZodTypeAny>(schema: TSchema) {
  return createZodDtoBase(schema) as unknown as ZodDtoClass<TSchema>;
}
```

#### Step A4.3: 导出

- [ ] 修改 `libs/common/src/dto/index.ts`：

```typescript
export { createZodDto, type ZodDtoClass } from "./create-zod-dto";
export { createI18nZodDto } from "./create-i18n-zod-dto";
```

#### Step A4.4: 验证 + 提交

- [ ] 运行 `pnpm --filter @meshbot/common build` + `typecheck`。预期 0 errors。

- [ ] 提交：

```bash
git add libs/common
git commit -m "feat(common): add createI18nZodDto via nestjs-zod

Phase 1 createZodDto 是无 i18n fallback；createI18nZodDto 走 nestjs-zod，
与 I18nValidationPipe 配合自动翻译 Zod 错误。"
```

---

### Task A5: useSchema + Form/FormItem in packages/design

**Files:**
- Create: `packages/design/src/hooks/use-schema.ts`
- Create: `packages/design/src/hooks/index.ts`
- Create: `packages/design/src/components/form/form.tsx`
- Create: `packages/design/src/components/form/index.ts`
- Modify: `packages/design/src/index.ts`
- Modify: `packages/design/package.json` (确认 react-hook-form / zodResolver / next-intl 在 peerDeps)

#### Step A5.1: 加 peerDependencies

- [ ] 检查 `packages/design/package.json`：

```bash
cat packages/design/package.json
```

- [ ] 若 `peerDependencies` 中缺，补全：

```json
"react-hook-form": "^7",
"@hookform/resolvers": "^3",
"next-intl": "^4",
"zod": "^3"
```

实际依赖应已存在（web-agent 已用过）；只补到 peerDependencies 声明。

#### Step A5.2: useSchema hook（从  拷贝 + 适配）

- [ ] 创建 `packages/design/src/hooks/use-schema.ts`：完整内容拷自 `/Users/grant//platform/packages/common/hooks/use.schema.ts`。具体代码（已验证 v3 兼容）：

```typescript
import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";

/**
 * 递归处理 Schema 的国际化。
 *
 * 支持 ZodObject / ZodString / ZodNumber / ZodOptional / ZodNullable /
 * ZodArray / ZodUnion / ZodDiscriminatedUnion / ZodEffects(refinement)。
 *
 * 每个 check 的 message 字段视为 i18n key，自动用 next-intl 的 t() 翻译。
 */
export const useSchema = <T extends z.ZodTypeAny>(schema: T): T => {
  const t = useTranslations();

  const translateSchema = useCallback(
    (currentSchema: z.ZodTypeAny): z.ZodTypeAny => {
      // ZodEffects (superRefine / refine)
      if (currentSchema instanceof z.ZodEffects) {
        const translatedInner = translateSchema(currentSchema._def.schema);
        const effect = currentSchema._def.effect;
        if (effect.type === "refinement") {
          return translatedInner.superRefine((val, ctx) => {
            const wrappedCtx: z.RefinementCtx = {
              ...ctx,
              addIssue: (issue: z.IssueData) => {
                ctx.addIssue({
                  ...issue,
                  message: issue.message ? t(issue.message) : undefined,
                });
              },
            };
            return effect.refinement(val, wrappedCtx);
          });
        }
        return new z.ZodEffects({
          ...currentSchema._def,
          schema: translatedInner,
        }) as z.ZodTypeAny;
      }

      // ZodObject
      if (currentSchema instanceof z.ZodObject) {
        const shape = currentSchema._def.shape();
        const translatedShape: Record<string, z.ZodTypeAny> = {};
        for (const key in shape) {
          translatedShape[key] = translateSchema(shape[key]);
        }
        return new z.ZodObject({
          ...currentSchema._def,
          shape: () => translatedShape,
        }) as z.ZodTypeAny;
      }

      // ZodString
      if (currentSchema instanceof z.ZodString) {
        let newSchema = z.string();
        const checks = currentSchema._def.checks || [];
        for (const check of checks) {
          switch (check.kind) {
            case "email":
              newSchema = newSchema.email({ message: check.message ? t(check.message) : undefined });
              break;
            case "min":
              newSchema = newSchema.min(check.value, { message: check.message ? t(check.message) : undefined });
              break;
            case "max":
              newSchema = newSchema.max(check.value, { message: check.message ? t(check.message) : undefined });
              break;
            case "regex":
              newSchema = newSchema.regex(check.regex, { message: check.message ? t(check.message) : undefined });
              break;
            case "length":
              newSchema = newSchema.length(check.value, { message: check.message ? t(check.message) : undefined });
              break;
            case "url":
              newSchema = newSchema.url({ message: check.message ? t(check.message) : undefined });
              break;
            case "uuid":
              newSchema = newSchema.uuid({ message: check.message ? t(check.message) : undefined });
              break;
            default:
              break;
          }
        }
        if (currentSchema._def.description) newSchema = newSchema.describe(currentSchema._def.description);
        return newSchema;
      }

      // ZodNumber
      if (currentSchema instanceof z.ZodNumber) {
        const isCoerce = currentSchema._def.coerce === true;
        let newSchema = isCoerce ? z.coerce.number() : z.number();
        const checks = currentSchema._def.checks || [];
        for (const check of checks) {
          switch (check.kind) {
            case "min":
              newSchema = newSchema.min(check.value, { message: check.message ? t(check.message) : undefined });
              break;
            case "max":
              newSchema = newSchema.max(check.value, { message: check.message ? t(check.message) : undefined });
              break;
            case "int":
              newSchema = newSchema.int({ message: check.message ? t(check.message) : undefined });
              break;
            default:
              break;
          }
        }
        if (currentSchema._def.description) newSchema = newSchema.describe(currentSchema._def.description);
        return newSchema;
      }

      if (currentSchema instanceof z.ZodOptional) return translateSchema(currentSchema._def.innerType).optional();
      if (currentSchema instanceof z.ZodNullable) return translateSchema(currentSchema._def.innerType).nullable();
      if (currentSchema instanceof z.ZodArray) return z.array(translateSchema(currentSchema._def.type));

      if (currentSchema instanceof z.ZodDiscriminatedUnion) {
        const options = currentSchema._def.options || [];
        const translated = options.map((o: z.ZodTypeAny) => translateSchema(o));
        return z.discriminatedUnion(currentSchema._def.discriminator, translated as typeof options);
      }

      if (currentSchema instanceof z.ZodUnion) {
        const options = currentSchema._def.options || [];
        const translated = options.map((o: z.ZodTypeAny) => translateSchema(o));
        return z.union(translated as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
      }

      return currentSchema;
    },
    [t],
  );

  return translateSchema(schema) as T;
};
```

- [ ] 创建 `packages/design/src/hooks/index.ts`：

```typescript
export { useSchema } from "./use-schema";
```

#### Step A5.3: Form / FormItem（参考  简化）

- [ ] 创建 `packages/design/src/components/form/form.tsx`：

```tsx
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Children,
  cloneElement,
  isValidElement,
  type FC,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  type Control,
  type ControllerRenderProps,
  type DefaultValues,
  type FieldValues,
  type Resolver,
  type SubmitHandler,
  useForm,
  type UseFormReturn,
} from "react-hook-form";
import type { ZodType } from "zod";

import {
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
  FormMessage,
  Form as UIForm,
  FormItem as UIFormItem,
} from "../ui/form";

interface FormProps<T extends FieldValues> extends PropsWithChildren {
  schema: ZodType<T>;
  defaultValues?: DefaultValues<T>;
  onSubmit: SubmitHandler<T>;
  className?: string;
  disabled?: boolean;
}

export function Form<T extends FieldValues>({
  schema,
  defaultValues,
  onSubmit,
  className,
  disabled,
  children,
}: FormProps<T>) {
  // biome-ignore lint/suspicious/noExplicitAny: zod 4.x 与 zodResolver 类型微差
  const resolver: Resolver<T> = zodResolver(schema as any);
  const form = useForm<T>({ resolver, defaultValues });

  return (
    <UIForm {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className={className}
        noValidate
      >
        <fieldset disabled={disabled} style={{ all: "unset", display: "contents" }}>
          {children}
        </fieldset>
      </form>
    </UIForm>
  );
}

interface FormItemProps<T extends FieldValues> extends PropsWithChildren {
  name: string;
  label?: string | ReactNode;
  description?: string | ReactNode;
  control?: Control<T>;
  className?: string;
}

export const FormItem: FC<FormItemProps<FieldValues>> = ({
  name,
  label,
  description,
  control,
  className,
  children,
}) => {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <UIFormItem className={className}>
          {label ? <FormLabel>{label}</FormLabel> : null}
          <FormControl>
            {Children.count(children) === 1 && isValidElement(children)
              ? cloneElement(children as ReactElement<ControllerRenderProps>, field)
              : children}
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </UIFormItem>
      )}
    />
  );
};
```

- [ ] 创建 `packages/design/src/components/form/index.ts`：

```typescript
export { Form, FormItem } from "./form";
```

#### Step A5.4: barrel 导出

- [ ] 修改 `packages/design/src/index.ts`，追加（保留现有）：

```typescript
export * from "./components/form";
export * from "./hooks";
```

#### Step A5.5: 验证 + 提交

- [ ] 运行：

```bash
pnpm --filter @meshbot/design build
pnpm --filter @meshbot/design typecheck
```

预期 0 errors（若 zod 类型与 zodResolver 有兼容问题，按 biome-ignore + as any 处理）。

- [ ] 提交：

```bash
git add packages/design pnpm-lock.yaml
git commit -m "feat(design): add useSchema hook and Form/FormItem high-level wrapper

useSchema 递归翻译 Zod schema 内 message key（与 next-intl 配合）；
Form/FormItem 基于 react-hook-form + zodResolver 的统一封装。
取代之前在 web-agent 各页面散落的 useForm/zodResolver 手写代码。"
```

---

### Task A6: 集成 Form/FormItem 到 web-agent 的一个现有表单

**目的**：验证 Track A 集成链路（schema → useSchema → Form/FormItem → 提交 → 后端 i18n 错误）端到端工作。挑 `apps/web-agent/src/app/login/page.tsx` 作为试点。

**Files:**
- Modify: `apps/web-agent/src/app/login/page.tsx`

#### Step A6.1: 改写 LoginPage 用新封装

- [ ] 修改 `apps/web-agent/src/app/login/page.tsx`，把 useForm/zodResolver/FormField/FormItem 等替换为 Form/FormItem + useSchema：

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
  Form,
  FormItem,
  Input,
  useSchema,
} from "@meshbot/design";
import { type LoginInput, loginSchema } from "@meshbot/types-agent";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthShellLayout } from "@/components/layouts/auth-shell-layout";
import { useLogin } from "@/rest/auth";

export default function LoginPage() {
  const router = useRouter();
  const loginMutation = useLogin();
  const t = useTranslations("login");
  const schema = useSchema(loginSchema);

  const onSubmit = async (values: LoginInput) => {
    try {
      await loginMutation.mutateAsync(values);
      router.push("/");
    } catch (e) {
      // surfaced via FormMessage if returned 4xx with i18n key already translated server-side
    }
  };

  return (
    <AuthShellLayout>
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Form schema={schema} defaultValues={{ username: "", password: "" }} onSubmit={onSubmit}>
            <FormItem name="username" label={t("account")}>
              <Input placeholder={t("accountPlaceholder")} />
            </FormItem>
            <FormItem name="password" label={t("password")}>
              <Input type="password" placeholder={t("passwordPlaceholder")} />
            </FormItem>
            {loginMutation.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{(loginMutation.error as Error).message}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? t("submitting") : t("submit")}
            </Button>
          </Form>
        </CardContent>
      </Card>
    </AuthShellLayout>
  );
}
```

#### Step A6.2: 确认 messages 有所需 key

- [ ] 查看 `apps/web-agent/messages/zh.json`，确认 `login.*` 段有 title/subtitle/account/accountPlaceholder/password/passwordPlaceholder/submit/submitting。若 `submitting` 缺则手补两份 JSON。

#### Step A6.3: 确认 loginSchema 用了 i18n key

- [ ] 查看 `libs/types-agent/src/account/login.schema.ts` 或类似位置：

```bash
grep -rln "loginSchema" libs/types-agent/src/
```

打开该文件，若 message 写的是裸中文（如 `"用户名必填"`），替换为 i18n key（如 `"validation.required"`）。同步在 `apps/web-agent/messages/{zh,en}.json` 的 `validation` 段加对应 key。

#### Step A6.4: 冒烟

- [ ] 运行 `pnpm --filter @meshbot/web-agent build` + `typecheck`，预期 0 errors。

- [ ] 启动 web-agent + server-agent 联合测试：

```bash
timeout 30s pnpm dev:server-agent &
timeout 30s pnpm dev:web-agent &
sleep 8
# 用浏览器打开 http://localhost:3001/login
# 1) 不填提交 → 应看到 useSchema 翻译过的中文错误
# 2) 切英文 cookie → 应看到英文错误
pkill -f "server-agent|web-agent"
```

人工验证（无法纯 curl 测）。

#### Step A6.5: 提交

```bash
git add apps/web-agent
git commit -m "refactor(web-agent): migrate login page to Form/FormItem + useSchema

试点验证 Track A 链路：loginSchema 的 i18n key → useSchema 翻译 →
Form/FormItem 渲染 → 提交。其余页面 Phase 2/3 逐步迁。"
```

---

### Task A7: sync-locales 脚本

**Files:**
- Create: `scripts/sync-locales.ts`
- Modify: `scripts/README.md` (加 sync:locales 说明)
- Modify: root `package.json` (加 sync:locales)

#### Step A7.1: 实现脚本

- [ ] 创建 `scripts/sync-locales.ts`：

```typescript
#!/usr/bin/env tsx
/**
 * sync-locales —— 扫描前后端所有 t() / i18n.translate() 调用，
 * 对比 locale JSON 文件，输出 missing / orphan / asymmetric。
 *
 * 用法：
 *   pnpm sync:locales              # 只报告
 *   pnpm sync:locales -- --write   # 把 missing 在 zh/en 都补占位
 *   pnpm sync:locales -- --check   # 仅 diff；有不一致则 exit 1（用于 pre-commit）
 *   pnpm sync:locales -- --prune   # 删 orphan（危险，需 PR 评审）
 */
import { Project, SyntaxKind } from "ts-morph";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const WEB_APPS = ["web-agent", "web-main"];
const SERVER_APPS = ["server-agent", "server-main"];

interface LocaleSet {
  app: string;
  locales: Record<string, Record<string, string>>; // {zh: {flatKey: value}, en: {...}}
}

function flatten(obj: any, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof obj[k] === "object" && obj[k] !== null) {
      Object.assign(out, flatten(obj[k], key));
    } else {
      out[key] = String(obj[k]);
    }
  }
  return out;
}

function unflatten(flat: Record<string, string>): any {
  const out: any = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split(".");
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] ??= {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

function loadWebMessages(app: string): LocaleSet | null {
  const dir = path.join(ROOT, "apps", app, "messages");
  if (!fs.existsSync(dir)) return null;
  const set: LocaleSet = { app, locales: {} };
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const lang = file.replace(".json", "");
    set.locales[lang] = flatten(JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")));
  }
  return set;
}

function loadServerI18n(app: string): LocaleSet | null {
  const dir = path.join(ROOT, "apps", app, "i18n");
  if (!fs.existsSync(dir)) return null;
  const set: LocaleSet = { app, locales: {} };
  for (const lang of fs.readdirSync(dir)) {
    const langDir = path.join(dir, lang);
    if (!fs.statSync(langDir).isDirectory()) continue;
    set.locales[lang] = {};
    for (const file of fs.readdirSync(langDir)) {
      if (!file.endsWith(".json")) continue;
      const ns = file.replace(".json", "");
      const flat = flatten(JSON.parse(fs.readFileSync(path.join(langDir, file), "utf-8")));
      for (const [k, v] of Object.entries(flat)) {
        set.locales[lang][`${ns}.${k}`] = v;
      }
    }
  }
  return set;
}

function scanKeys(app: string, kind: "web" | "server"): Set<string> {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.base.json"),
    skipAddingFilesFromTsConfig: true,
  });
  const glob = path.join(ROOT, "apps", app, kind === "web" ? "src/**/*.{ts,tsx}" : "src/**/*.ts");
  project.addSourceFilesAtPaths(glob);

  const keys = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    sf.forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.CallExpression) return;
      const call = node.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = call.getExpression().getText();
      const isT =
        expr === "t" ||
        expr.endsWith(".t") ||
        expr.endsWith(".translate") ||
        expr === "useTranslations" ||
        expr === "getTranslations";

      if (!isT) return;

      const args = call.getArguments();
      if (args.length === 0) return;
      const first = args[0];
      if (first.getKind() === SyntaxKind.StringLiteral) {
        keys.add(first.getText().slice(1, -1)); // strip quotes
      } else if (first.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
        keys.add(first.getText().slice(1, -1));
      }
      // 跳过动态 key（模板字符串含 ${}）
    });
  }
  return keys;
}

function diff(set: LocaleSet, usedKeys: Set<string>, namespace?: string) {
  const langs = Object.keys(set.locales);
  const allDefined = new Set<string>();
  for (const l of langs) Object.keys(set.locales[l]).forEach((k) => allDefined.add(k));

  // 前端 useTranslations(namespace) 模式：key 已带 namespace 前缀
  // 后端 i18n.translate("namespace.key") 同样带前缀
  // useTranslations() 不带 namespace 的，scanKeys 已抓到完整 key

  const missing = [...usedKeys].filter((k) => !allDefined.has(k));
  const orphan = [...allDefined].filter((k) => !usedKeys.has(k));
  const asymmetric: string[] = [];
  if (langs.length >= 2) {
    const [a, b] = langs;
    for (const k of new Set([...Object.keys(set.locales[a]), ...Object.keys(set.locales[b])])) {
      if (!(k in set.locales[a]) || !(k in set.locales[b])) asymmetric.push(k);
    }
  }
  return { missing, orphan, asymmetric };
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const check = args.includes("--check");
const prune = args.includes("--prune");

let exitCode = 0;
let totalMissing = 0;
let totalAsymmetric = 0;

for (const app of WEB_APPS) {
  const set = loadWebMessages(app);
  if (!set) continue;
  const used = scanKeys(app, "web");
  const { missing, orphan, asymmetric } = diff(set, used);

  console.log(`\n=== web/${app} ===`);
  console.log(`  used keys: ${used.size}, defined: ${Object.keys(set.locales[Object.keys(set.locales)[0]] || {}).length}`);
  if (missing.length) console.log(`  MISSING (${missing.length}):`, missing.slice(0, 10), missing.length > 10 ? `... and ${missing.length - 10} more` : "");
  if (orphan.length) console.log(`  ORPHAN (${orphan.length}):`, orphan.slice(0, 10));
  if (asymmetric.length) console.log(`  ASYMMETRIC zh↔en (${asymmetric.length}):`, asymmetric.slice(0, 10));

  totalMissing += missing.length;
  totalAsymmetric += asymmetric.length;

  if (write && (missing.length || asymmetric.length)) {
    for (const lang of Object.keys(set.locales)) {
      for (const k of [...missing, ...asymmetric]) {
        if (!(k in set.locales[lang])) set.locales[lang][k] = "";
      }
      const file = path.join(ROOT, "apps", app, "messages", `${lang}.json`);
      fs.writeFileSync(file, JSON.stringify(unflatten(set.locales[lang]), null, 2) + "\n", "utf-8");
      console.log(`  wrote: ${file}`);
    }
  }
  if (prune && orphan.length) {
    for (const lang of Object.keys(set.locales)) {
      for (const k of orphan) delete set.locales[lang][k];
      const file = path.join(ROOT, "apps", app, "messages", `${lang}.json`);
      fs.writeFileSync(file, JSON.stringify(unflatten(set.locales[lang]), null, 2) + "\n", "utf-8");
      console.log(`  pruned: ${file}`);
    }
  }
}

for (const app of SERVER_APPS) {
  const set = loadServerI18n(app);
  if (!set) continue;
  const used = scanKeys(app, "server");
  const { missing, orphan, asymmetric } = diff(set, used);
  console.log(`\n=== server/${app} ===`);
  console.log(`  used keys: ${used.size}`);
  if (missing.length) console.log(`  MISSING (${missing.length}):`, missing.slice(0, 10));
  if (orphan.length) console.log(`  ORPHAN (${orphan.length}):`, orphan.slice(0, 10));
  if (asymmetric.length) console.log(`  ASYMMETRIC (${asymmetric.length}):`, asymmetric.slice(0, 10));
  totalMissing += missing.length;
  totalAsymmetric += asymmetric.length;
}

if (check && (totalMissing > 0 || totalAsymmetric > 0)) {
  console.error(`\n[FAIL] missing=${totalMissing} asymmetric=${totalAsymmetric}; run \`pnpm sync:locales -- --write\` to fix`);
  exitCode = 1;
}

console.log(`\nDone (missing=${totalMissing}, asymmetric=${totalAsymmetric})`);
process.exit(exitCode);
```

#### Step A7.2: package.json + README

- [ ] 修改 root `package.json` 的 scripts 加：

```json
"sync:locales": "tsx scripts/sync-locales.ts"
```

- [ ] 修改 `scripts/README.md`，在 "当前脚本" 表里加一行：

```markdown
| `sync-locales.ts` | `pnpm sync:locales` | 扫描 t() 调用与 locale JSON 对齐 |
```

#### Step A7.3: 验证

- [ ] 运行 `pnpm sync:locales`，预期：输出每个 app 的 missing/orphan/asymmetric 列表（基线状态可能有少量 orphan，可接受；missing 应为 0 或在 A6 已知遗漏）。

- [ ] 若报告大量 missing，用 `pnpm sync:locales -- --write` 一次补全，然后人工填实际译文。

#### Step A7.4: 提交

```bash
git add scripts package.json
git commit -m "feat(scripts): add sync-locales for i18n key alignment

扫前端 useTranslations()/t() + 后端 i18n.translate() 调用，
对比 messages/i18n JSON，报 missing/orphan/asymmetric。
--write 补占位；--check 用于 pre-commit；--prune 危险删除。"
```

---

## Track B — harness（5 task）

### Task B1: sync-skills.ts 脚本

**Files:**
- Create: `scripts/sync-skills.ts`
- Modify: root `package.json` (加 sync:skills)
- Modify: `scripts/README.md`

#### Step B1.1: 实现

- [ ] 创建 `scripts/sync-skills.ts`：

```typescript
#!/usr/bin/env tsx
/**
 * sync-skills —— 把 .cursor/rules/*.mdc 派生为 .claude/skills/<name>/SKILL.md。
 *
 * Cursor mdc frontmatter:                Claude SKILL.md frontmatter:
 *   description, globs?, alwaysApply?     name: <slug>
 *                                         description: <mdc desc> [Use when matching: <globs>]
 *
 * body 完全 1:1 拷过去。
 *
 * 用法：
 *   pnpm sync:skills           # 写
 *   pnpm sync:skills -- --check  # 仅比对；不一致 exit 1
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const RULES_DIR = path.join(ROOT, ".cursor", "rules");
const SKILLS_DIR = path.join(ROOT, ".claude", "skills");

interface Frontmatter {
  description?: string;
  globs?: string | string[];
  alwaysApply?: boolean;
}

function parseMdc(content: string): { fm: Frontmatter; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("missing frontmatter");
  const fm: Frontmatter = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    let v: any = line.slice(idx + 1).trim();
    if (v.startsWith("[") || v.startsWith("{")) {
      // yaml list/object — keep as string for now (simple cases)
    } else if (v === "true" || v === "false") v = v === "true";
    fm[k as keyof Frontmatter] = v;
  }
  // multi-line globs
  if (typeof fm.globs === "string" && fm.globs.startsWith("[")) {
    // primitive single-line yaml list
  }
  // multi-line block-style globs (- ...)
  const blockGlobs: string[] = [];
  let inGlobs = false;
  for (const line of m[1].split("\n")) {
    if (line.trim().startsWith("globs:")) {
      inGlobs = !line.includes(":") || line.endsWith(":");
      const rest = line.split(":").slice(1).join(":").trim();
      if (rest && !rest.startsWith("-")) {
        fm.globs = rest;
        inGlobs = false;
      }
      continue;
    }
    if (inGlobs) {
      if (line.startsWith("  - ")) blockGlobs.push(line.slice(4).trim());
      else if (line.startsWith("- ")) blockGlobs.push(line.slice(2).trim());
      else inGlobs = false;
    }
  }
  if (blockGlobs.length) fm.globs = blockGlobs;

  return { fm, body: m[2].trim() };
}

function buildSkillFrontmatter(slug: string, fm: Frontmatter): string {
  const desc = fm.description || "";
  const globs = Array.isArray(fm.globs) ? fm.globs.join(", ") : fm.globs;
  const trigger = globs ? ` Use when files matching ${globs} change, or when explicitly invoked.` : "";
  return `---
name: ${slug}
description: ${JSON.stringify(desc + trigger)}
---`;
}

function generate() {
  if (!fs.existsSync(RULES_DIR)) {
    console.error(`No rules dir: ${RULES_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(RULES_DIR).filter((f) => f.endsWith(".mdc"));
  return files.map((file) => {
    const slug = file.replace(/\.mdc$/, "");
    const mdcContent = fs.readFileSync(path.join(RULES_DIR, file), "utf-8");
    const { fm, body } = parseMdc(mdcContent);
    const fmOut = buildSkillFrontmatter(slug, fm);
    const skillContent = `${fmOut}\n\n${body}\n`;
    return { slug, skillContent };
  });
}

const check = process.argv.includes("--check");
let drift = 0;

for (const { slug, skillContent } of generate()) {
  const target = path.join(SKILLS_DIR, slug, "SKILL.md");
  if (check) {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "";
    if (existing !== skillContent) {
      console.error(`[drift] .claude/skills/${slug}/SKILL.md differs from .cursor/rules/${slug}.mdc`);
      drift++;
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, skillContent, "utf-8");
    console.log(`wrote: .claude/skills/${slug}/SKILL.md`);
  }
}

if (check && drift > 0) {
  console.error(`\n${drift} skill file(s) out of sync; run \`pnpm sync:skills\` to fix`);
  process.exit(1);
}
console.log("Done");
```

#### Step B1.2: pnpm script + README

- [ ] 修改 root `package.json` scripts：

```json
"sync:skills": "tsx scripts/sync-skills.ts"
```

- [ ] 修改 `scripts/README.md` 加一行：

```markdown
| `sync-skills.ts` | `pnpm sync:skills` | 把 .cursor/rules/*.mdc 派生为 .claude/skills/*/SKILL.md（单向） |
```

#### Step B1.3: 测试 + 提交

- [ ] 用一个 sample 测：

```bash
pnpm sync:skills
ls .claude/skills/  # 应该看到现有 5 条 meshbot 规则也被派生过来
```

预期：现有 5 条 `.mdc` 都派生出 `.claude/skills/<slug>/SKILL.md`，旧的（Phase 1 写的 CLAUDE.md 不冲突）。

- [ ] 提交：

```bash
git add scripts package.json
git commit -m "feat(scripts): add sync-skills to derive .claude/skills from .cursor/rules

单向同步：.cursor/rules/*.mdc -> .claude/skills/<slug>/SKILL.md。
mdc frontmatter (description/globs/alwaysApply) -> SKILL.md frontmatter
(name/description with 'Use when ...' hint)。
body 1:1 拷贝。pre-commit 跑 --check 防漂移。"
```

---

### Task B2: 13 条规约（.cursor/rules + 同步派生）

**Files:**
- Create × 13: `.cursor/rules/{service-tx-lock-cache,service-repo-access,controller-thin,swagger-api-declaration,shared-data-model,web-form-convention,dev-workflow,bypass-mode-safety,check-transactional,check-method-naming,check-lock-tx,check-repo-access,check-dead-exports}.mdc`
- Delete: `.cursor/rules/frontend-i18n.mdc` (被 web-form-convention 取代)
- Auto-generate × 13: `.claude/skills/<slug>/SKILL.md`

**做法**：每条规约 mostly 拷自 `/Users/grant//platform/.cursor/rules/<slug>.mdc`，路径/包名替换。本 task 一次完成所有 13 条 + 删 frontend-i18n + 跑 sync-skills。

#### Step B2.1: 复制  13 条 mdc

- [ ] 一次性拷贝（用 cp 而非 git mv，因为是跨仓库）：

```bash
cd /Users/grant/Meta1/meshbot
for slug in service-tx-lock-cache service-repo-access controller-thin swagger-api-declaration shared-data-model web-form-convention dev-workflow bypass-mode-safety check-transactional check-method-naming check-lock-tx check-repo-access; do
  cp /Users/grant//platform/.cursor/rules/$slug.mdc .cursor/rules/$slug.mdc
done
# check-dead-exports 在  不一定有；从 check-transactional 模板改写
```

- [ ] 处理 `check-dead-exports.mdc`（ 可能没有，参考其他 check-* 创建）：

```yaml
---
description: 运行死导出围栏脚本 `pnpm check:dead` 验证 named export 没人引用的清单，commit 前检查
globs: libs/**/*.ts,apps/**/src/**/*.ts
alwaysApply: false
---

# check:dead 静态围栏

`pnpm check:dead` 扫描 `libs/**` 与 `apps/server-*/src/**` 中的 named export，
对照仓库其他 import 检查是否有"已导出但无人使用"的死代码。

## 触发条件

- 提交前发现 named export 列表变化
- 删除一个 feature 后想找出残留 dead code
- 大型重构后整理 export surface

## 使用

```bash
pnpm check:dead              # 默认增量模式（与 docs/audits/dead-fence/ baseline 对比）
pnpm check:dead -- --force-report   # 强制刷新 baseline
```

## 配套围栏

`scripts/check-dead-exports.ts`（ts-morph 静态分析）。
```

#### Step B2.2: 路径与包名替换

每份 mdc 内通常含  路径 / 包名 / 域名引用。对所有 13 条做以下替换：

- [ ] 运行：

```bash
cd /Users/grant/Meta1/meshbot
# 包名替换
for f in .cursor/rules/{service-tx-lock-cache,service-repo-access,controller-thin,swagger-api-declaration,shared-data-model,web-form-convention,dev-workflow,bypass-mode-safety,check-transactional,check-method-naming,check-lock-tx,check-repo-access,check-dead-exports}.mdc; do
  [ -f "$f" ] || continue
  sed -i '' \
    -e 's|@meshbot/nest-common|@meshbot/common|g' \
    -e 's|@meshbot/nest-types|@meshbot/types|g' \
    -e 's|@meshbot/nest-types-agent|@meshbot/types-agent|g' \
    -e 's|@meshbot/nest-types-memory|@meshbot/types-main|g' \
    -e 's|@meshbot/nest-types-rag|@meshbot/types-main|g' \
    -e 's|@meshbot/design|@meshbot/design|g' \
    -e 's|@meshbot/common|@meshbot/web-common|g' \
    -e 's|platform|meshbot|g' \
    -e 's|ai-platform|meshbot|g' \
    "$f"
done
```

注：`sed -i ''` 是 macOS 语法；Linux 用 `sed -i`。

- [ ] 对域路径手工核查：grep 每个 mdc 里残留的 `libs/rag` / `libs/memory` / `libs/agent-tools` / `apps/server-app` / `apps/server-rag` / `apps/server-memory` / `apps/web-memory` / `apps/web-rag` / `apps/web-app`：

```bash
grep -rEn "libs/(rag|memory|agent-tools)|server-(app|rag|memory)|web-(memory|rag|app)" .cursor/rules/
```

把它们改成 meshbot 的对应路径或删除该段（如果 meshbot 没有对应物）。常见 mapping：
- `libs/rag` / `libs/memory` → 删除或替换为 `libs/types-main`
- `server-app` → `server-agent`（meshbot 的"主"业务端）
- `server-rag` / `server-memory` → 删除
- `web-memory` / `web-rag` / `web-app` → `web-agent` 或 `web-main`

#### Step B2.3: web-form-convention 特殊处理

- [ ] 编辑 `.cursor/rules/web-form-convention.mdc`：
  1. 顶部 `globs` 改为 `apps/web-agent/**/*,apps/web-main/**/*`
  2. 移除 "仅 web-agent 强制" 的特殊段（meshbot 两个 web 都已上 i18n）
  3. 把  的"以 `@meshbot/common/hooks` 导入 `useSchema`"改为"从 `@meshbot/design` 导入 `useSchema`、`Form`、`FormItem`"
  4. 表单 Schema 映射表替换为 meshbot 版：
     | 应用 | 推荐 Schema 包 |
     | web-agent | `@meshbot/types-agent` |
     | web-main | `@meshbot/types-main` |
     | 跨域 | `@meshbot/types` |

#### Step B2.4: 删除 frontend-i18n.mdc

- [ ] 

```bash
rm .cursor/rules/frontend-i18n.mdc
```

#### Step B2.5: 跑 sync-skills 派生

- [ ] 

```bash
pnpm sync:skills
```

应看到 `.claude/skills/<slug>/SKILL.md` 各 13 条 + 现有 meshbot 4 条（agent-arch、biome-format、desktop、meta1）派生出来。

#### Step B2.6: 验证

- [ ] 

```bash
pnpm sync:skills -- --check
```

应该 exit 0（刚同步过，无漂移）。

- [ ] 抽看 1-2 条派生结果：

```bash
cat .claude/skills/service-tx-lock-cache/SKILL.md | head -20
cat .claude/skills/web-form-convention/SKILL.md | head -20
```

确认 frontmatter 含 `name:` 与含 globs 信息的 `description:`。

#### Step B2.7: 提交

```bash
git add .cursor/rules .claude/skills
git commit -m "feat(rules): port 13  engineering rules to .cursor + .claude (mirrored)

新增 13 条规约（含 5 个 service-layer + check-* 触发器 + dev-workflow + bypass-mode-safety + shared-data-model + web-form-convention）。
路径/包名全部替换为 meshbot 版本。frontend-i18n 被 web-form-convention 取代后删除。
.claude/skills/ 由 .cursor/rules/ 经 sync-skills 派生。"
```

---

### Task B3: check:dead-exports 围栏

**Files:**
- Create: `scripts/check-dead-exports.ts`
- Create: `docs/audits/dead-fence/.gitkeep`
- Modify: root `package.json`

#### Step B3.1: 拷贝 + 适配

- [ ] 

```bash
cp /Users/grant//platform/scripts/check-dead-exports.ts \
   /Users/grant/Meta1/meshbot/scripts/check-dead-exports.ts
```

#### Step B3.2: 适配 glob/ignore

- [ ] 读 `scripts/check-dead-exports.ts`，找 `shouldSkipFile` 或类似 ignore 配置，确保包含：
  - `libs/agent/**`
  - `apps/cli-agent/**`
  - `apps/desktop/**`
  - `apps/web-*/**`
  - `packages/**`
  - `/tests/`
  - `/migrations/`
  - `node_modules`
  - `dist`

- [ ] `tsConfigFilePath` 改为 `tsconfig.base.json`（Phase 1 4 个围栏一致）

- [ ] -only 字样替换：

```bash
sed -i '' \
  -e 's|@meshbot/nest-common|@meshbot/common|g' \
  -e 's|platform|meshbot|g' \
  scripts/check-dead-exports.ts
```

#### Step B3.3: pnpm script

- [ ] 修改 root `package.json` scripts，把现有 `check` 扩展并加 `check:dead`：

```json
"check:dead": "tsx scripts/check-dead-exports.ts",
"check": "pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:repo && pnpm check:dead"
```

#### Step B3.4: baseline 初始化

- [ ] 

```bash
mkdir -p docs/audits/dead-fence
touch docs/audits/dead-fence/.gitkeep
pnpm check:dead -- --force-report
```

应生成 `docs/audits/dead-fence/<timestamp>.json` 作为 baseline。

#### Step B3.5: 验证全围栏

- [ ] 

```bash
pnpm check
```

5 项全绿。若 `check:dead` 在 first run 暴出实质 dead exports，可：
- 真的死代码 → 删
- 误报 → 调 ignore

#### Step B3.6: 提交

```bash
git add scripts package.json docs/audits/dead-fence
git commit -m "feat(scripts): port check-dead-exports fence

第 5 个静态围栏 —— named export 死导出检测。
pnpm check 现 5 项联跑（tx/naming/lock-tx/repo/dead）。"
```

---

### Task B4: husky + lint-staged + pre-commit

**Files:**
- Create: `.husky/pre-commit`
- Modify: root `package.json` (lint-staged config + prepare script)

#### Step B4.1: 安装 husky

- [ ] 

```bash
pnpm add -w -D husky lint-staged
pnpm exec husky init   # 创建 .husky/pre-commit 占位
```

`husky init` 会在 `package.json` 加 `"prepare": "husky"` 脚本。

#### Step B4.2: 写 pre-commit

- [ ] 编辑 `.husky/pre-commit`，替换内容为：

```bash
#!/bin/sh
set -e

# 1) 增量 biome 格式 + lint 修复（lint-staged 只处理 staged 文件）
pnpm exec lint-staged

# 2) 全量 5 围栏 + sync-skills 漂移检测
pnpm check
pnpm sync:skills -- --check

# 3) sync-locales 软告警（不阻断）
pnpm sync:locales -- --check || echo "[warn] sync:locales has missing/asymmetric keys; consider running 'pnpm sync:locales -- --write'"
```

- [ ] 确保 `.husky/pre-commit` 可执行：

```bash
chmod +x .husky/pre-commit
```

#### Step B4.3: lint-staged 配置

- [ ] 修改 root `package.json` 顶层加：

```json
"lint-staged": {
  "*.{ts,tsx,js,jsx,json}": "biome check --write --no-errors-on-unmatched"
}
```

#### Step B4.4: 验证

- [ ] 

```bash
# 写一个 trivial change
echo "// test" >> libs/common/src/index.ts
git add libs/common/src/index.ts
git commit -m "test: trigger husky" --dry-run
```

pre-commit 应触发；预期看到 lint-staged + check + sync-skills 输出。

- [ ] 撤销 trivial change：

```bash
git checkout libs/common/src/index.ts
```

#### Step B4.5: 提交

- [ ] 

```bash
git add .husky package.json
git commit -m "feat(hooks): add husky pre-commit running biome + check + sync-skills

lint-staged 增量跑 biome check --write；
pnpm check 全量 5 围栏；
sync-skills --check 防 .cursor/.claude 漂移；
sync-locales --check 软告警。"
```

---

### Task B5: post-build.js for Next standalone

**Files:**
- Create: `apps/web-agent/scripts/post-build.js`
- Create: `apps/web-main/scripts/post-build.js`
- Modify: `apps/web-agent/package.json` (build script)
- Modify: `apps/web-main/package.json` (build script)

#### Step B5.1: web-agent

- [ ] 创建 `apps/web-agent/scripts/post-build.js`：

```javascript
#!/usr/bin/env node
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const staticSource = join(projectRoot, ".next", "static");
const standaloneDir = join(projectRoot, ".next", "standalone", "apps", "web-agent");
const staticTarget = join(standaloneDir, ".next", "static");

if (!existsSync(staticSource) || !existsSync(standaloneDir)) {
  // export 模式或 standalone 未启用 — no-op safely
  process.exit(0);
}

cpSync(staticSource, staticTarget, { recursive: true });
console.log("[post-build] static assets copied to standalone");
```

- [ ] 修改 `apps/web-agent/package.json` 的 `build` 脚本：

```json
"build": "next build && node scripts/post-build.js"
```

#### Step B5.2: web-main

- [ ] 创建 `apps/web-main/scripts/post-build.js`（与 web-agent 一致，只把 `apps/web-agent` 替换为 `apps/web-main`）：

```javascript
#!/usr/bin/env node
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const staticSource = join(projectRoot, ".next", "static");
const standaloneDir = join(projectRoot, ".next", "standalone", "apps", "web-main");
const staticTarget = join(standaloneDir, ".next", "static");

if (!existsSync(staticSource) || !existsSync(standaloneDir)) {
  process.exit(0);
}

cpSync(staticSource, staticTarget, { recursive: true });
console.log("[post-build] static assets copied to standalone");
```

- [ ] 修改 `apps/web-main/package.json`：

```json
"build": "next build && node scripts/post-build.js"
```

#### Step B5.3: 验证

- [ ] 

```bash
pnpm --filter @meshbot/web-agent build
pnpm --filter @meshbot/web-main build
```

预期：web-agent 是 export 模式，`post-build.js` 早 exit 0（no-op）；web-main 默认 standalone，会复制成功（如果 `output: standalone` 已配）或同样 no-op。

#### Step B5.4: 提交

```bash
git add apps/web-agent apps/web-main
git commit -m "feat(web): add post-build.js for standalone mode

兼容 next build 的 standalone 输出，把 .next/static 拷到
standalone/apps/<app>/.next/static。export 模式时早 exit 0（no-op-safe）。
web-agent 当前 export 模式，脚本不生效；web-main 默认 standalone。"
```

---

## Track C — Phase 1 cleanup（3 task）

### Task C1: 删僵尸 auth + 删 libs/shared

**Files:**
- Delete: `apps/server-agent/src/auth/` (whole dir)
- Modify: `apps/server-agent/src/app.module.ts`
- Delete: `libs/shared/` (whole dir)

#### Step C1.1: 确认无外部引用

- [ ] 

```bash
grep -rln "LocalAuthModule\|local-auth\|@meshbot/shared" \
  apps libs packages scripts --include="*.ts" --include="*.tsx" --include="*.json" 2>/dev/null
```

预期：只在 `apps/server-agent/src/app.module.ts` 见到 LocalAuthModule（待删）；`@meshbot/shared` 无引用。

#### Step C1.2: 删 zombie auth

- [ ] 

```bash
rm -rf apps/server-agent/src/auth/
```

- [ ] 修改 `apps/server-agent/src/app.module.ts`：删除 `import { LocalAuthModule }` 行；从 `imports: [...]` 数组移除 `LocalAuthModule`。

#### Step C1.3: 删 libs/shared

- [ ] 

```bash
rm -rf libs/shared/
```

#### Step C1.4: 验证

- [ ] 

```bash
pnpm install
pnpm typecheck
pnpm --filter @meshbot/server-agent build
pnpm check
```

5 项全绿；server-agent build 通过；typecheck 0 errors。

- [ ] 冒烟启动 server-agent，确认 `POST /api/auth/register` 仍工作（由真 AuthModule 接管）。

#### Step C1.5: 提交

```bash
git add -A
git commit -m "chore(server-agent): remove zombie LocalAuthModule and empty libs/shared

apps/server-agent/src/auth/ 是 pre-existing 与 auth.module.ts 路由冲突的死代码，
verified by Phase 1 final review；libs/shared 是 Phase 1 留下的空壳，无消费者。
两者均无外部引用，直接删除。"
```

---

### Task C2: 移 PROVIDERS + 隐藏 Initializer + JSDoc + --force-report 文档

**Files:**
- Create: `libs/types-agent/src/ai/providers.ts`
- Create: `libs/types-agent/src/ai/index.ts`
- Modify: `libs/types-agent/src/index.ts`
- Modify: `packages/web-common/src/providers/index.ts`
- Modify: `apps/server-agent/src/controllers/setup.controller.ts`
- Modify: `apps/server-agent/package.json`
- Modify: `libs/common/src/lock/index.ts`
- Modify: `libs/common/src/cache/index.ts`
- Modify: `libs/common/src/common.module.ts`
- Modify: `scripts/README.md`

#### Step C2.1: PROVIDERS 迁到 types-agent

- [ ] 创建 `libs/types-agent/src/ai/providers.ts`：

把 `packages/web-common/src/providers/index.ts` 的 `ProviderDef` interface + `PROVIDERS` 常量整段挪过来。完整内容（含所有 providers entries）从源文件拷贝：

```bash
cp packages/web-common/src/providers/index.ts /tmp/providers-source.ts
# 然后手工拷过去 libs/types-agent/src/ai/providers.ts
```

至少确保以下结构：

```typescript
export interface ProviderDef {
  type: string;
  name: string;
  description: string;
  default_base_url: string;
  models: string[];
}

export const PROVIDERS: readonly ProviderDef[] = [
  // ... 把原文件的所有 provider entries 拷过来
] as const;

export type ModelConfigInput = {
  providerType: string;
  name: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
};
```

- [ ] 创建 `libs/types-agent/src/ai/index.ts`：

```typescript
export { PROVIDERS, type ProviderDef, type ModelConfigInput } from "./providers";
```

- [ ] 修改 `libs/types-agent/src/index.ts`：追加：

```typescript
export * from "./ai";
```

#### Step C2.2: web-common 改为 re-export

- [ ] 修改 `packages/web-common/src/providers/index.ts` 为：

```typescript
// 兼容性 re-export：PROVIDERS 已迁到 @meshbot/types-agent
export {
  PROVIDERS,
  type ProviderDef,
  type ModelConfigInput,
} from "@meshbot/types-agent";
```

确认 `packages/web-common/package.json` dependencies 含 `"@meshbot/types-agent": "workspace:*"`，若缺则补。

#### Step C2.3: setup.controller 改 import

- [ ] 修改 `apps/server-agent/src/controllers/setup.controller.ts`：

```typescript
// 原：import { PROVIDERS } from "@meshbot/web-common";
import { PROVIDERS } from "@meshbot/types-agent";
```

- [ ] 修改 `apps/server-agent/package.json`：从 dependencies 删除 `@meshbot/web-common`；确认 `@meshbot/types-agent` 已存在（应该已有）。

```bash
pnpm install
```

#### Step C2.4: 隐藏 Initializer

- [ ] 修改 `libs/common/src/lock/index.ts`：删除 `export { LockInitializer }` 行。

剩余应只有：

```typescript
export { LOCK_PROVIDER, type LockProvider, type LockRelease } from "./lock.provider";
export { MemoryLockProvider } from "./memory-lock.provider";
```

- [ ] 修改 `libs/common/src/cache/index.ts`：删除 `export { CacheInitializer }` 行。剩余：

```typescript
export { CACHE_PROVIDER, type CacheProvider } from "./cache.provider";
export { MemoryCacheProvider } from "./memory-cache.provider";
```

- [ ] 修改 `libs/common/src/common.module.ts`：内部 import 改为深路径（避免 import 链上还能拿到隐藏类）：

```typescript
// 改为：
import { LockInitializer } from "./lock/lock.initializer";
import { CacheInitializer } from "./cache/cache.initializer";
// 之前若从 "./lock" / "./cache" barrel 导入，改为这样的深路径
```

#### Step C2.5: forRoot JSDoc

- [ ] 修改 `libs/common/src/common.module.ts` 的 `CommonModule.forRoot` 静态方法，加 JSDoc：

```typescript
/**
 * 配置 meshbot 通用基础设施。
 *
 * **只能在根模块（AppModule）调一次**。模块标记为 `global: true`，
 * 子模块/子 app 无需重复调用。多次调用会创建多份 LockProvider /
 * CacheProvider 实例，导致不同代码路径取到不同的内部状态
 * （Map / LRUCache），破坏锁与缓存的全局一致性。
 *
 * @example
 * \@Module({
 *   imports: [
 *     CommonModule.forRoot(),  // 只在 AppModule 调一次
 *     // ...
 *   ],
 * })
 * export class AppModule {}
 */
static forRoot(options: CommonModuleOptions = {}): DynamicModule {
  // ... existing body
}
```

#### Step C2.6: scripts/README.md --force-report 段

- [ ] 在 `scripts/README.md` 末尾追加：

```markdown
## 增量基线模式

五个 `check:*` 脚本（tx / naming / lock-tx / repo / dead）都支持增量模式。运行时会读取 `docs/audits/<fence-name>/` 下最新的 baseline JSON，仅在以下情况输出新报告：

- 新增 finding（之前无、本次发现的）
- 已有 finding 内容变化（同 file:line 但 issue 类别不同）

**默认行为**：若与 baseline 一致 → 输出 `无新增 finding`，不写新 JSON；exit 0。

**强制刷新 baseline**：

当你**合法地修改了围栏覆盖的代码**（如新增 `@Transactional` 方法）后，希望基线"接受"这次变化：

```bash
pnpm check:tx -- --force-report
```

会强制写一份新 JSON 到 `docs/audits/tx-fence/<timestamp>.json`，下次跑就以新 baseline 为准。应当随业务代码一起 commit。
```

#### Step C2.7: 验证 + 提交

- [ ] 

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm check
```

全绿。

- [ ] 验证 `GET /api/providers` 端点仍返回原 JSON：

```bash
timeout 15s pnpm dev:server-agent &
sleep 5
curl -s http://localhost:3100/api/providers | head -20
pkill -f server-agent
```

- [ ] 提交：

```bash
git add -A
git commit -m "refactor: relocate PROVIDERS, hide initializers, add JSDoc + force-report docs

- PROVIDERS 从 packages/web-common 迁到 libs/types-agent/src/ai/（消除后端→前端反向依赖）
- libs/common barrel 不再导出 LockInitializer / CacheInitializer（内部装配器）
- CommonModule.forRoot JSDoc 注明只调一次
- scripts/README.md 增量基线模式段（介绍 --force-report 用法）"
```

---

### Task C3: 端到端集成测（Zod → createI18nZodDto → Controller）

**Files:**
- Create: `apps/server-agent/test/e2e/dto-i18n.spec.ts`
- Modify: root `jest.config.ts` (确认 apps/**/test/e2e 被 jest 扫到)

#### Step C3.1: 检查 jest 配置

- [ ] 查看 `jest.config.ts` 的 `roots` 与 `testPathIgnorePatterns`：

```bash
cat jest.config.ts
```

确认 `apps/` 在 roots，且 `apps/server-agent/test/e2e/` 不被 ignore。Phase 1 配的 testMatch `**/?(*.)+(spec|test).ts` 会扫到 `dto-i18n.spec.ts`。

#### Step C3.2: 写集成测

- [ ] 创建 `apps/server-agent/test/e2e/dto-i18n.spec.ts`：

```typescript
import "reflect-metadata";
import { Body, Controller, INestApplication, Module, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  AcceptLanguageResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  I18nValidationExceptionFilter,
  I18nValidationPipe,
} from "nestjs-i18n";
import request from "supertest";
import path from "node:path";
import { z } from "zod";
import { createI18nZodDto } from "@meshbot/common";

const TestSchema = z.object({
  deviceName: z.string().min(1, { message: "validation.required" }),
});

class TestDto extends createI18nZodDto(TestSchema) {}

@Controller("test")
class TestController {
  @Post("echo")
  echo(@Body() dto: TestDto) {
    return dto;
  }
}

@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: "zh",
      loader: I18nJsonLoader,
      loaderOptions: {
        path: path.join(__dirname, "fixtures", "i18n"),
      },
      resolvers: [new HeaderResolver(["x-lang"]), new AcceptLanguageResolver()],
    }),
  ],
  controllers: [TestController],
})
class TestModule {}

describe("e2e: createI18nZodDto + I18nValidationPipe", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalPipes(new I18nValidationPipe());
    app.useGlobalFilters(new I18nValidationExceptionFilter({ detailedErrors: false }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("合法 body 返回 200 + echo", async () => {
    const res = await request(app.getHttpServer())
      .post("/test/echo")
      .send({ deviceName: "alpha" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deviceName: "alpha" });
  });

  it("非法 body 默认 zh 返中文错误", async () => {
    const res = await request(app.getHttpServer())
      .post("/test/echo")
      .send({ deviceName: "" });
    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).toMatch(/必填字段|required/i); // 留一点弹性给 nestjs-i18n 翻译路径细节
  });

  it("Accept-Language en 返英文错误", async () => {
    const res = await request(app.getHttpServer())
      .post("/test/echo")
      .set("Accept-Language", "en")
      .send({ deviceName: "" });
    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).toMatch(/required field|required/i);
  });
});
```

#### Step C3.3: fixtures locale 文件

- [ ] 创建 `apps/server-agent/test/e2e/fixtures/i18n/zh/validation.json`：

```json
{
  "required": "必填字段"
}
```

- [ ] 创建 `apps/server-agent/test/e2e/fixtures/i18n/en/validation.json`：

```json
{
  "required": "Required field"
}
```

#### Step C3.4: 加 supertest 依赖

- [ ] 

```bash
pnpm add -w -D supertest @types/supertest
```

#### Step C3.5: 跑测试

- [ ] 

```bash
pnpm test apps/server-agent/test/e2e/dto-i18n.spec.ts
```

预期：3 个 it 全 PASS。

若 nestjs-i18n 的 `I18nValidationPipe` 与 `nestjs-zod` 的 DTO 集成有 mismatch（不抛 ZodValidationException），则需在 TestModule 配 `app.useGlobalPipes(new ZodValidationPipe())` 或类似 — 调试视错误信息处理。

#### Step C3.6: 提交

```bash
git add apps/server-agent/test pnpm-lock.yaml package.json
git commit -m "test(e2e): add Zod -> createI18nZodDto -> Controller integration test

3 cases: valid body / invalid zh / invalid en。验证 Track A 链路：
schema message 用 i18n key + I18nValidationPipe 自动翻译。"
```

---

## 全局收尾

### Phase 2 退出检查

- [ ] 运行所有命令并确认 0 失败：

```bash
cd /Users/grant/Meta1/meshbot
pnpm install
pnpm typecheck
pnpm test
pnpm check                # 5 围栏全绿
pnpm sync:locales -- --check
pnpm sync:skills -- --check
pnpm build
```

- [ ] 冒烟 server-agent：

```bash
timeout 15s pnpm dev:server-agent &
sleep 5
curl -s -X POST http://localhost:3100/api/auth/register \
  -H "Content-Type: application/json" \
  -H "Accept-Language: en" \
  -d '{"username":"smoke","password":"abc12345"}'
pkill -f server-agent
rm -f ~/.meshbot/agent.db*
```

预期：注册成功（首次）或失败（重复）；错误信息英文。

- [ ] 冒烟 server-main：

```bash
timeout 15s pnpm dev:server-main &
sleep 5
curl -s http://localhost:3200/api/health
pkill -f server-main
```

预期返 `{status:"up", message:"成功"}`。

- [ ] 在 CLAUDE.md 末尾追加 Phase 2 完成标记：

```markdown
### Phase 2（工程化 harness）✅ 已完成

- i18n 全栈接入（server-agent + server-main 后端 + web-main 前端镜像）
- createI18nZodDto + useSchema + Form/FormItem 三件套
- 13 条规约双套（.cursor/rules + .claude/skills）+ sync-skills 派生脚本
- check:dead-exports（第 5 个静态围栏）
- husky pre-commit 自动跑 5 围栏 + sync-skills --check
- Phase 1 final review backlog 完全清空（删僵尸 auth + 删 libs/shared + 移 PROVIDERS + 隐藏 Initializer + JSDoc + --force-report 文档 + 集成测）

### Phase 3（云端轨）待办

- server-main 起业务（User / Organization / AgentRegistration / Device）+ Postgres + 迁移
- @WithLock / @Cacheable 接入 Redis provider
- migrations-ddl 规范落地（脱 synchronize:true）
- Dockerfile + docker-compose
- 版本号策略（changesets）
- cli-agent 发布形态
- E2E 测试框架扩展

详见 `docs/superpowers/specs/2026-05-13-meshbot-borrow--design.md`。
```

- [ ] 提交：

```bash
git add .claude/CLAUDE.md
git commit -m "docs(claude): mark Phase 2 complete, list Phase 3 backlog"
```

- [ ] 可选 tag：

```bash
git tag -a phase-2-harness -m "Phase 2: harness + i18n + 前端表单层 + Phase 1 cleanup"
```

---

## Phase 2 验收清单

- [ ] `pnpm install` 无 peer dep 警告
- [ ] `pnpm typecheck` 全包通过
- [ ] `pnpm build` 全包构建通过
- [ ] `pnpm test` 全部 PASS（含新增 e2e dto-i18n 3 个）
- [ ] `pnpm check` 5 围栏全绿（tx/naming/lock-tx/repo/dead）
- [ ] `pnpm sync:locales -- --check` 通过
- [ ] `pnpm sync:skills -- --check` 通过
- [ ] husky pre-commit 触发完整流程（实际 commit 时验证）
- [ ] server-agent 启动正常，i18n 翻译生效（zh/en 两种 Accept-Language 都对）
- [ ] server-main 健康检查端点工作（含 i18n 翻译）
- [ ] web-agent login 页用 Form/FormItem + useSchema 重构，i18n 错误正常
- [ ] web-main 接入 next-intl 骨架（IntlProvider 包 layout，messages 文件就位）
- [ ] `.cursor/rules/` 含 17 条（4 既有 meshbot-specific + 13 新增；frontend-i18n 已删）
- [ ] `.claude/skills/` 派生镜像存在
- [ ] Phase 1 final review backlog 7 项全清
- [ ] CLAUDE.md Phase 2 完成标记 + Phase 3 待办清单更新
