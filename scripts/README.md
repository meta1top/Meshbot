# meshbot scripts

所有可执行脚本放在本目录，统一用 `tsx` 运行。

## 命名约定

- 文件名：`<verb>-<noun>.ts`（kebab-case），例如 `check-transactional.ts` / `sync-locales.ts`
- 顶部 JSDoc 用中文写明：脚本目标、使用场景、退出码语义
- 失败退出码：非 0；成功：0

## 当前脚本

| 脚本 | pnpm 命令 | 用途 |
|------|-----------|------|
| `check-transactional.ts` | `pnpm check:tx` | 校验 `@Transactional` 完整性（跨表写入是否挂） |
| `check-method-naming.ts` | `pnpm check:naming` | 校验事务方法命名约定（`*InDb` / `*InTx` / `persist*`） |
| `check-lock-tx.ts` | `pnpm check:lock-tx` | 校验事务-锁倒置漏洞（`@WithLock` 不可在 `@Transactional` 内） |
| `check-repo-access.ts` | `pnpm check:repo` | 校验 Entity 唯一归属 + 跨 libs 注入 Repository 限制 |
| `sync-locales.ts` | `pnpm sync:locales` | 扫描前后端 t() 调用对齐 locale JSON（missing/orphan/asymmetric）|
| `sync-skills.ts` | `pnpm sync:skills` | 把 .cursor/rules/*.mdc 派生为 .claude/skills/<slug>/SKILL.md（单向） |

一键全跑：`pnpm check`

### sync-locales 模式

- 默认：只报告，exit 0
- `--check`：报告 + 不一致时 exit 1（用于 pre-commit）
- `--write`：把 missing 在 zh/en 文件中补占位空字符串
- `--prune`：删除 orphan（**危险**，PR 评审后再用）

### sync-skills 模式

- 默认：从 .cursor/rules/*.mdc 重新生成 .claude/skills/<slug>/SKILL.md
- `--check`：只比对，不写；有漂移则 exit 1（pre-commit 用）
- 检测 orphan SKILL.md（无对应 .mdc 源）并 warn

注意：**唯一源是 .cursor/rules/**。永远不要手改 SKILL.md，改完会被覆盖。

## 适用范围

围栏只针对 NestJS 服务层代码（`libs/**/src/**` + `apps/server-*/src/**`）。
以下路径被显式排除：
- `libs/agent/**` —— Agent 域内部不挂 NestJS 装饰器（用 vitest）
- `apps/cli-agent/**` —— CLI 工具，非 NestJS 服务
- `apps/desktop/**` —— Electron 桌面壳，非 NestJS
- `apps/web-*/**` —— 前端 Next.js 应用
- `packages/**` —— 前端共享包
