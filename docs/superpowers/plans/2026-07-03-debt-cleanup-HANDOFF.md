# 换机接续提示词 — 技术债清理

> 在另一台电脑 `cd` 进 meshbot 仓库后，把下面「接续提示词」整段粘给 Claude Code 即可拉起执行。
> 前置：`git fetch && git checkout chore/debt-cleanup && git pull`（plan 与本文件都在这个分支上，已 push）。

---

## 接续提示词（整段复制粘贴）

```
我要用 subagent-driven-development 执行技术债清理 plan：docs/superpowers/plans/2026-07-03-debt-cleanup.md（6 个任务，范围与产品语义已在上一台电脑确认，见 plan 的 Global Constraints 与各任务）。

背景：这是 dispatch_subagent 三阶段（PR #8 前台派发 / #9 嵌套卡 / #10 后台+任务卡，均已合并进 main）三轮评审累积的债。当前在分支 chore/debt-cleanup（自 main def9824 切出，含全部三个 PR）。

请按 SDD 流程走：
1. 先读 plan + `git log --oneline -15`，新建 SDD 账本 .superpowers/sdd/progress.md（旧账本是上一台机器的本地 scratch，没同步；以 plan + git log 为准重建）。
2. 每任务：task-brief 抽简报 → 派实现子 agent（TDD）→ review-package → 派评审子 agent（spec 合规 + 代码质量两个 verdict）→ Critical/Important 派 fix 子 agent 复审 → 账本记 complete。
3. 建议任务顺序：Task 1（sync-locales 根因修）先做——做完后 Task 2 若新增 i18n 键不再需要顶层占位 workaround。其余 T2-T5 相互独立可任意序，T6 集成验证最后。
4. Task 5（e2e 竞态审计）本地无 Postgres 时做静态审计+改造即可，CI 为验证面。
5. Task 6 集成验证：全量 pnpm typecheck + pnpm test（对照基线：根 jest 全绿+1 skip；libs/agent vitest 9 个预存在失败只看新增）+ pnpm check + 隔离 MESHBOT_HOME boot。
6. 全部通过后派一个 opus 全分支终审（review-package `git merge-base main HEAD`..HEAD），核查跨任务契约与产品决策落地。
7. 终审通过用 superpowers:finishing-a-development-branch 收尾——**开 PR，不要自动 merge**（合并等我明确说「合并」；CLI gh pr merge 在我授权后可用）。

关键坑（判回归/避免返工用）：
- web-agent 纯逻辑模块（lib/*.ts）零 import 纪律：根 jest 是 node 环境无 jsdom，import jotai/React/组件会炸整个套件；spec 只 import 被测模块。
- 服务加构造依赖 / AgentModule 加工具 → 必须同步补所有 spec 的 mock 装配 + e2e TestingModule 的端口桩（否则跑别的 spec 才炸，1b 踩过）。改 ModelResolver 等构造签名要 grep 全部 new 点对齐。
- i18n zh/en 键必须对称（pre-commit sync-locales --check 强制）；Task 1 没做完前新增嵌套命名空间键仍需顶层空占位。
- libs/agent、libs/types-agent 的 dist 是 gitignored 持久产物，起 dev 或跑依赖它的验证前先 pnpm --filter <pkg> build 确认反映 HEAD（历史踩坑两次：dist 滞后导致「行为回退」误判）。
- dev 库在仓库根 .meshbot/（main.db，勿删改目录本身）；boot 验证必须用隔离 MESHBOT_HOME=$(mktemp -d) 并事后清理；server-agent 端口自检不固定（看启动日志/.meshbot/agent.port）。
- 旁路/实验操作别在主检出上切分支（dev 全家桶从工作树热重载，会让正在跑 dev 的我误判行为回退）——用 git worktree 隔离。
- 提交：中文 conventional commits，结尾 Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>。不自动 push（直到收尾）。

先重建账本，然后从 Task 1 开始。
```

---

## 已完成状态快照（换机时 git log 应能看到）

- `def9824` main：PR #10 合并（Phase 2 + 任务卡 + 一串验收期修复）
- `chore/debt-cleanup` 分支已推送，含本 plan + 本 handoff 两个 docs commit
- **代码任务 0 个已动**（纯 plan 阶段被打断），Task 1-6 全 pending

## Plan 六任务速览（详见 plan 正文）

| Task | 内容 | 关键决策 |
|------|------|----------|
| 1 | sync-locales 嵌套命名空间根因修 + 删全部顶层占位键 | ts-morph 解析 `t()` 标识符声明拼 namespace；脚本改动必须单测 |
| 2 | web-agent 小修包 | 终局未认领卡不再永显启动中 / loadMore 补 toolCalls 等字段 / code-point 安全截断 / **暗色语义色 token 化** |
| 3 | server-agent 清理 | 删 hasFailedPending / **统计排除 subagent**（quick 不动）/ **孤儿前台子会话 GC（标记了结不重跑）** / settle+boot 测试补齐 |
| 4 | libs 文档琐碎 + spawned smoke test | 纯文档+测试无行为变化 |
| 5 | **im-flow e2e 竞态** | 实证更正：重试已存在，本周挂是 CREATE EXTENSION 竞态（已修）；本任务审计其余套件补同款重试 |
| 6 | 集成验证 | 全量+围栏+隔离 boot+人工验收清单 |

## 用户已拍板的四个可选项（全做）

1. im-flow e2e 竞态真修 → 收窄为「其余 WS 套件审计补重试」（im-flow 本身已有重试）
2. 统计排除 subagent 会话（计数只算 user；token 用量仍含子会话＝真实花销）
3. 任务卡暗色语义色 token 化（硬编码 #3D8A4E / 字面 ✓✗ → Tailwind 语义色+dark 变体 / lucide 图标）
4. 孤儿前台子会话 GC：**标记了结，不重跑**（父上下文已死无人消费结果）
