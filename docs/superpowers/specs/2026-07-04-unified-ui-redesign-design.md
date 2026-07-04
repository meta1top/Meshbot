# 统一原创 UI 重构 设计 spec

> 状态:设计已定,待写实施 plan。本文是"总设计",实施按 §12 分期,每期各自出 plan。
> 关联:子项目 A(设备授权登录)、B(设备 Agent 反向通道)已落地;本重构是 A/B/C/D 共同的 UI 地基。
> brainstorm 可视化产物:`.superpowers/brainstorm/5396-*/content/*.html`(登录后三区、助手区、消息区、右侧随手问、登录前设备授权、设计语言板)。

## 1. 背景与目标

meshbot 现有两个前端:`web-agent`(桌面端)与 `web-main`(云协同端)。两者的问题:

1. **UI 各写各的**:IM 消息渲染(行式 vs 气泡)、会话主体、登录壳、AuthGuard、Providers、IntlProvider、confirm-dialog 都 fork 了两份;web-main 几乎没有桌面壳(无 rail / dock / 产物预览)。
2. **web-agent 观感抄 Slack**:68px rail + 频道/私信侧栏,缺自主设计个性。
3. **`--shell-accent` 在 web-main 悬空**(变量未定义 → 品牌橙渲染为无色),是现存缺陷。

**本重构目标**:设计一套**原创、Agent 原生、对话为中心**的 UI,让 `web-agent` 与 `web-main` **共用同一套展示层(壳 + 组件 + 视觉 token)**,数据/传输层各自注入。含**登录前**与**登录后**两套布局。

**成功标准**:
- 两端登录后是同一套三区壳(左中右),`web-agent` 仅额外标注"本机"设备。
- 视觉语言成体系(color / type / spacing / radius / component token),暗色配套,"暖炭·配橙",不像 Slack。
- 现有能力零丢失:产物预览(present_file)、随手问(AssistantDock)、ask_question 卡、im_send 确认卡、session 时间线(工具调用/子代理/todo)、per-session usage —— 全部平移进新壳。

## 2. 范围与非目标

**范围**:信息架构、左中右三区壳、左侧两级导航、右侧"上下文面板 + 全局随手问"、登录前(设备授权 / 云端轻登录)、视觉语言 token、两端展示层共享化、现存重复组件收敛。

**非目标(YAGNI)**:
- 不改后端 / 数据契约 / ws 传输(纯前端展示层重构 + token)。
- 不实现子项目 C(Agent 进频道的后端)/ D(流程平台)——只在 IA 里为它们**留位**(一级菜单"流程"、频道内 `AGENT` 成员标)。
- 不引入 framer-motion、状态机库等新范式;沿用现有 jotai(agent)/ react-query(两端)。
- 不做移动端专门布局(响应式收窄即可,沿用现有抽屉式)。

## 3. 信息架构(IA)—— 已定

### 3.1 一级菜单(左侧 rail,竖排)
顺序固定:**助手 · 消息 · 技能 · 网盘 · 流程 · 设置**,底部用户头像。

- **助手**(新拆出):**所有设备的 Agent 会话**。二级按设备分组,本机带绿标"本机",每设备可开多个会话,活动会话橙点 + "▶ 流式"。这是"我指挥我的设备舰队"。
- **消息**(新拆出):**人际 IM**。二级三组:私聊 / 群 / 频道。Agent 可被 @ 拉进频道/群当参与者(带 `AGENT` 标),但其主场多会话仍在"助手"区——两区不重复、只在此交汇。
- **技能 / 网盘 / 流程 / 设置**:沿用/留位。技能=技能市场+已装;网盘=企业网盘;流程=子项目 D 留位(暂空态);设置=组织/设备/模型。

> **关键变化**:现状 `web-agent` 把"频道/私信/助手"揉进**同一个** `MessagesSidebar` 三段,rail 是"消息/技能/网盘/更多"。新 IA 把**助手**与**消息**提升为两个**并列一级项**,各自有独立二级。

### 3.2 IA 分叉(已拍板)
"私聊我自己某台设备的 Agent"(子项目 B 已做的能力)→ **归"助手"区**(它本就是"我的设备 Agent 的会话");"消息 › 私聊"**只放人**。边界最干净。

## 4. 登录后布局 —— 左中右三区(已定)

```
┌──────┬──────────────┬───────────────────────┬─────────────────┐
│ ①rail │ ②二级菜单     │  中 · 对话主画布         │ 右 · 上下文+随手问 │
│ 64px │  ~200px      │  flex:1                │ ~212–246px      │
│      │              │                        │                 │
│ 助手  │ (随一级变)    │  会话头(标题栏)          │ [ctx tabs] ✦随手问│
│ 消息  │ 助手:设备分组 │  消息流(气泡/流式/工具卡) │ 上下文面板 或    │
│ 技能  │ 消息:私/群/频 │                        │ 随手问副驾       │
│ 网盘  │              │  输入框                 │                 │
│ 流程  │              │                        │                 │
│ 设置  │              │                        │                 │
│ 头像  │              │                        │                 │
└──────┴──────────────┴───────────────────────┴─────────────────┘
```

### 4.1 统一 header 带(对齐修正)
左②级标题、中对话标题、右 tab 三者共用**同一条 52px 高的 header 带 + 同一条底边线**;rail 顶端补同高品牌带,整条顶边拉平。解决现状顶部参差。

### 4.2 中 · 对话主画布
- **助手会话**:复用现有 session 时间线(`message-list` / `tool-call-block` / `subagent-card` / `todo-list` / `ask-question-card` / `im-send-confirm-card`),我方橙气泡靠右,Agent 输出流式(闪烁光标)+ 工具调用 chip。头部带"本机 Mac"设备标 + 流式状态。
- **消息会话**:人对人 IM。我方橙气泡靠右,他人带头像+名+时间靠左;频道内 Agent 消息带 `AGENT` 标。**统一为气泡式**(收敛现状 web-agent 行式 / web-main 气泡两套)。

### 4.3 右 · 双层:上下文面板 + 常驻随手问
右侧 tab 条:**左边灰色上下文 tab(随页面变)** + **右端钉住的橙色「✦ 随手问」(每页都在)**。

- **上下文 tab** 随一级页变:助手→产物/工具;频道→成员/文件/置顶;网盘→详情/版本…
- **✦ 随手问**(全局副驾,复用现有 `AssistantDock`):任何页面点开即问,**自动带入当前页面上下文**(复用已建的 `<llmuse>` 前端状态感知),默认接**本机 Agent**、可切设备。
- **随手问 vs 助手区**:助手区=命名的、长期的、跨设备**任务会话**(专门开一屏干活);随手问=就地的、临时的**一句话追问**(不离开当前页)。一个"进工作台",一个"随手叫一声"。
- 右区可折叠;`web-agent` 已有 `assistantPanelOpenAtom` + 顶栏 ✦ 开关 + 面板 resize,直接沿用。

## 5. 登录前布局 —— 已定

### 5.1 web-agent(本地桌面)—— 纯设备授权,无表单
方案:对话式起手,登录前**没有任何邮箱/密码表单**,只有一个按钮。

- **初始态**:品牌 + "开始和你的 Agent 协作" + 主按钮「⌘ 用浏览器授权本机」。
- **授权中态**:"已在浏览器打开授权页" + **配对码**(如 `WX7–K29`,防钓鱼,与 gh / VS Code 设备登录同款)+ 等待 spinner + "重新打开授权页"。
- 复用子项目 A 已建链路:`startAuthorize` / `pollAuthorize` / `completeAuthorize`(`web-agent/src/rest/auth.ts`);确认端仍是 `web-main/src/app/authorize/page.tsx`。
- 现状 `auth-shell-layout.tsx`(左品牌渐变块 + 右内容)重构为此对话式单列。

### 5.2 web-main(云端网页)—— 轻登录(选项 1)
云端网页保留**邮箱 + 验证码**轻登录(复用子项目 A 已建的 login/register/verify),**套同样的对话式视觉语言**(同品牌、同字体、同配色)。理由:"授权本机"在纯网页里没有"本机 Agent"可授权,云端需要一个第一因子。web-main 的设备授权确认页(`authorize/page.tsx`)保留、重新套皮。

## 6. 视觉语言(设计 token)—— 已定

### 6.1 配色 token(暖炭·配橙)
| token | 值 | 用途 |
|---|---|---|
| 炭黑 `--charcoal` | `#241c15` | 品牌 / rail / 主文字(现 `--primary`)|
| 深炭 `--charcoal-2` | `#342a20` | rail hover / 二级深 |
| **焦橙 `--accent`** | **`#d24a0d`** | 强调 / 主按钮 / 我方 / 流式 |
| 暖米 `--surface-0` | `#faf7f2` | 页面底 |
| 米二 `--surface-1` | `#f6f1ea` | 二级面板 |
| 纯白 `--surface-2` | `#ffffff` | 卡片 / 中区 |
| 暖边 `--border` | `#e6ded4` | 分割线 / 描边 |
| 在线绿 `--online` | `#16a34a` | 在线 / 本机 / 成功 |

**克制铁律**:橙只出现在"强调 / 我方 / 流式"三处,不铺满;绿只表在线 / 本机。

> **收敛现有 token**:design 包现有 `--secondary:#f97316`(亮橙)与 web-agent 局部 `--shell-accent:#d24a0d`(焦橙)**两个橙并存且不一致**。统一为 **`--accent:#d24a0d`**,提升进 design 共享 token,**同时修复 web-main `--shell-accent` 悬空缺陷**。`--shell-*` 系列从 web-agent 局部提升为共享语义 token(或直接映射到新命名),两端共用。

### 6.2 字号阶(紧凑,4 档基调)
22/800(页面大标题)· 15/800(会话标题)· 13/700(列表项/区块标题)· 12.5/400(正文)· 11/600(次要)· 9.5/700(分组标签)。数字一律 **tabular**(用量/时间/配对码对齐)。

### 6.3 字体(新增依赖)
拉丁走一款**几何人文体 Hanken Grotesk / Manrope**(暖、有辨识度、**自托管**);中文配系统 PingFang SC / 思源黑体。现状两端**均无自定义字体**——本次新增,经 `next/font/local`(woff2 入库)自托管,禁止外链 CDN(离线 / CSP)。

### 6.4 形制
圆角 **10–14px**(贴对话气质,保持);描边 1px 暖色;阴影极浅(`0 1px 2px rgba(0,0,0,.05)`)。整体密度接近 Linear/Notion,但**表面是暖米不是冷灰**——这是"不像 Slack"的关键:同样专业,但有温度。

### 6.5 暗色
沿用现有"暖炭·配橙"暗色(oklch hue ~55,暖炭底 + 提亮橙),**非纯灰**。新增 token 一并给暗色值。

### 6.6 三根"个性杆"(已拍板)
字体=Hanken/Manrope · 圆角=保持 10–14 · 橙=保持克制。

## 7. 组件清单(复用 vs 新建)

### 7.1 直接复用(web-agent 已有,平移进新壳)
`AssistantDock`(随手问)· `ArtifactPreviewPanel` + `artifact-body` + `pdf-view`(产物预览)· `ask-question-card` · `im-send-confirm-card` · session `message-list` / `tool-call-block` / `subagent-card` / `todo-list` / `pending-list` · usage atom(`usageByMessageFamily` / `sessionTotalsFamily`,per-session atomFamily 保持)· `ChatInput`(TipTap)· 产物自动打开 `use-auto-open-artifact`。

### 7.2 重构(改结构/样式,不推倒)
- **rail**:`workspace-rail.tsx` → 新 6 项(助手/消息/技能/网盘/流程/设置)+ 顶部品牌带 + 底部头像。
- **二级菜单**:拆成 `AssistantSidebar`(设备分组)与 `MessagesSidebar`(私聊/群/频道三组);现状单一三段 `MessagesSidebar` 拆分。
- **右区容器**:上下文 tab + 钉住随手问的 tab 条(现 `dock-tabs` 演进)。
- **header 带**:抽出统一 52px 带组件,三区对齐。
- **登录壳**:`auth-shell-layout` → 对话式设备授权单列。
- **IM 消息**:收敛为单一气泡式 `MessageBubbleList`(替代两端两份行式/气泡)。

### 7.3 新建
- 设计 token 层(§6)+ 字体接入。
- **共享展示壳**(§8):`AppShell` / `RailNav` / `SecondaryList` / `HeaderBand` / `RightZone` 等纯展示组件,数据经 props 注入。
- 流程一级页空态。

### 7.4 收敛重复(两端各一份 → 共享一份)
`IntlProvider`(几乎逐行相同)· `confirm-dialog` · `AuthGuard` 模式 · `user-menu` · IM 消息渲染。design 包 `apple/` 与 `ui/` 两套原子**收敛为一套**(默认 apple)。

## 8. 两端统一架构 —— 展示层共享 / 数据层注入

**核心原则**:数据/传输层**有意隔离且保持**(web-agent = `@meshbot/web-common` apiClient + agent token + `/ws/session` + jotai;web-main = 自建 `mainApi` + JWT + `/ws/im` + react-query)。**只共享纯展示组件**,数据经 props / adapter 注入。

**落地**:把壳与展示组件下沉到共享层(`@meshbot/design` 现有原子之上,新增一组 `shell/` 展示组件,或新包 `packages/web-shell`——plan 阶段定)。这些组件:
- 只吃数据(会话列表 / 消息 / presence)+ 回调(onSend / onSelect),**不 import 任何 app 的 api / socket / atom**。
- 两个 app 各写薄"数据适配 + 组装"层,把自己的 hooks 喂给同一套展示组件。

**web-agent vs web-main 差异**(同壳、少量分支):
| 维度 | web-agent | web-main |
|---|---|---|
| 登录前 | 设备授权(无表单)| 邮箱验证码轻登录 |
| "本机"标 | 有(本机设备绿标)| 无 |
| Electron 拖拽区 | 有 | 无 |
| 数据层 | apiClient + jotai + /ws/session | mainApi + react-query + /ws/im |
| 富文本输入 | TipTap | 可先用 textarea,渐进升级 |
| 助手区 | 全设备(本机 + 远端)| 全设备(纯远端)|

## 9. 数据流与错误处理

- 纯前端重构,数据流沿用现状:web-agent 经 jotai atom(`sessions` / `im` / `assistant-panel` / `session-usage`)+ jotai-tanstack-query 桥接;web-main 经 react-query hooks。
- 展示组件无副作用,加载/空/错态由注入的 status 驱动(沿用现有 skeleton / empty-state 组件)。
- 随手问上下文注入沿用 `<llmuse>` 机制(agent-ui-context-awareness),不新增契约。
- token 迁移风险:`--shell-accent` 悬空修复后需回归 web-main IM 橙色渲染。

## 10. 测试

- 组件层:关键展示组件(rail / secondary list / message bubble / header band / right zone)加 RTL 渲染 + 交互单测(选中态、tab 切换、折叠)。
- 视觉回归:token 迁移前后,对 web-agent 现有页面做人工冒烟(产物预览、随手问、session 流式、工具卡不回归)。
- 两端一致性:同一展示组件在两 app 的 storybook 式样例页(或各自 dev 路由)对照。
- i18n:新增文案走 `sync:locales --write` 补 stub(扁平 stub 工作流)。
- boot 验证:web-agent(Electron 壳)+ web-main 真启动,壳不崩、路由通。

## 11. 现有资产复用小结(降风险关键)
本重构**不是从零**:web-agent 已有 rail / 二级侧栏 / 顶栏(含 ✦随手问 开关)/ 随手问 dock / 产物预览 / session 时间线 / per-session usage / TipTap 输入 / 设备授权发起链路 / `<llmuse>` 上下文。工作量集中在:①视觉 token 换新 + 字体;②IA 重排(助手/消息拆分);③把这套壳**共享化并让 web-main 用上**;④收敛重复组件与双套原子。

## 12. 实施分期(每期各自出 plan,独立可交付)

1. **P1 视觉地基**:token 收敛(`--accent` 统一 / 修 `--shell-accent` 悬空 / `--shell-*` 提升共享)+ Hanken/Manrope 自托管接入 + design 原子 apple/ui 收敛。产出:两端换新皮不改结构。
2. **P2 web-agent IA 重排 + 三区壳精修**:rail 6 项、助手/消息二级拆分、统一 header 带、右区双层(上下文 tab + 钉住随手问)。产出:web-agent 落地新 IA/布局,现有能力零回归。
3. **P3 展示层共享化**:抽壳与展示组件到共享层,web-agent 改为消费。产出:共享壳 + web-agent 无回归。
4. **P4 web-main 采用共享壳**:给 web-main 装上 rail/dock/三区,统一 IM 为气泡式,收敛 IntlProvider/confirm-dialog/AuthGuard 重复。产出:两端同壳。
5. **P5 登录前重构**:web-agent 对话式设备授权、web-main 轻登录套新皮。

> 首个 plan 目标 **P1 + P2**(视觉地基 + web-agent 新 IA/布局),独立可交付、风险最低、即时可见。P3–P5 后续各自 plan。

## 13. 已定决策清单
- 方向:Agent 原生、对话为中心 ✅
- 布局:左中右三区 + 左两级 + 统一 52px header 带 ✅
- IA:助手/消息拆分为两个一级项;一级序 助手·消息·技能·网盘·流程·设置 ✅
- 私聊自己设备 Agent → 归"助手"区 ✅
- 右区 = 上下文面板 + 常驻全局随手问 ✅
- 登录前:web-agent 纯设备授权(配对码)、web-main 邮箱验证码轻登录 ✅
- 视觉:暖炭#241c15 + 焦橙#d24a0d,克制用橙;字体 Hanken/Manrope 自托管;圆角 10–14;暗色暖炭 ✅
- 架构:展示层共享、数据层各自注入 ✅

## 14. 风险与开放项(实施期确认,不阻塞设计)
- **共享壳落点**:放 `@meshbot/design/shell` 还是新包 `packages/web-shell`——P3 plan 定(倾向新包,避免 design 原子包变重 + 引入 app 级依赖)。
- **web-main 富文本**:先 textarea 还是直接上 TipTap(引入 jotai?)——倾向先 textarea,P4 评估。
- **字体子集**:Hanken/Manrope 仅拉丁,中文系统体;需确认 woff2 体积与首屏(P1 subset)。
- **token 大改回归面**:`--shell-*` 提升会触达 web-agent 所有页面,P1 需全页冒烟。
- design `apple/` 与 `ui/` 收敛可能影响两端所有表单——P1 谨慎,保留别名过渡。
