---
name: browser
description: 用真实 Chrome 自动操作社交平台（发帖、看评论），登录态持久。当前支持 X。发帖默认只预览，需用户确认。
---

# browser skill

用系统真 Google Chrome（patchright 驱动，反检测）自动完成需登录的浏览器任务。登录态持久（每平台一个 profile），登录一次复用。**当前仅 X。**

## 前提
- 系统装了 Google Chrome（缺会报错）。
- 首次每平台需人工登录一次。

## 怎么用（`[skill dir]` 是 skill_load 返回的绝对路径）
- 登录（弹窗人工登录一次）：`node [skill dir]/cli.js login --site x`
- 看评论：`node [skill dir]/cli.js comments --site x --url <推文链接> --max 30`
  → 评论写到 `<meshbotDir>/workspace/browser/`，返回条数+路径+样本。
- 发帖（**两步，必须人在环**）：
  1. 预览：`node [skill dir]/cli.js post --site x --text "正文"` → 返回预览文本 + 截图路径，**不发布**。
  2. **把预览呈现给用户，得到明确确认后**才发布：`node [skill dir]/cli.js post --site x --text "正文" --confirm`

## 注意
- **发帖前必须先 dry-run 预览并让用户确认**，不要直接 `--confirm`。
- headed 默认（窗口可见）。无显示环境设 `BROWSER_AGENT_HEADLESS=1`（隐蔽性略降）。
- 被反爬挡时命令以非 0 退出并打印 `BLOCKED:`，不要反复重试硬刚。
- 仅操作用户自有账号，遵守平台 ToS / 速率。
