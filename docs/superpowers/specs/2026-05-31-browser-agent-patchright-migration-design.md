# browser-agent 迁移设计：Camoufox/Python MCP → patchright/真 Chrome 内置工具

> 日期：2026-05-31
> 状态：待评审
> 前身：`docs/superpowers/specs/2026-05-30-browser-automation-design.md`（Python/Camoufox MCP 版，已实现并合入 main）

## 背景与动机

现有 browser-agent 是独立的 Python stdio MCP server，引擎 Camoufox（强化版 Firefox）。实际使用暴露两个体验问题：

1. **界面渲染怪**：Camoufox 是 Firefox 内核，X/小红书等站按 Chrome 调，Firefox 下布局/特性有差异。
2. **中文字体**：Camoufox 按 `os` 提供内置字体集，踩过豆腐块坑（靠钉 os 才修），脆弱。

spike 实测（同机）：**patchright + 系统真 Google Chrome 148** 两个问题同时根治，且：
- `navigator.webdriver=false`、headed 下 intoli 检测页 **0 失败项**、UA 是干净 `Chrome/148`；
- 小红书 login 渲染完美、中文走系统 PingFang 原生；
- **Node 原生** → 能进 server-agent 核心，去掉 Python/venv。

故迁移：引擎换 patchright/真 Chrome，形态从独立 MCP 进程改为 **server-agent 核心内置 `@Tool()`**（原 brainstorm 的"路线 C"，当初因 Camoufox 是 Python 被否，现因换内核 + Node 原生而成立）。

## 关键决策

| 维度 | 决策 |
|------|------|
| 引擎 | **patchright（Node）+ 系统真 Google Chrome**（`channel:"chrome"`），非 bundled Chromium |
| Chrome 缺失 | **要求真 Chrome，缺则启动报清晰错误**，不静默回落 Chromium |
| 形态 | **libs/agent 内置 `@Tool()` 工具** + 一个长驻 `@Injectable() BrowserService`；不再是独立 MCP 进程 |
| 可见性 | **headed 默认**（headless 会泄露 HeadlessChrome UA）；`BROWSER_AGENT_HEADLESS=1` 可切 |
| 驱动粒度 | LLM 驱动低层通用原语、ref 不用裸选择器、零平台知识（沿用 Python 版） |
| 能力面 | 与 Python 版一一对应（见下） |
| 并发 | 单浏览器、单 context、串行（promise 队列） |
| 迁移方式 | 双轨并存共建 → 验证三关 → 删除 Python `tools/browser-agent` |

不变的反检测北极星：**它就是真实用户的真实浏览器，我们只替他动手**。

## 架构与模块结构

全部落在 `libs/agent/`（框架无关层：只 `@Injectable()` + 生命周期钩子，无 DB/HTTP；静态围栏 `check:*` 豁免；测试用 **vitest**）。

```
libs/agent/src/tools/browser/
├── browser.service.ts   # @Injectable() 长驻 patchright 真 Chrome 持久 context
│                        #   懒启动 + OnModuleDestroy 关浏览器 + promise 队列串行 + 崩溃标记
├── humanize.ts          # 纯函数/工厂：动作延迟、打字节奏、RateLimiter、stepped 鼠标移动
├── snapshot.ts          # COLLECT_JS 常量 + formatSnapshot（纯函数，控 32KB）
├── guardrails.ts        # WriteGuard：compose→confirm token 状态机（纯）
├── primitives.ts        # 对 page 的薄封装原语（纯函数，吃 page）
└── browser.tools.ts     # 一组 @Tool() 类：每原语一个，调 BrowserService.run + primitives
```

**为什么在 libs/agent**：bash.tool 也在此 spawn 子进程——在 libs/agent 拥有/驱动外部进程（浏览器）有先例，且工具与其依赖的服务内聚。libs/agent 框架无关，浏览器既不需 DB 也不需 HTTP。

**BrowserService 生命周期**（解掉原 brainstorm"在 Nest 里别扭"的点）：
- `@Injectable()`，**懒启动**：不在 `OnModuleInit` 起 Chrome，首次 `use_profile` 才 `launchPersistentContext`。
- `OnModuleDestroy` → `close()`：server-agent 退出时关 Chrome。
- **串行**：`run(op)` 用 promise-chain 队列串行化所有页面操作（等价 Python asyncio.Lock），保证 LLM 不并发点乱。
- **崩溃隔离代价显式认领**：浏览器在 server-agent 进程内，崩溃会影响 agent 进程。`BrowserService` 对 context 崩溃 catch + 标记；`page()` 发现 context 关闭则抛错，让用户重 `use_profile`。

**工具注册**：每个 `@Tool()` 类实现 `MeshbotTool`，自动进现有 `ToolRegistry`（同 bash）。`ctx.signal` / `ctx.emitter` 直连（比 MCP 版少一层中转）。

**依赖**：`patchright` 加进 `libs/agent/package.json`；**不下载浏览器**（用系统真 Chrome），桌面应用打包也只多一个 npm 包，无 ~300MB 二进制。

## 能力面（与平台无关、对标 Python 版）

设计哲学不变：LLM 看快照组合通用原语完成任意站点；**元素用 `ref` 不用裸选择器**（`snapshot` 给每个可交互元素打 `data-mb-ref`，`click(ref)` 用 `[data-mb-ref="N"]` 定位，减少误点、避免脆弱选择器）。工具名加 `browser_` 前缀。

| 工具 | 行为 | patchright API |
|------|------|----------------|
| `browser_navigate(url)` | 导航 + 返回状态 | `page.goto(url,{waitUntil:'domcontentloaded'})` |
| `browser_snapshot()` | 精简 a11y 树（带 ref） | `page.evaluate(COLLECT_JS)` → `formatSnapshot` |
| `browser_get_state()` | url/title/是否被挡 | `page.title()` / `page.innerText('body')`（catch 空白页） |
| `browser_click(ref)` | 点击 | `locator.click()` + stepped 鼠标移动 + 延迟 |
| `browser_type_text(ref,text,submit?)` | 逐字输入 | `locator.pressSequentially(ch,{delay:0})` + 间隔 sleep |
| `browser_fill(ref,text)` | 快填 | `locator.fill()` |
| `browser_scroll(dy?)` | 滚动 | `page.mouse.wheel(0,dy)` |
| `browser_extract(selector,fields?)` | 抽取（看评论） | `page.$$eval(...)` |
| `browser_use_profile(name)` | 切/启动账号持久 profile | `launchPersistentContext` |
| `browser_begin_login(url)` | 有头登录页（人工登录） | `navigate` |
| `browser_login_status(...)` | 登录态自检 | DOM 检测 |
| `browser_compose(site,summary)` / `browser_confirm_publish(token,ref)` | 写护栏 | WriteGuard token |

**离散小工具**（每原语一个 `@Tool` 类），非合并大工具——schema 清晰、LLM 不易用错（对 ban 敏感场景更稳）。

**返回与截断**（对齐 agent-arch 双截断）：工具返回对象 → 序列化 string；喂 LLM 那份由 runner 层 `capForLlm` 截到 `TOOL_RESULT_LLM_LIMIT=32_000`。`formatSnapshot` 已控在 32KB 内（落在 a11y 快照 12–22KB 预算）。`browser_extract` 大结果**落盘** `<meshbotDir>/workspace/browser-agent/<ts>.json`，只回"N 条 + 文件路径 + 样本"给 LLM（补上 Python 版未实现的 spill）。

## 反检测环境（patchright + 真 Chrome）

比 Camoufox 更简单——真 Chrome 本身就对，无需伪装：

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
- **指纹**：真 Chrome 在真 macOS、真实住宅 IP——本身自洽真实，**无需任何 os/字体 spoof**（Camoufox 钉 os/字体豆腐块的坑消失）。
- **字体/界面**：系统 PingFang，中文原生；真 Chrome 渲染零差异（spike 验证小红书 login 完美）。
- **行为/人类节奏**（`humanize.ts`）：⚠️ 与 Camoufox 差异——patchright/Chrome **无内置 humanize**，鼠标拟人需自写：click 前取元素 bbox、分几步带抖动移鼠标再点；打字逐字延迟；滚动分段；动作间随机延迟；RateLimiter 每站限速。延迟/打字/限速从 Python 版移植，新增 stepped 鼠标移动 helper。
- **被挡即停**：`get_state` 命中验证码/403/Cloudflare 标记 → 上报停手。

**Chrome 必装检查**：首次 `launchPersistentContext` 若 Chrome 缺失，patchright 抛错；`BrowserService` catch 后重抛清晰错误（"需安装 Google Chrome，见 README"）。

**headed 默认**：`begin_login` 弹真 Chrome 窗口人工登录（2FA/扫码）；无显示环境配 xvfb 或 `BROWSER_AGENT_HEADLESS=1`（隐蔽性略降，且 headless 暴露 HeadlessChrome UA）。

## 中断 / 进度

- **`ctx.signal`（Stop）**：Playwright 单步不吃 AbortSignal。`run(op)` 用 `Promise.race([op(), abortPromise])`，signal 触发让当前工具调用 reject（用户 Stop 立即返回）；底层 op 可能后台跑完，但页面状态仍可用，下次调用继续。**= 尽力中断，非硬杀**（与 bash 的 SIGKILL 不同，诚实标注）。
- **`ctx.emitter`（进度）**：长操作前后 emit `runToolCallProgress`（"导航中… / 已加载 <title>"），同 bash 流给前端。

## 测试（vitest）

- **纯单测**（默认快、无浏览器）：humanize（延迟/打字/RateLimiter）、snapshot `formatSnapshot`+截断、guardrails token（含单次使用）、profile 路径+穿越防护、BrowserService 串行队列。
- **浏览器集成**（标记隔离、需真 Chrome）：原语对本地 fixture HTML 跑真 Chrome，验 navigate/snapshot/click/type/extract 真实 DOM 效果。
- **🎯 反检测验收**（opt-in、**headed**）：intoli 检测页断言 `navigator.webdriver=false` + 无 webdriver 失败项。必须 headed（headless 泄露 HeadlessChrome UA）。

## 迁移切换

1. TS 版与现有 Python `tools/browser-agent` **并存共建**，先不删。
2. 验证三关：单测 + 浏览器集成 + 反检测验收（headed）全绿；手动跑通 `use_profile→begin_login→小红书→snapshot→extract` 读链路 + `compose→confirm` 写链路。
3. 验证 OK 后**删 `tools/browser-agent`**（Python + venv），更新 README/旧 spec 标注 superseded。
4. **不再需要 mcp.json**：内置工具，server-agent 起来即有（之前那条"配 mcp.json"步骤直接省掉）。

## 明确不做（YAGNI，首切片对标 Python 版）

- ❌ Chromium 回落（要求真 Chrome）
- ❌ 代理（用自有住宅 IP）
- ❌ 多账号并发（串行）
- ❌ auto-confirm 无人值守发帖（先人在环）
- ❌ 超出 Python 版的额外原语（hover/select/tabs/upload/dialog/frame 按需补）
- 首切片 = 引擎（BrowserService）+ 全套现有原语 + 护栏 + 三关验收

## 与 Python 版的差异小结（迁移要点）

| 方面 | Python/Camoufox（旧） | TS/patchright（新） |
|------|----------------------|---------------------|
| 引擎 | Camoufox(Firefox) | patchright + 真 Chrome |
| 形态 | 独立 stdio MCP 进程 | server-agent 内置 @Tool |
| 语言/依赖 | Python venv + camoufox(~300MB FF) | Node patchright（无浏览器下载，用系统 Chrome） |
| 字体 | 钉 os 拿内置集（踩过豆腐块） | 系统字体，原生 |
| 鼠标拟人 | Camoufox 内置 humanize | 自写 stepped 移动 |
| 中断 | MCP adapter 传 signal | ctx.signal 直连（尽力中断） |
| 配置 | 需 mcp.json | 无需配置，内置即用 |
| 测试 | pytest | vitest |
| extract 大结果 | 内联（未落盘） | 落盘 + 摘要 |
