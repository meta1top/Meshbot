# meshbot 浏览器自动化（反检测）设计

> 日期：2026-05-30
> 状态：待评审

## 目标

给 meshbot agent 一套**通用的、被 agent 驱动的浏览器自动化能力**：在**尽量真实、不被检测**的浏览器环境下，由 agent（LLM）看页面、组合低层原语，完成任意网页自动化操作（发 X / 小红书帖、看评论/互动、读猫途鹰评论……）。

唯一北极星：**这就是一个真实用户的真实浏览器，我们只是替他动手；任何平台都靠 LLM 运行时驱动通用原语完成，引擎不含平台知识。**

## 关键决策（已锁定）

| 维度 | 决策 |
|------|------|
| 规模/意图 | 自己的少量账号，内容发布 + 看评论/互动；核心是**不被风控封号**。并发 = 1，无需代理池 / 账号池 / 指纹隔离 |
| 执行模型 | server-agent 管理的**持久化隐身 profile**，登录一次复用，可后台/定时无人值守 |
| 形态 | 仓库内自建 **stdio MCP server**（路线 B），由 meshbot 原生 MCP 机制拉起，**核心 agent 零改动** |
| 驱动粒度 | **LLM 驱动低层通用原语**（navigate/click/type/extract/snapshot…），零平台硬编码 |
| 引擎 | **Camoufox**（强化版 Firefox，无 CDP）；Patchright/Chromium 留可插拔口，v1 不做 |
| 默认可见性 | **headed**（最隐蔽，跑在用户机器上）；headless 为配置项 |

与 ota-reviews 的关系：**不强行合并**。ota-reviews 继续管"匿名批量抓公开评论"；本引擎管"需登录态 + 交互式 + 通用自动化"。独立 `tools/browser-agent/`，不共用包/venv。

## 架构 & 进程模型

一个**长驻 stdio MCP server**（Python），由 server-agent 通过 `<meshbotDir>/mcp.json` 拉起；agent 自动获得 `mcp__browser__*` 一组工具。

```
server-agent (NestJS)
  └─ McpService 读 mcp.json
       └─ spawn: <venv>/bin/python -m browser_agent.server   (stdio MCP)
            └─ 进程内常驻：
                 BrowserManager —— 持有 1 个 Camoufox 浏览器 + 持久 profile（登录态）
                 ├─ 暴露 MCP 工具：navigate / snapshot / click / type / extract …
                 └─ 所有交互原语经「真实环境层（humanize + 限速）」包装
```

**为什么长驻**：要持有一个"已登录、跨多次工具调用复用"的隐身浏览器 context。MCP server 生命周期 = server-agent 在它就在，浏览器在它内部常驻——这是 bash 一次性脚本做不到的（每次重启丢登录态）。

**并发**：单浏览器、单 context、**串行**。MCP server 内部对工具调用加互斥锁，避免 LLM 并发把同一页面点乱。

**调用链**：用户对 agent 说"看下我那条推的评论" → LLM 调 `navigate` → `snapshot`（拿可访问性树）→ 据此 `click`/`extract` → 结果回流。每次调用走 server-agent `toolsNode`，自带 `ctx.signal`（可中断）、进度事件、**32KB 结果截断**（快照需为此精简）。

## 通用原语面（与平台无关、可组合）

每个交互原语**内部都过"真实环境层"**。关键设计：**元素用 `ref` 不用裸选择器**——`snapshot` 返回精简可访问性树，每个可交互元素带 `ref` id，LLM 只能 `click(ref)`，既减少误点（误点多 = 暴露面大），也避免 LLM 编脆弱选择器。

| 类别 | 原语 | 说明 |
|------|------|------|
| 导航 | `navigate(url)` / `go_back` / `go_forward` / `reload` / `get_state()` | `get_state` 返回 url/title/是否疑似被挡 |
| 感知 | `snapshot()` | 精简可访问性树（role+name+ref，截断控 token），LLM 的眼睛 |
| | `screenshot(ref?, full?)` / `read_text(ref?)` / `get_html(ref?)` | 截图 / 取文本 / 生 HTML（逃生口） |
| 交互 | `click(ref, button?, count?)` / `hover(ref)` / `focus(ref)` | 点击/悬停/聚焦 |
| | `type(ref, text, submit?)` / `fill(ref)` / `clear(ref)` | 逐字输入（节奏化）/ 快填 / 清空 |
| | `select(ref, values)` / `check(ref)` / `uncheck(ref)` | 下拉 / 勾选 |
| | `press_key(key)` / `drag(from, to)` / `scroll(dir\|to_ref)` | 键盘 / 拖拽 / 滚动 |
| 等待 | `wait_for(text\|ref\|ms\|network_idle)` | 替代死 sleep |
| 多标签 | `tabs_list` / `tab_new(url?)` / `tab_select(id)` / `tab_close(id)` | 多标签 |
| 文件 | `upload(ref, paths)` / `wait_download()` | 发图/上传 / 下载 |
| 弹窗/框架 | `handle_dialog(accept?, text?)` / `switch_frame(ref?)` | alert/confirm/prompt / iframe |
| 抽取 | `extract(target_ref?, fields?)` | 从指定区域/整页提取**原始结构化内容**（如评论列表项的文本/作者/时间）；**解读由 LLM 做**，server 不做 NLP。大数据落盘，摘要回 LLM |
| 会话 | `use_profile(name)` / `login_status(site)` / `begin_login(site)` | 多账号 profile / 登录态 |
| 护栏 | `compose(...)` / `confirm_publish(token)` | 不可逆写操作的"预览→确认"（见护栏节） |

**实现取舍**：采用"多个离散小工具"（每个 schema 清晰，LLM 不易用错），而非少数带 `action` 参数的大工具——离散对 ban 敏感场景更稳。

**返回结构**：每个工具返回 `{ ok, summary, snapshot?, data?, blocked?, error? }`。`snapshot` 精简到塞进 32KB；`extract` 的大数据走 `data`，超过阈值时落盘到 `<meshbotDir>/workspace/browser-agent/`（与 meshbot workspace 约定一致）并只把摘要 + 文件路径回 LLM（配合 meshbot 的 32KB 截断，不撑爆上下文）。

## 反检测环境层（灵魂）

把反检测五层逐层落到引擎里。

### 引擎：Camoufox（主）

| | Camoufox（选它） | Patchright |
|---|---|---|
| CDP 指纹 | **根本没有 CDP**（走 Juggler），无 `Runtime.enable` 泄漏要堵 | 有 CDP，靠补丁藏，补丁本身仍可能被识别 |
| 指纹 | 引擎层注入 + 自洽，内置 | 需自己拼 |
| 人类节奏 | **内置 `humanize`**（贝塞尔鼠标） | 自己写 |
| 持久 profile | 支持 `user_data_dir` | 支持 |

引擎藏在 `manager.py` 接口后，万一某站对 Firefox 不友好可切 Patchright（可插拔，**v1 只做 Camoufox**）。

### 逐层落地

1. **JS 运行时痕迹** → 交给引擎。Camoufox 无 `navigator.webdriver`、无 CDP 痕迹，白拿。
2. **指纹自洽 + 稳定** → 每个 profile **钉死一套指纹**（UA/platform/screen/timezone/locale/WebGL 全自洽），随 `user_data_dir` 持久化，**不轮换**（真人不换设备）。timezone/locale/geolocation 对齐用户**真实地区**。
3. **网络层** → 跑在**用户自己机器 = 真实住宅 IP**，TLS/JA3 是真 Firefox 的。自有号最大的隐蔽红利，**不用代理**。⚠️ 约束：若把 server-agent 部到 VPS，机房 IP 破功，那时才需住宅代理。
4. **行为/人类节奏**（`humanize.py` + Camoufox 内置）：鼠标贝塞尔轨迹；打字逐字、延迟服从人类分布；滚动分段带阅读停留；动作间随机延迟（非固定 sleep）；**限速**（每站动作预算 + 冷却 + 每分钟上限 + 会话间长歇）；可选发帖前热身（落首页/feed 停留，v1 留口不强做）。
5. **被挡即停**：`get_state` 命中验证码/403/Cloudflare 挑战 → 返回 `blocked` 并**停手上报**，绝不猛点（猛点 = 必封）。

### 持久真实 profile + 登录（`manager.py`）

- `profiles/<账号名>/` = 持久 `user_data_dir`（cookie/localStorage/历史 → 养熟的真实会话），**gitignored**，每号一个，钉一套指纹。
- **登录一次**：`begin_login(site)` 起一个**有头**窗口，用户**人工**完成登录（2FA/扫码/短信都人来），会话落盘，之后复用。
- **写操作前自检** `login_status`：导航已知登录态端点 / 看头像元素是否在；失效 → 报"需重新登录"，不瞎试。
- **有头优先**：用户机器有显示器 → 默认 headed（最隐蔽）；无人值守/无显示 → headless（Camoufox headless 比 Chromium 隐蔽）或配虚拟显示（xvfb）。headed 为默认。

## 写操作护栏（`guardrails.py`）

动作分三档：
- **读**（navigate/snapshot/extract…）→ 无闸
- **可逆写**（存草稿等）→ 轻闸（限速）
- **不可逆写**（发布/回复/删除/关注）→ **强闸：compose → 预览 → 人工确认 → 才发布**

机制（两步 + token）：
1. LLM 调 `compose(...)`：把内容填进页面但**不点发布**，返回 `{preview: 截图+将发布文本, confirm_token}`。
2. LLM 把预览呈现给用户，问"确认发?"；用户确认 → LLM 才调 `confirm_publish(token)` 真点发布。

`confirm_token` 绑定那个"已暂存未发布"的页面状态——**没 compose 过拿不到 token，无法直接发布**，杜绝 LLM 自作主张发出去。默认**人在环里**（自己几个号每条该过目）；以后无人值守定时发再加白名单放开 auto-confirm（v1 不做）。

## 错误处理 & 可观测性

- **被挡即停**：见上，`blocked` 上报不猛点。
- **超时**：每动作 + 导航各自超时，超时返回错误不挂死。
- **中断**：server-agent `ctx.signal` 透传给 MCP invoke → 取消当前 Camoufox 操作。
- **失败留证**：出错存 `截图 + 当前 url` 到 debug 目录，便于诊断选择器/页面变化。
- **结构化日志**：每动作记 `profile/site/action/耗时/结果` 到日志文件，用来**观察某站何时开始挡你**（趋势）——长期运营的眼睛。

## 测试（pytest，默认不打网络）

- **原语单测**：对本地静态 HTML fixture / 本地测试服务器测 click/type/extract/snapshot，无网络。
- **`humanize` 单测**：延迟分布、轨迹、限速边界。
- **护栏单测**：`confirm_token` 逻辑（没 compose 不能 publish、token 失效）。
- **`snapshot` 单测**：样本 DOM → 精简可访问性树输出 + ref 稳定性。
- **🎯 反检测验收（opt-in，不进 CI）**：headed 跑通 bot 检测测试页（sannysoft / CreepJS / BrowserScan / DataDome demo），断言 `webdriver=false`、无 CDP、指纹自洽**全绿**。**这是"不被检测"的可量化成功标准**——这些页面绿了才算环境达标。

## 首个垂直切片（验收）

因为通用原语 + LLM 驱动，首切片 = 打通整条链路（无平台代码）：

**做**：Camoufox `BrowserManager` + 持久 profile + `begin_login` + 全套通用原语 + `humanize` + 护栏 + MCP server + `mcp.json` 接线。

**三步验收**：
1. **反检测**：bot 检测测试页全绿。
2. **读链路**：手动登录 X 一次 → 导航主页 → `extract` 最新一条推的评论 → 摘要回 agent。
3. **护栏写链路**：`compose` 一条推 → 预览给用户 → 确认 → `confirm_publish` 发出。

跨过即证明：**持久登录态、隐身达标、LLM 驱动原语（读）、写护栏**全闭环。之后小红书/猫途鹰/更多动作**同一套原语、零新代码**，纯靠 LLM 看快照驱动。

## 目录结构

```
tools/browser-agent/
├── pyproject.toml / requirements.txt   # mcp SDK + camoufox + playwright
├── browser_agent/
│   ├── server.py        # MCP server 入口：注册工具、起 BrowserManager
│   ├── manager.py       # 浏览器/context/profile 生命周期 + 互斥 + 登录
│   ├── primitives.py    # 低层原语实现
│   ├── humanize.py      # 人类节奏：延迟分布、贝塞尔鼠标、打字、限速
│   ├── snapshot.py      # 页面 → 精简可访问性树（控 token）
│   └── guardrails.py    # 写操作 compose/confirm
├── profiles/            # 持久 user_data_dir（每账号一个，gitignored）
├── debug/               # 失败截图（gitignored）
└── tests/
```

## 明确不做（YAGNI）

- ❌ Patchright/Chromium 引擎（可插拔留口）
- ❌ 代理池（用自有住宅 IP）
- ❌ 多账号并发（串行）
- ❌ auto-confirm 无人值守发帖（先人在环；定时以后用 meshbot 现有 `schedule` 工具加，引擎不改）
- ❌ 平台硬编码 recipe（本就 LLM 驱动）
- ❌ headless/xvfb 调优（headed 默认，部 VPS 再说）
- ❌ 打码服务（被挡 = 停 + 告诉用户）

## 开口项 / 约束

- 运行环境需 Python 3 + 能装 camoufox（首次会下载 Firefox 强化构建）。`begin_login` 需要有头显示环境。
- `mcp.json` 需加 `browser` 条目，stdio 命令指向 `tools/browser-agent` 的 venv python；首次可由安装步骤写入或文档引导。
- 反检测是长期军备竞赛：测试页"全绿"是入门线，真实平台（X/小红书）的风控会演进，靠结构化日志观察 block 率趋势、随时调 `humanize`/限速。
- 合规：仅操作用户自有账号；写操作人在环确认；遵守各平台 ToS/速率限制。
