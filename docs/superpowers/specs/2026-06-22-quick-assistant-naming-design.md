# 随手问命名设计（默认名 / 改名 / 上下文注入 / 改名 tool）

> 随手问 = AssistantDock，`kind="quick"` 的全局临时会话（不绑定当前 IM 对话）。
> 本设计给随手问一个**账号级、可改名的名字**，注入到 quick 会话上下文，并提供改名 tool。

## 背景

当前 dock 标题是固定 i18n 文案 `assistantDock.title`（"随手问"），无名字概念；quick 会话上下文不含任何身份信息。

用户诉求（5 项，1-2 已完成）：
1. ✅ dock 标题栏高度对齐左侧会话头（`h-[50px]` → `h-11`）。
2. ✅ 去掉副标题。
3. 给随手问一个默认名字，允许用户改名。
4. quick 会话需在上下文注入随手问名字 / 相关信息。
5. 提供改名 tool，让用户可通过对话给随手问改名。

本 spec 覆盖 **3-5**（1-2 已在 `feat(web-agent): 随手问头部对齐…` 提交）。

## 决策 / 假设

- **单个账号级全局名**：每个账号一个随手问名字，存 `Setting`（账号作用域实体，带 cloud_user_id）。键 `quick_assistant_name`。默认 `"随手问"`（保持熟悉）。
- 不做"多个随手问/每会话独立命名"——随手问是单一全局助手。
- 名字同时驱动：dock 标题显示（item 3）、quick 会话系统提示注入（item 4）、改名 tool 写入（item 5）。改名后 dock 标题应刷新。

## 架构（三层）

### server-agent

- **SettingService**：`quick_assistant_name` 的 get（带默认）/ set。优先复用现有通用 key-value 读写；缺则补该键的读写方法。
- **REST**（给 UI 改名）：GET 当前名、PATCH 新名。复用 `setting.controller` 的通用端点或新增 `/api/quick-assistant/name`。
- **runtime-context**：把 `quickAssistantName` 加进 `runtime-context.port` 向 libs/agent 暴露的账号级运行时上下文（PromptService 用，item 4）。
- **改名 tool port 实现**（item 5）：实现 rename 端口 → `SettingService.set(quick_assistant_name)`；写入后通过既有事件机制/前端重取让 dock 标题刷新。

### libs/agent

- **PromptService**（item 4）：构建系统提示时，若 `session.kind === "quick"`，注入名字（如「你的名字是『<name>』，由用户随手唤起，不绑定任何具体对话」）。名字来自 runtime-context。
- **改名 tool**（item 5）：仿 `skill-tools.port.ts` + `builtins/skill-*.tool.ts` 范式，新增 `rename-quick-assistant.tool.ts` + 端口（如 `QUICK_ASSISTANT_PORT { rename(name): Promise<void> }`），由 server-agent 实现注入。tool 参数：新名字（非空、长度上限）。

### web-agent

- **AssistantDock 标题**（item 3）：由固定 `t("title")` 改为显示存储的名字（经 setting query/atom 读取，默认回退 "随手问"）。
- **内联改名 UI**（item 3）：点标题进入编辑（input），回车/失焦 PATCH 保存并更新本地 atom。
- tool 改名后（item 5）若 dock 正打开，经事件或轮询/重取刷新标题。

## 各项落点汇总

| # | 内容 | 层 | 状态 |
|---|------|----|------|
| 1 | dock 头 `h-11` 对齐会话头 | web-agent | ✅ 已完成 |
| 2 | 去副标题 | web-agent + i18n | ✅ 已完成 |
| 3 | 默认名 + UI 改名 | Setting + REST + dock | 待做 |
| 4 | quick 会话上下文注入名字 | runtime-context + PromptService | 待做 |
| 5 | 改名 tool | libs/agent tool + port + server-agent 实现 | 待做 |

## 测试 / 验收

- **server-agent 单测**：SettingService get 默认 / set；改名 tool port 实现写入 Setting。
- **libs/agent 单测**：PromptService 对 `kind="quick"` 注入名字、对 `kind="user"` 不注入；rename tool 调用 port。
- **web-agent**：dock 显示名字、改名持久化、tool 改名后标题刷新（目视）。
- **目视**：dock 头与左侧会话头同高（h-11，已可验）。

## 边界 / 不变量

- 账号级 Setting，遵守 scope 围栏（quick_assistant_name 走 ScopedRepository）。
- 跨表写入才挂 `@Transactional`（单表 setting upsert 无需）。
- Entity 归属、tool 不直接注入 Repository（经 SettingService）等既有围栏照旧。
- 用户可见文案走 next-intl。

## 不在范围

- 随手问头像 / 多随手问 / 每会话独立人格。
- 把名字同步到非 quick（普通 user/IM）会话（item 4 仅 quick）。
