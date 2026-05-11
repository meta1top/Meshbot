# Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop 首次启动时检测 SQLite 中是否有模型配置，若无则引导用户完成供应商选择 + 模型配置。

**Architecture:** Desktop 主进程通过 better-sqlite3 直接读写 `~/.meshbot/agent.db`，web-agent 通过 IPC 与主进程通信。供应商元数据定义在 `packages/common` 中作为静态配置源。server-agent 启动时从 agent.db 加载模型配置。

**Tech Stack:** better-sqlite3, Electron IPC (contextBridge + ipcMain.handle), Next.js 15 App Router, React 19, Tailwind CSS v4, Zod, NestJS 11

---

## File Structure

```
packages/common/src/providers/
├── index.ts               # 供应商静态定义列表（真相源）
└── schema.ts              # Zod schema：模型配置表单校验

apps/desktop/src/
├── main.ts                # [修改] 启动流程：检测 → 分支加载 /setup 或 /
├── preload.ts             # [修改] 新增 4 个 IPC 方法
├── database.ts            # [新增] SQLite 初始化/同步/CRUD
├── database.test.ts       # [新增] 数据库模块单元测试
└── ipc-handlers.ts        # [新增] 注册 IPC handler

apps/web-agent/src/
├── app/
│   ├── layout.tsx         # [不变]
│   ├── page.tsx           # [修改] 主页面（从 IPC 读取模型状态）
│   └── setup/
│       └── page.tsx       # [新增] Setup 引导页
├── components/setup/
│   ├── provider-card.tsx  # [新增] 供应商选择卡片
│   └── model-form.tsx     # [新增] 模型配置表单
└── types/
    └── electron.d.ts      # [新增] window.electronAPI 类型声明

apps/server-agent/src/
└── app.module.ts          # [修改] 启动时加载 agent.db 模型配置
```

---

### Task 1: Provider definitions in packages/common

**Files:**
- Create: `packages/common/src/providers/index.ts`
- Create: `packages/common/src/providers/schema.ts`
- Modify: `packages/common/src/index.ts`

- [ ] **Step 1: Write provider definitions**

Create `packages/common/src/providers/index.ts`:

```ts
export interface ProviderDef {
  type: string;
  name: string;
  description: string;
  default_base_url: string;
  models: string[];
}

export const PROVIDERS: ProviderDef[] = [
  {
    type: "openai",
    name: "OpenAI",
    description: "GPT-4o, GPT-4.1 等系列模型",
    default_base_url: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4o-mini"],
  },
  {
    type: "anthropic",
    name: "Anthropic",
    description: "Claude Opus, Sonnet, Haiku 系列模型",
    default_base_url: "https://api.anthropic.com",
    models: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ],
  },
  {
    type: "google",
    name: "Google Generative AI",
    description: "Gemini 系列模型",
    default_base_url: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    type: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek V4 系列模型",
    default_base_url: "https://api.deepseek.com",
    models: ["deepseek-v4-pro", "deepseek-chat"],
  },
  {
    type: "ollama",
    name: "Ollama",
    description: "本地运行的开源模型",
    default_base_url: "http://localhost:11434",
    models: [], // 用户自行输入
  },
  {
    type: "openai-compatible",
    name: "OpenAI 兼容接口",
    description: "任何兼容 OpenAI API 格式的服务（如 OpenRouter、vLLM 等）",
    default_base_url: "",
    models: [], // 用户自行输入
  },
];
```

- [ ] **Step 2: Write Zod schemas**

Create `packages/common/src/providers/schema.ts`:

```ts
import { z } from "zod";

export const modelConfigSchema = z.object({
  providerId: z.string().min(1, "请选择供应商"),
  name: z.string().min(1, "请输入名称"),
  model: z.string().min(1, "请输入或选择模型"),
  apiKey: z.string().min(1, "请输入 API Key"),
  baseUrl: z.string().optional(),
});

export type ModelConfigInput = z.infer<typeof modelConfigSchema>;
```

- [ ] **Step 3: Re-export from package entry**

Modify `packages/common/src/index.ts` — replace the current `export {};` with:

```ts
export { PROVIDERS } from "./providers";
export type { ProviderDef } from "./providers";
export { modelConfigSchema } from "./providers/schema";
export type { ModelConfigInput } from "./providers/schema";
```

- [ ] **Step 4: Install Zod dependency in packages/common**

Run: `pnpm --filter @meshbot/common add zod`

- [ ] **Step 5: Build and verify**

Run: `pnpm --filter @meshbot/common build`
Expected: Compiles without errors.

- [ ] **Step 6: Commit**

```bash
git add packages/common/src/
git commit -m "feat: add provider definitions and model config schema to common package"
```

---

### Task 2: Add dependencies to desktop

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Add better-sqlite3 and @meshbot/common**

Run:
```bash
pnpm --filter @meshbot/desktop add better-sqlite3 @meshbot/common
pnpm --filter @meshbot/desktop add -D @types/better-sqlite3
```

- [ ] **Step 2: Verify deps installed**

Check `apps/desktop/package.json` now includes:
```json
"dependencies": {
  "@meshbot/common": "workspace:*",
  "better-sqlite3": "^...",
  "electron-updater": "^6"
},
"devDependencies": {
  "@types/better-sqlite3": "^...",
  ...
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "chore: add better-sqlite3 and @meshbot/common to desktop deps"
```

---

### Task 3: SQLite database module

**Files:**
- Create: `apps/desktop/src/database.ts`
- Create: `apps/desktop/src/database.test.ts`

- [ ] **Step 1: Create database module**

Create `apps/desktop/src/database.ts`:

```ts
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { PROVIDERS } from "@meshbot/common";
import type { ProviderDef } from "@meshbot/common";

const MESHBOT_DIR = path.join(homedir(), ".meshbot");
const DB_PATH = path.join(MESHBOT_DIR, "agent.db");
const LOG_DIR = path.join(MESHBOT_DIR, "logs");

let db: Database.Database | null = null;

export function getMeshBotDir(): string {
  return MESHBOT_DIR;
}

export function getLogDir(): string {
  return LOG_DIR;
}

export function ensureDirs(): void {
  mkdirSync(MESHBOT_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

export function openDatabase(): Database.Database {
  ensureDirs();
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  createTables(db);
  syncProviders(db);
  return db;
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error("Database not opened — call openDatabase() first");
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── Internal ──────────────────────────────────────────

function createTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      default_base_url TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id),
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// ── Provider sync ─────────────────────────────────────

function syncProviders(database: Database.Database): void {
  const now = new Date().toISOString();
  const upsert = database.prepare(`
    INSERT INTO providers (id, type, name, description, default_base_url, created_at)
    VALUES (@id, @type, @name, @description, @default_base_url, @created_at)
    ON CONFLICT(type) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      default_base_url = excluded.default_base_url
  `);

  const existing = new Set(
    database
      .prepare("SELECT type FROM providers")
      .all()
      .map((r: any) => r.type),
  );

  const txn = database.transaction(() => {
    for (const p of PROVIDERS) {
      const id = existing.has(p.type)
        ? (database
            .prepare("SELECT id FROM providers WHERE type = ?")
            .get(p.type) as any).id
        : randomUUID();

      upsert.run({
        id,
        type: p.type,
        name: p.name,
        description: p.description,
        default_base_url: p.default_base_url,
        created_at: now,
      });
    }
  });

  txn();
}

// ── Config queries ────────────────────────────────────

export function getSetupStatus(
  database: Database.Database,
): { needsSetup: boolean } {
  const row = database
    .prepare("SELECT COUNT(*) as count FROM models WHERE enabled = 1")
    .get() as any;
  return { needsSetup: row.count === 0 };
}

export function getProvidersList(database: Database.Database): ProviderDef[] {
  return PROVIDERS;
}

export function saveModelConfig(
  database: Database.Database,
  data: {
    providerType: string;
    name: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
  },
): { success: boolean; id: string } {
  const provider = database
    .prepare("SELECT id FROM providers WHERE type = ?")
    .get(data.providerType) as { id: string } | undefined;

  if (!provider) {
    throw new Error(`Unknown provider type: ${data.providerType}`);
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  database
    .prepare(
      `INSERT INTO models (id, provider_id, name, model, api_key, base_url, enabled, created_at, updated_at)
     VALUES (@id, @provider_id, @name, @model, @api_key, @base_url, 1, @created_at, @updated_at)`,
    )
    .run({
      id,
      provider_id: provider.id,
      name: data.name,
      model: data.model,
      api_key: data.apiKey,
      base_url: data.baseUrl ?? "",
      created_at: now,
      updated_at: now,
    });

  return { success: true, id };
}

export function getEnabledModels(
  database: Database.Database,
): Array<{
  id: string;
  provider_type: string;
  provider_name: string;
  name: string;
  model: string;
  api_key: string;
  base_url: string;
  default_base_url: string;
}> {
  return database
    .prepare(
      `SELECT m.id, p.type as provider_type, p.name as provider_name,
              m.name, m.model, m.api_key, m.base_url, p.default_base_url
       FROM models m
       JOIN providers p ON m.provider_id = p.id
       WHERE m.enabled = 1`,
    )
    .all() as any[];
}
```

- [ ] **Step 2: Write unit tests**

Create `apps/desktop/src/database.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { getSetupStatus, getProvidersList, saveModelConfig } from "./database";

// Use an in-memory database for tests
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      default_base_url TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id),
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Seed a test provider
  db.prepare(
    `INSERT INTO providers (id, type, name, description, default_base_url, created_at)
     VALUES ('p1', 'openai', 'OpenAI', '', 'https://api.openai.com/v1', '2026-01-01')`,
  ).run();
  return db;
}

describe("getSetupStatus", () => {
  it("returns needsSetup=true when no models exist", () => {
    const db = createTestDb();
    expect(getSetupStatus(db)).toEqual({ needsSetup: true });
    db.close();
  });

  it("returns needsSetup=false when enabled models exist", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO models (id, provider_id, name, model, api_key, enabled, created_at, updated_at)
       VALUES ('m1', 'p1', 'test', 'gpt-4o', 'sk-test', 1, '2026', '2026')`,
    ).run();
    expect(getSetupStatus(db)).toEqual({ needsSetup: false });
    db.close();
  });

  it("returns needsSetup=true when models exist but none enabled", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO models (id, provider_id, name, model, api_key, enabled, created_at, updated_at)
       VALUES ('m1', 'p1', 'test', 'gpt-4o', 'sk-test', 0, '2026', '2026')`,
    ).run();
    expect(getSetupStatus(db)).toEqual({ needsSetup: true });
    db.close();
  });
});

describe("getProvidersList", () => {
  it("returns non-empty provider list", () => {
    const providers = getProvidersList();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0]).toHaveProperty("type");
    expect(providers[0]).toHaveProperty("name");
  });
});

describe("saveModelConfig", () => {
  it("inserts a model and returns success", () => {
    const db = createTestDb();
    const result = saveModelConfig(db, {
      providerType: "openai",
      name: "My GPT",
      model: "gpt-4o",
      apiKey: "sk-abc123",
    });
    expect(result.success).toBe(true);
    expect(result.id).toBeTruthy();

    const { needsSetup } = getSetupStatus(db);
    expect(needsSetup).toBe(false);
    db.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail (no vitest config yet)**

Run: `pnpm --filter @meshbot/desktop vitest run`
Expected: Should run and pass the database tests.

Note: If vitest is not yet available, first run `pnpm --filter @meshbot/desktop add -D vitest` and add `"test": "vitest run"` to desktop/package.json scripts.

- [ ] **Step 4: Build desktop to verify compilation**

Run: `pnpm --filter @meshbot/desktop build`
Expected: Compiles without errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/database.ts apps/desktop/src/database.test.ts
git commit -m "feat: add SQLite database module with provider sync and model CRUD"
```

---

### Task 4: IPC handlers and preload

**Files:**
- Create: `apps/desktop/src/ipc-handlers.ts`
- Modify: `apps/desktop/src/preload.ts`

- [ ] **Step 1: Create IPC handlers**

Create `apps/desktop/src/ipc-handlers.ts`:

```ts
import { ipcMain, BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import {
  getSetupStatus,
  getProvidersList,
  saveModelConfig,
} from "./database";

export function registerIpcHandlers(
  database: Database.Database,
  getMainWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle("get-providers", () => {
    return getProvidersList(database);
  });

  ipcMain.handle("get-setup-status", () => {
    return getSetupStatus(database);
  });

  ipcMain.handle(
    "save-model-config",
    (
      _event,
      data: {
        providerType: string;
        name: string;
        model: string;
        apiKey: string;
        baseUrl?: string;
      },
    ) => {
      return saveModelConfig(database, data);
    },
  );

  ipcMain.handle("complete-setup", () => {
    const win = getMainWindow();
    if (win) {
      win.webContents.send("setup-complete");
    }
    return { success: true };
  });
}
```

- [ ] **Step 2: Update preload.ts**

Modify `apps/desktop/src/preload.ts` — replace entire file:

```ts
import { contextBridge, ipcRenderer } from "electron";

export interface ProviderInfo {
  type: string;
  name: string;
  description: string;
  default_base_url: string;
  models: string[];
}

export interface SetupStatus {
  needsSetup: boolean;
}

export interface ModelConfigData {
  providerType: string;
  name: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

contextBridge.exposeInMainWorld("electronAPI", {
  getProviders: (): Promise<ProviderInfo[]> =>
    ipcRenderer.invoke("get-providers"),

  getSetupStatus: (): Promise<SetupStatus> =>
    ipcRenderer.invoke("get-setup-status"),

  saveModelConfig: (
    data: ModelConfigData,
  ): Promise<{ success: boolean }> =>
    ipcRenderer.invoke("save-model-config", data),

  completeSetup: (): Promise<void> =>
    ipcRenderer.invoke("complete-setup"),

  onSetupComplete: (callback: () => void) => {
    ipcRenderer.on("setup-complete", () => callback());
  },
});
```

- [ ] **Step 3: Build to verify**

Run: `pnpm --filter @meshbot/desktop build`
Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/ipc-handlers.ts apps/desktop/src/preload.ts
git commit -m "feat: add IPC handlers and preload API for setup flow"
```

---

### Task 5: Startup flow in main.ts

**Files:**
- Modify: `apps/desktop/src/main.ts`

- [ ] **Step 1: Rewrite main.ts with setup detection and server-agent spawning**

Modify `apps/desktop/src/main.ts` — replace entire file:

```ts
import * as path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import {
  ensureDirs,
  openDatabase,
  getSetupStatus,
  getDatabase,
  getMeshBotDir,
  getLogDir,
} from "./database";
import { registerIpcHandlers } from "./ipc-handlers";

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

function createWindow(setupMode: boolean) {
  const route = setupMode ? "/setup" : "/";
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadURL(`http://localhost:3001${route}`);

  if (!app.isPackaged) {
    win.webContents.openDevTools();
  }

  return win;
}

function startServerAgent(): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverAgentPath = path.join(
      __dirname,
      "..",
      "..",
      "server-agent",
      "dist",
      "main.js",
    );

    serverProcess = fork(serverAgentPath, [], {
      stdio: "pipe",
      env: {
        ...process.env,
        MESHBOT_DIR: getMeshBotDir(),
      },
    });

    const timeout = setTimeout(() => {
      reject(new Error("server-agent start timeout (30s)"));
    }, 30000);

    serverProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    serverProcess.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) {
        reject(new Error(`server-agent exited with code ${code}`));
      }
    });

    // Poll for server-agent to be ready
    const poll = () => {
      const http = require("node:http");
      const req = http.get("http://localhost:3100", (res: any) => {
        clearTimeout(timeout);
        resolve();
      });
      req.on("error", () => {
        setTimeout(poll, 500);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(poll, 500);
      });
    };
    setTimeout(poll, 1000);
  });
}

app.whenReady().then(async () => {
  try {
    ensureDirs();
    const database = openDatabase();
    const { needsSetup } = getSetupStatus(database);

    registerIpcHandlers(database, () => mainWindow);

    if (!needsSetup) {
      try {
        await startServerAgent();
      } catch (err: any) {
        dialog.showErrorBox(
          "Server Agent 启动失败",
          `无法启动 server-agent：${err.message}\n\n请检查日志：${getLogDir()}`,
        );
      }
    }

    mainWindow = createWindow(needsSetup);
  } catch (err: any) {
    dialog.showErrorBox(
      "启动失败",
      `无法初始化应用：${err.message}\n\n请检查 ${getMeshBotDir()} 目录权限`,
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const database = getDatabase();
    const { needsSetup } = getSetupStatus(database);
    mainWindow = createWindow(needsSetup);
  }
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
```

- [ ] **Step 2: Build to verify**

Run: `pnpm --filter @meshbot/desktop build`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "feat: add setup detection and server-agent spawning to desktop startup"
```

---

### Task 6: Setup page UI

**Files:**
- Create: `apps/web-agent/src/types/electron.d.ts`
- Create: `apps/web-agent/src/components/setup/provider-card.tsx`
- Create: `apps/web-agent/src/components/setup/model-form.tsx`
- Create: `apps/web-agent/src/app/setup/page.tsx`
- Modify: `apps/web-agent/src/app/page.tsx`

- [ ] **Step 1: Create electronAPI type declaration**

Create `apps/web-agent/src/types/electron.d.ts`:

```ts
interface ProviderInfo {
  type: string;
  name: string;
  description: string;
  default_base_url: string;
  models: string[];
}

interface SetupStatus {
  needsSetup: boolean;
}

interface ModelConfigData {
  providerType: string;
  name: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

interface ElectronAPI {
  getProviders(): Promise<ProviderInfo[]>;
  getSetupStatus(): Promise<SetupStatus>;
  saveModelConfig(data: ModelConfigData): Promise<{ success: boolean }>;
  completeSetup(): Promise<void>;
  onSetupComplete(callback: () => void): void;
}

interface Window {
  electronAPI?: ElectronAPI;
}
```

- [ ] **Step 2: Create ProviderCard component**

Create `apps/web-agent/src/components/setup/provider-card.tsx`:

```tsx
"use client";

interface ProviderCardProps {
  type: string;
  name: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}

export default function ProviderCard({
  name,
  description,
  selected,
  onSelect,
}: ProviderCardProps) {
  return (
    <button
      onClick={onSelect}
      className={`flex flex-col gap-2 rounded-xl border-2 p-4 text-left transition-all cursor-pointer
        ${selected
          ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500"
          : "border-gray-200 hover:border-gray-300 bg-white"
        }`}
    >
      <span className="font-semibold text-gray-900">{name}</span>
      <span className="text-sm text-gray-500">{description}</span>
    </button>
  );
}
```

- [ ] **Step 3: Create ModelForm component**

Create `apps/web-agent/src/components/setup/model-form.tsx`:

```tsx
"use client";

import { useState, useMemo } from "react";
import type { ProviderInfo, ModelConfigData } from "@/types/electron";

interface ModelFormProps {
  provider: ProviderInfo;
  onSubmit: (data: ModelConfigData) => Promise<void>;
  submitting: boolean;
  error: string | null;
}

export default function ModelForm({
  provider,
  onSubmit,
  submitting,
  error,
}: ModelFormProps) {
  const [name, setName] = useState("");
  const [model, setModel] = useState(provider.models[0] ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.default_base_url);
  const [customModel, setCustomModel] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      providerType: provider.type,
      name: name || `${provider.name} - ${model}`,
      model,
      apiKey,
      baseUrl: baseUrl || undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          名称 <span className="text-gray-400">(可选)</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${provider.name} - ${model || "..."}`}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          模型标识 <span className="text-red-500">*</span>
        </label>
        {customModel || provider.models.length === 0 ? (
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="输入模型名，如 gpt-4o"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        ) : (
          <div className="flex gap-2">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {provider.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setCustomModel(true)}
              className="text-sm text-blue-600 hover:underline whitespace-nowrap"
            >
              自定义
            </button>
          </div>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          API Key <span className="text-red-500">*</span>
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          API 端点 <span className="text-gray-400">(选填)</span>
        </label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={provider.default_base_url}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={!model || !apiKey || submitting}
        className="mt-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? "保存中..." : "保存并开始"}
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Create Setup page**

Create `apps/web-agent/src/app/setup/page.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import ProviderCard from "@/components/setup/provider-card";
import ModelForm from "@/components/setup/model-form";
import type { ProviderInfo, ModelConfigData } from "@/types/electron";

function getAPI(): ElectronAPI | null {
  if (typeof window !== "undefined" && window.electronAPI) {
    return window.electronAPI;
  }
  return null;
}

export default function SetupPage() {
  const router = useRouter();
  const api = getAPI();

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selected, setSelected] = useState<ProviderInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (api) {
      api.getProviders().then((list) => {
        setProviders(list);
        setLoading(false);
      });
    } else {
      setLoading(false);
    }
  }, []);

  const handleSubmit = async (data: ModelConfigData) => {
    if (!api) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.saveModelConfig(data);
      if (result.success) {
        await api.completeSetup();
        router.push("/");
      }
    } catch (err: any) {
      setError(err.message ?? "保存失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-400">加载中...</p>
      </main>
    );
  }

  if (!api) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="rounded-xl bg-white p-8 shadow-sm max-w-md text-center">
          <p className="text-gray-500">
            请在 MeshBot Desktop 应用中完成初始化配置。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 py-10">
      <div className="mx-auto max-w-lg px-4">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">
          欢迎使用 MeshBot
        </h1>
        <p className="mb-8 text-gray-500">请先配置模型以开始使用</p>

        <div className="rounded-xl bg-white p-6 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">
            选择供应商
          </h2>

          <div className="mb-6 grid grid-cols-2 gap-2">
            {providers.map((p) => (
              <ProviderCard
                key={p.type}
                type={p.type}
                name={p.name}
                description={p.description}
                selected={selected?.type === p.type}
                onSelect={() => setSelected(p)}
              />
            ))}
          </div>

          {selected && (
            <>
              <div className="mb-4 border-t border-gray-100" />
              <h2 className="mb-3 text-sm font-semibold text-gray-700">
                模型配置
              </h2>
              <ModelForm
                provider={selected}
                onSubmit={handleSubmit}
                submitting={submitting}
                error={error}
              />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Update main page to show existing model status**

Modify `apps/web-agent/src/app/page.tsx` — replace entire file:

```tsx
"use client";

import { useState, useEffect } from "react";

export default function Home() {
  const [status, setStatus] = useState<string>("检查中...");

  useEffect(() => {
    const api = window.electronAPI;
    if (api) {
      api.getSetupStatus().then((s) => {
        setStatus(s.needsSetup ? "需要配置" : "已就绪");
      });
    } else {
      setStatus("浏览器模式（未连接桌面端）");
    }
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-bold">MeshBot Agent</h1>
      <p className="ml-4 text-sm text-gray-400">{status}</p>
    </main>
  );
}
```

- [ ] **Step 6: Build web-agent to verify**

Run: `pnpm --filter @meshbot/web-agent build`
Expected: Compiles without errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web-agent/src/
git commit -m "feat: add setup page with provider selection and model configuration form"
```

---

### Task 7: Server-agent config loading

**Files:**
- Modify: `apps/server-agent/src/app.module.ts`
- Modify: `apps/server-agent/package.json`

- [ ] **Step 1: Add better-sqlite3 and @meshbot/common deps**

Run:
```bash
pnpm --filter @meshbot/server-agent add better-sqlite3 @meshbot/common
pnpm --filter @meshbot/server-agent add -D @types/better-sqlite3
```

- [ ] **Step 2: Update AppModule to load config on startup**

Modify `apps/server-agent/src/app.module.ts` — replace entire file:

```ts
import { Module, type OnModuleInit } from "@nestjs/common";
import Database from "better-sqlite3";
import { homedir } from "os";
import path from "path";

function loadConfig() {
  const meshbotDir = process.env.MESHBOT_DIR ?? path.join(homedir(), ".meshbot");
  const dbPath = path.join(meshbotDir, "agent.db");

  const db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");

  const models = db
    .prepare(
      `SELECT m.id, p.type as provider_type, p.name as provider_name,
              m.name, m.model, m.api_key, m.base_url, p.default_base_url
       FROM models m
       JOIN providers p ON m.provider_id = p.id
       WHERE m.enabled = 1`,
    )
    .all();

  db.close();

  console.log(`[server-agent] Loaded ${models.length} model(s) from agent.db`);
  for (const m of models as any[]) {
    console.log(
      `  - ${m.name}: ${m.provider_type}/${m.model}`,
    );
  }

  return models;
}

@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule implements OnModuleInit {
  onModuleInit() {
    loadConfig();
  }
}
```

- [ ] **Step 3: Build server-agent to verify**

Run: `pnpm --filter @meshbot/server-agent build`
Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add apps/server-agent/src/app.module.ts apps/server-agent/package.json pnpm-lock.yaml
git commit -m "feat: load model config from agent.db on server-agent startup"
```

---

### Task 8: Integration verification

- [ ] **Step 1: Full monorepo build**

Run: `pnpm build`
Expected: All packages and apps compile without errors.

- [ ] **Step 2: Run all tests**

Run: `pnpm --filter @meshbot/desktop test`
Expected: All database tests pass.

- [ ] **Step 3: Dry-run the startup flow**

1. Delete `~/.meshbot/agent.db` if it exists
2. Start web-agent: `pnpm dev:web-agent`
3. Start desktop: `pnpm dev:desktop`
4. Verify: Electron window opens and loads `/setup` page
5. Select a provider, fill model form, click "保存并开始"
6. Verify: Server-agent starts, page navigates to `/`

- [ ] **Step 4: Commit any fixes from integration testing**

```bash
git add -A
git commit -m "fix: integration adjustments for setup flow"
```
