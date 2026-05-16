# 贡献指南

## 环境要求

- Node.js `>= 22`（与 CI 对齐；`package.json` 的 `engines` 强制）
- pnpm `>= 10`（仓库内置 `packageManager` 字段）
- Docker（跑 e2e 测试 / 本地 Postgres 依赖）

## 起步

```bash
pnpm install --frozen-lockfile
pnpm dev:db:up                # 起本地 Postgres（docker-compose）
pnpm migration:run:main       # 跑 server-main 数据库迁移
pnpm dev                      # 启动所有 app（turbo dev）
```

按需启动单个 app：

```bash
pnpm dev:server-agent         # :3100，SQLite，本地 Agent 后端
pnpm dev:server-main          # :3200，Postgres，云协同后端
pnpm dev:web-agent            # :3001，桌面端 UI
pnpm dev:web-main             # :3002，云协同前端
pnpm dev:desktop              # Electron 桌面壳
pnpm dev:cli-agent            # CLI Agent 工具
```

## 提交 PR 前本地检查

仓库已配置 husky pre-commit 自动跑：Biome（lint-staged） + 5 围栏 + sync:skills + sync:locales --check。

如果想手工完整复刻 CI（包括 strict 围栏 + 全量测试）：

```bash
pnpm install --frozen-lockfile
pnpm dev:db:up
pnpm lint
pnpm typecheck
pnpm check:strict             # 严格模式（CI 用）；本地 pnpm check 走 baseline 增量
pnpm sync:skills -- --check
pnpm sync:locales -- --check
pnpm test
pnpm build
```

## 静态围栏（5 个）

仓库通过 5 个静态围栏维护代码规约：

| 围栏 | 命令 | 检查内容 |
|---|---|---|
| `check:tx` | `pnpm check:tx` | `@Transactional()` 使用合法性 / 冗余（写动作 ≤ 1） / 绕过 TxTypeOrmModule |
| `check:naming` | `pnpm check:naming` | 私有 `@Transactional()` 方法命名约定（`*InTx` / `*InDb` / `persist*`） |
| `check:lock-tx` | `pnpm check:lock-tx` | 事务-锁倒置漏洞（`@WithLock` 不能在 `@Transactional` 内） |
| `check:repo` | `pnpm check:repo` | Entity 唯一归属 Service / 非 Service 注入 Repository / 跨 lib 注入 |
| `check:dead` | `pnpm check:dead` | 没人引用的 named export |

详见 [`.claude/CLAUDE.md`](.claude/CLAUDE.md) 「关键约定」节。

## i18n 维护

- 后端 i18n 资源在 `apps/server-*/i18n/{zh,en}/<namespace>.json`
- 前端 i18n 资源在 `apps/web-*/messages/{zh,en}.json`
- 提交时 husky 自动 `pnpm sync:locales -- --check`（硬失败模式），missing key / asymmetric 都会阻断
- 修复：`pnpm sync:locales -- --write` 补占位，再人工填中英文

## 数据库迁移

- 后端 TypeORM 迁移文件：`apps/server-{agent,main}/src/migrations/`
- 命令：

  ```bash
  pnpm migration:generate:main -- src/migrations/<NameInPascalCase>
  pnpm migration:run:main
  pnpm migration:revert:main
  pnpm migration:show:main
  # agent 同理：:agent 后缀
  ```

- 迁移规约：snake_case 列名 / 逻辑外键 / 幂等 SQL（`IF NOT EXISTS`） / pgcrypto。详见 `.cursor/rules/migrations-ddl.mdc`

## 提交规范

- **conventional commits 风格**：`feat: ...` / `fix: ...` / `refactor: ...` / `chore: ...` / `docs: ...` / `test: ...`
- **中文 commit body**（仓库习惯，但 type 用英文）
- **每个 task 一个 commit**（如 Phase 4 plan 里的 task ID）—— 便于 review

## 发布流程

> 本节将在 Track D（changesets 接入）落地后回填。当前手工流程：push `cli@<version>` 触发 `publish-cli.yml`、push `app@<version>` 触发 `package-desktop.yml`。

## 常见问题

- **pre-commit 卡 sync:locales --check**：先 `pnpm sync:locales -- --write` 补占位，再人工填中英文译文
- **e2e 测试找不到 Postgres**：`pnpm dev:db:up` 起本地 Postgres；端口冲突改 `infra/dev/docker-compose.dev.yml` 端口映射
- **better-sqlite3 装不上**：检查 `node` 版本是否 >= 22，必要时 `pnpm rebuild better-sqlite3`
