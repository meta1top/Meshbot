# 本地多 Agent 地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一台设备可以创建多个 Agent，各自拥有独立的人格（system prompt）、技能目录、MCP 配置、记忆、工作区与默认模型；会话绑定到某个 Agent；本地 UI 可切换。

**Architecture:** 新增 `agents` 表（SQLite）承载元数据，物理内容下沉到 `accounts/<cloudUserId>/agents/<agentId>/{memory,skills,mcp.json,workspace}`。运行时靠一条新的 `AgentContextService`（AsyncLocalStorage）传递当前 agentId——`MeshbotConfigService` 的路径 getter 从 ALS 取 agentId，于是 `SkillService` / `MemoryService` / 所有文件工具**零改动自动按 agent 隔离**。LangGraph 图完全不用改：它注入的工具集与模型本来就是每轮从 ALS 惰性求值的。

**Tech Stack:** NestJS 11 / TypeORM (SQLite) / LangGraph 1.x / Zod (`createZodDto`) / Next.js 15 + Jotai / Jest。

## Global Constraints

- 数据库列名 snake_case（项目配置 `SnakeNamingStrategy`）。
- 本地轨 schema 用 TypeORM 迁移文件（`apps/server-agent/src/migrations/`），启动自动跑；`down()` 空实现（SQLite 不支持 DROP COLUMN，与既有迁移一致）。
- 禁止数据库级外键约束（不用 `@ManyToOne` / `@OneToMany` / `@JoinColumn`）。
- 带 `cloud_user_id` 的 Entity 必须经 `ScopedRepository`（`check:scope` 静态围栏强制）；每个 Entity 有且仅有一个归属 Service 持有 `@InjectRepository`（`check:repo`）。
- 跨表写入才加 `@Transactional()`；单表 upsert / update **不加**（`check:tx` 会把多余的判为 REDUNDANT）。私有 `@Transactional()` 方法命名必须是 `*InDb` / `*InTx` / `*InTransaction` / `persist*`（`check:naming`）。
- `libs/types-*` 禁止依赖 NestJS / TypeORM。
- 公开方法写中文 JSDoc。禁止在 `if` 前一行放注释（Biome 会破坏结构）。
- 前端所有用户可见字符串走 next-intl `useTranslations`，禁止裸字符串；新增嵌套 key 后必须跑 `pnpm sync:locales --write` 补 stub。
- 每个 Task 结束前跑 `pnpm check`（7 道静态围栏）+ 相关单测。
- **存量不兼容**：本计划不写迁移兼容代码。Task 1 会要求先清空本地 `.meshbot/accounts/`。

## 已确认的设计前提（来自 spec，不要重新讨论）

1. Agent 是**完全独立体**：独立记忆 / 工作区 / 技能目录 / MCP 进程池。
2. **checkpointer 不下沉**——仍是账号级 `accounts/<id>/agent.db`。`thread_id` 就是 session id，天然隔离；subagent 子图复用同一 checkpointer 是硬不变量。
3. **`AccountGraphProvider` 与 `graph.builder.ts` 一行都不改。**
4. **`ModelResolver` 一行都不改**——三级优先级由 `RunnerService` 传入的覆盖 id 实现。
5. `remote_enabled` / `visibility` 两列本计划**建但不用**（云端注册是计划二），避免二次迁移。

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `apps/server-agent/src/entities/agent.entity.ts` | `agents` 表 Entity |
| `apps/server-agent/src/migrations/1781200000000-AddAgents.ts` | 建 `agents` 表 + `sessions.agent_id` 列 |
| `apps/server-agent/src/services/agent.service.ts` | `Agent` 的唯一归属 Service（CRUD + 默认 agent 引导） |
| `apps/server-agent/src/services/agent.service.spec.ts` | 单测 |
| `apps/server-agent/src/controllers/agent.controller.ts` | Agent CRUD REST |
| `apps/server-agent/src/controllers/mcp.controller.ts` | 当前 agent 的 mcp.json 读写 REST |
| `libs/agent/src/account/agent-context.service.ts` | 当前 agentId 的 ALS |
| `libs/agent/src/account/agent-context.service.spec.ts` | 单测 |
| `libs/types-agent/src/agent.ts` | Agent 的 Zod schema（跨端共享） |
| `apps/web-agent/src/atoms/agent.ts` | 当前 agent 的 Jotai atom（持久化） |
| `apps/web-agent/src/rest/agents.ts` | Agent REST 客户端 |
| `apps/web-agent/src/components/shell/agent-rail.tsx` | 最左 agent 图标导航条 |
| `apps/web-agent/src/components/agent/agent-editor-sheet.tsx` | Agent 新建/编辑抽屉 |
| `apps/web-agent/src/components/agent/mcp-editor.tsx` | MCP 配置编辑器 |

**修改**

| 文件 | 改动 |
|---|---|
| `libs/agent/src/config/meshbot-config.service.ts` | 四个路径 getter 下沉到 `agents/<agentId>/` |
| `libs/agent/src/tools/tool-registry.ts` | `accountEntries` key 加 agent 维度 |
| `libs/agent/src/mcp/mcp.service.ts` | `perAccount` → `perAgent`，懒加载 + 闲置回收 |
| `libs/agent/src/graph/runtime-context.port.ts` | `resolve()` 增 `agentName` / `agentSystemPrompt`，删 `quickAssistantName` |
| `libs/agent/src/graph/context-builder.ts` | 新增 `buildPersonaMessage()` |
| `libs/agent/src/graph/graph-runner.service.ts` | 人格改为每轮刷新的 `system:persona` |
| `apps/server-agent/src/entities/session.entity.ts` | 加 `agentId` 列 |
| `apps/server-agent/src/services/session.service.ts` | 建会话绑定 agentId；subagent 继承父会话 |
| `apps/server-agent/src/services/runner.service.ts` | 把 agentId 压入 ALS；模型三级优先级 |
| `apps/server-agent/src/runtime-context.module.ts` | 端口实现改读 `AgentService` |
| `apps/server-agent/src/skills/skill-install.service.ts` | 4 处 `getSkillsDir()` 的调用方要带 agent 上下文 |
| `apps/server-agent/src/controllers/skill.controller.ts` | 带 agentId 参数，包 `agentContext.run()` |
| `apps/server-agent/src/controllers/artifact.controller.ts` | 同上 |
| `apps/server-agent/src/services/remote-artifact.service.ts` | 同上 |
| `apps/server-agent/src/account/account-runtime.registry.ts` | 去掉登录时的 `mcp.initAccount` |
| `apps/web-agent/src/app/(shell)/layout.tsx` | 挂载 agent 导航条 |

**删除**

| 文件 | 原因 |
|---|---|
| `apps/server-agent/src/services/quick-assistant.service.ts` | 名字收编进 `agent.name` |
| `libs/agent/src/tools/builtins/rename-quick-assistant.tool.ts` | 改名为 `rename_agent`，重写 |

---

## Task 1: `agents` 表 + AgentService CRUD

**Files:**
- Create: `apps/server-agent/src/entities/agent.entity.ts`
- Create: `apps/server-agent/src/migrations/1781200000000-AddAgents.ts`
- Create: `apps/server-agent/src/services/agent.service.ts`
- Create: `apps/server-agent/src/services/agent.service.spec.ts`
- Create: `libs/types-agent/src/agent.ts`
- Modify: `libs/types-agent/src/index.ts`
- Modify: `apps/server-agent/src/app.module.ts`（注册 Entity + Service）

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  - `Agent` entity，字段：`id` / `cloudUserId` / `name` / `avatar` / `description` / `systemPrompt` / `defaultModelConfigId` / `remoteEnabled` / `visibility` / `sortOrder` / `createdAt` / `updatedAt`
  - `AgentService`：`list(): Promise<Agent[]>` / `findOrNull(id: string): Promise<Agent | null>` / `create(input: AgentCreateInput): Promise<Agent>` / `update(id: string, input: AgentUpdateInput): Promise<Agent>` / `remove(id: string): Promise<void>` / `ensureDefault(): Promise<Agent>`
  - `libs/types-agent`：`AgentCreateSchema` / `AgentUpdateSchema` / `AgentViewSchema`，及类型 `AgentCreateInput` / `AgentUpdateInput` / `AgentView`；常量 `DEFAULT_AGENT_NAME = "M"`、`DEFAULT_AGENT_AVATAR = "🤖|#f97316"`

- [ ] **Step 0: 清空存量本地数据**

本计划不做迁移兼容。先备份并清掉本地账号数据树，否则 `sessions.agent_id` NOT NULL 会让老会话跑不起来。

```bash
# 源码态 dev 的数据根是 <repoRoot>/.meshbot
mv .meshbot .meshbot.bak-$(git rev-parse --short HEAD)
```

- [ ] **Step 1: 写 Zod schema（先写，实体和 DTO 都依赖它）**

`libs/types-agent/src/agent.ts`：

```ts
import { z } from "zod";

/** 默认 Agent 的名字（账号下零 agent 时自动创建）。 */
export const DEFAULT_AGENT_NAME = "M";

/** 默认 Agent 的头像：`emoji|背景色` 两段式，前端拆开渲染。 */
export const DEFAULT_AGENT_AVATAR = "🤖|#f97316";

/** 远程可见性。本期恒 private，org 为云端注册（计划二）预留。 */
export const AgentVisibilitySchema = z.enum(["private", "org"]);

/** 创建 Agent 的入参。 */
export const AgentCreateSchema = z.object({
  name: z.string().min(1).max(32),
  avatar: z.string().min(1).max(64),
  description: z.string().max(200).default(""),
  systemPrompt: z.string().max(20_000).default(""),
  defaultModelConfigId: z.string().nullable().default(null),
});

/** 更新 Agent 的入参（全字段可选）。 */
export const AgentUpdateSchema = AgentCreateSchema.partial().extend({
  remoteEnabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/** Agent 对外视图。 */
export const AgentViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  defaultModelConfigId: z.string().nullable(),
  remoteEnabled: z.boolean(),
  visibility: AgentVisibilitySchema,
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AgentVisibility = z.infer<typeof AgentVisibilitySchema>;
export type AgentCreateInput = z.infer<typeof AgentCreateSchema>;
export type AgentUpdateInput = z.infer<typeof AgentUpdateSchema>;
export type AgentView = z.infer<typeof AgentViewSchema>;
```

在 `libs/types-agent/src/index.ts` 末尾加：

```ts
export * from "./agent";
```

- [ ] **Step 2: 写失败的单测**

`apps/server-agent/src/services/agent.service.spec.ts`。参照仓库既有 service 单测的建库方式（用内存 SQLite DataSource + `ScopedRepositoryFactory`）：

```ts
import { DEFAULT_AGENT_NAME } from "@meshbot/types-agent";
import { AccountContextService } from "@meshbot/lib-agent";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { Agent } from "../entities/agent.entity";
import { AgentService } from "./agent.service";

describe("AgentService", () => {
  let ds: DataSource;
  let service: AgentService;
  let account: AccountContextService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Agent],
      synchronize: true,
    });
    await ds.initialize();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentService,
        AccountContextService,
        ScopedRepositoryFactory,
        {
          provide: getRepositoryToken(Agent),
          useValue: ds.getRepository(Agent),
        },
      ],
    }).compile();
    service = moduleRef.get(AgentService);
    account = moduleRef.get(AccountContextService);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("create 后能按 id 查回，且带上当前账号", async () => {
    await account.run("acct-1", async () => {
      const created = await service.create({
        name: "研发助手",
        avatar: "🛠️|#3b82f6",
        description: "写代码",
        systemPrompt: "你是研发助手",
        defaultModelConfigId: null,
      });
      expect(created.id).toBeTruthy();
      const found = await service.findOrNull(created.id);
      expect(found?.name).toBe("研发助手");
      expect(found?.cloudUserId).toBe("acct-1");
      expect(found?.remoteEnabled).toBe(false);
      expect(found?.visibility).toBe("private");
    });
  });

  it("按账号隔离：另一个账号看不到", async () => {
    const id = await account.run("acct-1", () =>
      service
        .create({
          name: "A",
          avatar: "🅰️|#000000",
          description: "",
          systemPrompt: "",
          defaultModelConfigId: null,
        })
        .then((a) => a.id),
    );
    await account.run("acct-2", async () => {
      expect(await service.findOrNull(id)).toBeNull();
      expect(await service.list()).toHaveLength(0);
    });
  });

  it("ensureDefault：零 agent 时建默认 agent；已有时原样返回第一个", async () => {
    await account.run("acct-1", async () => {
      const first = await service.ensureDefault();
      expect(first.name).toBe(DEFAULT_AGENT_NAME);
      const again = await service.ensureDefault();
      expect(again.id).toBe(first.id);
      expect(await service.list()).toHaveLength(1);
    });
  });

  it("update 只改传入字段", async () => {
    await account.run("acct-1", async () => {
      const a = await service.create({
        name: "旧名",
        avatar: "🤖|#f97316",
        description: "描述",
        systemPrompt: "提示词",
        defaultModelConfigId: null,
      });
      const updated = await service.update(a.id, { name: "新名" });
      expect(updated.name).toBe("新名");
      expect(updated.systemPrompt).toBe("提示词");
      expect(updated.description).toBe("描述");
    });
  });

  it("remove 后查不到", async () => {
    await account.run("acct-1", async () => {
      const a = await service.create({
        name: "临时",
        avatar: "🤖|#f97316",
        description: "",
        systemPrompt: "",
        defaultModelConfigId: null,
      });
      await service.remove(a.id);
      expect(await service.findOrNull(a.id)).toBeNull();
    });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm test -- agent.service.spec
```
Expected: FAIL —— `Cannot find module '../entities/agent.entity'`

- [ ] **Step 4: 写 Entity**

`apps/server-agent/src/entities/agent.entity.ts`：

```ts
import { SnowflakeBaseEntity } from "@meshbot/common";
import type { AgentVisibility } from "@meshbot/types-agent";
import { Column, CreateDateColumn, Entity, UpdateDateColumn } from "typeorm";

/**
 * Agent 表 —— 一个设备（账号）下可有多个 Agent，各自独立的人格/技能/MCP/记忆/工作区。
 * 物理内容落在 accounts/<cloudUserId>/agents/<id>/ 下，本表只存元数据。
 */
@Entity("agents")
export class Agent extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ type: "text" })
  name!: string;

  /** `emoji|背景色` 两段式，如 `🛠️|#3b82f6`。 */
  @Column({ type: "text" })
  avatar!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  /** 人格正文。每轮以 system:persona 稳定 id 注入，可随时改、立即对老会话生效。 */
  @Column({ name: "system_prompt", type: "text", default: "" })
  systemPrompt!: string;

  /** 该 Agent 的默认模型；会话级 modelConfigId 优先于它。 */
  @Column({ name: "default_model_config_id", type: "text", nullable: true })
  defaultModelConfigId!: string | null;

  /** 「允许远程」开关。本期只建列不消费，云端注册在计划二。 */
  @Column({ name: "remote_enabled", type: "boolean", default: false })
  remoteEnabled!: boolean;

  /** 远程可见性。本期恒 private，org 为组织共享预留。 */
  @Column({ type: "text", default: "private" })
  visibility!: AgentVisibility;

  @Column({ name: "sort_order", type: "integer", default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
```

- [ ] **Step 5: 写迁移**

`apps/server-agent/src/migrations/1781200000000-AddAgents.ts`：

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 一设备多 Agent 地基：
 * - agents 表：Agent 元数据（人格/头像/默认模型/远程开关）
 * - sessions.agent_id：会话归属的 Agent（NOT NULL —— 存量不兼容，需先清库）
 * SQLite 限制：down 不删列/表（与既有迁移约定一致）。
 */
export class AddAgents1781200000000 implements MigrationInterface {
  name = "AddAgents1781200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agents" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "avatar" TEXT NOT NULL,
        "description" TEXT NOT NULL DEFAULT '',
        "system_prompt" TEXT NOT NULL DEFAULT '',
        "default_model_config_id" TEXT,
        "remote_enabled" boolean NOT NULL DEFAULT (0),
        "visibility" TEXT NOT NULL DEFAULT 'private',
        "sort_order" integer NOT NULL DEFAULT (0),
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_agents_cloud_user" ON "agents" ("cloud_user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "agent_id" TEXT NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_sessions_agent" ON "sessions" ("agent_id")`,
    );
  }

  public async down(): Promise<void> {
    // SQLite 不支持 DROP COLUMN（旧版），保持结构（幂等，与仓库既有迁移一致）
  }
}
```

> 注：`agent_id` 用 `NOT NULL DEFAULT ''` 而非纯 NOT NULL —— SQLite 给已有表加 NOT NULL 列必须有默认值。清库后不会有 `''` 的行；Task 3 的 SessionService 保证写入时永远有真实 agentId。

- [ ] **Step 6: 写 AgentService**

`apps/server-agent/src/services/agent.service.ts`：

```ts
import {
  DEFAULT_AGENT_AVATAR,
  DEFAULT_AGENT_NAME,
  type AgentCreateInput,
  type AgentUpdateInput,
} from "@meshbot/types-agent";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { Agent } from "../entities/agent.entity";

/** Agent 表的归属 Service —— 一个设备下多个 Agent 的数据层（按账号隔离）。 */
@Injectable()
export class AgentService {
  /** Agent 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly repo: ScopedRepository<Agent>;

  /** 裸仓库：仅供 @Transactional 的 findDataSource 反射定位 DataSource，业务读写一律走 repo。 */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: findDataSource 反射读取
  private readonly txAnchorRepo: Repository<Agent>;

  constructor(
    @InjectRepository(Agent)
    rawRepo: Repository<Agent>,
    scopedFactory: ScopedRepositoryFactory,
  ) {
    this.repo = scopedFactory.create(rawRepo);
    this.txAnchorRepo = rawRepo;
  }

  /** 列出当前账号的全部 Agent，按 sortOrder、创建时间升序。 */
  list(): Promise<Agent[]> {
    return this.repo.find({
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
  }

  /** 按 id 取 Agent；不存在或不属于当前账号返回 null。 */
  findOrNull(id: string): Promise<Agent | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** 按 id 取 Agent；不存在抛 404。 */
  async findOrThrow(id: string): Promise<Agent> {
    const agent = await this.findOrNull(id);
    if (!agent) {
      throw new NotFoundException(`Agent 不存在：${id}`);
    }
    return agent;
  }

  /** 创建一个 Agent。 */
  async create(input: AgentCreateInput): Promise<Agent> {
    const entity = this.repo.create({
      name: input.name,
      avatar: input.avatar,
      description: input.description,
      systemPrompt: input.systemPrompt,
      defaultModelConfigId: input.defaultModelConfigId,
    });
    return this.repo.save(entity);
  }

  /** 更新 Agent（只覆盖传入字段）。 */
  async update(id: string, input: AgentUpdateInput): Promise<Agent> {
    const agent = await this.findOrThrow(id);
    Object.assign(agent, input);
    return this.repo.save(agent);
  }

  /** 删除 Agent。注意：磁盘目录由调用方（Controller）负责清理。 */
  async remove(id: string): Promise<void> {
    await this.findOrThrow(id);
    await this.repo.delete({ id });
  }

  /**
   * 保证当前账号至少有一个 Agent：零 agent 时建默认 Agent，否则返回第一个。
   * 启动引导与登录后都会调；幂等。
   */
  async ensureDefault(): Promise<Agent> {
    const existing = await this.list();
    if (existing.length > 0) {
      return existing[0];
    }
    return this.create({
      name: DEFAULT_AGENT_NAME,
      avatar: DEFAULT_AGENT_AVATAR,
      description: "",
      systemPrompt: "",
      defaultModelConfigId: null,
    });
  }
}
```

> **雪花 id 坑**：必须用 `this.repo.create({...})` 再 `save`，不能给 `save()` 传 plain object，也不能用 `.insert()` —— `SnowflakeBaseEntity` 的 `@BeforeInsert` hook 只在真实体实例上触发，否则 id 写 NULL。

- [ ] **Step 7: 在 app.module 注册**

在 `apps/server-agent/src/app.module.ts` 里：把 `Agent` 加进 `TxTypeOrmModule.forFeature([...])` 的实体数组，把 `AgentService` 加进 `providers` 与 `exports`。迁移会被 `migrationsRun: true` 自动执行，无需额外注册（迁移目录是 glob 扫描）。

- [ ] **Step 8: 跑测试确认通过**

```bash
pnpm test -- agent.service.spec
```
Expected: PASS（5 个用例全绿）

- [ ] **Step 9: 跑静态围栏**

```bash
pnpm check
```
Expected: 全部 0 finding。重点确认 `check:scope` 把 `Agent` 识别为账号作用域 Entity、`check:repo` 把 `AgentService` 认作唯一归属。

- [ ] **Step 10: Commit**

```bash
git add apps/server-agent/src/entities/agent.entity.ts \
        apps/server-agent/src/migrations/1781200000000-AddAgents.ts \
        apps/server-agent/src/services/agent.service.ts \
        apps/server-agent/src/services/agent.service.spec.ts \
        apps/server-agent/src/app.module.ts \
        libs/types-agent/src/agent.ts \
        libs/types-agent/src/index.ts
git commit -m "feat(agent): agents 表 + AgentService —— 一设备多 Agent 的数据层"
```

---

## Task 2: sessions.agent_id — 会话绑定 Agent

**Files:**
- Modify: `apps/server-agent/src/entities/session.entity.ts`
- Modify: `apps/server-agent/src/services/session.service.ts`
- Modify: `apps/server-agent/src/services/session.service.spec.ts`
- Modify: `apps/server-agent/src/services/dispatch-subagent.service.ts`

**Interfaces:**
- Consumes: Task 1 的 `AgentService.ensureDefault()` / `Agent` entity
- Produces: `Session.agentId: string`（NOT NULL）；`SessionService.create()` 增加必填 `agentId` 入参；subagent 子会话继承父会话 `agentId`

- [ ] **Step 1: 写失败的单测**

在 `apps/server-agent/src/services/session.service.spec.ts` 追加：

```ts
it("建会话必须带 agentId，并原样落库", async () => {
  await account.run("acct-1", async () => {
    const s = await service.create({ title: "新会话", agentId: "agent-1" });
    const found = await service.findOrNull(s.id);
    expect(found?.agentId).toBe("agent-1");
  });
});

it("subagent 子会话继承父会话的 agentId", async () => {
  await account.run("acct-1", async () => {
    const parent = await service.create({ title: "父", agentId: "agent-7" });
    const child = await service.createSubSession({
      parentSessionId: parent.id,
      parentToolCallId: "tc-1",
      title: "子",
      modelConfigId: null,
    });
    expect(child.agentId).toBe("agent-7");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- session.service.spec
```
Expected: FAIL —— `create` 不接受 `agentId`，`Session` 上没有 `agentId` 属性（TS 报错）

- [ ] **Step 3: Session 实体加列**

在 `apps/server-agent/src/entities/session.entity.ts` 的 `modelConfigId` 之前插入：

```ts
  /** 会话归属的 Agent（NOT NULL）。人格/技能/MCP/记忆/工作区全按它解析。 */
  @Column({ name: "agent_id", type: "text" })
  agentId!: string;
```

- [ ] **Step 4: SessionService 建会话带 agentId**

`create()` 的入参类型加必填 `agentId: string`，落库时透传。`createSubSession()` 先读父会话拿 `agentId`，写进子会话：

```ts
  /** 建子会话：agentId 继承父会话——子 Agent 必须跑在同一个 Agent 的技能/工作区里。 */
  async createSubSession(input: {
    parentSessionId: string;
    parentToolCallId: string;
    title: string;
    modelConfigId: string | null;
  }): Promise<Session> {
    const parent = await this.findOrThrow(input.parentSessionId);
    const entity = this.repo.create({
      title: input.title,
      kind: "subagent",
      agentId: parent.agentId,
      parentSessionId: input.parentSessionId,
      parentToolCallId: input.parentToolCallId,
      modelConfigId: input.modelConfigId,
    });
    return this.repo.save(entity);
  }
```

`dispatch-subagent.service.ts` 调用 `createSubSession` 处不用改（它没传 agentId，现在由父会话推导）。

- [ ] **Step 5: 修所有 `sessions.create()` 调用点**

`agentId` 变必填后 TS 会把所有调用点标红。逐个修：REST 建会话（Controller 从请求带 agentId）、quick 会话、远程 run 入站建会话。跑 typecheck 定位：

```bash
pnpm typecheck
```
Expected: 报错列表就是待修清单。每处都要有真实 agentId 来源——**不要用空串兜底**，拿不到就调 `agents.ensureDefault()`。

- [ ] **Step 6: 跑测试确认通过**

```bash
pnpm test -- session.service.spec && pnpm typecheck
```
Expected: PASS + 0 类型错误

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(agent): sessions.agent_id —— 会话绑定 Agent，子会话继承父会话"
```

---

## Task 3: AgentContextService（ALS）+ RunnerService 贯通

**Files:**
- Create: `libs/agent/src/account/agent-context.service.ts`
- Create: `libs/agent/src/account/agent-context.service.spec.ts`
- Modify: `libs/agent/src/index.ts`（导出）
- Modify: `libs/agent/src/agent.module.ts`（provide + export）
- Modify: `apps/server-agent/src/services/runner.service.ts`
- Modify: `apps/server-agent/src/services/runner.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 `AgentService`；Task 2 `Session.agentId`
- Produces: `AgentContextService`（`run<T>(agentId: string, fn: () => T): T` / `get(): string | null` / `getOrThrow(): string`）；一次 run 期间 ALS 里必有当前 agentId

- [ ] **Step 1: 写失败的单测**

`libs/agent/src/account/agent-context.service.spec.ts`：

```ts
import { AgentContextService } from "./agent-context.service";

describe("AgentContextService", () => {
  it("run 内可读到 agentId，run 外为 null", () => {
    const svc = new AgentContextService();
    expect(svc.get()).toBeNull();
    svc.run("agent-1", () => {
      expect(svc.get()).toBe("agent-1");
    });
    expect(svc.get()).toBeNull();
  });

  it("getOrThrow 在无上下文时抛错", () => {
    const svc = new AgentContextService();
    expect(() => svc.getOrThrow()).toThrow(/无活跃 Agent 上下文/);
  });

  it("异步连续体自动继承", async () => {
    const svc = new AgentContextService();
    await svc.run("agent-2", async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(svc.get()).toBe("agent-2");
    });
  });

  it("嵌套 run 内层覆盖外层，退出后恢复", () => {
    const svc = new AgentContextService();
    svc.run("outer", () => {
      svc.run("inner", () => {
        expect(svc.get()).toBe("inner");
      });
      expect(svc.get()).toBe("outer");
    });
  });
});
```

`apps/server-agent/src/services/runner.service.spec.ts` 追加：

```ts
it("run 期间 ALS 里是该会话绑定的 agentId", async () => {
  const seen: (string | null)[] = [];
  graphRunner.streamMessage = jest.fn(async function* () {
    seen.push(agentContext.get());
    yield { kind: "usage", usage: {} } as never;
  });
  await sessions.create({ title: "T", agentId: "agent-42" });
  // ...kick 该会话，等 run 结束
  expect(seen).toEqual(["agent-42"]);
});

it("模型三级优先级：会话覆盖 > agent 默认 > 账号启用", async () => {
  const overrides: (string | null)[] = [];
  modelRunCtx.run = jest.fn((id, fn) => {
    overrides.push(id);
    return fn();
  });
  // agent.defaultModelConfigId = "m-agent"，session.modelConfigId = null
  // → 期望传入 "m-agent"
  // session.modelConfigId = "m-session" → 期望传入 "m-session"
  expect(overrides).toEqual(["m-agent", "m-session"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- agent-context.service.spec
```
Expected: FAIL —— `Cannot find module './agent-context.service'`

- [ ] **Step 3: 写 AgentContextService**

`libs/agent/src/account/agent-context.service.ts`：

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

interface AgentStore {
  agentId: string;
}

/**
 * 进程内「当前 Agent 上下文」。
 *
 * 一个账号下可有多个 Agent，各自独立的人格/技能/MCP/记忆/工作区。本 ALS 承载
 * 当前 run（或当前 REST 请求）作用的 agentId：
 * - run 路径：RunnerService 读 session.agentId，包住「建流 + for-await」整段。
 * - REST 路径：Controller 从请求参数取 agentId 显式 run()。
 *
 * MeshbotConfigService 的路径 getter 从这里取 agentId 拼 agents/<agentId>/...，
 * 因此 SkillService / MemoryService / 文件工具零改动自动按 Agent 隔离。
 */
@Injectable()
export class AgentContextService {
  private readonly als = new AsyncLocalStorage<AgentStore>();

  /** 在指定 Agent 上下文中运行 fn（同步或异步）。 */
  run<T>(agentId: string, fn: () => T): T {
    return this.als.run({ agentId }, fn);
  }

  /** 当前 agentId；无上下文返回 null。 */
  get(): string | null {
    return this.als.getStore()?.agentId ?? null;
  }

  /**
   * 当前 agentId；无上下文抛错（内部不变量：Agent 化文件访问必须在 Agent 上下文内，
   * 触发说明存在编程错误）。
   */
  getOrThrow(): string {
    const id = this.get();
    if (!id) {
      throw new Error(
        "AgentContext: 当前无活跃 Agent 上下文（Agent 化文件访问运行在 Agent 上下文之外）",
      );
    }
    return id;
  }
}
```

在 `libs/agent/src/index.ts` 导出，在 `libs/agent/src/agent.module.ts` 的 `providers` 与 `exports` 里加 `AgentContextService`。

- [ ] **Step 4: RunnerService 压入 ALS + 模型三级优先级**

改 `apps/server-agent/src/services/runner.service.ts` 的 `consumeRunStream`（现在在 :480）：

```ts
  /**
   * stream 消费入口：先读 session 拿 kind（subAgent 判定）、agentId、modelConfigId，
   * 再把「建流 + for-await 消费 + finally」整段包进 AgentContext + ModelRunContext ——
   * async generator 的 next() 跑在调用方（本方法）的 ALS 上下文里，包裹范围必须
   * 覆盖整个消费循环，只包建流无效。
   *
   * 模型三级优先级：会话覆盖 > Agent 默认 > 账号启用首行（最后一级由 ModelResolver 兜底）。
   */
  private async consumeRunStream(
    sessionId: string,
    batch: { id: string; content: string }[],
    run: InflightRun,
    resume: boolean,
    runStartedAt: number,
  ): Promise<void> {
    const session = await this.sessions.findOrNull(sessionId);
    const subAgent = session?.kind === "subagent";
    const agentId = session?.agentId ?? (await this.agents.ensureDefault()).id;
    const agent = await this.agents.findOrNull(agentId);
    const modelOverride =
      session?.modelConfigId ?? agent?.defaultModelConfigId ?? null;
    await this.agentCtx.run(agentId, () =>
      this.modelRunCtx.run(modelOverride, () =>
        this.consumeRunStreamInCtx(
          sessionId,
          batch,
          run,
          resume,
          runStartedAt,
          subAgent,
        ),
      ),
    );
  }
```

构造函数注入 `AgentContextService` 与 `AgentService`。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm test -- agent-context.service.spec runner.service.spec
```
Expected: PASS

- [ ] **Step 6: 跑静态围栏 + 全量单测**

```bash
pnpm check && pnpm test
```
Expected: 围栏 0 finding；全量测试无新增失败

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(agent): AgentContext ALS + RunnerService 贯通（含模型三级优先级）"
```

---

## Task 4: 路径 getter 下沉 —— 技能/记忆/工作区自动按 Agent 隔离

**这是全案的杠杆点。** 改完这个 getter，`SkillService` / `MemoryService` / 7 个文件工具**一行不改**就按 Agent 隔离了。

**Files:**
- Modify: `libs/agent/src/config/meshbot-config.service.ts`
- Modify: `libs/agent/tests/unit/meshbot-config.service.test.ts`
- Modify: `apps/server-agent/src/controllers/skill.controller.ts`
- Modify: `apps/server-agent/src/controllers/artifact.controller.ts`
- Modify: `apps/server-agent/src/services/remote-artifact.service.ts`

**Interfaces:**
- Consumes: Task 3 的 `AgentContextService`
- Produces: `getSkillsDir()` / `getMemoryDir()` / `getWorkspaceDir()` / `getMcpConfigPath()` 全部返回 `<meshbotDir>/accounts/<acct>/agents/<agentId>/...`；`getDatabasePath()` / `getAccountCheckpointDbPath()` / `getPromptDir()` **保持账号级不变**

- [ ] **Step 1: 写失败的单测**

改 `libs/agent/tests/unit/meshbot-config.service.test.ts`，把账号级断言换成 agent 级：

```ts
it("四个 Agent 化路径落在 agents/<agentId>/ 下", () => {
  const service = makeService();
  account.run("acct-1", () => {
    agentCtx.run("agent-9", () => {
      const agentRoot = path.join(
        service.getMeshbotDir(),
        "accounts",
        "acct-1",
        "agents",
        "agent-9",
      );
      expect(service.getSkillsDir()).toBe(path.join(agentRoot, "skills"));
      expect(service.getMemoryDir()).toBe(path.join(agentRoot, "memory"));
      expect(service.getWorkspaceDir()).toBe(path.join(agentRoot, "workspace"));
      expect(service.getMcpConfigPath()).toBe(path.join(agentRoot, "mcp.json"));
    });
  });
});

it("db 路径保持账号级，不下沉", () => {
  const service = makeService();
  account.run("acct-1", () => {
    agentCtx.run("agent-9", () => {
      expect(service.getAccountCheckpointDbPath()).toBe(
        path.join(service.getMeshbotDir(), "accounts", "acct-1", "agent.db"),
      );
      expect(service.getDatabasePath()).toBe(
        path.join(service.getMeshbotDir(), "main.db"),
      );
    });
  });
});

it("无 Agent 上下文时 Agent 化 getter 抛错", () => {
  const service = makeService();
  account.run("acct-1", () => {
    expect(() => service.getSkillsDir()).toThrow(/无活跃 Agent 上下文/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- meshbot-config.service.test
```
Expected: FAIL —— 路径里没有 `agents/agent-9`

- [ ] **Step 3: 改 MeshbotConfigService**

构造函数注入 `AgentContextService`，新增 `agentDir()`，四个 getter 改用它：

```ts
  constructor(
    private readonly account: AccountContextService,
    private readonly agent: AgentContextService,
  ) {
    this.meshbotDir = resolveMeshbotDir();
  }

  /**
   * 当前 Agent 专属数据根：<meshbotDir>/accounts/<cloudUserId>/agents/<agentId>，自动 mkdir。
   * 无 Agent 上下文时 getOrThrow 抛错——Agent 化文件 getter 必须在 Agent 上下文内调用。
   */
  private agentDir(): string {
    const dir = path.join(
      this.accountDir(),
      "agents",
      this.agent.getOrThrow(),
    );
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Skills 根目录：<accountDir>/agents/<agentId>/skills（按 Agent 隔离）。 */
  getSkillsDir(): string {
    return path.join(this.agentDir(), "skills");
  }

  /** MCP 配置：<accountDir>/agents/<agentId>/mcp.json（按 Agent 隔离）。 */
  getMcpConfigPath(): string {
    return path.join(this.agentDir(), "mcp.json");
  }

  /** 记忆目录：<accountDir>/agents/<agentId>/memory（按 Agent 隔离）。 */
  getMemoryDir(): string {
    return path.join(this.agentDir(), "memory");
  }

  /** Bash tool 默认 cwd：<accountDir>/agents/<agentId>/workspace，自动 mkdir。 */
  getWorkspaceDir(): string {
    if (process.env.MESHBOT_WORKSPACE) {
      return process.env.MESHBOT_WORKSPACE;
    }
    const dir = path.join(this.agentDir(), "workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
```

`getPromptDir()` / `getDatabasePath()` / `getAccountCheckpointDbPath()` **不动**（前者只剩 session-title / suggestion 模板，是账号级）。

- [ ] **Step 4: 修四处非 run 上下文的调用点**

这四处走 REST / relay，没有 Agent 上下文，改完 getter 会当场抛错：

1. **`apps/server-agent/src/controllers/skill.controller.ts`** —— `GET installed` / `POST install` / `DELETE :name` / `POST publish` 全部增加 `agentId` 参数（query 或 body），方法体包 `this.agentCtx.run(agentId, () => ...)`。`market` 端点不碰磁盘，不用改。
2. **`apps/server-agent/src/controllers/artifact.controller.ts:48`** —— 端点增加 `agentId` query 参数，包 `agentCtx.run()`。前端 `apiClient` 取产物文件时要带上当前 agent。
3. **`apps/server-agent/src/services/remote-artifact.service.ts:49`** —— 远程产物请求的 payload 里带上 agentId，包 `agentCtx.run()`。
4. **`apps/server-agent/src/services/drive-tool.service.ts`** 的 3 处 —— 确认全部只被 drive tool（run 内）调用；若有 REST 入口同样处理。

**验证手段**：`grep -rn --include='*.ts' -e 'getSkillsDir()' -e 'getMemoryDir()' -e 'getWorkspaceDir()' -e 'getMcpConfigPath()' libs/agent/src apps/server-agent/src` 逐个确认调用链上游都在 `agentCtx.run()` 里。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm test -- meshbot-config.service.test && pnpm test && pnpm typecheck
```
Expected: PASS

- [ ] **Step 6: 真启动验证（不可省）**

单测和 typecheck 都发现不了 DI 崩溃与运行时「无 Agent 上下文」抛错。必须真起服务：

```bash
pnpm dev:server-agent
```
Expected: 启动无异常；登录后打开一个会话发一条消息，能正常回复；确认磁盘上出现 `.meshbot/accounts/<id>/agents/<agentId>/workspace/`。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(agent): 路径 getter 下沉到 agents/<agentId>/ —— 技能/记忆/工作区自动隔离"
```

---

## Task 5: ToolRegistry 加 Agent 维度

**Files:**
- Modify: `libs/agent/src/tools/tool-registry.ts`
- Modify: `libs/agent/src/tools/tool-registry.spec.ts`

**Interfaces:**
- Consumes: Task 3 `AgentContextService`
- Produces: `registerForAgent(cloudUserId, agentId, tool, lcTool)` / `unregisterAgent(cloudUserId, agentId)` / `unregisterAccount(cloudUserId)`（清该账号全部 agent）。`asLangChainBindable()` / `get()` / `list()` 按当前 ALS 的「账号 + agent」解析。

- [ ] **Step 1: 写失败的单测**

```ts
it("两个 Agent 的 MCP 工具互不可见", () => {
  const registry = makeRegistry();
  registry.registerForAgent("acct-1", "agent-a", toolA, lcToolA);
  registry.registerForAgent("acct-1", "agent-b", toolB, lcToolB);
  account.run("acct-1", () => {
    agentCtx.run("agent-a", () => {
      const names = registry.asLangChainBindable().map((t) => t.name);
      expect(names).toContain("tool-a");
      expect(names).not.toContain("tool-b");
      expect(registry.get("tool-b")).toBeUndefined();
    });
    agentCtx.run("agent-b", () => {
      expect(registry.get("tool-b")).toBeDefined();
    });
  });
});

it("内置工具对所有 Agent 都可见", () => {
  const registry = makeRegistry();
  account.run("acct-1", () => {
    agentCtx.run("agent-a", () => {
      expect(registry.get("bash")).toBeDefined();
    });
  });
});

it("unregisterAccount 清掉该账号下全部 Agent 的工具", () => {
  const registry = makeRegistry();
  registry.registerForAgent("acct-1", "agent-a", toolA, lcToolA);
  registry.registerForAgent("acct-1", "agent-b", toolB, lcToolB);
  registry.unregisterAccount("acct-1");
  account.run("acct-1", () => {
    agentCtx.run("agent-a", () => {
      expect(registry.get("tool-a")).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- tool-registry.spec
```
Expected: FAIL —— `registerForAgent is not a function`

- [ ] **Step 3: 改 ToolRegistry**

```ts
  /** MCP 工具按「账号+Agent」键：`${cloudUserId}:${agentId}` → (toolName → Entry) */
  private readonly agentEntries = new Map<string, Map<string, Entry>>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly account: AccountContextService,
    private readonly agent: AgentContextService,
  ) {}

  /**
   * 为指定 Agent 注册一个 MCP 工具。同 Agent 重名时覆盖（upsert）。
   * @param cloudUserId 账号 ID（= JWT sub）
   * @param agentId Agent ID
   */
  registerForAgent(
    cloudUserId: string,
    agentId: string,
    tool: MeshbotTool,
    lcTool: StructuredToolInterface,
  ): void {
    const key = agentKey(cloudUserId, agentId);
    let bucket = this.agentEntries.get(key);
    if (!bucket) {
      bucket = new Map();
      this.agentEntries.set(key, bucket);
    }
    bucket.set(tool.name, { meshbotTool: tool, lcTool });
  }

  /** 清除指定 Agent 的所有 MCP 工具（MCP 闲置回收 / 配置变更时调用）。 */
  unregisterAgent(cloudUserId: string, agentId: string): void {
    this.agentEntries.delete(agentKey(cloudUserId, agentId));
  }

  /** 清除指定账号下**全部 Agent** 的 MCP 工具（账号登出时调用）。 */
  unregisterAccount(cloudUserId: string): void {
    const prefix = `${cloudUserId}:`;
    for (const key of [...this.agentEntries.keys()]) {
      if (key.startsWith(prefix)) {
        this.agentEntries.delete(key);
      }
    }
  }

  /**
   * 返回当前 ALS「账号 + Agent」上下文对应的 MCP 工具 map。
   * 缺任一上下文时返回空 Map，不抛错（内置工具仍可用）。
   */
  private currentAgentEntries(): Map<string, Entry> {
    const acct = this.account.get();
    const agentId = this.agent.get();
    if (!acct || !agentId) return new Map();
    return this.agentEntries.get(agentKey(acct, agentId)) ?? new Map();
  }
```

`asLangChainBindable()` / `get()` / `list()` 里把 `currentAccountEntries()` 换成 `currentAgentEntries()`。文件末尾加：

```ts
/** 「账号+Agent」复合键。 */
function agentKey(cloudUserId: string, agentId: string): string {
  return `${cloudUserId}:${agentId}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test -- tool-registry.spec
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(agent): ToolRegistry 按「账号+Agent」隔离 MCP 工具"
```

---

## Task 6: McpService 按 Agent 懒加载 + 闲置回收

**Files:**
- Modify: `libs/agent/src/mcp/mcp.service.ts`
- Modify: `libs/agent/src/mcp/mcp.service.spec.ts`
- Modify: `apps/server-agent/src/account/account-runtime.registry.ts`
- Modify: `apps/server-agent/src/services/runner.service.ts`

**Interfaces:**
- Consumes: Task 5 `ToolRegistry.registerForAgent` / `unregisterAgent`；Task 3 `AgentContextService`
- Produces: `McpService.ensureAgent(cloudUserId, agentId): Promise<void>`（幂等、懒加载）/ `acquire(cloudUserId, agentId): void` / `release(cloudUserId, agentId): void` / `teardownAgent(cloudUserId, agentId)` / `teardownAccount(cloudUserId)`（拆该账号全部 agent）/ `sweepIdle(now: number): Promise<void>`

**为什么懒加载**：现状是登录时一次性起全部 MCP。5 个 Agent × 3 个 stdio server = 登录拉 15 个子进程。改成 Agent 首次被使用才 init，闲置 30 分钟且无活跃 run 时回收。

- [ ] **Step 1: 写失败的单测**

```ts
it("ensureAgent 幂等：重复调用只 init 一次", async () => {
  const svc = makeService(); // createClient 被 stub
  await svc.ensureAgent("acct-1", "agent-a");
  await svc.ensureAgent("acct-1", "agent-a");
  expect(createClientSpy).toHaveBeenCalledTimes(1);
});

it("两个 Agent 各起各的 client，工具注册到各自名下", async () => {
  const svc = makeService();
  await svc.ensureAgent("acct-1", "agent-a");
  await svc.ensureAgent("acct-1", "agent-b");
  expect(createClientSpy).toHaveBeenCalledTimes(2);
  expect(registry.registerForAgent).toHaveBeenCalledWith(
    "acct-1",
    "agent-a",
    expect.anything(),
    expect.anything(),
  );
});

it("sweepIdle 回收闲置且无活跃 run 的 Agent", async () => {
  const svc = makeService();
  await svc.ensureAgent("acct-1", "agent-a");
  await svc.sweepIdle(Date.now() + 31 * 60_000);
  expect(registry.unregisterAgent).toHaveBeenCalledWith("acct-1", "agent-a");
});

it("sweepIdle 不回收有活跃 run 的 Agent（refCount > 0）", async () => {
  const svc = makeService();
  await svc.ensureAgent("acct-1", "agent-a");
  svc.acquire("acct-1", "agent-a");
  await svc.sweepIdle(Date.now() + 31 * 60_000);
  expect(registry.unregisterAgent).not.toHaveBeenCalled();
  svc.release("acct-1", "agent-a");
  await svc.sweepIdle(Date.now() + 31 * 60_000);
  expect(registry.unregisterAgent).toHaveBeenCalled();
});

it("teardownAccount 拆掉该账号全部 Agent", async () => {
  const svc = makeService();
  await svc.ensureAgent("acct-1", "agent-a");
  await svc.ensureAgent("acct-1", "agent-b");
  await svc.teardownAccount("acct-1");
  expect(closeSpy).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- mcp.service.spec
```
Expected: FAIL —— `ensureAgent is not a function`

- [ ] **Step 3: 改 McpService**

核心结构（保留 `createClient` / `loadConfig` / `mapServersToLangchainShape` 不动）：

```ts
/**
 * 单 Agent 的 MCP 运行态：client + 已注册工具名 + 活跃 run 引用计数 + 最近使用时刻。
 * client 为 null 表示「该 Agent 无 MCP 配置或加载失败」——仍登记，避免每次 run 重复读盘。
 */
interface AgentMcp {
  client: MultiServerMCPClient | null;
  names: Set<string>;
  refCount: number;
  lastUsedAt: number;
}

@Injectable()
export class McpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);

  /** `${cloudUserId}:${agentId}` → 该 Agent 的 MCP 运行态。 */
  private readonly perAgent = new Map<string, AgentMcp>();

  /**
   * 懒加载：确保该 Agent 的 MCP 已就绪。已就绪则只刷新 lastUsedAt。
   *
   * **契约：必须在 accountContext.run + agentContext.run 内调用** —— loadConfig
   * 读的是 Agent 化路径 getMcpConfigPath()，依赖两层 ALS。
   *
   * mcp.json 不存在 / 无 server / 加载失败时**也登记一个空运行态**，避免每次 run
   * 都重复读盘重试。配置改动后由 REST 层调 teardownAgent 使其失效。
   */
  async ensureAgent(cloudUserId: string, agentId: string): Promise<void> {
    const key = agentKey(cloudUserId, agentId);
    const existing = this.perAgent.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return;
    }
    const cfg = this.loadConfig();
    if (!cfg || Object.keys(cfg.mcpServers).length === 0) {
      this.perAgent.set(key, {
        client: null,
        names: new Set(),
        refCount: 0,
        lastUsedAt: Date.now(),
      });
      return;
    }
    const mcpServers = mapServersToLangchainShape(cfg.mcpServers);
    const client = this.createClient(mcpServers);
    const names = new Set<string>();
    try {
      const tools = (await client.getTools()) as StructuredToolInterface[];
      for (const lcTool of tools) {
        try {
          const { meshbot } = buildMcpToolAdapter(lcTool);
          this.registry.registerForAgent(cloudUserId, agentId, meshbot, lcTool);
          names.add(meshbot.name);
        } catch (err) {
          // 单颗 tool 适配 / 注册失败只跳过，不拖垮其他 server。
          this.logger.warn(
            `Skip MCP tool "${lcTool.name}" for ${key}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to load MCP tools for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        await client.close();
      } catch {
        // best-effort 清理，已记主错。
      }
      this.perAgent.set(key, {
        client: null,
        names: new Set(),
        refCount: 0,
        lastUsedAt: Date.now(),
      });
      return;
    }
    this.perAgent.set(key, {
      client,
      names,
      refCount: 0,
      lastUsedAt: Date.now(),
    });
    this.logger.log(
      `MCP ready for ${key}: ${names.size} tools from ${Object.keys(mcpServers).length} server(s).`,
    );
  }

  /** 标记该 Agent 有活跃 run（回收保护）。 */
  acquire(cloudUserId: string, agentId: string): void {
    const entry = this.perAgent.get(agentKey(cloudUserId, agentId));
    if (entry) {
      entry.refCount += 1;
      entry.lastUsedAt = Date.now();
    }
  }

  /** 活跃 run 结束（解除回收保护）。 */
  release(cloudUserId: string, agentId: string): void {
    const entry = this.perAgent.get(agentKey(cloudUserId, agentId));
    if (entry) {
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
    }
  }

  /**
   * 回收闲置 Agent 的 MCP 子进程：refCount 为 0 且超过 IDLE_RECLAIM_MS 未使用。
   * now 显式传入便于测试；生产由定时器每 5 分钟调一次。
   *
   * refCount > 0 一律跳过——有 run 正在跑时回收会当场抽掉它的工具。
   */
  async sweepIdle(now: number): Promise<void> {
    for (const [key, entry] of [...this.perAgent.entries()]) {
      if (entry.refCount > 0) continue;
      if (now - entry.lastUsedAt < IDLE_RECLAIM_MS) continue;
      const { cloudUserId, agentId } = splitAgentKey(key);
      await this.teardownAgent(cloudUserId, agentId);
    }
  }

  /** 拆掉单个 Agent 的 MCP 运行态：反注册工具、关闭 client。幂等。 */
  async teardownAgent(cloudUserId: string, agentId: string): Promise<void> {
    const key = agentKey(cloudUserId, agentId);
    const entry = this.perAgent.get(key);
    if (!entry) {
      return;
    }
    this.perAgent.delete(key);
    this.registry.unregisterAgent(cloudUserId, agentId);
    if (!entry.client) {
      return;
    }
    try {
      await entry.client.close();
    } catch (err) {
      this.logger.warn(
        `MCP client close error for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 拆掉某账号下**全部 Agent** 的 MCP 运行态（登出时调用）。幂等。 */
  async teardownAccount(cloudUserId: string): Promise<void> {
    const prefix = `${cloudUserId}:`;
    for (const key of [...this.perAgent.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const { agentId } = splitAgentKey(key);
      await this.teardownAgent(cloudUserId, agentId);
    }
  }

  onModuleInit(): void {
    // .unref() 必须有：否则 Jest 会报「worker process failed to exit gracefully」。
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle(Date.now());
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    for (const key of [...this.perAgent.keys()]) {
      const { cloudUserId, agentId } = splitAgentKey(key);
      await this.teardownAgent(cloudUserId, agentId);
    }
  }
}

/** 「账号+Agent」复合键。 */
function agentKey(cloudUserId: string, agentId: string): string {
  return `${cloudUserId}:${agentId}`;
}

/** 拆回 {cloudUserId, agentId}。两段 id 都不含冒号（雪花 / JWT sub），按首个冒号切分。 */
function splitAgentKey(key: string): { cloudUserId: string; agentId: string } {
  const idx = key.indexOf(":");
  return {
    cloudUserId: key.slice(0, idx),
    agentId: key.slice(idx + 1),
  };
}
```

配套的字段与常量（类顶部）：

```ts
/** 闲置回收阈值：30 分钟无活跃 run 且未被使用则关闭子进程。 */
const IDLE_RECLAIM_MS = 30 * 60_000;

/** 回收扫描间隔。 */
const SWEEP_INTERVAL_MS = 5 * 60_000;

  private sweepTimer: NodeJS.Timeout | null = null;
```

`AgentMcp.client` 类型要放宽成 `MultiServerMCPClient | null`（无 MCP 配置 / 加载失败时登记空运行态，靠 `null` 表达）。类声明改为 `implements OnModuleInit, OnModuleDestroy`。

- [ ] **Step 4: 去掉登录时的 initAccount**

`apps/server-agent/src/account/account-runtime.registry.ts:37-45` 里删掉 `ctx.run(id, () => mcp.initAccount(id))`（懒加载接管）。登出路径仍调 `mcp.teardownAccount(id)`。

- [ ] **Step 5: RunnerService 接线 ensure / acquire / release**

把 Task 3 写的 `consumeRunStream` 整个替换成下面这版（`cloudUserId` 从 `AccountContextService` 取——RunnerService 已经跑在账号上下文内）：

```ts
  private async consumeRunStream(
    sessionId: string,
    batch: { id: string; content: string }[],
    run: InflightRun,
    resume: boolean,
    runStartedAt: number,
  ): Promise<void> {
    const cloudUserId = this.account.getOrThrow();
    const session = await this.sessions.findOrNull(sessionId);
    const subAgent = session?.kind === "subagent";
    const agentId = session?.agentId ?? (await this.agents.ensureDefault()).id;
    const agent = await this.agents.findOrNull(agentId);
    const modelOverride =
      session?.modelConfigId ?? agent?.defaultModelConfigId ?? null;
    await this.agentCtx.run(agentId, async () => {
      // 懒加载该 Agent 的 MCP（首次使用才拉子进程），并在 run 期间挂引用计数
      // 防止闲置回收把正在用的工具抽走。
      await this.mcp.ensureAgent(cloudUserId, agentId);
      this.mcp.acquire(cloudUserId, agentId);
      try {
        await this.modelRunCtx.run(modelOverride, () =>
          this.consumeRunStreamInCtx(
            sessionId,
            batch,
            run,
            resume,
            runStartedAt,
            subAgent,
          ),
        );
      } finally {
        this.mcp.release(cloudUserId, agentId);
      }
    });
  }
```

构造函数新增注入：`AccountContextService`（若尚未注入）、`AgentContextService`、`AgentService`、`McpService`。

- [ ] **Step 6: 跑测试确认通过**

```bash
pnpm test -- mcp.service.spec && pnpm test
```
Expected: PASS

- [ ] **Step 7: 真启动验证**

```bash
pnpm dev:server-agent
```
Expected: 登录时**不再**拉起 MCP 子进程（看日志无 `MCP ready`）；发第一条消息时才出现 `MCP ready for <acct>:<agent>`。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(agent): MCP 按 Agent 隔离——懒加载 + 引用计数 + 闲置回收"
```

---

## Task 7: 人格 `system:persona` 每轮刷新

**这是全案最容易踩的坑。** 现状 system prompt 只在首轮写进 checkpointer，之后永不刷新——多 Agent 下改了 prompt 或换了 Agent，旧会话仍带旧人格，**且静默不报错**。

**Files:**
- Modify: `libs/agent/src/graph/runtime-context.port.ts`
- Modify: `libs/agent/src/graph/context-builder.ts`
- Modify: `libs/agent/src/graph/context-builder.spec.ts`
- Modify: `libs/agent/src/graph/graph-runner.service.ts`
- Modify: `libs/agent/src/graph/graph-runner.service.spec.ts`
- Modify: `apps/server-agent/src/runtime-context.module.ts`

**Interfaces:**
- Consumes: Task 1 `AgentService`；Task 3 `AgentContextService`
- Produces: `RuntimeContextPort.resolve()` 返回 `{ displayName, language, timezone, agentName, agentSystemPrompt }`（`quickAssistantName` 删除）；`ContextBuilder.buildPersonaMessage(): Promise<SystemMessage>`（稳定 id `system:persona`）

- [ ] **Step 1: 写失败的单测**

`libs/agent/src/graph/context-builder.spec.ts`：

```ts
it("buildPersonaMessage 用稳定 id system:persona", async () => {
  const msg = await builder.buildPersonaMessage();
  expect(msg.id).toBe("system:persona");
});

it("人格 = Agent 的 systemPrompt + 记忆段 + LLMUSE 指南", async () => {
  runtimeContext.resolve.mockResolvedValue({
    displayName: null,
    language: null,
    timezone: null,
    agentName: "研发助手",
    agentSystemPrompt: "你是研发助手，只写 TypeScript。",
  });
  const msg = await builder.buildPersonaMessage();
  const content = String(msg.content);
  expect(content).toContain("你是研发助手，只写 TypeScript。");
  expect(content).toContain(MEMORY_GUIDE);
  expect(content).toContain(LLMUSE_GUIDE);
});

it("systemPrompt 为空时不产生前导空行", async () => {
  runtimeContext.resolve.mockResolvedValue({
    displayName: null,
    language: null,
    timezone: null,
    agentName: "M",
    agentSystemPrompt: "",
  });
  const msg = await builder.buildPersonaMessage();
  expect(String(msg.content).startsWith("\n")).toBe(false);
});
```

`libs/agent/src/graph/graph-runner.service.spec.ts`：

```ts
it("system:persona 每轮都推送（不是只在首轮）", async () => {
  // 先跑一轮，让 checkpointer 里有历史
  await drain(runner.streamMessage(threadId, [{ id: "u1", content: "hi" }]));
  const sent: BaseMessage[] = [];
  graph.stream = jest.fn((input) => {
    sent.push(...(input as GraphState).messages);
    return emptyStream();
  });
  // 第二轮：有历史了
  await drain(runner.streamMessage(threadId, [{ id: "u2", content: "hi2" }]));
  expect(sent.some((m) => m.id === "system:persona")).toBe(true);
});

it("改了 Agent 的 systemPrompt，下一轮的 system:persona 内容跟着变", async () => {
  await drain(runner.streamMessage(threadId, [{ id: "u1", content: "hi" }]));
  runtimeContext.resolve.mockResolvedValue({
    displayName: null,
    language: null,
    timezone: null,
    agentName: "M",
    agentSystemPrompt: "全新人格",
  });
  const sent: BaseMessage[] = [];
  graph.stream = jest.fn((input) => {
    sent.push(...(input as GraphState).messages);
    return emptyStream();
  });
  await drain(runner.streamMessage(threadId, [{ id: "u2", content: "hi2" }]));
  const persona = sent.find((m) => m.id === "system:persona");
  expect(String(persona?.content)).toContain("全新人格");
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- context-builder.spec graph-runner.service.spec
```
Expected: FAIL —— `buildPersonaMessage is not a function`；第二个测试里 `system:persona` 不存在

- [ ] **Step 3: 改 RuntimeContextPort**

```ts
/** 当前账号 + 当前 Agent 的运行时信息端口；字段缺失返 null。 */
export interface RuntimeContextPort {
  /** 在账号 + Agent 上下文内解析运行时信息；字段缺失返 null。 */
  resolve(): Promise<{
    displayName: string | null;
    language: string | null;
    timezone: string | null;
    /** 当前 Agent 的名字；注入 system:ctx，让 agent 始终知道自己叫什么。 */
    agentName: string | null;
    /** 当前 Agent 的人格正文；由 ContextBuilder 组进 system:persona。 */
    agentSystemPrompt: string | null;
  }>;
}
```

- [ ] **Step 4: ContextBuilder 新增 buildPersonaMessage**

```ts
  /**
   * 组装人格消息（稳定 id system:persona；**每轮刷新**、reducer 按 id 原地更新）。
   *
   * 内容 = 当前 Agent 的 systemPrompt + 记忆段（MEMORY_GUIDE + core.md）+ LLMUSE 指南。
   *
   * 必须每轮刷新而非首轮注入：多 Agent 下用户随时可改 systemPrompt，首轮写死
   * 会让老会话永远带着旧人格，且静默不报错。
   */
  async buildPersonaMessage(): Promise<SystemMessage> {
    const ext = this.runtimeContext ? await this.runtimeContext.resolve() : null;
    const content = [
      ext?.agentSystemPrompt || "",
      this.buildMemorySection(),
      LLMUSE_GUIDE,
    ]
      .filter(Boolean)
      .join("\n\n");
    return new SystemMessage({ id: "system:persona", content });
  }
```

`buildContextMessage()` 里把 `ext?.quickAssistantName` 换成 `ext?.agentName`（`assistantName: xxx（你自己的名字）` 那行）。

- [ ] **Step 5: GraphRunner 去掉首轮注入**

`streamMessageImpl` 里删掉 `promptService.reloadIfChanged()` + `systemPrompt` 拼装 + `hasHistory` 判断 + `if (systemPrompt && !hasHistory)` 整块，改为：

```ts
    await this.threadState.sanitizeOrphanToolCalls(threadId);
    const inputMessages: BaseMessage[] = [];
    // system:persona / system:ctx / system:skills 全部用稳定 id 每轮重发；
    // reducer 按 id 原地更新（位置不变、不累积），无需先 RemoveMessage 再 Add。
    // 人格必须每轮刷新：Agent 的 systemPrompt 随时可改，首轮写死会让老会话
    // 永远带旧人格（静默错误）。
    inputMessages.push(await this.contextBuilder.buildPersonaMessage());
    inputMessages.push(await this.contextBuilder.buildContextMessage(threadId));
    if (this.contextBuilder.hasSkills()) {
      inputMessages.push(this.contextBuilder.buildSkillsMessage());
    }
```

`resumeStream()` 里也补上 `buildPersonaMessage()`（与 `system:ctx` 并列）。

`PromptService` 的注入可以从 GraphRunner 移除（人格不再经它）——但它仍被 `SessionTitleService` / `SuggestionService` 使用，**不要删除这个类**。

- [ ] **Step 6: runtime-context.module 换实现**

```ts
    {
      provide: RUNTIME_CONTEXT_PORT,
      useFactory: (
        account: AccountContextService,
        agentCtx: AgentContextService,
        cloudIdentity: CloudIdentityService,
        setting: SettingService,
        agents: AgentService,
      ): RuntimeContextPort => ({
        async resolve() {
          const cloudUserId = account.getOrThrow();
          const agentId = agentCtx.get();
          const [identity, language, timezone, agent] = await Promise.all([
            cloudIdentity.get(cloudUserId).catch(() => null),
            setting.get("language").catch(() => null),
            setting.get("timezone").catch(() => null),
            agentId ? agents.findOrNull(agentId).catch(() => null) : null,
          ]);
          return {
            displayName: identity?.displayName ?? null,
            language,
            timezone,
            agentName: agent?.name ?? DEFAULT_AGENT_NAME,
            agentSystemPrompt: agent?.systemPrompt ?? null,
          };
        },
      }),
      inject: [
        AccountContextService,
        AgentContextService,
        CloudIdentityService,
        SettingService,
        AgentService,
      ],
    },
```

模块 `imports` 里要能拿到 `AgentService`（从 app.module 的 exports 或直接 `TxTypeOrmModule.forFeature([Agent])` + provide）。

- [ ] **Step 7: 跑测试确认通过**

```bash
pnpm test -- context-builder.spec graph-runner.service.spec && pnpm test
```
Expected: PASS

- [ ] **Step 8: 真启动验证（DI 高危）**

改了 provider 的 `inject` 数组，typecheck 和单测都漏得掉 DI 崩溃。必须真起：

```bash
pnpm dev:server-agent
```
Expected: 启动无 `Nest can't resolve dependencies` 报错；发消息能正常回复。

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(agent): 人格改为每轮刷新的 system:persona —— 改 prompt 立即对老会话生效"
```

---

## Task 8: 默认 Agent 引导 + QuickAssistant 收编

**Files:**
- Delete: `apps/server-agent/src/services/quick-assistant.service.ts`
- Delete: `libs/agent/src/tools/builtins/rename-quick-assistant.tool.ts`
- Create: `libs/agent/src/tools/builtins/rename-agent.tool.ts`
- Create: `libs/agent/src/tools/builtins/rename-agent.tool.spec.ts`
- Modify: `apps/server-agent/src/account/account-runtime.registry.ts`
- Modify: `libs/types-agent/src/quick-assistant.ts`（删 `QUICK_ASSISTANT_DEFAULT_NAME`）

**Interfaces:**
- Consumes: Task 1 `AgentService`；Task 3 `AgentContextService`
- Produces: 登录建 runtime 时调 `agents.ensureDefault()`；`rename_agent` 工具（参数 `{ name: string }`，改当前 Agent 的 name）；`AGENT_RENAME_PORT`（libs/agent → server-agent 解耦端口，签名 `rename(agentId: string, name: string): Promise<void>`）

- [ ] **Step 1: 写失败的单测**

`libs/agent/src/tools/builtins/rename-agent.tool.spec.ts`：

```ts
it("rename_agent 改当前 Agent 的名字", async () => {
  const port = { rename: jest.fn().mockResolvedValue(undefined) };
  const tool = new RenameAgentTool(agentCtx, port);
  await agentCtx.run("agent-3", () => tool.execute({ name: "运维值班" }));
  expect(port.rename).toHaveBeenCalledWith("agent-3", "运维值班");
});

it("无 Agent 上下文时抛错", async () => {
  const tool = new RenameAgentTool(agentCtx, port);
  await expect(tool.execute({ name: "X" })).rejects.toThrow(
    /无活跃 Agent 上下文/,
  );
});
```

在 `account-runtime.registry.spec.ts` 追加：

```ts
it("建 runtime 时保证账号至少有一个 Agent", async () => {
  await registry.createRuntime("acct-new");
  expect(agents.ensureDefault).toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- rename-agent.tool.spec
```
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 定义 AGENT_RENAME_PORT**

工具在 `libs/agent`，`AgentService` 在 `apps/server-agent` —— 依赖方向禁止反向，所以要一个端口（照 `RUNTIME_CONTEXT_PORT` 的既有模式）。

`libs/agent/src/tools/agent-rename.port.ts`：

```ts
/**
 * AGENT_RENAME_PORT —— libs/agent → server-agent 解耦端口。
 *
 * rename_agent 工具需要写 agents 表，但 libs/agent 不能依赖 server-agent 的
 * AgentService。由 server-agent 实现并绑定（同 RUNTIME_CONTEXT_PORT 的模式）。
 */
export const AGENT_RENAME_PORT = Symbol("AGENT_RENAME_PORT");

/** 改名端口。 */
export interface AgentRenamePort {
  /** 把指定 Agent 改名。必须在账号上下文内调用。 */
  rename(agentId: string, name: string): Promise<void>;
}
```

在 `apps/server-agent/src/runtime-context.module.ts` 里绑定（与另外两个端口并列）：

```ts
    {
      provide: AGENT_RENAME_PORT,
      useFactory: (agents: AgentService): AgentRenamePort => ({
        async rename(agentId, name) {
          await agents.update(agentId, { name });
        },
      }),
      inject: [AgentService],
    },
```

并加进模块的 `exports`。

- [ ] **Step 4: 写 rename_agent 工具**

`libs/agent/src/tools/builtins/rename-agent.tool.ts` —— 照 `rename-quick-assistant.tool.ts` 的结构（`@Tool()` 装饰器 + `MeshbotTool` 接口 + Zod schema `{ name: z.string().min(1).max(32) }`），执行体：

```ts
  async execute(args: { name: string }): Promise<string> {
    const agentId = this.agentCtx.getOrThrow();
    await this.port.rename(agentId, args.name);
    return `已改名为「${args.name}」`;
  }
```

删掉 `rename-quick-assistant.tool.ts`，并从 `libs/agent` 的 tool 注册模块里摘除它。

- [ ] **Step 5: 登录时引导默认 Agent**

`apps/server-agent/src/account/account-runtime.registry.ts` 的 `createRuntime` 里（原来 `mcp.initAccount` 的位置，Task 6 已清空）：

```ts
      // 保证账号至少有一个 Agent —— sessions.agent_id 是 NOT NULL，
      // 零 Agent 会让建会话直接失败。幂等。
      await ctx.run(id, () => this.agents.ensureDefault());
```

- [ ] **Step 6: 删 QuickAssistant**

删 `quick-assistant.service.ts`；`runtime-context.module.ts` 里的 `QUICK_ASSISTANT_NAME_KEY` 引用已在 Task 7 移除；`libs/types-agent/src/quick-assistant.ts` 里删 `QUICK_ASSISTANT_DEFAULT_NAME`（若该文件只剩这一个导出则整个删掉，并从 index.ts 摘除）。

`pnpm check:dead` 会揪出残留的死导出。

- [ ] **Step 7: 跑测试 + 围栏确认通过**

```bash
pnpm test && pnpm check
```
Expected: PASS；`check:dead` 0 finding

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(agent): 默认 Agent 引导 + QuickAssistant 收编为 agent.name"
```

---

## Task 9: Agent CRUD REST + MCP 配置 REST

**Files:**
- Create: `apps/server-agent/src/controllers/agent.controller.ts`
- Create: `apps/server-agent/src/controllers/agent.controller.spec.ts`
- Create: `apps/server-agent/src/controllers/mcp.controller.ts`
- Create: `apps/server-agent/src/dto/agent.dto.ts`
- Modify: `apps/server-agent/src/app.module.ts`

**Interfaces:**
- Consumes: Task 1 `AgentService`；Task 3 `AgentContextService`；Task 4 的 `getMcpConfigPath()`
- Produces: REST `GET /api/agents` / `POST /api/agents` / `PATCH /api/agents/:id` / `DELETE /api/agents/:id` / `POST /api/agents/:id/duplicate`；`GET /api/agents/:id/mcp` / `PUT /api/agents/:id/mcp`

- [ ] **Step 1: 写 DTO**

`apps/server-agent/src/dto/agent.dto.ts`：

```ts
import {
  AgentCreateSchema,
  AgentUpdateSchema,
  AgentViewSchema,
} from "@meshbot/types-agent";
import { createZodDto } from "nestjs-zod";

/** 创建 Agent 请求体。 */
export class AgentCreateDto extends createZodDto(AgentCreateSchema) {}

/** 更新 Agent 请求体。 */
export class AgentUpdateDto extends createZodDto(AgentUpdateSchema) {}

/** Agent 视图。 */
export class AgentViewDto extends createZodDto(AgentViewSchema) {}
```

- [ ] **Step 2: 写失败的单测**

`apps/server-agent/src/controllers/agent.controller.spec.ts`：

```ts
/** 测试夹具：一份合法的 AgentCreateInput。 */
const fixture = (name: string) => ({
  name,
  avatar: "🤖|#f97316",
  description: "",
  systemPrompt: "你是测试助手",
  defaultModelConfigId: null,
});

it("DELETE 会连同磁盘目录一起清掉", async () => {
  await service.ensureDefault(); // 保证不是最后一个
  const agent = await service.create(fixture("待删"));
  const dir = config.agentDirOf(agent.id);
  mkdirSync(dir, { recursive: true });
  await controller.remove(agent.id);
  expect(existsSync(dir)).toBe(false);
  expect(await service.findOrNull(agent.id)).toBeNull();
});

it("DELETE 会连同该 Agent 的会话一起清掉", async () => {
  await service.ensureDefault();
  const agent = await service.create(fixture("带会话"));
  await sessions.create({ title: "会话", agentId: agent.id });
  await controller.remove(agent.id);
  expect(await sessions.findByAgentId(agent.id)).toHaveLength(0);
});

it("DELETE 最后一个 Agent 被拒绝（至少留一个）", async () => {
  const only = await service.ensureDefault();
  await expect(controller.remove(only.id)).rejects.toThrow(/至少保留一个/);
  expect(await service.findOrNull(only.id)).not.toBeNull();
});

it("duplicate 复制配置但不复制记忆/工作区/会话", async () => {
  const src = await service.create(fixture("源"));
  const copy = await controller.duplicate(src.id);
  expect(copy.name).toBe("源 (副本)");
  expect(copy.systemPrompt).toBe(src.systemPrompt);
  expect(copy.avatar).toBe(src.avatar);
  expect(copy.id).not.toBe(src.id);
});

it("PUT mcp 写入非法 JSON 时抛 400", async () => {
  const agent = await service.ensureDefault();
  await expect(
    controller.putMcp(agent.id, { raw: "{ 不是 json" }),
  ).rejects.toThrow(/JSON 解析失败/);
});

it("PUT mcp 写入 schema 不合法的配置时抛 400", async () => {
  const agent = await service.ensureDefault();
  await expect(
    controller.putMcp(agent.id, { raw: '{"mcpServers":{"x":{}}}' }),
  ).rejects.toThrow(/配置校验失败/);
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm test -- agent.controller.spec
```
Expected: FAIL —— 模块不存在

- [ ] **Step 4: 业务下沉 —— AgentService 补三个方法**

Controller 必须瘦（`controller-thin` 规范），所以先把三件有副作用的事放进 `AgentService`：

```ts
  /**
   * 删除 Agent —— 连同它的全部会话与磁盘目录一起清掉。
   *
   * 跨表写入（agents + sessions + session_messages），故挂 @Transactional()；
   * 磁盘删除放在事务**之后**（文件系统不参与事务，先删文件后回滚会丢数据）。
   *
   * 不允许删到零 Agent：sessions.agent_id 是 NOT NULL，零 Agent 会让建会话直接失败。
   */
  async removeWithData(id: string): Promise<void> {
    const all = await this.list();
    if (all.length <= 1) {
      throw new BadRequestException("至少保留一个 Agent");
    }
    await this.removeInDb(id);
    rmSync(this.config.agentDirOf(id), { recursive: true, force: true });
  }

  /** 删 Agent 及其会话（含消息）。磁盘目录由调用方在事务外清理。 */
  @Transactional()
  private async removeInDb(id: string): Promise<void> {
    await this.findOrThrow(id);
    const sessions = await this.sessions.findByAgentId(id);
    for (const s of sessions) {
      await this.sessions.removeWithMessages(s.id);
    }
    await this.repo.delete({ id });
  }

  /**
   * 复制一个 Agent 的配置（名字加「(副本)」后缀）。
   * 只复制元数据——记忆 / 工作区 / 已装技能 / MCP 配置**不复制**，副本从零开始。
   */
  async duplicate(id: string): Promise<Agent> {
    const src = await this.findOrThrow(id);
    return this.create({
      name: `${src.name} (副本)`,
      avatar: src.avatar,
      description: src.description,
      systemPrompt: src.systemPrompt,
      defaultModelConfigId: src.defaultModelConfigId,
    });
  }
```

`removeInDb` 命名命中 `*InDb` 约定（`check:naming` 强制：私有 `@Transactional()` 方法必须是 `*InDb` / `*InTx` / `*InTransaction` / `persist*`）。它跨 `agents` / `sessions` / `session_messages` 三张表写入，所以 `@Transactional()` 是必须的（`check:tx` 会把缺失判为 MISSING）。

`MeshbotConfigService` 要补一个**不依赖 ALS** 的 getter，供删除时定位目录：

```ts
  /**
   * 指定 Agent 的数据根（显式传 id，不走 ALS）。
   * 供「删除 Agent」这类需要操作**非当前** Agent 目录的场景使用。
   */
  agentDirOf(agentId: string): string {
    return path.join(this.accountDir(), "agents", agentId);
  }
```

`SessionService` 要补 `findByAgentId(agentId: string): Promise<Session[]>` 与 `removeWithMessages(sessionId: string): Promise<void>`（后者若已存在则直接复用）。

`AgentService` 因此新增三个注入：`MeshbotConfigService`（定位目录）、`SessionService`（删会话）、以及 `@Transactional` / `BadRequestException` / `node:fs` 的 `rmSync` 三个 import。

**依赖方向检查**：`AgentService → SessionService` 是单向的（Task 2 里 `SessionService.create()` 把 `agentId` 当普通入参收，不反向依赖 `AgentService`），不会成环。

- [ ] **Step 5: 写 Controller**

`apps/server-agent/src/controllers/agent.controller.ts`：

```ts
import { AgentContextService } from "@meshbot/lib-agent";
import { McpConfigSchema } from "@meshbot/lib-agent";
import type { AgentView } from "@meshbot/types-agent";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { MeshbotConfigService, McpService } from "@meshbot/lib-agent";
import { AgentCreateDto, AgentUpdateDto, AgentViewDto } from "../dto/agent.dto";
import type { Agent } from "../entities/agent.entity";
import { AgentService } from "../services/agent.service";

/** Entity → 对外视图。日期转 ISO 字符串，与 AgentViewSchema 对齐。 */
function toAgentView(agent: Agent): AgentView {
  return {
    id: agent.id,
    name: agent.name,
    avatar: agent.avatar,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    defaultModelConfigId: agent.defaultModelConfigId,
    remoteEnabled: agent.remoteEnabled,
    visibility: agent.visibility,
    sortOrder: agent.sortOrder,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

@ApiTags("agents")
@Controller("api/agents")
export class AgentController {
  constructor(
    private readonly agents: AgentService,
    private readonly agentCtx: AgentContextService,
    private readonly config: MeshbotConfigService,
    private readonly mcp: McpService,
  ) {}

  @Get()
  @ApiOperation({ summary: "列出当前账号的全部 Agent" })
  @ApiOkResponse({ type: AgentViewDto, isArray: true })
  async list(): Promise<AgentView[]> {
    const agents = await this.agents.list();
    return agents.map(toAgentView);
  }

  @Post()
  @ApiOperation({ summary: "创建 Agent" })
  @ApiOkResponse({ type: AgentViewDto })
  async create(@Body() body: AgentCreateDto): Promise<AgentView> {
    return toAgentView(await this.agents.create(body));
  }

  @Patch(":id")
  @ApiOperation({ summary: "更新 Agent" })
  @ApiOkResponse({ type: AgentViewDto })
  async update(
    @Param("id") id: string,
    @Body() body: AgentUpdateDto,
  ): Promise<AgentView> {
    return toAgentView(await this.agents.update(id, body));
  }

  @Delete(":id")
  @ApiOperation({ summary: "删除 Agent（连同其会话、记忆、工作区）" })
  @ApiOkResponse()
  async remove(@Param("id") id: string): Promise<void> {
    await this.agents.removeWithData(id);
    await this.mcp.teardownAgent(this.currentAccount(), id);
  }

  @Post(":id/duplicate")
  @ApiOperation({ summary: "复制 Agent 的配置（不复制记忆/工作区/技能）" })
  @ApiOkResponse({ type: AgentViewDto })
  async duplicate(@Param("id") id: string): Promise<AgentView> {
    return toAgentView(await this.agents.duplicate(id));
  }

  @Get(":id/mcp")
  @ApiOperation({ summary: "读取该 Agent 的 mcp.json（不存在返回空配置）" })
  @ApiOkResponse()
  async getMcp(@Param("id") id: string): Promise<{ raw: string }> {
    await this.agents.findOrThrow(id);
    return this.agentCtx.run(id, () => {
      const path = this.config.getMcpConfigPath();
      const raw = existsSync(path)
        ? readFileSync(path, "utf8")
        : '{\n  "mcpServers": {}\n}\n';
      return { raw };
    });
  }

  @Put(":id/mcp")
  @ApiOperation({ summary: "写入该 Agent 的 mcp.json（Zod 校验后落盘并失效运行态）" })
  @ApiOkResponse()
  async putMcp(
    @Param("id") id: string,
    @Body() body: { raw: string },
  ): Promise<void> {
    await this.agents.findOrThrow(id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.raw);
    } catch (err) {
      throw new BadRequestException(
        `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = McpConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new BadRequestException(`配置校验失败：${result.error.message}`);
    }
    this.agentCtx.run(id, () => {
      writeFileSync(this.config.getMcpConfigPath(), body.raw, "utf8");
    });
    // 让运行态失效——下次 run 时 ensureAgent 会按新配置重建 client。
    await this.mcp.teardownAgent(this.currentAccount(), id);
  }
}
```

> `currentAccount()` 是个私有小方法，返回 `this.account.getOrThrow()`（注入 `AccountContextService`）。REST 请求已经由鉴权拦截器压过账号上下文，这里直接取即可。

**注意 `check:repo` 围栏**：Controller 不能注入 Repository——上面全部经 Service，合规。`McpConfigSchema` 需要从 `libs/agent` 导出（现在可能只在内部使用，要在 `libs/agent/src/index.ts` 补 export）。

- [ ] **Step 6: 跑测试 + 围栏**

```bash
pnpm test -- agent.controller.spec && pnpm check
```
Expected: PASS。重点确认三道围栏：
- `check:repo` —— Controller 没有直接注入 Repository
- `check:tx` —— `removeInDb` 跨三表写入，挂了 `@Transactional()`，不报 MISSING
- `check:naming` —— `removeInDb` 命中 `*InDb` 约定

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(agent): Agent CRUD REST + MCP 配置读写 REST"
```

---

## Task 10: web-agent — agent atoms + 图标导航条

**Files:**
- Create: `apps/web-agent/src/rest/agents.ts`
- Create: `apps/web-agent/src/atoms/agent.ts`
- Create: `apps/web-agent/src/components/shell/agent-rail.tsx`
- Modify: `apps/web-agent/src/app/(shell)/layout.tsx`
- Modify: `apps/web-agent/messages/zh.json` / `en.json`

**Interfaces:**
- Consumes: Task 9 的 REST 端点；`AgentView` 类型
- Produces: `useAgents()` hook（SWR/react-query，按仓库既有 `src/rest/*.ts` 的风格）；`currentAgentIdAtom`（`atomWithStorage`，持久化到 localStorage）；`<AgentRail />` 组件

- [ ] **Step 1: REST 客户端**

`apps/web-agent/src/rest/agents.ts` —— 照现有 `src/rest/devices.ts` 的写法（`apiClient` + 类型来自 `@meshbot/types-agent`）：`listAgents()` / `createAgent()` / `updateAgent()` / `deleteAgent()` / `duplicateAgent()` / `getAgentMcp()` / `putAgentMcp()`，以及 `useAgents()` hook。

- [ ] **Step 2: atom**

`apps/web-agent/src/atoms/agent.ts`：

```ts
import { atomWithStorage } from "jotai/utils";

/**
 * 当前选中的 Agent id，持久化到 localStorage。
 *
 * 注意：任何「按 Agent 隔离」的前端状态（会话列表、技能列表、用量）都必须
 * 按 agentId 分片或在切换时失效——本仓库在 usage atom 上栽过全局单例串台的坑。
 */
export const currentAgentIdAtom = atomWithStorage<string | null>(
  "meshbot.currentAgentId",
  null,
);
```

- [ ] **Step 3: AgentRail 组件**

`apps/web-agent/src/components/shell/agent-rail.tsx` —— 约 56px 宽的竖条：

- 每个 agent 渲染一个圆形头像按钮：`avatar` 是 `emoji|色值` 两段式，拆开后用色值做背景、emoji 做前景
- 当前选中的加高亮环（`ring-2 ring-primary`）
- 正在跑 run 的 agent 显示脉冲点（从会话 status 派生）
- hover 出 `Tooltip` 显示 `name`
- 底部一个 `+` 按钮，点开 Task 11 的新建抽屉
- 首屏若 `currentAgentIdAtom` 为 null 或指向已删除的 agent，自动选中列表第一个

所有文案走 `useTranslations("agent")`，新增 key 后跑 `pnpm sync:locales --write`。

- [ ] **Step 4: 挂进 shell layout**

`apps/web-agent/src/app/(shell)/layout.tsx` 里，在现有侧栏**左侧**插入 `<AgentRail />`，形成「图标条 + 主侧栏 + 主区」三栏。

- [ ] **Step 5: 验证**

```bash
pnpm dev:web-agent
```
Expected: 导航条渲染出默认 Agent；点 `+` 弹出抽屉（Task 11 前先接一个占位）；切换 agent 时 URL 不变但侧栏会话列表跟着换。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web-agent): Agent 图标导航条 + 当前 Agent atom"
```

---

## Task 11: web-agent — Agent 编辑抽屉

**Files:**
- Create: `apps/web-agent/src/components/agent/agent-editor-sheet.tsx`
- Modify: `apps/web-agent/src/components/shell/agent-rail.tsx`
- Modify: `apps/web-agent/messages/zh.json` / `en.json`

**Interfaces:**
- Consumes: Task 10 的 `useAgents()` / REST 客户端；Task 1 的 `AgentCreateSchema` / `AgentUpdateSchema`
- Produces: `<AgentEditorSheet agentId={string | null} open onOpenChange />`（`agentId` 为 null 时是新建）

- [ ] **Step 1: 表单**

走 `Form/FormItem` + `useSchema`（`web-form-convention` 规范），直接复用 `AgentCreateSchema`：

- 名字（`Input`）
- 头像：emoji 选择器 + 8 个预设背景色的色块选择，合成 `emoji|#hex`
- 描述（`Input`）
- system prompt（`Textarea`，高度大一些，支持多行）
- 默认模型（`Select`，选项来自现有的模型配置 REST；可空 = 跟随账号默认）

**「允许远程」开关本期不放**——列已经建好，但云端注册在计划二，放一个不生效的开关会误导人。

- [ ] **Step 2: 危险动作**

- 删除：`AlertDialog` 二次确认，文案必须写清「会同时删除该 Agent 的全部会话、记忆与工作区文件，不可恢复」
- 只剩一个 Agent 时，删除按钮 disabled + Tooltip 说明

- [ ] **Step 3: 复制**

「从现有 Agent 复制」调 `duplicateAgent(id)`，复制后直接打开新 agent 的编辑抽屉。

- [ ] **Step 4: 验证**

```bash
pnpm dev:web-agent
```
Expected: 新建 → 导航条立刻出现；改名 → 导航条 tooltip 跟着变；改 system prompt → **在该 agent 的既有会话里再发一条消息，回复的人格应立即变化**（这是 Task 7 的端到端验证）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web-agent): Agent 编辑抽屉（新建/编辑/复制/删除）"
```

---

## Task 12: web-agent — 技能/记忆页 Agent 化 + MCP 管理 UI

**Files:**
- Modify: `apps/web-agent/src/app/(shell)/skills/page.tsx`（及其 REST 客户端）
- Modify: 记忆相关页面 / 组件
- Create: `apps/web-agent/src/components/agent/mcp-editor.tsx`
- Modify: `apps/web-agent/messages/zh.json` / `en.json`

**Interfaces:**
- Consumes: Task 9 的 `agentId` 参数化 REST；Task 10 的 `currentAgentIdAtom`
- Produces: 技能页/记忆页/MCP 页全部作用于当前 Agent

- [ ] **Step 1: 技能页带 agentId**

所有技能 REST 调用（`installed` / `install` / `uninstall` / `publish`）带上 `currentAgentIdAtom` 的值。**缓存 key 必须包含 agentId**，否则切 Agent 后会看到上一个 Agent 的技能列表（这就是 usage atom 串台的同款坑）。

- [ ] **Step 2: MCP 编辑器**

`mcp-editor.tsx`：一个 JSON 编辑区（可以先用受控 `Textarea` + 保存时 Zod 校验，不必上 Monaco），保存调 `putAgentMcp(agentId, json)`。校验失败在下方红字提示具体错误。

放在 Agent 编辑抽屉的一个 Tab 里，或独立设置页——二选一，跟现有 IA 保持一致。

- [ ] **Step 3: 记忆页带 agentId**

同技能页。

- [ ] **Step 4: 验证（关键）**

```bash
pnpm dev:server-agent   # 一个终端
pnpm dev:web-agent      # 另一个终端
```

手工验证清单：
1. 建 Agent A、Agent B
2. 给 A 装一个技能，切到 B —— **B 的技能列表必须是空的**
3. 给 A 配一个 MCP server，切到 B —— **B 看不到 A 的 MCP 工具**
4. 在 A 里让它写一个文件，切到 B 让它 `ls` —— **B 看不到 A 的文件**
5. 磁盘上确认 `accounts/<id>/agents/<A>/` 与 `<B>/` 两棵独立的树

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web-agent): 技能/记忆/MCP 页降级为 Agent 级 + 新增 MCP 管理 UI"
```

---

## Task 13: 终验 + 文档

**Files:**
- Modify: `.claude/CLAUDE.md`（表归属章节）

- [ ] **Step 1: 全量验证**

```bash
pnpm check && pnpm test && pnpm typecheck
```
Expected: 围栏 0 finding；测试全绿（对照 main 的基线判断，不要把预存在失败算成回归）；类型 0 错误。

**读完整输出，不要只看 tail** —— turbo 的退出码会掩盖子任务失败。

- [ ] **Step 2: 双 Agent 并发冒烟（自动化覆盖不到）**

同时在 Agent A 和 Agent B 里各发一条会触发工具调用的消息，确认：
- 两个 run 的工具集不串（A 的 MCP 工具不出现在 B 的调用里）
- 两个 run 的工作区不串
- 两个 run 的 usage 标注各自正确（`llm_calls` 表里 model 不互相覆盖）

这是 ALS 隔离最容易出问题的地方——`ModelRunContext` 的注释里已经记了一次并行 run 互相覆盖 meta 的教训。

- [ ] **Step 3: 更新 CLAUDE.md 表归属**

在「表归属」表的 server-agent 行加上 `Agent`（新表）与 `Session` 的 `agent_id` 列说明。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: CLAUDE.md 表归属补 agents 表与 sessions.agent_id"
```

---

## 交付后的状态

做完这 13 个 Task：

- 本地可以创建任意多个 Agent，各自独立的人格、技能、MCP、记忆、工作区、默认模型
- 会话绑定 Agent，切 Agent 就切一整套上下文
- 改 system prompt 立即对既有会话生效
- MCP 子进程按 Agent 懒加载、闲置回收，不会因为 Agent 变多而爆炸

**没做**（计划二）：`remote_enabled` 开关的 UI 与云端注册、云端寻址从 `deviceId` 改为 `agentId`、web-main 改造、双轨对等技能。数据库的 `remote_enabled` / `visibility` 两列已经建好，计划二不需要再动本地迁移。
