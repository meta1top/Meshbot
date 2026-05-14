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

## 增量基线模式

五个 `check:*` 脚本（`tx` / `naming` / `lock-tx` / `repo` / `dead`）都支持**增量模式**。
运行时读取 `docs/audits/<fence-name>/` 下最新的 baseline JSON 报告，
仅在以下情况输出新报告：

- 新增 finding（baseline 里没有、本次发现的）
- 已有 finding 内容变化（同 `file:line` 但 issue 类别 / 描述变更）

**默认行为**：若本次扫描与 baseline 完全一致 → 打印 `无新增 finding`，
不写新 JSON，exit 0。CI / pre-commit 默认走这条路径。

### 强制刷新基线 `--force-report`

当你**合法地修改了围栏覆盖的代码**（例如新增一个 `@Transactional` 方法、
迁移 Entity 归属、删除老的死导出符号）后，希望基线"接受"这次变化：

```bash
pnpm check:tx -- --force-report
pnpm check:naming -- --force-report
pnpm check:lock-tx -- --force-report
pnpm check:repo -- --force-report
pnpm check:dead -- --force-report
```

会强制把本次完整结果写一份新 JSON 到
`docs/audits/<fence-name>/<timestamp>.json`，下次跑就以新文件为新 baseline。
新生成的 JSON 应当随业务代码一起 commit，作为"已审计过"的证据。

> 注意：`--force-report` 只刷新报告，不放过新增的违规。如果本次发现违规仍会 exit 1。
