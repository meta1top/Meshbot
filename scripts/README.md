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

一键全跑：`pnpm check`

## 适用范围

围栏只针对 NestJS 服务层代码（`libs/**/src/**` + `apps/server-*/src/**`）。
以下路径被显式排除：
- `libs/agent/**` —— Agent 域内部不挂 NestJS 装饰器（用 vitest）
- `apps/cli-agent/**` —— CLI 工具，非 NestJS 服务
- `apps/desktop/**` —— Electron 桌面壳，非 NestJS
- `apps/web-*/**` —— 前端 Next.js 应用
- `packages/**` —— 前端共享包
