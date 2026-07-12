# 登录 / 注册 / 设备授权全流程重设计 设计 spec

> 分支 `feat/langchain-1x` 连续提交。可视化方案已与用户在 brainstorm
> companion 中逐屏确认（流程走向 / 视觉方向 / 五步向导均已选定）。

## 0. 需求（用户原话）

1. 更精致的 UI，覆盖所有登录 / 注册 / 授权流程页面；
2. 每个页面合理出方案再优化；
3. 修 bug：授权成功后先显示「已授权 + 授权码」又跳到「授权成功请关闭此页」，状态混乱；
4. 云端已登录态的授权逻辑是对的（授权 → 跳转 → 客户端登录成功）；但登录 / 注册
   路径完成账号、组织、模型配置后**没有续接设备授权**，需要合理设计；
5. 全局：大视图加载一律骨架屏，小请求（按钮）用内联 spinner——沉淀为规则或技能。

## 1. 现状勘查结论

| 项 | 现状 |
|---|---|
| 授权协议 | OAuth device flow 变体：桌面端 `startAuthorize` → 浏览器 `/authorize?request=<id>` → 批准得 `userCode` → **loopback 跳 `127.0.0.1` 换 token**（同机证明，防远程钓鱼，必须保留）→ 桌面端 2s 轮询到 done。手动输码是 loopback 兜底 |
| 混乱点（需求 3） | `authorize/page.tsx` 批准成功后**无条件**渲染授权码卡片，同时 effect 跳 loopback → server-agent 返回**裸文本 HTML**（`auth.controller.ts:46`）。授权码本应只是兜底却总闪现 |
| 断链点（需求 4） | 桌面端登录页「去注册」是裸 `/register`（无 `next`）→ 注册完 `next ?? "/assistant"` 进云端主界面，授权死，桌面端空轮询 10 分钟。而 authorize→login→register 的 `next` 透传是通的 |
| 组织引导 | `OrgOnboarding`（建组织 / 粘贴邀请码）已内嵌 `/authorize` 页，auth 卡片风格 |
| 模型配置 | 完全在登录后 settings 完整界面；桌面端 `ModelSetupGate` 提示跳转 |
| TTL | `REQUEST_TTL_MS = 10 分钟`（`libs/main/src/services/device-auth.service.ts:9`），注册+验码+建组织可能超时 |
| 加载态 | authorize 页用大 spinner；无 Skeleton 组件、无规范 |

## 2. 流程设计（已确认）

### 2.1 注册走授权链 + 五步向导（方案 B）

```
桌面端「注册并授权本机」→ startAuthorize 拿 request → 打开
  /register?next=/authorize?request=<id> → 桌面端进入轮询等待态

浏览器五步向导（全程 auth 卡片风格 + 顶部步骤指示 + 授权链提示条）：
  ① 创建账号 → ② 邮箱验证 → ③ 组织（建组织 / 粘贴邀请码）
  → ④ 模型配置 → ⑤ 设备授权确认
```

- **步骤 ④ 的分支**：建组织（owner）→ 显示模型步；**粘贴邀请码加入组织
  （受邀成员，无模型写权限）→ 自动跳过模型步**直接到设备授权。
- 模型步是**简化版表单**：厂商预设 chip（DeepSeek / OpenAI / Ollama / 自定义）
  + 模型名 + API Key；contextWindow 用 `MODEL_SPECS` 自动解析并展示
  「已按模型自动识别 · 可改」；复用共享 Zod schema 与
  `OrgModelConfigService`（REST 同现有 settings 表单），仅 UI 是向导布局。
  支持「跳过，稍后配置」→ 回落 2.3 的引导路径。
- 登录路径不变：`/authorize` 未登录 → `/login?next=…`，login/register 间
  `next` 透传保持。
- **TTL 10 → 30 分钟**；桌面端 `WAIT_TIMEOUT_MS` 同步 30 分钟。授权页
  expired 错误卡加「回到桌面端重新发起」明确引导。

### 2.2 批准收尾静默化（修需求 3）

- 批准成功：**不渲染授权码**，显示「正在完成授权…」spinner → 立即跳 loopback。
- server-agent 回调页：裸文本换**品牌化内联 HTML**（无外部资源）：logo、
  绿对勾圆环扩散动画、「授权成功，本页可关闭」、自动尝试 `window.close()`；
  失败态红叉 +「回桌面端重试」。
- loopback 失败用户退回 web-main：现有 sessionStorage 恢复机制这时才展示
  授权码兜底卡（黄提示条「自动完成失败」+ 授权码块 + 粘贴引导）。
- 云端已登录态主路径逻辑不动，仅视觉升级。

### 2.3 模型缺失的授权后引导（方案 A 回落）

授权成功页（web-main 侧兜底恢复态）与 server-agent 回调页不承载引导；
桌面端登录成功后由现有 `ModelSetupGate` 检测无模型 → 引导跳云端配置。
（向导跳过模型步的用户走这条回落，不新增页面。）

## 3. 页面清单与视觉语言（已确认 mockup）

统一视觉：暖米底 + 品牌橙不变；背景加两团 3-4% 橙色径向光晕；卡片白底
`rounded-2xl` + 极淡边框 + 双层阴影（近锐远柔）；logo 独立卡片外居中；
状态切换 150ms 淡入上移；主按钮 pending 时文字左侧内嵌 spinner。

| 页面 | 方案 |
|---|---|
| 桌面端登录页 | 三步流程示意（点击授权→浏览器确认→自动登录）；等待态脉冲浏览器图标；「去注册」→「注册并授权本机」（带授权上下文） |
| web-main 登录页 | 输入框聚焦橙描边等精修；带 `next=/authorize` 时顶部浅橙提示条「完成登录后将继续设备授权」 |
| web-main 注册页 | 五步指示器（当前步高亮，受邀分支动态四步）+ 授权链提示条 + 表单精修 |
| 组织步 | OrgOnboarding 现有双入口（建组织/邀请码）套新视觉 |
| 模型步（新） | 厂商预设 chip + 简化表单 + 自动上下文识别 + 跳过链接 |
| 授权确认页 | 设备信息结构化小卡（💻 图标 + 设备名 / 平台 / 组织三行）替代长文案；批准 pending 全卡 spinner |
| 已拒绝页 | 灰叉 + 「可关闭本页」弱化处理 |
| 授权码兜底卡 | 仅 loopback 失败恢复时出现：黄提示条 + 码块 + 粘贴引导 |
| server-agent 回调页 | 品牌化内联 HTML 成功 / 失败双态（见 2.2） |

## 4. 加载规范（技能 + 组件）

- `packages/design` 新增 `Skeleton` 基础组件（块 / 文本行 / 圆形变体，
  `animate-pulse`，主题 muted 变量取色）。
- 新增项目技能 `.claude/skills/loading-states`，规则：
  1. 整页 / 大区块首载 → 骨架屏（形状贴近真实内容，禁全屏大 spinner）；
  2. 按钮 / 小操作请求 → 按钮内联 spinner + disabled，不弹遮罩；
  3. 已有数据的刷新 → 静默后台更新，不闪骨架。
- 本工程内 authorize 页首载态改卡片骨架屏做示范；存量页面迁移不在本次范围。

## 5. V1 边界

- 不改设备授权安全模型（loopback 同机证明、userCode 兜底、手动输码保留）。
- 不做邮箱找回密码 / SSO / 多组织切换向导。
- 存量登录后页面的骨架屏迁移不在本次范围（规范先立，逐步迁移）。
- web-main 已登录用户直接访问 /register 的行为维持现状。

## 6. 测试与验收

- 单测：TTL 变更；批准成功后不渲染授权码（组件测试视现有覆盖形态）；
  受邀成员分支跳过模型步的向导状态机；server-agent 回调 HTML 含品牌节点。
- 眼验四条路径：已登录直接授权 / 未登录→登录→授权 / 全新注册五步→授权 /
  loopback 失败→退回→授权码兜底→手动输码。
- 眼验设计细节：光晕背景、卡片阴影层次、步骤指示、状态切换动效、
  回调页对勾动画、骨架屏示范。
