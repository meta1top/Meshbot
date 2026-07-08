# CHANGELOG

本仓库通过 [changesets](https://github.com/changesets/changesets) 管理变更与版本号。
每个对外发布的包维护一份独立 CHANGELOG：

| 包 | npm | CHANGELOG |
|---|---|---|
| `@meshbot/agent` | [npm](https://www.npmjs.com/package/@meshbot/agent) | [apps/cli/CHANGELOG.md](apps/cli/CHANGELOG.md) |
| `@meshbot/server-agent` | [npm](https://www.npmjs.com/package/@meshbot/server-agent) | [apps/server-agent/CHANGELOG.md](apps/server-agent/CHANGELOG.md) |
| `@meshbot/desktop` | GitHub Releases（installer） | [apps/desktop/CHANGELOG.md](apps/desktop/CHANGELOG.md) |

注：上述三个包通过 `.changeset/config.json` 的 `fixed` 组共享版本号，
每次 release 后号同步推进。

## 发布流程

1. 开发者在 PR 中加 `pnpm changeset` 生成变更说明
2. PR 合并到 `main` → `release.yml` workflow 自动开 "Version Packages" PR
3. 合并 Version PR → `release.yml` 跑 `changeset publish`：
   - `cli` / `server-agent` → npm publish + 自动 git tag
   - `desktop` → workflow 末尾手工推 `@meshbot/desktop@<v>` tag
4. `@meshbot/desktop@<v>` tag 触发 `package-desktop.yml` 构建 macOS/Windows/Linux 安装包并附到 GitHub Release

详见 [CONTRIBUTING.md](CONTRIBUTING.md) 的「发布流程」节。
