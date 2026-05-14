---
name: frontend-i18n
description: "前端改动必须同步处理国际化（zh/en） Use when files matching {apps/web-agent/**,apps/web-main/**,packages/design/**,packages/common/**} change, or when explicitly invoked."
---

# Frontend i18n Rule

## 适用范围

- 任何前端代码改动（页面、组件、布局、交互文案）都要检查国际化影响。

## 必须遵守

- 不在前端组件中硬编码用户可见文案，统一通过 i18n key 获取。
- 新增文案时，必须同时更新 `apps/web-agent/messages/zh.json` 与 `apps/web-agent/messages/en.json`。
- 修改文案时，两个语言文件保持 key 一致、结构一致，避免缺失 key。
- 删除文案时，同步清理两个语言文件中的废弃 key。
- PR/提交前，至少自检一次中英文切换后的界面文案是否正常显示。

## 快速检查清单

- [ ] 前端改动是否引入了新文案？
- [ ] 新/改文案是否已接入 i18n key？
- [ ] `zh.json` 与 `en.json` 是否都已同步？
- [ ] 切换语言后页面是否无 missing key/回退异常？

