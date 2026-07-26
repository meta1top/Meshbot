# Agent 编辑器 v2 设计（提示词文件化 / 工具启停 / 五 tab / 全量复制）

日期：2026-07-26
范围：三段交付的总设计。每段独立 plan、独立真机验收。

## 一、背景与目标

Agent 的可配置面正在扩大（人格、技能、MCP、工具），但编辑器只有「基本信息 + MCP JSON」两 tab，人格是 DB 单列 textarea，工具无任何 per-agent 管理，复制只拷 5 个元数据字段。目标：

1. 新建极简：只填基本信息（去向导、去 MCP 步骤、去「从现有复制」下拉）
2. 编辑五 tab：基本信息 / 提示词（文件化）/ 技能 / MCP（友好编辑器）/ 工具（启停）
3. 侧栏铅笔 → 下拉菜单（编辑 / 复制），复制升级为全量配置复制

## 二、已确认的决策

| 决策点 | 结论 |
|--------|------|
| 提示词注入 | `<agentDir>/prompts/` 的 **AGENT.md + 全部 *.md 注入**到新的第五条稳定 id 系统消息 **`system:prompts`**（每轮刷新） |
| DB 列迁移 | **不迁移，丢弃** `agent.system_prompt` 列（迁移删列，停止消费）；老数据用户自己重填文件 |
| 新建表单 | 只留 name/avatar/description/默认模型；人格创建后在提示词 tab 写 |
| MCP 编辑器 | **高亮+校验 JSON 编辑器**（轻量 CodeMirror：高亮/行号/实时校验定位/一键格式化；不引 Monaco）——保住与 Claude Desktop/Code 配置互拷的优势 |
| 工具启停 | **仅内建工具**，按分组展示 + 单工具开关 + 组级一键；**核心豁免**（`todo_write`、`ask_question`）不可禁；MCP 工具不在此 tab（已有 server 级启停）。存 `<agentDir>/tools.json` |
| 复制 | 侧栏下拉菜单入口；DB 行 + **目录级拷贝 prompts/、skills/、mcp.json、tools.json**；memory/workspace/会话不复制 |

## 三、提示词文件化（第一段）

### 存储

- 目录：`<agentDir>/prompts/`（`MeshbotConfigService.getPromptsDir()` 新增，Agent 级）
- `AGENT.md` = 人格主文件（UI 置顶、不可删、不可改名）；其余任意 `*.md`
- 文件名校验：`/^[\w.-]+\.md$/` 且解析后必须仍在 prompts 目录内（防路径穿越）；大小写不敏感去重

### 注入（system:prompts）

- `ContextBuilder.buildPromptsMessage()`，稳定 id `system:prompts`，与另四条（persona/ctx/skills/mcp）同机制每轮 Remove+重建
- 内容 = AGENT.md 全文在首 + 其余文件按文件名（字典序）拼接，文件间以 `\n\n` 分隔；不加文件名标头（所见即所得的连续人格文本）
- 目录空/不存在 → `hasPrompts()` false，整条省略
- 总量护栏：拼接后超 **64k 字符**截断，尾部附一行说明「（提示词超长已截断）」——防自爆上下文；护栏值具名常量
- `system:persona` 相应缩水：只剩 MEMORY_GUIDE + `<memory>` + LLMUSE_GUIDE（agentSystemPrompt 段删除，runtime-context 的该字段一并清理）

### DB 与兼容

- TypeORM 迁移删除 `agent.system_prompt` 列（本地轨启动自动跑；SQLite drop column）
- `AgentCreateSchema` / 编辑表单 / duplicate 的 systemPrompt 字段全部移除
- CloudAgent 注册镜像不受影响（本就只上 name/avatar/description）

### REST（server-agent，归属新 `PromptFileService`——文件 I/O 在 libs/agent）

- `GET /api/agents/:id/prompts` → `[{ file, size, mtime }]`（AGENT.md 恒在列表首位，无文件时也返回它的空占位）
- `GET /api/agents/:id/prompts/:file` → 原文
- `PUT /api/agents/:id/prompts/:file` → 写入（新建同端点）
- `DELETE /api/agents/:id/prompts/:file` → 删除（AGENT.md 拒绝 400）

### 编辑抽屉「提示词」tab（第一段 UI）

- 左列文件列表（AGENT.md 置顶固定 + 新建按钮 + 删除入口），右区 textarea 编辑器（md 高亮留后，先纯文本）
- 显式「保存」按钮（文件级即时保存，不随 footer）；未保存切换文件/关闭抽屉时并入现有脏检测确认
- 新建简化同段落地：单步表单，拆除向导/复制下拉/MCP 步骤

## 四、工具启停（第二段）

### 存储与生效

- `<agentDir>/tools.json`：`{ "disabledTools": string[] }`（人机共写；缺失 = 全启用）
- 归属新 `ToolPrefsService`（libs/agent）：读缓存 + 写（校验→落盘）；写后无需 teardown（内建工具 bind 每 run 现算）
- **过滤点**：`ToolRegistry.asLangChainBindable()` / `list()` / `get()` 统一按当前 ALS Agent 的禁用集过滤**全局内建 entries**；MCP 桶不过滤。ALS 外（无 Agent 上下文）不过滤
- **豁免**：`PROTECTED_TOOLS = ["todo_write", "ask_question"]`（具名常量，libs/types-agent）——写入 tools.json 也无效（读取时剔除），UI 灰置

### 分组

- `TOOL_GROUPS`（libs/types-agent，前后端共享）：文件与终端 / 记忆 / 技能 / IM / 网盘 / 调度 / 子代理 / MCP 管理 / 产物与交互 / 其他。未登记的工具落「其他」（新增工具不阻塞）

### REST 与 UI

- `GET/PUT /api/agents/:id/tools`（GET 返回全量内建工具 + 分组 + 禁用态 + 豁免标记）
- 工具 tab：分组折叠列表 + 单工具 Switch + 组级一键开关；豁免项灰置带提示；变更即时保存

## 五、技能 tab / MCP 编辑器 / 下拉菜单与全量复制（第三段）

- **技能 tab**：已安装列表（名字/描述/卸载按钮）+ 简版市场安装（来源切换 + 搜索 + 安装按钮），复用 `/api/skills` 全套 REST 与 /skills 页卡片逻辑，适配窄容器；深度浏览仍去 /skills 页（tab 内给跳转链接）
- **MCP tab 升级**：CodeMirror 6（`@codemirror/lang-json` + lint）替换 textarea；保存语义不变（随 footer 统一保存）；实时校验错误行内标注 + 一键格式化按钮
- **侧栏下拉**：`SessionTree.AgentRow` 铅笔 → `DropdownMenu`（编辑 / 复制）；web-main 无 onEditAgent 时不渲染（现状语义）；复制项带 loading 态
- **复制全量化**：`AgentService.duplicate()` 扩展——DB 行（name+「(副本)」/avatar/description/defaultModelConfigId）+ 递归拷贝 `prompts/`、`skills/`（含 `.meshbot-install.json` 清单）、`mcp.json`、`tools.json`；memory/workspace 不拷；目标目录已存在冲突时报错不覆盖

## 六、测试与验收（分段）

各段风险分档：一/二段**中**（存储 + 注入链路 + registry 过滤），三段**低-中**。

**第一段**：PromptFileService 单测（vitest：文件名校验/路径穿越拒绝/AGENT.md 保护）；buildPromptsMessage 三态 + 截断护栏；迁移后老 Agent 启动正常（列删除不炸）；真机——建文件→对话人格生效、删列后无回归
**第二段**：过滤点单测（禁用集生效/豁免剔除/ALS 外不过滤/MCP 桶不受影响）+ 变异抽查（过滤条件取反）；真机——禁 bash 后 agent 确实无法调用
**第三段**：复制后目录逐项比对（含清单文件）；CodeMirror 校验定位；真机——复制的 Agent 五类配置齐全、原 Agent 无扰动

**每段通用**：`pnpm lint/typecheck/check/test/build` 全绿；改 DI 真 boot；用户真机验收后才进下一段。

## 七、明确不做

- prompts 的 md 富文本/预览渲染（纯文本编辑起步）
- 提示词模板市场 / 跨 Agent 提示词共享
- 工具启停的 agent 自管理工具（本期只人管；类比 mcp_* 的 agent 自管理留后续评估）
- MCP 结构化表单编辑器（保持 JSON 文本形态）
- memory/workspace 的复制
- web-main 侧编辑能力（远程 Agent 仍只读）
