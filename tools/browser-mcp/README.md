# meshbot-browser-mcp

自写的薄 **nodriver stealth MCP** —— 用系统真 Google Chrome（nodriver 驱动，反检测）给 meshbot agent 一套**通用低层浏览器原语**（navigate / snapshot / click / type / extract …），登录态持久。任意站点，零平台知识。

设计见 `docs/superpowers/specs/2026-05-31-browser-mcp-nodriver-design.md`。

## ⚠️ 先读：反检测 ≠ 不封号

本工具解决的是**反自动化检测**（隐藏 `navigator.webdriver`、不走 CDP `Runtime.enable` 握手指纹、真 Chrome 真指纹）—— 让你“**不被识别为机器人**”。但 X / 小红书**封号主要是行为风控 + 账号关联风控**（同设备多账号、机械化节奏、违禁词限流）。实测小红书做 Canvas/WebGL/字体/21 项硬件指纹 + 行为分析。**没有任何框架能保证不封。** 要降低封号，必须配套**运营纪律**：

- **单设备单账号**（同设备多账号约 78% 触发异常）
- **住宅 IP**（本机跑就是你真实住宅 IP；部 VPS 需挂住宅代理）
- **人类节奏 + 限速**（本工具原语已内置延迟/打字节奏，但发帖频率仍要克制、养号）
- **发布前人在环确认**（见下"写操作护栏"）

## 前提
- 系统装了 **Google Chrome**（nodriver 自动探测；缺则启动报错）。
- 首次每账号需在弹出的 Chrome 窗口里**人工登录一次**。

## 安装
```bash
cd tools/browser-mcp
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
# 不下载浏览器（用系统真 Chrome）。
```

## 接入 meshbot
在 `<meshbotDir>/mcp.json`（默认 `~/.meshbot/mcp.json`；开发态 `<repo>/.meshbot/mcp.json`）的 `mcpServers` 下加：
```json
{
  "mcpServers": {
    "browser": {
      "command": "/绝对路径/meshbot/tools/browser-mcp/.venv/bin/python",
      "args": ["-m", "browser_mcp.server"],
      "env": { "BROWSER_MCP_HEADLESS": "0" }
    }
  }
}
```
> 字段对齐 meshbot `McpConfigSchema`（`libs/agent/src/mcp/mcp.schema.ts`）：顶层 `mcpServers`，stdio 用 `command`/`args`/`env`。

重启 server-agent 后，agent 获得 `mcp__browser__*` 工具，核心零改动。

## 工具（12 个通用低层原语）
`use_profile(name)` 启动/切账号持久 profile · `navigate(url)` · `snapshot()`（精简可访问性树，带 `[ref]`）· `click(ref)` · `type_text(ref,text,submit?)` · `fill(ref,text)` · `scroll(dy?)` · `extract(selector)`（看评论）· `get_state()` · `screenshot(path)` · `cookies_save(path)` / `cookies_load(path)`。

agent 工作循环：`navigate → snapshot → click/type(ref) → snapshot → …`，任意站。

## 首次登录
让 agent 调 `use_profile("my-x")` —— 弹出真 Chrome（headed），你**人工登录一次**（账号/2FA/扫码），登录态落盘（`tools/browser-mcp/profiles/my-x/`，已 gitignore），之后复用。多账号一号一 profile。

`BROWSER_MCP_HEADLESS=1` 可无头运行（隐蔽性略降，且 headless 会暴露 HeadlessChrome 痕迹；首次登录务必 headed）。

## 写操作护栏（流程约定）
通用低层原语下没有 `post/confirm` 语义动词，所以**发布/删除/关注等不可逆操作的护栏是流程约定**：agent 必须先 `snapshot`/`screenshot` 把"将要点的发布按钮 + 已填内容"**呈现给用户、得到明确确认后再 `click` 发布键**。工具层不强制 —— 这是"纯通用原语"的取舍。

## 测试
```bash
.venv/bin/pytest                 # 纯单测（默认，无浏览器无网络）
BROWSER_E2E=1 .venv/bin/pytest   # nodriver 真 Chrome 集成（本地 fixture，无网络）
BROWSER_ONLINE=1 .venv/bin/pytest # 反检测验收（intoli，需联网）
```

## 约束
- 仅操作你自有账号；遵守各平台 ToS / 速率。
- 单 profile 同刻仅一个 Chrome（profile lock）；多账号并发须一号一目录（manager 串行起步）。
- 反检测是长期军备竞赛；平台风控会演进，靠观察 + 调节奏/限速维持。
