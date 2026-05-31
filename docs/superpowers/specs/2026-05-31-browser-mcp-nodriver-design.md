# browser-mcp 设计：自写薄 nodriver stealth MCP（通用原语）

> 日期：2026-05-31
> 状态：待评审
> 取代：`2026-05-31-browser-agent-patchright-migration-design.md`（patchright skill 版）+ `2026-05-30-browser-automation-design.md`（Camoufox MCP 版）。二者均退役。

## 决策依据（两轮研究 + 一次安全审计的收敛）

- 通用 agent 浏览器 = LLM 驱动**低层通用原语**(任意站)，需**常驻浏览器**；常驻浏览器最干净的家是 **MCP**(meshbot 托管其生命周期)，不是 skill+daemon(脆)。
- 反检测引擎选型：**nodriver**（undetected-chromedriver 继任者）—— 2026 基准对 31 个 Cloudflare 目标 0 封锁(唯一)，CDP attach 真 Chrome、无 webdriver/Runtime.enable 协议指纹、不锁 Firefox(无 Camoufox 的渲染/字体坑)。审计确认其自测过 Cloudflare/社媒。
- 现成整包 MCP 都不直接用：
  - **vercel agent-browser**：原语强但**零反检测**(暴露 navigator.webdriver)，发 X/小红书高风险。
  - **vibheksoni/stealth-browser-mcp**：nodriver 引擎对，但 13k 行/97 工具、**把"宿主任意 Python 执行"做成 MCP 工具**(create_python_binding 无沙箱 exec)+ HTTP transport 默认 `0.0.0.0` 不鉴权 → 接进 agent 平台不可接受。
  - **RobithYusuf/mcp-stealth-chrome**：更干净(stdio、零遥测、出站全 opt-in)但单文件 6k 行、137 工具、bus-factor=1、9★ → 不当基座。
- **结论**：引擎采用 nodriver；**自写一个十几工具的薄 MCP 壳**(最小、可审、可控、无多余攻击面)；**移植 RobithYusuf `state.py` 的 profile 鲁棒性代码**(踩坑才有的真功夫)。

## ⚠️ 必须写在最前的认知前提：反检测 ≠ 不封号

所有这些工具解决的是**反自动化检测**(webdriver/CDP/指纹)。但 X/小红书**封号主要是"行为风控 + 账号关联风控"**(同设备多账号、机械化节奏、违禁词)。实测小红书做 Canvas/WebGL/字体/21 项硬件指纹 + 行为分析，同设备登 3+ 账号约 78% 触发异常。**没有任何框架能保证不封**。本设计只负责"反检测 + 给行为安全留接口"，真正决定账号死活的是**行为策略 + 住宅代理 + 养号 + 单设备单账号 + 人在环**，这是框架之外、必须配套的运营纪律。

## 关键决策表

| 维度 | 决策 |
|------|------|
| 引擎 | **nodriver**(Python，CDP attach 系统真 Chrome) |
| 形态 | **自写薄 MCP server**(stdio)，~12 个通用低层原语，零平台知识 |
| 形态归属 | 独立可发布 Python 包 `tools/browser-mcp/`(非 apps/——apps 是 TS 单仓)，pyproject 配好可发 PyPI；meshbot 经 `mcp.json` stdio 接入（核心零改动） |
| 驱动粒度 | LLM 驱动低层通用原语(navigate/snapshot/click/type/extract…)，任意站 |
| 持久登录 | 移植 state.py：Chrome `user_data_dir` 每账号一目录 + SingletonLock 处理 + storage_state 双轨 |
| 反检测 | 引擎级交给 nodriver；我们加行为层(节奏/限速/被挡即停)；写操作护栏为流程约定 |
| 可见性 | headed 默认(真窗口、登录用)；headless 可配 |
| 处置 | 取代 patchright `tools/browser` + Camoufox `tools/browser-agent`，验证后删 |

## 目录结构（独立可发布 Python 包）

```
tools/browser-mcp/
├── pyproject.toml          # 可发布：name=meshbot-browser-mcp，deps: nodriver、mcp(或 fastmcp)、(pytest dev)
├── README.md               # 安装、mcp.json 接入、登录、行为安全纪律
├── browser_mcp/
│   ├── server.py           # MCP server：注册 ~12 个工具（stdio），全经 BrowserManager 串行
│   ├── manager.py          # 常驻 nodriver 浏览器实例 + 多 profile + 串行锁 + 生命周期
│   ├── profile.py          # ★ 移植 RobithYusuf state.py：SingletonLock PID 解析 / per-PID 回退 / wipe_window_state / 默认 profile 解析
│   ├── session.py          # 双轨持久登录：profile 为主 + storage_state save/load（改进：含 sessionStorage、落盘 0600、localStorage 用 CDP 受控页写入而非逐 origin 真实导航）
│   ├── snapshot.py         # 页面 → 精简可访问性树 + ref（COLLECT_JS 思路移植，控 token）
│   ├── humanize.py         # 行为层：延迟分布 / 打字节奏 / 鼠标轨迹 / RateLimiter（纯函数）
│   ├── primitives.py       # 低层原语：navigate/snapshot/click/type/fill/scroll/extract/get_state…
│   └── patches.py          # ★ 移植 nodriver 0.48 / Chrome 147+ 的 Cookie.from_json 补丁（否则会话 KeyError 崩）
└── tests/
    ├── fixtures/           # 保存(strip script)的真实页面 DOM，供解析单测
    └── *.py                # pytest：humanize/snapshot/profile 纯单测 + nodriver e2e(标记 opt-in) + 反检测验收
```

## 工具面（~12 个通用低层原语，零平台知识）

LLM 工作循环：`navigate → snapshot → click/type → snapshot → …`，任意站。元素用 snapshot 给的 `ref` 引用，不用裸选择器。

| 工具 | 作用 |
|------|------|
| `use_profile(name)` | 启动/切换某账号的持久 nodriver 实例(每账号一 user_data_dir) |
| `navigate(url)` | 导航 + 返回状态(含疑似被挡) |
| `snapshot()` | 精简可访问性树(带 [ref])，LLM 的眼睛 |
| `click(ref)` / `type_text(ref,text,submit?)` / `fill(ref,text)` | 交互(内置人类节奏) |
| `scroll(dy?)` / `press_key(key)` | 滚动 / 按键 |
| `extract(selector)` | 抽取文本/结构化(看评论；大结果落盘 + 摘要) |
| `get_state()` | url/title/被挡标记 |
| `screenshot()` | 截图(多模态/预览) |
| `cookies_get/set`、`storage_state_save/load` | 登录态读写/迁移 |

**写操作护栏的诚实说明**：纯通用原语下没有 `post/confirm` 这种语义动词，所以**护栏退化为流程约定** —— 由 meshbot 侧 SKILL/指令要求 agent 在不可逆点击(发布/删除/关注)前**先 snapshot 预览并取得用户确认**。工具层不强制(这是"纯通用原语"相对"硬流程动词"主动接受的取舍)。

## 持久登录 & profile（移植 state.py 的核心价值）

- **主**：Chrome `user_data_dir` 每账号一目录(`<meshbotDir>/browser-profiles/<account>/`)，cookie/localStorage/登录态落盘复用。
- **鲁棒性**(移植 RobithYusuf `state.py`)：解析 `SingletonLock` 符号链接里的 PID 判活锁/陈旧锁；主 profile 被占时回退 per-PID profile(并发不死锁)；`wipe_window_state` 只清窗口/会话残留、保留登录态(治 macOS sleep/wake 后窗口 0×0)。
- **辅**：`storage_state` JSON 导出/导入(对标 Playwright storageState)做跨机迁移；改进 save 含 sessionStorage、落盘 `chmod 600`、localStorage 注入用受控空白页 CDP 写(不对每 origin 真实导航)。
- **多账号** = 多目录；同一 user_data_dir 同刻仅一个 Chrome(profile lock)，并发由 manager 管。

## 反检测 & 行为层

- **引擎级**：nodriver 本体(无 webdriver、无 Runtime.enable、真 Chrome 真指纹真 IP)。我们不重复造。
- **行为层**(`humanize.py`，我们加)：动作随机延迟、逐字打字节奏、鼠标分段轨迹、每站 `RateLimiter`、`get_state` 命中验证码/403 → 上报停手不硬刚。
- **真实住宅 IP**：跑在用户本机；VPS 部署需住宅代理(nodriver 支持)。
- **patches.py**：带上 nodriver 0.48/Chrome 147+ 的 Cookie.from_json 补丁。

## meshbot 接入

`<meshbotDir>/mcp.json` 加 stdio 条目：`{ "mcpServers": { "browser": { "command": "<venv>/bin/python", "args": ["-m","browser_mcp.server"] } } }`。agent 自动获得 `mcp__browser__*`。核心 agent 零改动。

## 测试（pytest）

- 纯单测(默认、无浏览器)：humanize(延迟/打字/限速)、snapshot formatSnapshot/截断、profile(SingletonLock 解析/锁判定/wipe 逻辑——可对造的假 profile 目录测)、storage_state save/load 形状。
- nodriver e2e(opt-in、需 Chrome)：原语对本地 fixture 真实 DOM；持久 profile 复用。
- 🎯 反检测验收(opt-in、headed)：bot 检测页 navigator.webdriver 隐藏 + 无 webdriver 失败项。

## 首切片 / YAGNI

- 首切片：薄 MCP(上述 ~12 工具) + profile 层(移植 state.py) + humanize + patches + meshbot 接入 + 反检测验收 + 手动跑通"登录 → 在 X 用通用原语发一条(预览→确认→点发布) + 抓一页评论"。
- ❌ 不做：captcha 求解 / vision-LLM / curl_cffi(初版不引入，减外发面与依赖)；平台专用动词(纯通用原语)；多账号并发(串行起步)；vibheksoni 的元素克隆/hook/cdp-functions 全家桶(本就不要)。

## 处置

patchright `tools/browser`(10 任务) + Camoufox `tools/browser-agent` 在本方案验证通过后删除；旧 spec 标 superseded。
