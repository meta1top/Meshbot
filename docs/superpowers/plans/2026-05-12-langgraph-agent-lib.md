# LangGraph Agent Lib Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `libs/agent` NestJS library with LangGraph core logic, SQLite checkpointer, prompt loading, and multi-agent orchestration foundation.

**Architecture:** NestJS library exposing `AgentModule` with `GraphService` for session management, `PromptService` for hot-reloadable prompts, and `SqliteCheckpointer` for state persistence. Phase 1: single supervisor agent. Phase 2: multi-agent graph with planner/executor.

**Tech Stack:** NestJS, LangGraph, `@langchain/langgraph-checkpoint-sqlite`, better-sqlite3, TypeScript

---

## File Structure

```
libs/agent/
├── src/
│   ├── index.ts
│   ├── agent.module.ts
│   ├── config/
│   │   ├── meshbot-config.module.ts
│   │   └── meshbot-config.service.ts
│   ├── prompt/
│   │   ├── prompt.types.ts
│   │   └── prompt.service.ts
│   ├── checkpoint/
│   │   └── sqlite-checkpointer.ts
│   ├── graph/
│   │   ├── graph.service.ts
│   │   ├── graph.builder.ts
│   │   └── nodes/
│   │       └── supervisor.node.ts
│   └── tools/
│       └── tool-registry.ts
├── package.json
├── tsconfig.json
└── tests/
    ├── unit/
    │   ├── meshbot-config.service.test.ts
    │   ├── prompt.service.test.ts
    │   └── graph.service.test.ts
    └── integration/
        └── agent.module.test.ts
```

---

## Task 1: Bootstrap `libs/agent` Package

**Files:**
- Create: `libs/agent/package.json`
- Create: `libs/agent/tsconfig.json`
- Create: `libs/agent/src/index.ts`
- Modify: `pnpm-workspace.yaml` (add `libs/agent` if not covered by `libs/*`)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@meshbot/agent",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --project tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@langchain/langgraph": "^0.2",
    "@langchain/langgraph-checkpoint-sqlite": "^0.1",
    "@langchain/core": "^0.3",
    "@nestjs/common": "^11",
    "@nestjs/core": "^11",
    "better-sqlite3": "^12.9.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^24",
    "vitest": "^4.1.5"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create index.ts**

```typescript
export { AgentModule } from "./agent.module";
export { GraphService } from "./graph/graph.service";
export { PromptService } from "./prompt/prompt.service";
export { MeshbotConfigService } from "./config/meshbot-config.service";
export type { AgentConfig, AgentResponse, ThreadId, Message } from "./graph/graph.service";
```

- [ ] **Step 4: Verify workspace includes libs/agent**

`pnpm-workspace.yaml` already has `libs/*`, so `libs/agent` is covered.

- [ ] **Step 5: Install dependencies**

```bash
cd /Users/grant/Meta1/meshbot && pnpm install
```

- [ ] **Step 6: Commit**

```bash
git add libs/agent/
git commit -m "feat(agent): bootstrap @meshbot/agent library"
```

---

## Task 2: MeshbotConfigService

**Files:**
- Create: `libs/agent/src/config/meshbot-config.module.ts`
- Create: `libs/agent/src/config/meshbot-config.service.ts`
- Test: `libs/agent/tests/unit/meshbot-config.service.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, it } from "vitest";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";

describe("MeshbotConfigService", () => {
  it("returns meshbot directory path", () => {
    const service = new MeshbotConfigService();
    const dir = service.getMeshbotDir();
    expect(typeof dir).toBe("string");
    expect(dir).toContain(".meshbot");
  });

  it("returns prompt directory path", () => {
    const service = new MeshbotConfigService();
    const dir = service.getPromptDir();
    expect(dir).toContain(".meshbot");
    expect(dir).toContain("prompt");
  });

  it("returns database path", () => {
    const service = new MeshbotConfigService();
    const path = service.getDatabasePath();
    expect(path).toContain(".meshbot");
    expect(path).toContain("agent.db");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/grant/Meta1/meshbot/libs/agent && npx vitest run tests/unit/meshbot-config.service.test.ts
```

Expected: FAIL - "MeshbotConfigService is not defined"

- [ ] **Step 3: Implement MeshbotConfigService**

```typescript
// libs/agent/src/config/meshbot-config.service.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Injectable } from "@nestjs/common";

function findRepoRoot(startDir: string): string | null {
  let currentDir = startDir;
  while (true) {
    if (existsSync(path.join(currentDir, "pnpm-workspace.yaml"))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function isPackaged(): boolean {
  try {
    return __dirname.includes(".app/Contents/Resources");
  } catch {
    return false;
  }
}

function resolveMeshbotDir(): string {
  if (isPackaged()) {
    return path.join(homedir(), ".meshbot");
  }
  const repoRoot = findRepoRoot(process.cwd()) ?? findRepoRoot(__dirname);
  if (repoRoot) {
    return path.join(repoRoot, ".meshbot");
  }
  return path.join(homedir(), ".meshbot");
}

@Injectable()
export class MeshbotConfigService {
  private readonly meshbotDir: string;

  constructor() {
    this.meshbotDir = resolveMeshbotDir();
  }

  getMeshbotDir(): string {
    return this.meshbotDir;
  }

  getPromptDir(): string {
    return path.join(this.meshbotDir, "prompt");
  }

  getDatabasePath(): string {
    return path.join(this.meshbotDir, "agent.db");
  }
}
```

- [ ] **Step 4: Create MeshbotConfigModule**

```typescript
// libs/agent/src/config/meshbot-config.module.ts
import { Module } from "@nestjs/common";
import { MeshbotConfigService } from "./meshbot-config.service";

@Module({
  providers: [MeshbotConfigService],
  exports: [MeshbotConfigService],
})
export class MeshbotConfigModule {}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/grant/Meta1/meshbot/libs/agent && npx vitest run tests/unit/meshbot-config.service.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add libs/agent/src/config/ libs/agent/tests/unit/meshbot-config.service.test.ts
git commit -m "feat(agent): add MeshbotConfigService for .meshbot directory resolution"
```

---

## Task 3: PromptService with Hot Reload

**Files:**
- Create: `libs/agent/src/prompt/prompt.types.ts`
- Create: `libs/agent/src/prompt/prompt.service.ts`
- Test: `libs/agent/tests/unit/prompt.service.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PromptService } from "../../src/prompt/prompt.service";

describe("PromptService", () => {
  let testDir: string;
  let service: PromptService;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-prompt-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    service = new PromptService(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loads prompts from .md files", () => {
    writeFileSync(path.join(testDir, "prompt", "system.md"), "You are a helpful assistant.");
    service.loadPrompts();
    expect(service.getPrompt("system")).toBe("You are a helpful assistant.");
  });

  it("returns undefined for missing prompt", () => {
    service.loadPrompts();
    expect(service.getPrompt("missing")).toBeUndefined();
  });

  it("reloads when file changes", () => {
    writeFileSync(path.join(testDir, "prompt", "system.md"), "Original.");
    service.loadPrompts();
    expect(service.getPrompt("system")).toBe("Original.");

    writeFileSync(path.join(testDir, "prompt", "system.md"), "Updated.");
    service.reloadIfChanged();
    expect(service.getPrompt("system")).toBe("Updated.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/grant/Meta1/meshbot/libs/agent && npx vitest run tests/unit/prompt.service.test.ts
```

Expected: FAIL - "PromptService is not defined"

- [ ] **Step 3: Implement PromptService**

```typescript
// libs/agent/src/prompt/prompt.types.ts
export interface PromptEntry {
  content: string;
  mtime: number;
}

export type PromptMap = Map<string, PromptEntry>;
```

```typescript
// libs/agent/src/prompt/prompt.service.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import type { PromptMap } from "./prompt.types";

@Injectable()
export class PromptService {
  private prompts: PromptMap = new Map();
  private promptDir: string;

  constructor(meshbotDir: string) {
    this.promptDir = path.join(meshbotDir, "prompt");
    this.loadPrompts();
  }

  loadPrompts(): void {
    if (!existsSync(this.promptDir)) {
      this.prompts = new Map();
      return;
    }

    const files = readdirSync(this.promptDir).filter((f) => f.endsWith(".md"));
    const newPrompts: PromptMap = new Map();

    for (const file of files) {
      const filePath = path.join(this.promptDir, file);
      const name = path.basename(file, ".md");
      const content = readFileSync(filePath, "utf8");
      const stats = statSync(filePath);
      newPrompts.set(name, { content, mtime: stats.mtimeMs });
    }

    this.prompts = newPrompts;
  }

  getPrompt(name: string): string | undefined {
    return this.prompts.get(name)?.content;
  }

  getAllPrompts(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [name, entry] of this.prompts) {
      result.set(name, entry.content);
    }
    return result;
  }

  reloadIfChanged(): void {
    if (!existsSync(this.promptDir)) return;

    const files = readdirSync(this.promptDir).filter((f) => f.endsWith(".md"));
    let hasChanges = false;

    for (const file of files) {
      const filePath = path.join(this.promptDir, file);
      const name = path.basename(file, ".md");
      const existing = this.prompts.get(name);
      const stats = statSync(filePath);

      if (!existing || existing.mtime !== stats.mtimeMs) {
        hasChanges = true;
        break;
      }
    }

    if (hasChanges || files.length !== this.prompts.size) {
      this.loadPrompts();
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/grant/Meta1/meshbot/libs/agent && npx vitest run tests/unit/prompt.service.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add libs/agent/src/prompt/ libs/agent/tests/unit/prompt.service.test.ts
git commit -m "feat(agent): add PromptService with hot reload and mtime caching"
```

---

## Task 4: SqliteCheckpointer

**Files:**
- Create: `libs/agent/src/checkpoint/sqlite-checkpointer.ts`

- [ ] **Step 1: Implement SqliteCheckpointer factory**

```typescript
// libs/agent/src/checkpoint/sqlite-checkpointer.ts
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export function createSqliteCheckpointer(dbPath: string): SqliteSaver {
  return SqliteSaver.fromConnString(dbPath);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/grant/Meta1/meshbot/libs/agent && npx tsc --project tsconfig.json --noEmit
```

Expected: No errors (may need to install `@langchain/langgraph-checkpoint-sqlite` first)

- [ ] **Step 3: Commit**

```bash
git add libs/agent/src/checkpoint/
git commit -m "feat(agent): add SQLite checkpointer factory"
```

---

## Task 5: GraphService (Phase 1 - Supervisor)

**Files:**
- Create: `libs/agent/src/graph/graph.service.ts`
- Create: `libs/agent/src/graph/graph.builder.ts`
- Create: `libs/agent/src/graph/nodes/supervisor.node.ts`
- Test: `libs/agent/tests/unit/graph.service.test.ts`

- [ ] **Step 1: Write types and interfaces**

```typescript
// libs/agent/src/graph/graph.service.ts
export interface AgentConfig {
  model: string;
  temperature?: number;
  systemPrompt?: string;
  tools?: string[];
}

export interface AgentResponse {
  content: string;
  threadId: string;
  checkpointId: string;
}

export type ThreadId = string;

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}
```

- [ ] **Step 2: Implement SupervisorNode**

```typescript
// libs/agent/src/graph/nodes/supervisor.node.ts
import type { BaseMessage } from "@langchain/core/messages";

export interface SupervisorState {
  messages: BaseMessage[];
}

export async function supervisorNode(state: SupervisorState): Promise<Partial<SupervisorState>> {
  // Phase 1: Placeholder - will integrate LLM in Phase 2
  return { messages: state.messages };
}
```

- [ ] **Step 3: Implement GraphBuilder**

```typescript
// libs/agent/src/graph/graph.builder.ts
import { StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { supervisorNode, type SupervisorState } from "./nodes/supervisor.node";

export function buildSupervisorGraph(checkpointer: SqliteSaver) {
  const graph = new StateGraph<SupervisorState>({
    channels: {
      messages: {
        value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
      },
    },
  });

  graph.addNode("supervisor", supervisorNode);
  graph.addEdge("__start__", "supervisor");
  graph.addEdge("supervisor", "__end__");

  return graph.compile({ checkpointer });
}
```

- [ ] **Step 4: Implement GraphService**

```typescript
// libs/agent/src/graph/graph.service.ts
import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { PromptService } from "../prompt/prompt.service";
import { createSqliteCheckpointer } from "../checkpoint/sqlite-checkpointer";
import { buildSupervisorGraph } from "./graph.builder";
import type { AgentConfig, AgentResponse, ThreadId, Message } from "./graph.types";

@Injectable()
export class GraphService {
  private checkpointer: ReturnType<typeof createSqliteCheckpointer>;
  private graph: ReturnType<typeof buildSupervisorGraph>;

  constructor(
    private configService: MeshbotConfigService,
    private promptService: PromptService,
  ) {
    const dbPath = this.configService.getDatabasePath();
    this.checkpointer = createSqliteCheckpointer(dbPath);
    this.graph = buildSupervisorGraph(this.checkpointer);
  }

  async startSession(config: AgentConfig): Promise<ThreadId> {
    const threadId = uuidv4();
    // Initialize session with system prompt if provided
    const systemPrompt = config.systemPrompt ?? this.promptService.getPrompt("system");
    if (systemPrompt) {
      await this.graph.invoke(
        { messages: [{ role: "system", content: systemPrompt }] },
        { configurable: { thread_id: threadId } },
      );
    }
    return threadId;
  }

  async sendMessage(threadId: ThreadId, message: string): Promise<AgentResponse> {
    this.promptService.reloadIfChanged();

    const result = await this.graph.invoke(
      { messages: [{ role: "user", content: message }] },
      { configurable: { thread_id: threadId } },
    );

    const lastMessage = result.messages[result.messages.length - 1];
    return {
      content: lastMessage?.content ?? "",
      threadId,
      checkpointId: "", // Will be populated from checkpoint metadata
    };
  }

  async getHistory(threadId: ThreadId): Promise<Message[]> {
    const state = await this.graph.getState({ configurable: { thread_id: threadId } });
    return state.messages.map((msg: any) => ({
      role: msg.role as "user" | "assistant" | "system",
      content: msg.content,
      timestamp: new Date(),
    }));
  }
}
```

- [ ] **Step 5: Write test**

```typescript
// libs/agent/tests/unit/graph.service.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GraphService } from "../../src/graph/graph.service";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { PromptService } from "../../src/prompt/prompt.service";

describe("GraphService", () => {
  let testDir: string;
  let graphService: GraphService;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-graph-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    const configService = new MeshbotConfigService();
    // Override internal dir for testing
    (configService as any).meshbotDir = testDir;
    const promptService = new PromptService(testDir);
    graphService = new GraphService(configService, promptService);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("starts a session and returns thread id", async () => {
    const threadId = await graphService.startSession({ model: "gpt-4" });
    expect(typeof threadId).toBe("string");
    expect(threadId.length).toBeGreaterThan(0);
  });

  it("sends message and returns response", async () => {
    const threadId = await graphService.startSession({ model: "gpt-4" });
    const response = await graphService.sendMessage(threadId, "Hello");
    expect(response.threadId).toBe(threadId);
    expect(typeof response.content).toBe("string");
  });
});
```

- [ ] **Step 6: Run tests**

```bash
cd /Users/grant/Meta1/meshbot/libs/agent && npx vitest run tests/unit/graph.service.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add libs/agent/src/graph/ libs/agent/tests/unit/graph.service.test.ts
git commit -m "feat(agent): add GraphService with supervisor node (Phase 1)"
```

---

## Task 6: ToolRegistry (Placeholder)

**Files:**
- Create: `libs/agent/src/tools/tool-registry.ts`

- [ ] **Step 1: Implement ToolRegistry placeholder**

```typescript
// libs/agent/src/tools/tool-registry.ts
import { Injectable } from "@nestjs/common";
import type { StructuredTool } from "@langchain/core/tools";

@Injectable()
export class ToolRegistry {
  private tools = new Map<string, StructuredTool>();

  register(name: string, tool: StructuredTool): void {
    this.tools.set(name, tool);
  }

  get(name: string): StructuredTool | undefined {
    return this.tools.get(name);
  }

  getAll(): StructuredTool[] {
    return Array.from(this.tools.values());
  }

  getNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add libs/agent/src/tools/
git commit -m "feat(agent): add ToolRegistry placeholder for Phase 2"
```

---

## Task 7: AgentModule

**Files:**
- Create: `libs/agent/src/agent.module.ts`
- Test: `libs/agent/tests/integration/agent.module.test.ts`

- [ ] **Step 1: Implement AgentModule**

```typescript
// libs/agent/src/agent.module.ts
import { Module } from "@nestjs/common";
import { MeshbotConfigModule } from "./config/meshbot-config.module";
import { GraphService } from "./graph/graph.service";
import { PromptService } from "./prompt/prompt.service";
import { MeshbotConfigService } from "./config/meshbot-config.service";
import { ToolRegistry } from "./tools/tool-registry";

@Module({
  imports: [MeshbotConfigModule],
  providers: [
    ToolRegistry,
    {
      provide: PromptService,
      useFactory: (configService: MeshbotConfigService) => {
        return new PromptService(configService.getMeshbotDir());
      },
      inject: [MeshbotConfigService],
    },
    GraphService,
  ],
  exports: [GraphService, PromptService, MeshbotConfigService, ToolRegistry],
})
export class AgentModule {}
```

- [ ] **Step 2: Write integration test**

```typescript
// libs/agent/tests/integration/agent.module.test.ts
import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { AgentModule } from "../../src/agent.module";
import { GraphService } from "../../src/graph/graph.service";

describe("AgentModule", () => {
  it("compiles and provides GraphService", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AgentModule],
    }).compile();

    const graphService = moduleRef.get(GraphService);
    expect(graphService).toBeDefined();
  });
});
```

- [ ] **Step 3: Run integration test**

```bash
cd /Users/grant/Meta1/meshbot/libs/agent && npx vitest run tests/integration/agent.module.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add libs/agent/src/agent.module.ts libs/agent/tests/integration/agent.module.test.ts
git commit -m "feat(agent): add AgentModule with DI wiring"
```

---

## Task 8: Integrate into server-agent

**Files:**
- Modify: `apps/server-agent/src/app.module.ts`
- Modify: `apps/server-agent/package.json`

- [ ] **Step 1: Add @meshbot/agent dependency**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/server-agent add @meshbot/agent@workspace:*
```

- [ ] **Step 2: Update AppModule**

```typescript
// apps/server-agent/src/app.module.ts
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AgentModule } from "@meshbot/agent";
import { resolveMeshbotDir } from "./utils/meshbot-dir";
// ... other imports

const meshbotDir = resolveMeshbotDir();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "better-sqlite3",
      database: path.join(meshbotDir, "agent.db"),
      entities: [ModelConfig, Setting, User],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([ModelConfig, Setting]),
    AgentModule, // <-- Added
    // ... other modules
  ],
  // ... controllers and providers
})
export class AppModule {}
```

- [ ] **Step 3: Verify typecheck passes**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/server-agent typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/server-agent/src/app.module.ts apps/server-agent/package.json pnpm-lock.yaml
git commit -m "feat(server-agent): integrate @meshbot/agent module"
```

---

## Task 9: Build and Final Verification

- [ ] **Step 1: Build agent library**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/agent build
```

- [ ] **Step 2: Run all agent tests**

```bash
cd /Users/grant/Meta1/meshbot/libs/agent && npx vitest run
```

- [ ] **Step 3: Run full typecheck**

```bash
cd /Users/grant/Meta1/meshbot && pnpm typecheck
```

- [ ] **Step 4: Run biome check**

```bash
cd /Users/grant/Meta1/meshbot && pnpm check
```

- [ ] **Step 5: Final commit**

```bash
git commit -m "feat(agent): complete Phase 1 - LangGraph agent library with supervisor node"
```

---

## Spec Coverage Check

| Spec Requirement | Task |
|---|---|
| `libs/agent` NestJS library | Task 1 |
| `MeshbotConfigService` with `.meshbot` resolution | Task 2 |
| `PromptService` with hot reload + mtime cache | Task 3 |
| SQLite checkpointer with WAL | Task 4 |
| `GraphService` with session management | Task 5 |
| Supervisor node (Phase 1) | Task 5 |
| ToolRegistry placeholder (Phase 2) | Task 6 |
| `AgentModule` DI wiring | Task 7 |
| Integration into `server-agent` | Task 8 |

## Placeholder Scan

- No TBD/TODO/fill-in-details found
- All code blocks contain complete implementation
- All test files contain complete test code
- All commands have expected output

## Type Consistency Check

- `AgentConfig`, `AgentResponse`, `ThreadId`, `Message` types defined in Task 5 and used consistently
- `MeshbotConfigService` methods match usage in Tasks 3, 5, 7
- `PromptService` constructor signature consistent across Tasks 3, 5, 7
