# browser-agent

反检测浏览器自动化 MCP server（Camoufox + 持久登录态 profile + LLM 驱动低层原语）。
设计见 [`docs/superpowers/specs/2026-05-30-browser-automation-design.md`](../../docs/superpowers/specs/2026-05-30-browser-automation-design.md)。

agent 通过 meshbot 原生 MCP 机制拿到 `mcp__browser__*` 一组与平台无关的低层工具
（navigate / snapshot / click / type_text / extract / …），自己看页面快照驱动；不含任何平台代码。

## 安装

```bash
cd tools/browser-agent
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m camoufox fetch    # 下载强化版 Firefox（首次较慢，~300MB）
```

`pip install -e` 是 editable 安装：`browser_agent` 包对该 venv 的 python 全局可导入，
故下面 `-m browser_agent.server` 在任意 cwd 都能解析（meshbot 从 server-agent 的 cwd 拉起也没问题）。

## 接入 meshbot

在 `<meshbotDir>/mcp.json`（默认 `~/.meshbot/mcp.json`）的 `mcpServers` 下加一条 stdio 条目，
`command` 用**绝对路径**指向本目录 venv 的 python：

```json
{
  "mcpServers": {
    "browser": {
      "command": "/绝对路径/meshbot/tools/browser-agent/.venv/bin/python",
      "args": ["-m", "browser_agent.server"],
      "env": { "BROWSER_AGENT_HEADLESS": "0" }
    }
  }
}
```

> 字段名对齐 meshbot 的 `McpConfigSchema`（`libs/agent/src/mcp/mcp.schema.ts`）：
> 顶层键是 **`mcpServers`**，stdio server 用 `command` / `args` / `env`。

重启 server-agent 后，agent 即获得 `mcp__browser__use_profile / navigate / snapshot / click /
type_text / extract / get_state / compose / confirm_publish` 等工具。

## 首次登录

让 agent 依次调：
1. `use_profile("my-x")` —— 启动该账号的持久隐身 profile（profiles/my-x/，已 gitignore）。
2. `begin_login("https://x.com/login")` —— 弹出**有头**浏览器窗口；你**人工**完成登录
   （账号密码 / 2FA / 扫码均可）。会话落盘，之后复用，无需再登。

`BROWSER_AGENT_HEADLESS=1` 可无头运行（隐蔽性略降；首次登录建议仍用有头）。

## 发帖护栏（不可逆写操作）

发帖/回复等不可逆操作走两步：agent 先 `compose(site, summary)` 拿到预览 + `confirm_token`，
把预览呈现给你确认后，再 `confirm_publish(token, publish_ref)` 才真正点发布。token 单次有效，
没 compose 过无法直接发布。

## 测试

```bash
.venv/bin/pytest -q                 # 纯单测（默认，无网络无浏览器）
.venv/bin/pytest -m browser -q      # 原语集成（需 camoufox 二进制，无网络）
.venv/bin/pytest -m online -q       # 反检测验收（需联网，opt-in）
```

## 约束

- `begin_login` 需要有头显示环境（本机桌面）。无显示的服务器需配虚拟显示（xvfb）或走 headless。
- 跑在你自己机器 = 真实住宅 IP，是隐蔽性的关键红利；若部署到 VPS（机房 IP）需另配住宅代理。
- 仅操作你自有账号；写操作人在环确认；遵守各平台 ToS / 速率限制。
- 限速：每站默认 ≤30 动作/分钟（`BROWSER_AGENT_MAX_ACTIONS_PER_MIN` 可调），超了自动冷却。

## 已知边界（首切片，后续迭代补）

- **护栏是流程约定、非沙箱**：`confirm_publish` 工具要 token 才发布；但通用 `click(ref)` 不受
  护栏管——LLM 直接点「发布」按钮可绕过 compose→confirm。发帖务必走 compose→confirm 流程。
- **`compose` 不替你填内容**：它只登记待确认动作并返回 token/预览文本；正文要先用 `type_text`
  填进页面，`compose` 的 `preview` 是你传入的摘要，不是页面截图。
- **`extract` 暂不落盘**：大结果整段内联返回，依赖 meshbot 32KB 截断；海量「看评论」场景的
  落盘分页（spec 设想的 `<meshbotDir>/workspace/browser-agent/`）留待后续。
- 仅实现验收路径所需原语（navigate/snapshot/click/type_text/fill/scroll/extract/get_state +
  会话/护栏）；`hover/select/tabs/upload/dialog/frame/screenshot` 等按需补，模式同 primitives。
