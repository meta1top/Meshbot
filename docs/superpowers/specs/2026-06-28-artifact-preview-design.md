# 子项目①：本地产物预览（present_file → 文件框 → dock 预览面板）设计

> 状态：已通过 brainstorm，待评审 → writing-plans
> 日期：2026-06-28
> 关联：[[session-todo]] / [[agent-ask-question-hitl]]（tool-call 特判卡范式）、[[realtime-socket-architecture]]（流式）、[[tool-call-display-convention]]（友好名/路径打码）
> 后续：子项目②「云端分享」（上传 server-main + 短链接 + web-main 公开页 + 跨 agent 下载）独立 spec，依赖本项目的「分享」按钮占位。

## 1. 目标 / 范围

agent 产出结果性文件（html/pdf/md/图片/文本等）后，在对话流显示**文件框**；点击在右侧 dock 区域显示**预览面板**（与「随手问助手」**切换**：出现预览即助手↔预览切换，预览关闭回助手）。预览面板可**下载 / 全屏 / 关闭**；**分享**按钮本期占位（留给子项目②）。

**范围内**：本地轨（server-agent 文件 serving + web-agent 预览 UI + libs/agent 工具）。
**范围外**：分享/上传/短链接/跨 agent（子项目②）。

## 2. 架构（复用 tool-call 链路，零消息字段）

**关键决策**：产物识别用显式工具 `present_file`；文件框是这次 **tool call 的特判渲染**（像 `todo_write`/`ask_question`）。**不**给 `SessionMessage` 加 attachments 字段、**不**加新 socket 事件——`present_file` 就是普通工具调用，走现有 `tool_call_start/end` + `toolCalls` 持久化，历史重载自动重建文件框。产物内容**实时读 workspace**（新建 serving 端点）。

```
agent 调 present_file({path, title}) → 现有 tool_call 流 → 前端 tool-call-block 特判
  → 渲染「文件框卡」（类型图标 + 标题 + 点击预览）
点击文件框 → set panelType='preview' + previewArtifact + panelOpen=true
  → 右侧 aside 渲染 ArtifactPreviewPanel（替代 AssistantDock）
预览/下载 → GET /api/artifacts/raw?path=&download= （server-agent 实时读 workspace 文件，流式）
关闭预览 → panelType='assistant'（回助手）
```

## 3. `present_file` 工具（libs/agent）

- 参数 `presentFileSchema`（types-agent）：`{ path: string(min1); title?: string }`。
- 注入 `MeshbotConfigService`（同 write_file）。`execute`：
  - `abs = resolveFilePath(path, config.getWorkspaceDir())`；
  - **必须在 workspace 内**：`abs.startsWith(workspaceDir)` 否则返回错误（产物只呈现工作区内文件）；
  - `existsSync(abs)` 否则返回错误（让 agent 知道文件不存在）；
  - 返回确认 JSON：`{ status:"presented", path:<相对路径>, name:basename, size:statSync.size }`。
- 纯 fs（无端口，同 write_file/read_file）。注册进 AgentModule。
- `description` 引导：产出**最终结果文件**（报告/网页/图表/PDF 等）后调它呈现给用户；中间过程文件不用调。

## 4. 对话流文件框（tool-call-block 特判）

- `tool.name === "present_file" && tool.status !== "streaming"` → `ArtifactFileCard`（早返回放 `useState(open)` 之后，守 Rules of Hooks，同 todo_write 特判位置）。
- `ArtifactFileCard`：从 `tool.args` 取 `{path, title}`，显示**类型图标**（按扩展名）+ `title ?? basename(path)` + 类型标签 + 「点击预览」提示。整卡可点 → 打开 dock 预览。
- 路径不直接显示给用户（避免暴露），只显示标题/文件名。

## 5. dock 助手↔预览切换

- 新 atom（`atoms/assistant-panel.ts`）：
  - `assistantPanelTypeAtom: atom<'assistant' | 'preview'>('assistant')`；
  - `previewArtifactAtom: atom<{ path: string; title?: string } | null>(null)`。
- 点文件框：`setPreviewArtifact({path,title}); setPanelType('preview'); setPanelOpen(true)`。
- `app-shell-layout.tsx` 右侧 aside（现 `<AssistantDock/>` 处）：`panelType === 'preview' && previewArtifact ? <ArtifactPreviewPanel/> : <AssistantDock/>`。宽度/抽屉（translate-x）/拖拽机制全复用。
- `ArtifactPreviewPanel` 头部「关闭」→ `setPanelType('assistant')`（回助手，previewArtifact 可不清）；顶栏 ✦ / dock X（`panelOpen=false`）关整个面板，逻辑不变。

## 6. server-agent 文件 serving 端点

- `ArtifactController`：`GET /api/artifacts/raw?path=<相对路径>&download=0|1`。
  - 注入 `AccountContextService` + `MeshbotConfigService`（或等价的 workspace 解析）。
  - **账号作用域**：workspace 按当前登录账号解析（`account.getOrThrow()`）。
  - **路径遍历防护**：`abs = resolveFilePath(path, workspaceDir)`；`abs.startsWith(workspaceDir)` 否则 `403`（杜绝 `../` 逃逸）。
  - 文件不存在 → `404`。
  - 流式返回 `StreamableFile`，按扩展名设 `Content-Type`；`download=1` 加 `Content-Disposition: attachment; filename="<basename>"`。
- 注册进合适模块（SessionModule 或新 ArtifactModule）。

## 7. 预览渲染（ArtifactPreviewPanel）+ 操作

- 纯函数 `artifactKind(path): 'html'|'pdf'|'image'|'markdown'|'text'|'binary'`（`lib/artifact.ts`，按扩展名）+ `artifactRawUrl(path, {download})`（构造 serving URL）。
- 渲染分发：
  - `html` → `<iframe sandbox src={rawUrl}>`（sandbox 防脚本越权）。
  - `pdf` → `<iframe src={rawUrl}>`（浏览器内置 viewer）。
  - `image`（png/jpg/jpeg/gif/webp/svg）→ `<img src={rawUrl}>`。
  - `markdown` → fetch raw 文本 → 复用现有 Markdown 渲染组件。
  - `text`（txt/csv/json/log/代码）→ fetch raw → `<pre>`。
  - `binary` → 「该类型不支持预览，请下载」。
- 头部：标题 + 操作按钮——
  - **下载**：`rawUrl(download=1)`（`<a download>` 或新窗口）。
  - **全屏**：`createPortal` 模态（复用 ConfirmDialog 范式，`fixed inset-0 z-50`），内嵌同分发渲染；Esc / 点关闭退出。
  - **分享**：占位按钮（禁用 + 「即将上线」tooltip），留子项目②。
  - **关闭**：回助手（`panelType='assistant'`）。

## 8. 边界 / 安全 / 不变量

- **实时读**：文件被 agent 后续改/删 → serving 404，预览面板显示「产物已不存在或已变更」，下载按钮禁用。
- **账号隔离**：serving workspace 按当前账号，跨账号无法读他人产物（路径校验在各自 workspace 内）。
- **路径遍历**：`startsWith(workspaceDir)` 双重防护（工具侧 + serving 侧）。
- **html sandbox**：iframe `sandbox`（默认禁脚本；如需脚本另评，本期默认禁）。
- **友好名/打码**：`TOOL_LABELS` 加 `present_file: 呈现文件`（兜底用，正常走文件框特判）；文件框只显示标题不显示绝对路径。
- 单一预览：dock 一次显示一个产物；点另一个文件框切换 previewArtifact。

## 9. 测试

- **types-agent**：`presentFileSchema` jest（path 非空、title 可选）。
- **libs/agent**：`present_file` 工具 vitest（workspace 内解析、不存在/越界返回错误、正常返回 name/size；mock config.getWorkspaceDir + fs）。
- **server-agent**：`ArtifactController` jest（账号作用域 key、路径遍历 `../` → 403、不存在 → 404、Content-Type 按扩展名、download=1 加 Disposition）。
- **web-agent**：`artifactKind`/`artifactRawUrl` 纯函数 jest（各扩展名分发、URL 构造）。组件靠 typecheck。
- **boot 验证**：新 ArtifactController + DI；启动 successfully started + `/api/artifacts/raw` 路由 Mapped。

## 10. 涉及文件（预估）

- types-agent：`present-file.ts`（presentFileSchema + 类型）+ index。
- libs/agent：`tools/builtins/present-file.tool.ts` + agent.module 注册 + 工具 vitest。
- server-agent：`controllers/artifact.controller.ts` + 模块注册 + spec（+ 可能 dto）。
- web-agent：`atoms/assistant-panel.ts`（type + previewArtifact atom）、`lib/artifact.ts`（kind/url 纯函数 + jest）、`components/session/tool-call-block.tsx`（present_file 特判）、`components/session/artifact-file-card.tsx`、`components/artifact/artifact-preview-panel.tsx`、`components/artifact/artifact-fullscreen.tsx`、`layouts/app-shell-layout.tsx`（aside 切换）、`lib/tool-display.ts`（TOOL_LABELS 加一条）。
