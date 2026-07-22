# MeshBot 官网落地页设计

日期：2026-07-22
范围：`apps/web-main` 的 `/` 路由改造为公开落地页
定稿视觉：[assets/2026-07-22-landing-page-mockup.html](assets/2026-07-22-landing-page-mockup.html)（已批准，实现以此为准）

> 本文替换同名早期版本。早期版本把产品定位为「本地 Agent 工具」、结构为三段精简页、
> hero 论点为「本地跑但能远程指挥」，经能力核实与需求澄清后**整体作废**。

## 一、定位

| 维度 | 决定 |
|------|------|
| 产品定位 | **人与 Agent 的协同工作空间**（不是本地 Agent 工具） |
| 目标受众 | 开发者 / AI 尝鲜者 |
| Hero 论点 | **同一个工作空间**——团队在这里协作，Agent 带着各自的人格技能记忆一起工作 |
| 主 CTA | 双 CTA：**免费开始**（主）+ **下载桌面端**（次） |
| 上线时点 | 注册路径不依赖 Release，**页面可先上线**；下载按钮在无 Release 时降级（见 §5） |

「本地跑，但能远程指挥」降级为第 06 段的**单个能力**，不再是全页论点。

## 二、内容真实性约束（硬性）

落地页只展示**已实现且可用**的能力。以下结论来自对代码的逐项核实，是所有文案的事实基线：

**可以展示**：36 个内建工具 · MCP（stdio + http/sse，字段名兼容 Claude Desktop/Code）· 技能系统与市场 · 一设备多 Agent（技能/MCP/记忆/工作区/人格五项路径级隔离）· HITL 确认与提问卡 · 子 Agent 并行委派 · 人↔人 IM 全链路（频道/私聊/未读/已读多端同步/成员管理）· 用户与设备双层 Presence · 组织与邀请 · PKCE 设备授权 · 云端模型网关（厂商 key 不下发端侧）· 跨设备远程 run 与实时镜像 · 远程 HITL · 公开分享链接（密码/过期/撤销）

**禁止出现在页面上**：

1. **工作流 / flows** —— 前后端零实现，无 Entity 无 Service 无迁移，不在导航栏。任何措辞都构成虚假宣传。
2. **「Agent 与 Agent 协作」** —— `dispatch_subagent` 的子 Agent 继承父 `agentId`，是同一 Agent 身份的上下文分身，非多人格协作。
3. **「群组」** —— 无 `group` 会话类型，多人协作即 private channel，页面统一称「频道」。
4. **「Agent 是频道成员」** —— `ConversationMember.userId` 仅接受 `app_user` id，Agent 无法入会话。准确表述为「Agent 读得到频道内容，也能替你起草回复」。
5. **「语义记忆」** —— 记忆检索为大小写不敏感子串匹配，无向量无 embedding。
6. **「安全可控」类笼统主张** —— `bash` / `write_file` / `edit_file` 无任何确认门或 allowlist，仅 4 个工具走 HITL。
7. **Homebrew 等包管理器安装入口** —— 不存在。
8. **网盘的人类操作界面** —— `/drive` 为占位页。网盘只能按「Agent 管理云端文件 + 公开分享链接」的口径写（第 08 段）。

**数据边界的准确表述**（第 07 段，三档缺一不可）：

| 档 | 内容 |
|---|---|
| 留在本机 | 会话历史与全部消息 · Agent 记忆 · 工具执行记录 · 工作区文件（云端无对应表，不持久化） |
| **过境但不留存** | 用云端模型网关时的对话内容 · 跨设备运行时的执行帧（内存路由中转，进程重启即消失） |
| 存在云端 | 账号/组织/成员 · 团队消息 · 网盘文件 · Agent 名称与头像（厂商密钥加密存储，不下发设备） |

中间那档**必须保留**。省略它会使「数据不出本地」成为可被十分钟证伪的虚假主张——对开发者受众尤其致命。

## 三、页面结构（9 段 + Footer）

| # | 区块 | 展示形式 | 图形语言 |
|---|------|---------|---------|
| 01 | HERO 同一个工作空间 | 三栏工作空间全景动效 + 双 CTA | 点阵网格 + 左上光晕 |
| 02 | 每个 Agent 都是独立的个体 | 放射 mesh 图（中心 Agent + 五属性节点） | 右下光晕 + 流动虚线 |
| 03 | 会拆解、会反问、发出去前先问你 | 完整 Agent 对话演示 | 横向扫描线 |
| 04 | 频道、私聊，和看得见的在场 | 三栏 IM 界面 | 无底纹（留白透气） |
| 05 | 你的 MCP 配置直接搬过来 | 左文右代码块 | 点阵 + 顶部橙光横扫 |
| 06 | 换个地方，接着看它干活 | 手机 + 实时镜像 + 链路脉冲 | 左上光晕 + 同心波纹 |
| 07 | 你的数据在哪 | 三档分区 | 底纹密度递减（实心→斜纹→点阵） |
| 08 | 分享一份文件，条件由你定 | 居中悬浮分享卡 | 点阵 |
| 09 | 四步就位，大约五分钟 | 四步编号栅格 + 收尾双 CTA | 右下光晕 |
| — | Footer | 四栏导航 | — |

**不设独立开源区块**。GitHub 入口收在导航栏与 Footer 开发者栏。

**每段图形语言必须不同**——这是「有设计感」与「模板感」的分界。全页统一使用「边框+面板」矩形是上一版被否决的直接原因。

## 四、视觉规范

**双主题**，导航栏切换按钮，首次进入跟随 `prefers-color-scheme`，手动切换后以 `data-theme` 覆盖。

| token | 深色 | 浅色 |
|-------|------|------|
| 页底 | `oklch(0.135 0.008 55)` | `#f2ece3` |
| 面板 | `oklch(0.175 0.009 55)` | `#faf7f2` |
| 卡片 | `oklch(0.205 0.011 55)` | `#ffffff` |
| 分隔线 / 边框 | `oklch(0.245 / 0.29 …55)` | `#e6ded4` / `#d5c9b9` |
| 主文字 / 次 / 弱 | `oklch(0.96 / 0.70 / 0.55 …55)` | `#241c15` / `#6b5d4f` / `#9a8b7b` |
| 品牌橙 | `#d24a0d` | `#c04409`（压深保对比度） |

排版特征：主标题 `clamp(46px,7.2vw,92px)` / `font-weight:800` / `letter-spacing:-.052em`；等宽小标签 10px / `letter-spacing:.19em` / 大写 / 橙色；直角按钮 `border-radius:2px`；左侧留白处等宽段号（技术图纸感）。

landing 专属排版 token 就近置于 landing 目录并 scoped，**禁止写入 `packages/design`**。

## 五、技术实现

**渲染**：`apps/web-main/src/app/page.tsx` 由 `"use client"` 重定向闸门改为 **Server Component 静态页**。web-main 无 middleware，`/` 天然公开。

**删除的行为**：原「已登录→`/assistant`，未登录→`/login`」重定向整体移除，所有人访问 `/` 均见落地页。

**登录态 CTA**：token 存于 localStorage（`apps/web-main/src/lib/auth-storage.ts`），服务端无法获知登录态。hero 与收尾的双 CTA 对所有人恒定；仅导航栏右侧入口切换，做成独立 client component，初始渲染固定宽度骨架，`useProfile` 到达后显示「登录」或「进入应用」。选骨架而非默认「登录」：向已登录用户显示「登录」是错误信息。

**动画**：纯 CSS，只动 `transform` / `opacity`。**不引入 framer-motion**。用 `IntersectionObserver` 使动画仅在进入视口时播放。

**降级**：`prefers-reduced-motion: reduce` 下所有入场、脉冲、波纹、流动虚线、光扫全部停用，内容静态直出、信息零丢失。

**i18n**：按 `i18n-page` 规范全部走 next-intl，新增 `landing` namespace，**zh 与 en 均按正式文案撰写**。完成后执行 `pnpm sync:locales --write`。

**下载 CTA**：指向 GitHub Releases latest，按 `navigator.userAgent` 推荐平台产物。**无 Release 时降级为「查看源码」指向仓库**，不产生 404——这使页面可先于 Release 上线。

## 六、验收标准

风险分档：**低–中**（纯前端展示，无并发、无跨设备协议、无状态机）。不需要独立 reviewer。

- [ ] `web-design-guidelines` 技能审查通过（a11y / 焦点 / 语义 / 性能）
- [ ] Playwright 多断点截图：375 / 768 / 1440，**深浅两主题各一轮**
- [ ] 主题切换：跟随系统 + 手动覆盖 + 切换无闪烁
- [ ] `prefers-reduced-motion: reduce` 下信息完整、无动画
- [ ] 键盘可达：所有 CTA 与主题切换按钮可 Tab 聚焦，焦点态清晰
- [ ] 未登录 / 已登录两态导航栏 CTA 正确，无布局跳动
- [ ] 页面正文不含 §2 所列任何禁止项
- [ ] `pnpm sync:locales -- --check` 通过；`pnpm lint` / `typecheck` / `build` 通过

## 七、范围外的前置依赖

不属本 spec，但影响上线：

1. **首个 GitHub Release**（electron-builder 三平台产物、macOS 签名公证、CI 发布流程）——下载 CTA 的完整体验依赖它，但页面不被它阻塞
2. **仓库缺 LICENSE**——Footer 有「许可证」入口，上线前必须补齐
3. **README 第 44 行笔误**——写作「Next.js 15」，实际 `^16.2.4`

## 八、核实中发现的产品缺陷（与落地页无关，另行处理）

1. **模型 provider 前后端不一致**：前端 `PROVIDERS` 提供 6 项（openai / anthropic / google / deepseek / ollama / openai-compatible），本地轨运行时白名单仅 2 项（openai / openai-compatible），其余**保存成功、运行抛错**。ollama 默认 baseUrl 已预填 `http://localhost:11434`，极易踩中；正确接法是选 `openai-compatible` 填 `http://localhost:11434/v1`。
2. **`ImSendSchema` / `ImReadSchema` 无消费点**：WS 上行消息的长度与非空校验实际未生效。
3. **IM 断线无补偿**：重连不重拉会话与消息，断线期间消息需手动切会话才补回。

## 九、明确不做

- 真·可玩 demo（需演示后端、限流、沙箱）
- 独立开源宣讲区块
- 亮色/暗色之外的第三主题
- 产品截图墙（UI 仍在迭代，截图易作废；改用真实组件重绘的演示）
