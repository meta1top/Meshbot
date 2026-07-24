# 产品 UI 与落地页视觉统一设计

日期：2026-07-25
范围：`packages/design` token 层 + 门面页（登录/注册/授权/onboarding，web-main 与 web-agent 双端）
参照基准：落地页视觉语言（`apps/web-main/src/components/landing/landing.css`，已验收，本设计不改动它）

## 一、背景与问题

落地页（2026-07-22 上线）确立了一套用户认可的视觉语言：暖米纸底/暖炭双主题、品牌橙 `#d24a0d`、**近直角硬边**（按钮 2px / 卡片 6px）、等宽眉标签、点阵/光晕/扫描线图形语言、技术图纸质感。

产品 UI（登录注册、web-main 内页、web-agent 客户端）配色与落地页同族（共享 `--brand`、暖米侧栏、暖炭暗色），但**质感层完全不同**：shadcn 默认 `--radius: 0.5rem` 圆润档、登录卡 `rounded-2xl`（≈14px）、无等宽点缀、无图形语言。从落地页点进登录页有明显跳变。

## 二、已确认的决策

| 决策点 | 结论 |
|--------|------|
| 渗透深度 | **质感对齐**：全局统一圆角/排版/按钮等基础质感；图形语言（点阵/光晕）只进低密度页面（门面页、空态、onboarding、设置页头部），高密度工作区（会话流、IM 列表）保持克制 |
| 主按钮色 | **深炭主 + 橙色关键动作**：日常操作保持深炭 `--primary: #241c15`；关键转化动作（登录/注册提交、发送、新建 Agent 等）用品牌橙。橙色保持稀缺性 |
| 圆角档 | **照搬落地页**（浏览器真实渲染三档对比后选定）：按钮/输入框 2px、卡片 6px、列表行 4px、头像等 `rounded-full` 不动。**后续澄清**：对照落地页 `landing.css` 发现该基准里扁平带边框大面板全是 0px 纯直角，只有悬浮/带投影元素才用小圆角——据此拍板改为三层规则：扁平带边框容器 0px（对齐落地页面板规则）/ 悬浮层（Dialog/Popover/DropdownMenu/Select/Sheet 等 portal 浮层 + 登录卡）6px / 控件（按钮/输入框/小标签）2px；`--radius-lg` 的「4px」档仅短暂存在即被归零 |
| 实现路径 | **design token 收敛**：质感下沉为 `packages/design` 共享 token 与工具类，两端自动继承；落地页 `--lp-*` 保持独立不动 |
| 节奏 | 只规划到第一个可验证交付点（token 层 + 门面页），用户真机验收后再规划第二段 |

## 三、Token 层（packages/design）

### 圆角档位表

`packages/design/src/styles/globals.css` 的 `@theme inline` 中，圆角由乘法派生（`--radius-md: calc(var(--radius) * 0.8)` 等）改为**显式硬边档位**：

| token | 现值（基于 0.5rem） | 新值 | 主要消费者 |
|-------|------|------|-----------|
| `--radius-sm` | 4.8px | **2px** | 小标签、代码块 |
| `--radius-md` | 6.4px | **2px** | 按钮、输入框、下拉（shadcn 默认档） |
| `--radius-lg` | 8px | **0px** | 扁平容器/列表行（全站直角，对齐落地页面板规则；`rounded-lg` 归零，会话流工具卡等条目组件均随之直角化） |
| `--radius-xl` | 11.2px | **6px** | 悬浮层：Dialog/AlertDialog/Popover/DropdownMenu/Select 下拉面板/Sheet/ContextMenu/HoverCard/Command 等 Radix portal 浮层 |
| `--radius-2xl` / `3xl` / `4xl` | 14.4/17.6/20.8px | **6px** | 大卡收敛（含登录卡 AuthCard `rounded-2xl`） |
| `--shell-radius` | 8px | **0px** | 壳结构件（rail 图标按钮、侧栏行、settings 分栏面板角）——审计确认消费者全是扁平无投影结构件，无悬浮用法，直接归零 |
| `rounded-full` | 圆 | 不动 | 头像、状态点、开关 |

仓库现有 `rounded-*` 类几乎全走派生档位（md 106 处 / lg 39 处 / 2xl 14 处 / xl 13 处 / full 55 处），**改档位表即一次全局收紧，无需逐文件改类名**。改后全站截图回归，对依赖大圆角的个别组件（开关、进度条类）单独豁免。

### 签名元素工具类

新增到 design 包，前缀 `mb-*`，**opt-in 使用**，不影响存量：

- `mb-eyebrow`——等宽 10px 大写橙色小标签（落地页眉标签同款：`letter-spacing: .19em`，亮色 `#a83b07`——10px 小字 `#c04409` 差一点不到 AA 4.5:1，对齐落地页 `--lp-brand-lt` 的处理 / 暗色 `var(--brand)`）
- `mb-dots`——点阵纹理背景（低密度页面专用）
- `mb-glow`——品牌橙径向柔光
- `mb-hairline-grid`——1px 边框分栏容器

### 按钮策略

- `primary` 深炭不动
- `Button` 组件新增 **`variant="brand"`**：品牌橙底白字，hover `--brand-hover`。暗色下 `#d24a0d` 上白字对比度 ≈ 4.6:1（落地页已校验）
- 适用面：关键转化动作专用，日常提交仍走 `primary`

### 明确不动

配色 token（已同族）· 落地页 `--lp-*` · `rounded-full` 元素 · mobile 脚手架 · 字体（两侧已同用 Hanken + 中文回退）

## 四、第一交付段：门面页

**范围**：token 层全局切换 + 登录/注册/授权/onboarding。`AuthShell` → `PreLoginShellView` / `AuthCard` 在 `packages/web-common`，**web-main 与 web-agent 登录界面同时生效**（含 Electron `auth-shell-mode`）。

1. **AuthCard**：大圆角随 token 自动收敛 6px；现有近锐远柔双层阴影保留（与落地页卡片投影同气质）
2. **卡内排版**：表单标题上方加 `mb-eyebrow` 眉标签（`SIGN IN` / `CREATE ACCOUNT` 等，走 next-intl 新增 key）；标题 `font-weight: 800` + 收紧字距
3. **按钮**：登录/注册**主提交按钮用 `variant="brand"`**——延续用户从落地页橙色 CTA 点入的转化链路；次级动作（切注册、忘记密码）保持深炭/链接样式
4. **背景**：`PreLoginShellView` 现有两团橙色柔光保留，加 `mb-dots` 点阵纹理
5. **onboarding / 授权确认页**同套处理：眉标签 + 关键确认按钮 brand

## 五、后续段落（本 spec 不细化，验收后另行规划）

- 第二段：内页与客户端的签名元素应用——空态、设置页头部、页面标题眉标签、`mb-hairline-grid` 在概览类页面的使用
- 高密度工作区始终保持克制，不加纹理

## 六、验收标准

风险分档：**低–中**（纯前端视觉，无协议/并发/状态机）。不派独立 reviewer；核心不变量（圆角档位表、brand variant 对比度）做变异抽查。

- [ ] Playwright 截图：web-main 登录/注册/授权 + web-agent 登录，375/768/1440 × 深浅双主题
- [ ] token 副作用抽查：两端主工作区（会话页、IM、设置）截图，抓大圆角假设异常
- [ ] `mb-eyebrow` 文案走 next-intl，`pnpm sync:locales -- --check` 通过
- [ ] 暗色 brand 按钮对比度实测 ≥ 4.5:1
- [ ] `pnpm lint` / `typecheck` / `build` 通过
- [ ] **用户真机验收**通过后才进入第二段规划

## 七、明确不做

- 落地页任何改动（它是基准，不是对象）
- 高密度工作区加纹理/图形语言
- 第三主题、配色改版
- mobile（Expo 脚手架，无实质 UI）
