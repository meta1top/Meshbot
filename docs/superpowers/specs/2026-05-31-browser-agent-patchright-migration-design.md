# browser 自动化设计：patchright/真 Chrome 做成 meshbot skill

> 日期：2026-05-31
> 状态：待评审
> 前身：`docs/superpowers/specs/2026-05-30-browser-automation-design.md`（Python/Camoufox MCP 版，已实现并合入 main）
> 取代：本文档早先一版"内置 @Tool"方案（已否决，理由见下）

## 背景与动机

现有 browser-agent 是独立 Python stdio MCP server，引擎 Camoufox（Firefox）。实际使用暴露：界面渲染怪（Firefox 内核，X/小红书按 Chrome 调）+ 中文字体豆腐块（靠钉 os 才修，脆弱）。

spike 实测（同机）：**patchright + 系统真 Google Chrome 148** 两问题同时根治——`navigator.webdriver=false`、headed 下 intoli 检测页 0 失败、UA 干净 `Chrome/148`、小红书 login 渲染+中文完美、Node 原生。故引擎换 patchright/真 Chrome。

**形态决策（两次迭代）**：
- 先考虑"server-agent 内置 `@Tool()`" → **否决**：十几个 browser 工具会常驻每个 session 的工具列表（哪怕不碰浏览器）、`BrowserService` 常驻 core 生命周期、patchright 成 core 硬依赖——**太重**。
- 最终选 **meshbot 运行时 skill + 捆绑 patchright CLI（高层任务动词）**：渐进式披露（用到才 `skill_load`）、可插拔、零 core 改动。贴合本仓库已有的 skill 机制与 ota-reviews 先例。

## 关键决策

| 维度 | 决策 |
|------|------|
| 引擎 | **patchright（Node）+ 系统真 Google Chrome**（`channel:"chrome"`），非 bundled Chromium |
| Chrome 缺失 | **要求真 Chrome，缺则 CLI 清晰报错退出**，不静默回落 |
| 形态 | **meshbot 运行时 skill**：`<meshbotDir>/skills/browser/`，捆绑 Node/patchright CLI；**零 core 改动、无 mcp.json** |
| 交互粒度 | **高层任务动词**（login / post / comments / status），每条一次性进程；**放弃低层原语/snapshot/ref** |
| 可见性 | **headed 默认**（headless 泄露 HeadlessChrome UA）；`BROWSER_AGENT_HEADLESS=1` 可切 |
| 登录态 | **持久 user-data-dir**（每平台/账号一个），登录一次复用 |
| 写护栏 | `post` 默认 dry-run（只预览不发）；SKILL.md 要求 agent 先给用户看预览、确认后才 `--confirm` 重跑 |
| 并发 | 单次一个浏览器（动词一次性），无并发 |
| 迁移 | skill 验证三关后删 Python `tools/browser-agent` |

反检测北极星不变：**它就是真实用户的真实浏览器，我们只替他动手**。

## 为什么是 skill 而不是内置工具 / MCP

- **内置 @Tool**：工具常驻全局列表 + core 耦合 + patchright 进 core → 太重。
- **MCP（现状 Python）**：独立进程比内置轻，但工具仍**全局可见**（每 session 都在 LLM 工具列表里），且要管 mcp.json。
- **skill（本方案）**：`skill_list` 才发现、`skill_load` 才载入、用 `bash` 跑捆绑 CLI——**默认工具列表不被 browser 工具撑大**，core 零负担，可插拔。本仓库 `skill_load` 返回 `[skill dir] <abs>` 正是为"载入后用 bash 跑捆绑脚本"设计的。

## skill 机制（本仓库实测）

- 运行时 skill 在 `<meshbotDir>/skills/<name>/SKILL.md`（`MeshbotConfigService.getSkillsDir()`）。与 `.claude/skills/`（开发用）无关。
- `skill_load(name)` 返回 SKILL.md 正文 + 首行 `[skill dir] <绝对路径>`；引用的其他文件/脚本由 LLM 后续用 read_file/bash 按需取（渐进式）。
- 现状：`tools/ota-reviews` 无 SKILL.md、`.meshbot/skills` 不存在——运行时 skill 安装是 pending 的一步，本方案要补上（创建目录 + 软链）。

## 目录结构

源码放仓库 `tools/browser/`（与 `tools/ota-reviews/` 同级，自带 `node_modules`）：

```
tools/browser/
├── package.json          # 依赖 patchright（+ vitest）；自带 node_modules，不下载浏览器（用系统 Chrome）
├── SKILL.md              # frontmatter(name/description) + 正文：动词清单、登录一次流程、发帖确认约定、注意事项
├── cli.js                # 入口：解析 verb → dispatch（无三方 arg 库或用极简）
├── src/
│   ├── browser.js        # launchPersistentContext(channel:'chrome', headed) + profile 解析 + Chrome 必装检查
│   ├── humanize.js       # 延迟分布 / 逐字打字间隔 / stepped 鼠标移动 / RateLimiter（纯函数）
│   ├── login.js          # verb 实现
│   ├── post.js           # verb 实现（dry-run 预览 → --confirm 发布）
│   ├── comments.js       # verb 实现（→ JSON 落盘 + 摘要）
│   └── platforms/        # 每平台选择器/流程：x.js / xhs.js / tripadvisor.js
└── tests/
    ├── fixtures/         # 保存的 HTML 样本（评论解析单测、本地表单页）
    └── *.test.js         # vitest
```

**安装**：安装步骤创建 `<meshbotDir>/skills/`（现不存在）并软链：
`ln -s <repo>/tools/browser <meshbotDir>/skills/browser`（开发态 `<repo>/.meshbot`、打包态 `~/.meshbot`）。`skill_load` 的 `[skill dir]` 顺软链解析到真实目录（含 node_modules），LLM `bash` 跑 `node <skill dir>/cli.js <verb>`。

## 任务动词（高层 CLI）

每条动词一次性：用持久 profile launch 真 Chrome → 跑硬流程（humanize 节奏）→ 退。LLM 只决定"调哪个动词 + 参数"。

| 动词 | 作用 | 输出 |
|------|------|------|
| `login --site <x\|xhs\|tripadvisor>` | 有头 Chrome，人工登录一次（2FA/扫码），持久化 profile | 登录成功/失败 |
| `post --site <x\|xhs> --text "…" [--image …] [--confirm]` | 无 `--confirm`：填内容但**不发**，返回预览（文本 + 截图路径）；有 `--confirm`：真发布 | 预览 / 已发布 |
| `comments --site <…> --url <…> [--max N]` | 拉评论 → 写 `<meshbotDir>/workspace/browser/<ts>.json` | N 条 + 文件路径 + 样本 |
| `status --site <…>` | 登录态自检 | 已登录/需登录 |

**写护栏（流程约定，非工具内 token）**：`post` 默认 dry-run。SKILL.md 明确：agent 必须先把 dry-run 预览呈现给用户，用户确认后才加 `--confirm` 重跑发布。轻、人在环、够用。

**首切片只做 X**（`login/post/comments --site x`，纯文本）；小红书/猫途鹰是同模式加 `platforms/<p>.js` 适配器，零新机制。

## 反检测环境（patchright + 真 Chrome）

每动词一次性，但 profile 持久。比 Camoufox 简单——真 Chrome 本身就对：

**启动配置**（patchright 最佳实践）：
```
launchPersistentContext(<profileDir>, {
  channel: "chrome",      // 系统真 Chrome
  headless: 默认 false,    // BROWSER_AGENT_HEADLESS=1 才 true
  viewport: null,         // no_viewport
  // 绝不加自定义 userAgent / headers（patchright 警告会泄露）
})
```

逐层：
- **JS 运行时**：patchright 已堵 `navigator.webdriver`（spike 实测 false）+ CDP `Runtime.enable`（隔离 ExecutionContext）。白拿。
- **指纹**：真 Chrome 在真 macOS、真实住宅 IP——本身自洽真实，无需任何 os/字体 spoof（Camoufox 钉 os/字体豆腐块的坑消失）。
- **字体/界面**：系统 PingFang，中文原生；真 Chrome 渲染零差异。
- **行为/人类节奏**（`humanize.js`）：patchright/Chrome **无内置 humanize**，鼠标拟人需自写——click 前取元素 bbox、分几步带抖动移鼠标再点；逐字打字延迟；滚动分段；动作间随机延迟。
- **限速**：v1 在单次流程内控节奏；跨次每分钟上限因一次性进程较弱，自有号手动节奏够用（按需再落磁盘时间戳节流）。
- **被挡即停**：命中验证码/403/Cloudflare 标记 → 非 0 退出 + 打印 `BLOCKED: …`，不硬刚。

**Chrome 必装检查**：`launchPersistentContext` 若 Chrome 缺失，patchright 抛错；`browser.js` catch 后打印清晰错误（"需安装 Google Chrome，见 SKILL.md"）非 0 退出。

**headed 默认**：`login`/`post` 弹真 Chrome 窗口；无显示环境配 xvfb 或 `BROWSER_AGENT_HEADLESS=1`（隐蔽性略降，且 headless 暴露 HeadlessChrome UA）。

## 测试（vitest，独立项目）

- **纯单测**（默认快、无浏览器）：humanize（延迟/打字/限速）、平台评论解析器对保存的 HTML fixture（无网络）、CLI 参数解析、profile 路径 + 穿越防护、dry-run/confirm 分支。
- **浏览器集成**（真 Chrome，opt-in）：动词对本地 fixture 表单页验证 launch+填充+humanize 链路（不打真实平台）。
- **🎯 反检测验收**（intoli，**headed**，opt-in）：`navigator.webdriver=false` + 无 webdriver 失败项。必须 headed（headless 泄露 HeadlessChrome UA）。
- 真实平台 smoke：手动、opt-in，不进默认套件（要登录、易抖）。

## 迁移 / 处置

1. `tools/browser`（Node/patchright skill）与现有 Python `tools/browser-agent` **并存共建**，先不删。
2. 验证三关：单测 + 浏览器集成 + 反检测验收（headed）全绿；手动跑通 `login→post(dry-run→confirm)→comments` on X。
3. 验证 OK 后**删 `tools/browser-agent`**（Python + venv），更新旧 spec 标注 superseded。
4. **零 core 改动、无 mcp.json**：纯捆绑 skill + 安装软链。

## 明确不做（YAGNI，首切片 = X 一个平台）

- ❌ 低层原语 / snapshot / ref（改为高层动词）
- ❌ Chromium 回落（要求真 Chrome）
- ❌ 代理（用自有住宅 IP）
- ❌ 并发（动词一次性）
- ❌ auto-confirm 无人值守发帖（先人在环）
- ❌ 跨次持久限速、图片上传（首切片纯文本，后补）
- ❌ 小红书/猫途鹰适配器（首切片只 X，同模式后补）

## 与 Python/Camoufox 版的差异小结

| 方面 | Python/Camoufox（旧） | Node/patchright skill（新） |
|------|----------------------|------------------------------|
| 引擎 | Camoufox(Firefox) | patchright + 真 Chrome |
| 形态 | 独立 stdio MCP 进程 | meshbot skill + 捆绑 CLI（bash 跑） |
| 工具可见性 | MCP 工具全局可见 | 渐进式：skill_load 才载入 |
| 交互粒度 | LLM 驱动低层原语 | 高层任务动词 |
| 字体 | 钉 os 拿内置集（踩过豆腐块） | 系统字体，原生 |
| 鼠标拟人 | Camoufox 内置 humanize | 自写 stepped 移动 |
| 配置 | 需 mcp.json | 无需 mcp.json，安装软链即用 |
| core 负担 | MCP 注册 | 零 core 改动 |
| 测试 | pytest | vitest |
