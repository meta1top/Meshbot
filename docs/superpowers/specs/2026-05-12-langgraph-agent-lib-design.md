# LangGraph Agent Lib 设计

## 目标

创建 `libs/agent` NestJS 库，使用 LangGraph 实现 Agent 核心逻辑，支持多 Agent 编排。

## 架构

```
libs/agent/
├── src/
│   ├── agent.module.ts
│   ├── config/
│   │   ├── meshbot-config.module.ts
│   │   └── meshbot-config.service.ts
│   ├── prompt/
│   │   ├── prompt.service.ts
│   │   └── prompt.types.ts
│   ├── graph/
│   │   ├── graph.service.ts
│   │   ├── graph.builder.ts
│   │   └── nodes/
│   │       ├── supervisor.node.ts
│   │       ├── executor.node.ts
│   │       └── planner.node.ts
│   ├── checkpoint/
│   │   └── sqlite-checkpointer.ts
│   ├── tools/
│   │   └── tool-registry.ts
│   └── index.ts
├── package.json
└── tsconfig.json
```

## 核心组件

### 1. MeshbotConfigService

封装 `resolveMeshbotDir()` 为 NestJS ConfigService，提供 `.meshbot` 目录路径。

```typescript
@Injectable()
export class MeshbotConfigService {
  getMeshbotDir(): string;
  getPromptDir(): string;
  getDatabasePath(): string;
}
```

### 2. PromptService

读取 `.meshbot/prompt/*.md`，按文件名（不含扩展名）作为 key 缓存。

- 启动时加载全部 `.md`
- 每次新会话检查 `mtime`，有变化则重载
- 缓存策略：文件修改时间比对

```typescript
@Injectable()
export class PromptService {
  getPrompt(name: string): string;
  getAllPrompts(): Map<string, string>;
  reloadIfChanged(): Promise<void>;
}
```

### 3. SqliteCheckpointer

使用 `@langchain/langgraph-checkpoint-sqlite` 的 `SqliteSaver`。

- 数据库路径与 TypeORM 相同：`agent.db`
- 启用 WAL 模式
- Checkpointer 表使用 `checkpoint_` 前缀，避免与 TypeORM 表冲突

```typescript
export function createSqliteCheckpointer(dbPath: string): SqliteSaver;
```

### 4. GraphService

LangGraph 编译和管理。

```typescript
@Injectable()
export class GraphService {
  startSession(config: AgentConfig): Promise<ThreadId>;
  sendMessage(threadId: ThreadId, message: string): Promise<AgentResponse>;
  getHistory(threadId: ThreadId): Promise<Message[]>;
}
```

### 5. Agent 节点（分阶段实现）

**第一阶段**：单 Agent（Supervisor）对话
- `supervisor.node.ts`：处理用户消息，调用 LLM，返回回复

**第二阶段**：多 Agent 编排
- `supervisor.node.ts`：路由消息到子 Agent
- `planner.node.ts`：分解任务，制定执行计划
- `executor.node.ts`：执行具体任务，调用工具

### 6. ToolRegistry

工具注册中心，第二阶段实现。

```typescript
@Injectable()
export class ToolRegistry {
  register(name: string, tool: Tool): void;
  get(name: string): Tool;
  getAll(): Tool[];
}
```

## 数据流

```
用户消息 → API Controller → AgentService → LangGraph
                                              │
                    ┌─────────────────────────┘
                    ▼
            SQLite Checkpointer (agent.db)
                    │
                    ▼
            PromptService (读取 .meshbot/prompt/*.md)
```

## 接口定义

```typescript
interface AgentConfig {
  model: string;
  temperature?: number;
  systemPrompt?: string;
  tools?: string[];
}

interface AgentResponse {
  content: string;
  threadId: string;
  checkpointId: string;
}

type ThreadId = string;

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}
```

## 依赖

- `@langchain/langgraph`
- `@langchain/langgraph-checkpoint-sqlite`
- `@langchain/core`
- `@nestjs/common`
- `better-sqlite3`

## 集成到 server-agent

```typescript
// apps/server-agent/src/app.module.ts
import { AgentModule } from "@meshbot/agent";

@Module({
  imports: [
    TypeOrmModule.forRoot({...}),
    AgentModule.forRoot(),
    // ...
  ],
})
export class AppModule {}
```

## 关键设计决策

| 决策 | 选择 |
|------|------|
| .meshbot 目录获取 | ConfigService 注入（MeshbotConfigService） |
| Prompt 加载 | 热更新 + 缓存（mtime 检查） |
| Checkpointer | SqliteSaver，WAL 模式，表名前缀 `checkpoint_` |
| Agent 编排 | 分阶段：单 Agent → 多 Agent |
| 工具 | 第二阶段实现 |
