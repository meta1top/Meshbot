# meshbot Phase 2：工程化 harness + i18n + 前端表单层 + Phase 1 cleanup

- 日期：2026-05-14
- 范围：meshbot Phase 2（继 Phase 1 地基之后）
- 参考：platform（继续借鉴）
- 形态：一份大 spec，内部 3 个轨道；后续单份 plan 拆 ~16 个 task

---

## 1. 总体目标与范围

### 1.1 目标

把 Phase 1 打下的地基，转化成**日常开发流上能直接用的工程化体验**：
- Phase 1 让规约成为代码（装饰器 + 围栏）
- **Phase 2 让规约变成开发者每次保存/提交时自动触发的反馈**（pre-commit + skills/rules + 表单层封装）
- 并补齐 i18n 这块**唯一一块"先抽象掉，再补实现成本最低"的横切关注点**

### 1.2 双工具支持

meshbot 团队同时使用 **Claude Code** 和 **Cursor**，Phase 2 规约必须双套维护：
- `.claude/skills/<name>/SKILL.md`（YAML frontmatter: `name`, `description`）
- `.cursor/rules/<name>.mdc`（YAML frontmatter: `description`, `globs`, `alwaysApply`）

**单一来源**：`.cursor/rules/*.mdc` 为源，`scripts/sync-skills.ts` 派生 `.claude/skills/*/SKILL.md`。

### 1.3 三条轨道（解耦交付）

| 轨道 | 主题 | 估算 task |
|------|------|-----------|
| **A** | i18n + 前端表单层（web-main next-intl + 双 server 后端 nestjs-i18n + createI18nZodDto + useSchema + Form/FormItem + sync-locales） | 6 |
| **B** | harness（13 条规约 × 双套文件 + check:dead 围栏 + husky/lint-staged + post-build.js） | 7 |
| **C** | Phase 1 cleanup backlog（删僵尸 auth + 移 PROVIDERS + libs/shared 去留 + 集成测 + JSDoc + Initializer 隐藏 + --force-report doc） | 3 |

合计 ~16 task。

### 1.4 现状盘点

- ✅ **web-agent 已完整接入 next-intl**（`next-intl ^4.11.0` + `src/i18n/config.ts` + `messages/zh.json`/`en.json` + 7 处 `useTranslations` 使用）
- ❌ web-main 没有 messages 目录、没接 next-intl
- ❌ server-agent / server-main 没有 nestjs-i18n
- ❌ `createI18nZodDto` / `useSchema` / `Form` / `FormItem` 全缺
- ❌ 没有 sync-locales 脚本
- ⚠️ meshbot 已有 5 条 cursor 规则（`agent-arch` / `biome-format` / `desktop` / `frontend-i18n` / `meta1`）
  - 保留：`agent-arch` / `desktop` / `meta1` / `biome-format`
  - 改写：`frontend-i18n` → 取代为新的 `web-form-convention`

### 1.5 不做什么

- 不引入 RabbitMQ / Nacos / Redis（Phase 3）
- 不动 LangGraph / Agent 业务逻辑
- 不重写既有 controller / service 业务行为（除 Track C 明确小修）
- 不引入完整 CI/CD（Phase 4）
- 不开 server-main 业务代码（Phase 3）
- i18n 不做语言切换 UI（cookie 默认 zh-CN；切换交给后续）
- 不上路径式 locale（用 cookie/header 检测）

### 1.6 Phase 2 退出标志

- 后端能用 `i18n.t("key")` 翻译
- 前端 `useSchema(MySchema)` 拿到 i18n 错误信息的 schema
- 前端 Form/FormItem 替代裸 shadcn `<form>`
- `pnpm sync:locales` 一键扫描 `t()` 同步 locale JSON
- `pnpm check:dead` 围栏跑通
- `pnpm sync:skills --check` 通过
- pre-commit 自动跑 `pnpm check`
- 双工具新会话能正确触发规约
- Phase 1 final review backlog 全部清空

---

## 2. 三轨概览 + 镜像策略 + 依赖关系

### 2.1 Track A — i18n + 前端表单层

| # | 资产 | 现状 | Phase 2 动作 | 端 |
|---|------|------|-------------|---|
| A1 | web-agent next-intl | ✅ 已就绪 | 抽出可复用的 `i18n/config.ts` 与 `intl-provider` 模式 | web-agent |
| A2 | web-main next-intl | ❌ 缺 | 镜像 A1（messages 最小种子 + i18n/config.ts + IntlProvider） | web-main |
| A3 | server 后端 nestjs-i18n | ❌ 缺 | server-agent + server-main 同步接入；`apps/server-*/i18n/{zh,en}/` 资源；全局 `I18nValidationPipe` + `I18nService` | server-agent / server-main |
| A4 | createI18nZodDto | ⚠️ Phase 1 无 i18n 版 | 引入 `nestjs-zod`，新增 `createI18nZodDto`；旧 `createZodDto` 保留 fallback | libs/common |
| A5 | useSchema hook | ❌ 缺 | 放 `packages/design/src/hooks/use-schema.ts`：递归翻译 Zod schema 内 message key | packages/design |
| A6 | Form / FormItem | ❌ 缺 | 放 `packages/design/src/components/form/`：基于 react-hook-form + zodResolver 的统一封装 | packages/design |
| A7 | sync-locales 脚本 | ❌ 缺 | `scripts/sync-locales.ts`：扫描 `t()` 调用 + 后端 i18n 调用，diff 出 missing/orphan/asymmetric | scripts |

### 2.2 Track B — harness（13 条规约 × 双套 + 围栏 + pre-commit + post-build）

| # | 内容 | 形态 |
|---|------|------|
| B1 | 12 条新增规约 + 1 条改写（`frontend-i18n` → `web-form-convention`） | 每条同时输出 `.claude/skills/<name>/SKILL.md` 和 `.cursor/rules/<name>.mdc` |
| B1.1 | `scripts/sync-skills.ts` | 从 `.cursor/rules/*.mdc` 派生 `.claude/skills/<name>/SKILL.md` |
| B2 | `check:dead-exports` 围栏脚本 + pnpm script | 单脚本 + baseline JSON 沿用 Phase 1 模式 |
| B3 | husky + lint-staged + pre-commit | `pnpm install` 自动安装 husky；commit 前跑 `pnpm check` + biome lint-staged |
| B4 | `scripts/post-build.js` for Next standalone | web-agent / web-main 各一份，no-op-safe |

### 2.3 Track C — Phase 1 cleanup backlog

| # | 内容 |
|---|------|
| C1 | 删除 `apps/server-agent/src/auth/`（僵尸 LocalAuthModule 与 auth.module.ts 路由冲突） |
| C2 | 把 `PROVIDERS` 常量从 `@meshbot/web-common` 迁到 `libs/types-agent/src/ai/providers.ts` |
| C3 | `libs/shared` 删除（无消费者，pre-existing 空壳） |
| C4 | `scripts/README.md` 补 `--force-report` baseline 刷新说明 |
| C5 | 端到端 Zod → createI18nZodDto → Controller 集成测 |
| C6 | `CommonModule.forRoot()` JSDoc 注明只调一次 |
| C7 | `libs/common` 的 barrel 隐藏 `CacheInitializer` / `LockInitializer` |

### 2.4 规约镜像策略

| 字段 | `.claude/skills/<name>/SKILL.md` | `.cursor/rules/<name>.mdc` |
|------|----------------------------------|----------------------------|
| 标识 | `name: <slug>` | 文件名即标识 |
| 描述 | `description: ...`（含"Use when ..."自然语言触发） | `description: ...` |
| 触发 glob | （在 description 自然语言描述） | `globs: "<glob>"` |
| 默认加载 | 由用户输入触发 | `alwaysApply: true / false` |
| 内容 | 完整 markdown | 完整 markdown |

**实施做法**：
1. 先写 `.cursor/rules/<name>.mdc`
2. 跑 `pnpm sync:skills` 派生 `.claude/skills/<name>/SKILL.md`
3. 两份一起 commit；pre-commit 跑 `pnpm sync:skills --check` 防漂移

### 2.5 13 条规约清单

| # | slug | 来源 | alwaysApply | 备注 |
|---|------|------|-------------|------|
| 1 | `service-tx-lock-cache` |  复用 | true | Redis 改为 LockProvider/CacheProvider |
| 2 | `service-repo-access` |  复用 | true | 路径示例改 meshbot |
| 3 | `controller-thin` |  复用 | true | 同上 |
| 4 | `swagger-api-declaration` |  复用 | false | glob 触发 |
| 5 | `shared-data-model` |  复用 | false | createI18nZodDto 引用 nestjs-zod |
| 6 | `web-form-convention` |  复用 + 改写 | false | 取代旧 `frontend-i18n.mdc` |
| 7 | `dev-workflow` |  复用 | true | 命令为 meshbot 现有 |
| 8 | `bypass-mode-safety` |  复用 | true | 删 MQ/对象存储；保留 git/远程脚本 |
| 9 | `check-transactional` |  复用 | false | slash trigger |
| 10 | `check-method-naming` |  复用 | false | 同 |
| 11 | `check-lock-tx` |  复用 | false | 同 |
| 12 | `check-repo-access` |  复用 | false | 同 |
| 13 | `check-dead-exports` |  复用 | false | 与 B2 配套 |

### 2.6 依赖关系图

```
Track A i18n + 表单                 Track B harness                Track C cleanup
─────────────────────              ───────────────────             ────────────────
A1 web-agent ✅           ┐        B1 双套规约文件                  C1 删僵尸 auth
A2 web-main 镜像         │        (依赖 A4/A5/A6 落地             C2 移 PROVIDERS
A3 nestjs-i18n           │         才能写正确)                     C3 libs/shared
A4 createI18nZodDto ◄────┤        B2 check:dead 围栏              C4 README 补丁
A5 useSchema             │        B3 husky + pre-commit           C5 集成测
A6 Form/FormItem ◄───────┤         (依赖 B2 / Phase 1 check:* )   C6 forRoot JSDoc
A7 sync-locales          │        B4 post-build.js                C7 隐藏 Initializer
                          │
                          ▼
                  C5 集成测（验证 A4 工作）
```

**关键依赖**：
- B1（写新规约）依赖 A4/A5/A6 落地，否则 `web-form-convention.mdc` 引用 `useSchema` / `Form` / `FormItem` 不存在
- C5（集成测）依赖 A4
- B3（pre-commit）独立可做
- C 轨道全部独立，可与 A/B 并行

### 2.7 推荐落地顺序

1. **第 1 周**：A1-A3（i18n 基础设施）+ C1-C4（无依赖 cleanup）并行
2. **第 2 周**：A4 (createI18nZodDto) + A5/A6 (useSchema + Form) + A7 (sync-locales)
3. **第 3 周**：B1（13 条规约 × 双套）+ B2 (check:dead) + B3 (pre-commit) + B4 (post-build)
4. **收尾**：C5（集成测）+ C6/C7（小修） + 全套回归

---

## 3. Track A 详细设计（i18n + 表单层）

### A1 — web-agent 现状复盘（参考实现）

```
apps/web-agent/
├── messages/{zh,en}.json                # locale 资源
├── src/
│   ├── i18n/config.ts                   # locales = ["zh", "en"], defaultLocale "zh", cookieName "locale"
│   └── components/intl-provider.tsx     # NextIntlClientProvider wrapper
```

整站不走路径式 locale（无 `app/[locale]/...`），cookie 检测决定。

### A2 — web-main 镜像

复制 web-agent 的整套 i18n 配置：
- `apps/web-main/messages/{zh,en}.json` 最小种子（`common.appTitle` 等）
- `apps/web-main/src/i18n/config.ts` 与 web-agent 一致
- `apps/web-main/src/components/intl-provider.tsx` 镜像

> web-agent + web-main **共享同一份 i18n 约定**，但 messages 文件**各自独立**（业务不同，不抽到 web-common）。

### A3 — 后端 nestjs-i18n 接入（双 server）

**为什么后端也需要 i18n**：
- 业务错误信息（`"已存在注册用户"`）需要随 client locale 翻译
- Zod schema 的 message 写 i18n key，后端 `I18nValidationPipe` 与前端 `useSchema` 共用同一个 key

**接入形态**：

```
apps/server-agent/
├── i18n/
│   ├── zh/
│   │   ├── common.json
│   │   ├── auth.json
│   │   └── validation.json
│   └── en/  (镜像)
└── src/app.module.ts            # imports: [I18nModule.forRoot({ ... })]

apps/server-main/                 # 同形态，Phase 3 起业务，但 i18n 框架现在就上
```

**配置要点**：
- `I18nModule.forRoot({ fallbackLanguage: "zh", loaderOptions: { path: i18n/ } })`
- locale 解析链：`CookieResolver` → `HeaderResolver(Accept-Language)` → `defaultLanguage`
- 全局 `I18nValidationPipe` 翻译 Zod 错误

**改造既有 server-agent**：把 `auth.service.ts` 硬编码中文（`"已存在注册用户，不允许重复注册"`、`"用户名或密码错误"`）替换为 i18n key 调用。

### A4 — createI18nZodDto 升级

引入 `nestjs-zod` 包：

```typescript
// libs/common/src/dto/create-i18n-zod-dto.ts
import { createZodDto } from "nestjs-zod";
import type { ZodTypeAny } from "zod";

/**
 * i18n 感知 DTO。message 写 i18n key（如 "validation.password.tooShort"），
 * I18nValidationPipe 自动按 request locale 翻译。
 */
export function createI18nZodDto<T extends ZodTypeAny>(schema: T) {
  return createZodDto(schema);
}
```

Phase 1 的 `createZodDto` 保留（独立功能：纯校验、无 i18n）。

### A5 — useSchema hook（packages/design）

参考  `packages/common/hooks/use.schema.ts`，做递归遍历：

```typescript
// packages/design/src/hooks/use-schema.ts
import { useTranslations } from "next-intl";
import { z } from "zod";

export const useSchema = <T extends z.ZodTypeAny>(schema: T): T => {
  const t = useTranslations();
  // 递归处理：ZodObject / ZodString / ZodNumber / ZodOptional / ZodNullable
  //          ZodArray / ZodUnion / ZodDiscriminatedUnion / ZodEffects(refinement)
  // 每个 check 把 message: "i18n.key" 替换为 t("i18n.key")
  return translateSchema(schema, t) as T;
};
```

放 `packages/design` 而非 `packages/web-common`，因为它与 Form/FormItem 强绑定。

### A6 — Form / FormItem（packages/design）

参考  `packages/design/src/components/uix/form/index.tsx`，基于 `react-hook-form` + `@hookform/resolvers/zod`：

```typescript
// packages/design/src/components/form/form.tsx
import { useForm as useRHF } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

export function Form<T>({ schema, defaultValues, onSubmit, children }: FormProps<T>) {
  const form = useRHF({ resolver: zodResolver(schema), defaultValues });
  return (
    <UIForm {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>{children}</form>
    </UIForm>
  );
}

export function FormItem({ name, label, description, children }: FormItemProps) {
  // FormField + FormLabel + FormControl + FormDescription + FormMessage 封装
}
```

**层次关系**：
- 低层原语：`packages/design/src/components/ui/form.tsx`（unchanged，shadcn 风格）
- 高层封装：`packages/design/src/components/form/`（Phase 2 后强制使用）

**使用范例**：

```tsx
import { Form, FormItem, useSchema, Input } from "@meshbot/design";
import { RegisterAgentSchema } from "@meshbot/types-main";

function RegisterForm() {
  const schema = useSchema(RegisterAgentSchema);
  return (
    <Form schema={schema} onSubmit={handleSubmit}>
      <FormItem name="agentId" label="Agent ID">
        <Input />
      </FormItem>
      <FormItem name="deviceName" label="设备名">
        <Input />
      </FormItem>
    </Form>
  );
}
```

### A7 — sync-locales 脚本

**目的**：扫描所有 `t("xxx")` 与后端 `i18n.t("xxx")` 调用，对比 `messages/*.json` 与 `i18n/<locale>/*.json`：
- **missing**：代码用了但 locale 文件没有
- **orphan**：locale 文件有但代码没用
- **asymmetric**：zh 有 / en 没（或反之）

**用法**：
```bash
pnpm sync:locales              # 只报告
pnpm sync:locales -- --write   # 补 missing（占位空字符串）
pnpm sync:locales -- --prune   # 删 orphan（危险，需 PR 评审）
```

**实现要点**：
- ts-morph 扫前端 `useTranslations()` / `getTranslations()` / `t("...")`
- ts-morph 扫后端 `this.i18n.t("...")` / `I18nService.translate("...")`
- 与每份 JSON 的 flat-key 集合 diff
- 对比 zh.json vs en.json 的 key 集合

脚本放 `scripts/sync-locales.ts`，单脚本扫所有 `apps/web-*` + `apps/server-*`。

---

## 4. Track B 详细设计（harness）

### B1 — 13 条规约 × 双套文件

（清单见 §2.5）

**保留不动的 meshbot 既有规约**：`agent-arch.mdc` / `desktop.mdc` / `meta1.mdc` / `biome-format.mdc`。

**改写**：`frontend-i18n.mdc` → 完整由新的 `web-form-convention.mdc` 取代（覆盖 i18n + Form/FormItem + useSchema 三件套约束）。

### B1.1 — 镜像脚本 `scripts/sync-skills.ts`

```typescript
// scripts/sync-skills.ts (tsx)
// 读取 .cursor/rules/*.mdc -> 写 .claude/skills/<name>/SKILL.md
//
// 转换规则：
//   .mdc frontmatter:                  .claude SKILL.md frontmatter:
//     description, globs, alwaysApply    name: <slug from filename>
//                                        description: <from mdc> +
//                                                     "Use when matching globs: <globs>"
//
// body 完全 1:1 拷过去（同一份 markdown）。
//
// --check 模式：只比对，不写；diff 不一致则 exit 1
```

**调用**：
- `pnpm sync:skills`：一次同步
- `pnpm sync:skills -- --check`：pre-commit 阶段防漂移

**新规约工作流**：
1. 写/改 `.cursor/rules/<name>.mdc`
2. `pnpm sync:skills`
3. 两份同时 commit

### B2 — `check:dead-exports` 围栏

直接搬  `scripts/check-dead-exports.ts`（~850 行），调整：
- 路径 glob 改 meshbot
- ignore 列表加 `libs/agent/**` / `apps/cli-agent/**` / `packages/**`
- baseline JSON 落 `docs/audits/dead-fence/`

`package.json`：
```json
"check:dead": "tsx scripts/check-dead-exports.ts",
"check": "pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:repo && pnpm check:dead"
```

### B3 — husky + lint-staged + pre-commit

**选型**：husky + lint-staged。

**安装**：
```bash
pnpm add -w -D husky lint-staged
pnpm exec husky init
```

**`.husky/pre-commit`**：
```bash
#!/bin/sh
pnpm exec lint-staged
pnpm check
pnpm sync:skills -- --check
pnpm sync:locales -- --check 2>/dev/null || true   # warning only, not blocking
```

**根 `package.json`**：
```json
"lint-staged": {
  "*.{ts,tsx,js,jsx,json}": ["biome check --write --no-errors-on-unmatched"]
}
```

**取舍**：pre-commit 跑全量 `pnpm check`（meshbot 体量小，~3-5 秒）。失败时开发者清楚"有围栏违例"，比"增量分析"更清晰。

### B4 — `post-build.js` for Next standalone

参考  实现：

```javascript
// apps/web-{agent,main}/scripts/post-build.js
import { cpSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const staticSource = join(projectRoot, ".next", "static");
const standaloneDir = join(projectRoot, ".next", "standalone", "apps", "<app>");
const staticTarget = join(standaloneDir, ".next", "static");

if (!existsSync(staticSource) || !existsSync(standaloneDir)) process.exit(0);
cpSync(staticSource, staticTarget, { recursive: true });
console.log("Static assets copied");
```

`apps/web-{agent,main}/package.json` 改：
```json
"build": "next build && node scripts/post-build.js"
```

**web-agent 当前 `output: "export"`**：脚本 no-op-safe（`existsSync(standaloneDir)` 跳过 exit 0），不影响现有静态导出。web-main 默认 standalone。

---

## 5. Track C 详细设计（Phase 1 cleanup backlog）

### C1 — 删除僵尸 auth 目录

**动作**：
1. 删除 `apps/server-agent/src/auth/` 整个目录
2. `app.module.ts` 移除 `LocalAuthModule` 引用 + import
3. `grep -r "LocalAuthModule\|local-auth"` 全仓确认无引用

**验证**：`pnpm dev:server-agent` 启动；`POST /api/auth/register` 由真 `AuthModule` 接管；`pnpm check` 全绿。

### C2 — 移 PROVIDERS 常量

**动作**：
1. 在 `libs/types-agent/src/ai/providers.ts` 新建 `PROVIDERS` 常量（从 `packages/web-common` 拷出来）
2. `packages/web-common/src/providers/index.ts` 改为 re-export 自 `@meshbot/types-agent`（兼容性）
3. `apps/server-agent/src/controllers/setup.controller.ts` 改 import 来源
4. 删除 `apps/server-agent/package.json` 的 `@meshbot/web-common` 依赖
5. `pnpm install` 重生 lock

**验证**：`pnpm typecheck` 通过；`pnpm dev:server-agent` 启动；`GET /api/providers` 返回与之前完全相同的 JSON。

### C3 — 删除 `libs/shared`

**现状**：单文件 `export {};`，无消费者。

**动作**：
1. `grep -r "@meshbot/shared"` 全仓确认无引用
2. 删除 `libs/shared/` 整个目录
3. `pnpm install` 重生 lock

### C4 — 补 `--force-report` 文档

在 `scripts/README.md` 末尾追加"增量基线模式"段，说明默认增量行为 + `--force-report` 用法。

### C5 — 端到端 Zod → createI18nZodDto → Controller 集成测

**位置**：`apps/server-agent/test/e2e/dto-i18n.spec.ts`

**测试**：
- `Test.createTestingModule` 起完整 NestJS 含 `I18nModule.forRoot()` + `I18nValidationPipe`
- test-only controller：`@Post("test/echo") echo(@Body() dto: RegisterAgentDto)`
- 三个 case：
  1. 合法 body → 200 + echo
  2. 非法 body（`deviceName: ""`）→ 400 + 中文错误（默认 zh）
  3. `Accept-Language: en` → 400 + 英文错误

### C6 — `CommonModule.forRoot()` JSDoc

在 `libs/common/src/common.module.ts` `forRoot` 上加 JSDoc 注明"只能调一次"。

### C7 — 隐藏 Initializer

1. 改 `libs/common/src/lock/index.ts`：移除 `LockInitializer` re-export
2. 改 `libs/common/src/cache/index.ts`：同理
3. `common.module.ts` 内部直接从深路径导入

**验证**：`pnpm --filter @meshbot/common build` 通过；`grep "LockInitializer\|CacheInitializer"` 仅出现在 `libs/common/src/{lock,cache}/`；`pnpm test` 12/12。

---

## 6. 风险 / 未决问题 / Phase 3 衔接

### 6.1 已知风险

| # | 风险 | 缓解 |
|---|------|------|
| R1 | nestjs-i18n + Zod 校验 `superRefine` 翻译绕过 | C5 集成测覆盖 superRefine 路径；spec 明确"refine 自行翻译" |
| R2 | `useSchema` 递归性能 | useCallback + useMemo；schema 引用稳定即命中 |
| R3 | `sync:skills` 漂移 | pre-commit `pnpm sync:skills --check` 拦 |
| R4 | husky 在 desktop fork 子进程下不工作 | 不关心（开发者 commit 时触发，与 Electron 运行时无关） |
| R5 | C2 移 PROVIDERS 破坏 web-agent 渲染 | C2 步骤含完整 web-agent setup 流程验证 |
| R6 | i18n messages 既有结构冲突 | A7 默认只补 missing；--prune opt-in |
| R7 | 既有规约与新规约冲突 | 删除 `frontend-i18n.mdc`（被取代）；其余 3 个独立主题 |

### 6.2 未决问题

**Phase 2 开始前需敲定**：
- Q1：sync-skills 源是 `.mdc`（默认）
- Q2：husky vs lefthook → husky（默认）
- Q3：pre-commit 全量 vs 增量 → 全量（默认）
- Q4：web-main messages 起步 → 最小种子（默认）
- Q5：post-build.js 是否给 web-agent 也加 → 加但 no-op-safe（默认）

**Phase 2 实施中**：
- Q6：i18n key 命名 → 沿用现有 camelCase
- Q7：sync-locales 动态 key → 跟随  行为（跳过 + warning）
- Q8：Form/FormItem 输入模式 → controlled via react-hook-form Controller

**Phase 3 开始前需敲定**：
- Q9：版本号策略（changesets / release-please / 各自 semver）
- Q10：server-main 部署形态（docker / k8s / Serverless）
- Q11：cli-agent 发布形态（npm / brew / 内嵌 desktop）
- Q12：监控选型（Sentry / OTel）

### 6.3 Phase 3 衔接

| Phase 3 任务 | Phase 2 准备 |
|--------------|--------------|
| server-main 起步 | i18n 框架已就绪；只需新增业务 key |
| Postgres + 迁移 | migrations-ddl 规约已落地 |
| Redis 接入 LockProvider/CacheProvider | Phase 1 抽象已就位 |
| changesets 引入 | Phase 2 已配 pnpm 收口 |
| E2E 测试 | C5 已示范 NestJS E2E |
| 多产物发布 | post-build.js + Turbo 任务已就绪 |
| Web 新表单 | Form/FormItem + useSchema + i18n 已就位 |

**Phase 4（CI/CD）**衔接：Phase 2 的 pre-commit 提供"本地 / CI 跑同一组命令"的契约 —— `pnpm install && pnpm check && pnpm test`。

### 6.4 Phase 2 退出标志

- `pnpm typecheck` / `pnpm test` / `pnpm check` / `pnpm check:dead` / `pnpm sync:locales`（无 missing） / `pnpm sync:skills --check`（无漂移）全通过
- 13 条规约 `.cursor/rules/` + `.claude/skills/` 双套就绪
- pre-commit 自动跑 `pnpm check`
- web-agent + web-main 前端表单走 Form/FormItem + useSchema
- server-agent + server-main 接入 nestjs-i18n（server-main 仅框架，业务 Phase 3）
- `apps/server-agent/src/auth/` 僵尸清空
- `PROVIDERS` 从 `@meshbot/web-common` 迁出
- `libs/shared` 删除
- Phase 1 final review backlog 全部清空

---

## 7. 下一步

本 spec 通过后进入 **writing-plans skill**，为 Phase 2 撰写详细实施计划（plan），把 ~16 个 task 展开到可直接进入实施的颗粒度。
