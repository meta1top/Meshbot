# Desktop 应用启动引导 & 模型初始化配置

## 概述

当 Desktop 应用首次启动时，检测本地 SQLite 中是否已有模型配置。若无，引导用户完成初始化（选择供应商、配置模型 + API Key），保存后启动 server-agent 进入正常使用。

---

## 一、数据模型

SQLite 数据库：`~/.anybot/agent.db`

### `providers` 供应商表

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | UUID |
| `type` | TEXT NOT NULL UNIQUE | 类型标识：`openai` / `anthropic` / `google` / `deepseek` / ... |
| `name` | TEXT NOT NULL | 显示名称 |
| `description` | TEXT | 简要描述 |
| `default_base_url` | TEXT | 官方 API 默认端点 |
| `created_at` | TEXT | ISO 时间戳 |

由代码中的静态配置源启动时 upsert（`INSERT ... ON CONFLICT(type) DO UPDATE`）。`type` 不可变，`name`、`description`、`default_base_url` 在同步时更新。

### `models` 模型表

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | UUID |
| `provider_id` | TEXT FK → providers.id | 所属供应商 |
| `name` | TEXT NOT NULL | 用户自定义名称 |
| `model` | TEXT NOT NULL | 模型标识：`gpt-4o` / `claude-opus-4-7` |
| `api_key` | TEXT NOT NULL | API Key |
| `base_url` | TEXT | 自定义端点，为空则用 provider 默认值 |
| `enabled` | INTEGER DEFAULT 1 | 是否启用 |
| `created_at` | TEXT | ISO 时间戳 |
| `updated_at` | TEXT | ISO 时间戳 |

### `settings` 设置表

| 列 | 类型 | 说明 |
|---|---|---|
| `key` | TEXT PK | 设置键 |
| `value` | TEXT | 设置值 |

预留，当前阶段不使用。

### 检测逻辑

`SELECT COUNT(*) FROM models WHERE enabled = 1` → 为 0 则进入 setup 引导。

---

## 二、启动流程

```
Desktop 启动 (app.whenReady)
  → 确保 ~/.anybot/ 目录存在
  → 打开 ~/.anybot/agent.db
  → 供应商同步 upsert（从代码配置源）
  → SELECT enabled models count
    ├── count > 0
    │   → fork server-agent
    │   → wait ready
    │   → 加载 web-agent（正常模式，路由 /）
    │
    └── count = 0
        → 加载 web-agent（setup 模式，路由 /setup）
        → 用户填写模型配置
        → web-agent 通过 IPC 提交到 main process
        → main process 写入 SQLite (models 表)
        → main process fork server-agent
        → 通知 web-agent 刷新，跳转到 /
```

---

## 三、IPC 接口

Desktop 通过 `contextBridge` 向 web-agent 暴露：

```ts
electronAPI {
  getProviders(): Promise<Provider[]>
  getSetupStatus(): Promise<{ needsSetup: boolean }>
  saveModelConfig(data: {
    providerId: string
    name: string
    model: string
    apiKey: string
    baseUrl?: string
  }): Promise<{ success: boolean }>
  completeSetup(): Promise<void>
}
```

### 通信路径

```
web-agent (renderer) ──IPC──▶ desktop (main) ──better-sqlite3──▶ agent.db
```

---

## 四、Web-Agent Setup 页面

### 路由

| 路由 | 场景 |
|---|---|
| `/setup` | 引导页（无配置时） |
| `/` | 主页面（有配置时） |

### 页面结构

- **供应商选择区**：卡片式，选中高亮。数据来自 `getProviders()` IPC
- **模型配置表单**：名称、模型标识（下拉+可输入）、API Key、API 端点（选填，默认用供应商 base_url）
- **保存按钮**：调用 `saveModelConfig()` → `completeSetup()` → 跳转 `/`

### 交互规则

- 表单校验：API Key 不能为空，模型标识不能为空
- 仅支持配置一个模型（MVP），后续主界面可添加更多
- 用户关闭窗口不保存 → 下次启动仍无配置，重新进入 setup

---

## 五、供应商配置源

在 `packages/common/src/providers/index.ts` 中维护硬编码列表：

```ts
interface ProviderDef {
  type: string
  name: string
  description: string
  default_base_url: string
  models: string[]  // 预置常用模型列表，用于 UI 下拉
}
```

更新 app 时加入新供应商或修改 base_url，代码合并上线后用户下次启动自动同步 upsert。

---

## 六、异常处理

| 场景 | 处理 |
|---|---|
| `~/.anybot/` 创建失败 | 原生错误对话框，提示检查权限，app 退出 |
| SQLite 读写失败 | 错误提示 + 重试按钮 |
| 供应商同步失败 | 日志记录，使用已有数据继续 |
| API Key 为空 | 表单校验拦截，不提交 |
| 用户填写一半退出 | 下次启动 models 表仍空，重新进入 setup |
| server-agent 启动失败 | 弹窗提示，显示日志路径 |
| server-agent 启动超时 | 30s 超时，提示重试 |

---

## 七、文件改动清单

### 新增

```
packages/common/src/providers/
├── index.ts                    # 供应商定义列表
└── schema.ts                   # Zod schema

apps/desktop/src/
├── database.ts                 # SQLite 初始化、同步、CRUD
└── ipc-handlers.ts             # IPC handler 注册

apps/web-agent/src/
├── app/setup/page.tsx          # Setup 引导页
└── components/setup/
    ├── provider-card.tsx       # 供应商选择卡片
    └── model-form.tsx          # 模型配置表单
```

### 修改

```
apps/desktop/
├── src/main.ts                 # 启动流程改造
├── src/preload.ts              # 新增 IPC 方法
└── package.json                # +better-sqlite3

apps/web-agent/src/app/
├── page.tsx                    # 主页面微调
└── layout.tsx                  # 保持不变

apps/server-agent/src/
└── app.module.ts               # 启动时加载 agent.db，初始化 LangChain
```

### 预估改动量

约 430 行，分布在 9 个文件中。
