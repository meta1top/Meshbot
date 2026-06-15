# 本地 Agent 数据按云端账号隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 单进程 server-agent 内多账号并发隔离——共享 `agent.db` 按 `cloud_user_id` 字段隔离、请求级账号上下文、每账号运行时（MCP/技能/提示词/云连接）登录建登出拆。

**Architecture:** 权威设计见 [docs/superpowers/specs/2026-06-15-local-agent-per-account-isolation-design.md](../specs/2026-06-15-local-agent-per-account-isolation-design.md)（v3）。核心三件套：(1) `AccountContextService`（`AsyncLocalStorage` 持当前 `cloudUserId`，请求经 JWT `sub` 注入、后台显式 `run`）；(2) `ScopedRepository`（集中式作用域，自动注入 `cloud_user_id` 过滤 + 写时带账号，`.unscoped()` 是唯一受审 escape）；(3) `AccountRuntimeRegistry`（`Map<cloudUserId, AccountRuntime>`，登录 create / 登出 teardown / 改配置 reload）。新增 `check:scope` 静态围栏挡裸查询防并发串台。

**Tech Stack:** NestJS、TypeORM + better-sqlite3（TypeORM 迁移）、`node:async_hooks` AsyncLocalStorage、ts-morph（围栏）、@nestjs/jwt + passport-jwt、socket.io-client、jest（server-agent）、vitest（libs/agent）。

---

## 阶段总览（对应 spec §13）

1. **数据模型 + 迁移**：7 张账号表加 `cloud_user_id`；`CloudIdentity` 改多行（PK=`cloud_user_id`）+ `logged_in`；`CloudIdentityService` 多行化；SQLite 迁移。
2. **请求级账号上下文 + 集中作用域 + 静态围栏**：`AccountContextService` + JWT 注入拦截器 + `ScopedRepository` + `check:scope` 围栏；7 个归属 Service 接入。
3. **每账号运行时注册表 + 文件账号化 + 热重载**：`MeshbotConfigService` 文件 getter 账号化；`McpService`/技能/提示词每账号化；`AccountRuntimeRegistry`；`ImRelayClientService` 账号化。
4. **登录/登出生命周期 + 重启恢复**：登录建运行时 + 签 JWT；登出 teardown + `logged_in=false`；boot 恢复全部已登录账号；runner 按 session 属主重建上下文。
5. **前端**：多账号 token 管理 + 切换/新增账号入口；登出清 token；复用 auth-guard。
6. **CronJob 跨账号作用域**：调度遍历全部已登录账号到期任务，各在本账号上下文执行。

## 通用约定（每个任务都适用）

- **TDD**：先写失败单测 → 跑红 → 最小实现 → 跑绿 → commit。server-agent 用 jest（`pnpm --filter @meshbot/server-agent test`），libs/agent 用 vitest（`pnpm --filter @meshbot/agent test`）。
- **静态围栏**：每个 commit 前 `pnpm check`（6 围栏）全绿。涉及 `@Transactional` 私有方法命名遵守 `*InTx`/`*InDb`/`persist*`（check:naming）。
- **迁移**：本地轨 SQLite 走 TypeORM 迁移文件，`apps/server-agent/src/migrations/<timestamp>-<Name>.ts`，类名 `Name<timestamp> implements MigrationInterface`，raw SQL + `IF NOT EXISTS`。现有最新 `1780000000000`；本计划新增从 `1780100000000` 起。
- **列名**：无 SnakeNamingStrategy，全部 `@Column({ name: "snake_case" })` 显式。
- **错误码**：agent 域用 3xxx；现有占用到 `IM_NOT_CONNECTED=3005`，本计划新增从 3006 起。
- **中文 JSDoc**：公开方法加中文 JSDoc。
- **账号隔离表清单（7 张）**：`sessions`/`session_messages`/`pending_messages`/`llm_calls`/`model_configs`/`settings`/`cron_jobs`。`cloud_identity` 是账号注册表本身，**不**在此清单（不按 `cloud_user_id` 过滤）。

---

## Phase 1：数据模型 + 迁移

### Task 1.1：7 张账号表实体加 `cloudUserId` 字段

**Files:**
- Modify: `apps/server-agent/src/entities/session.entity.ts`
- Modify: `apps/server-agent/src/entities/session-message.entity.ts`
- Modify: `apps/server-agent/src/entities/pending-message.entity.ts`
- Modify: `apps/server-agent/src/entities/llm-call.entity.ts`
- Modify: `apps/server-agent/src/entities/model-config.entity.ts`
- Modify: `apps/server-agent/src/entities/setting.entity.ts`
- Modify: `apps/server-agent/src/entities/cron-job.entity.ts`

- [ ] **Step 1: 给每个实体加 `cloudUserId` 列**

在每个实体类体内加入（放在主键之后、其余列之前）：

```typescript
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;
```

`setting.entity.ts` 当前只有 `key`(PK)+`value`，加列后为：

```typescript
@Entity("settings")
export class Setting {
  @PrimaryColumn()
  key!: string;

  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column()
  value!: string;
}
```

> 注意 `settings` 主键当前是 `key`。多账号下同一 `key` 各账号一份 → 主键需变为复合 `(cloud_user_id, key)`。本 Task 仅加列；复合主键在 Task 1.3 迁移 + Task 1.1b 实体主键调整中处理。

- [ ] **Step 2: `settings` 改复合主键**

把 `setting.entity.ts` 的 `key` 与 `cloudUserId` 都标为主键：

```typescript
@Entity("settings")
export class Setting {
  @PrimaryColumn({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @PrimaryColumn()
  key!: string;

  @Column()
  value!: string;
}
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: PASS（实体仅加列，无消费方编译错误——服务层查询在 Phase 2 改）

- [ ] **Step 4: Commit**

```bash
git add apps/server-agent/src/entities
git commit -m "feat(agent): 7 张账号表实体加 cloud_user_id（settings 改复合主键）"
```

---

### Task 1.2：`CloudIdentity` 实体改多行（PK=`cloud_user_id`）+ `logged_in`

**Files:**
- Modify: `apps/server-agent/src/entities/cloud-identity.entity.ts`

- [ ] **Step 1: 改主键为 `cloud_user_id`、删除 `id` 列、加 `logged_in`**

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * 云端身份镜像（v3 多行）：每个登录过的云端账号一行，主键 = cloudUserId。
 * loggedIn 标记当前是否登录（区别于「有缓存 token」——登出后行保留、token 留存，loggedIn=false）。
 */
@Entity("cloud_identity")
export class CloudIdentity {
  @PrimaryColumn({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column({ type: "text" })
  email!: string;

  @Column({ name: "display_name", type: "text" })
  displayName!: string;

  @Column({ name: "org_id", type: "text", nullable: true })
  orgId!: string | null;

  @Column({ name: "org_name", type: "text", nullable: true })
  orgName!: string | null;

  @Column({ type: "text", nullable: true })
  role!: string | null;

  @Column({ name: "cloud_token", type: "text" })
  cloudToken!: string;

  @Column({ name: "cloud_token_expires_at", type: "text", nullable: true })
  cloudTokenExpiresAt!: string | null;

  @Column({ name: "logged_in", type: "boolean", default: false })
  loggedIn!: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
```

- [ ] **Step 2: typecheck（预期 CloudIdentityService 报错）**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: FAIL —— `cloud-identity.service.ts` 仍用 `id: SINGLE_ROW_ID`，`id` 列已删。这是预期的，Task 1.4 修。

- [ ] **Step 3: 暂不 commit**，继续 Task 1.3/1.4（这三个 Task 是一组：实体+迁移+服务，一起 commit）。

---

### Task 1.3：迁移 —— 7 表加列 + `cloud_identity` 重建

**Files:**
- Create: `apps/server-agent/src/migrations/1780100000000-AddCloudUserIdToAccountTables.ts`
- Create: `apps/server-agent/src/migrations/1780200000000-CloudIdentityMultiRow.ts`

- [ ] **Step 1: 写 7 表加列迁移**

`1780100000000-AddCloudUserIdToAccountTables.ts`：

```typescript
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 7 张账号隔离表加 cloud_user_id（v3 字段隔离）。
 * 旧单用户数据无 cloud_user_id（NULL）→ 被作用域过滤，符合 D7「从空开始」。
 * settings 主键改为复合 (cloud_user_id, key)：SQLite 无 ALTER PRIMARY KEY，需重建表。
 */
export class AddCloudUserIdToAccountTables1780100000000
  implements MigrationInterface
{
  name = "AddCloudUserIdToAccountTables1780100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      "sessions",
      "session_messages",
      "pending_messages",
      "llm_calls",
      "model_configs",
      "cron_jobs",
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN "cloud_user_id" TEXT`,
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "idx_${table}_cloud_user_id" ON "${table}" ("cloud_user_id")`,
      );
    }

    // settings 复合主键：重建表
    await queryRunner.query(`
      CREATE TABLE "settings_new" (
        "cloud_user_id" TEXT NOT NULL,
        "key"           TEXT NOT NULL,
        "value"         TEXT NOT NULL,
        PRIMARY KEY ("cloud_user_id", "key")
      )
    `);
    // 旧行无账号归属 → 不迁移（D7）。直接换表。
    await queryRunner.query(`DROP TABLE "settings"`);
    await queryRunner.query(`ALTER TABLE "settings_new" RENAME TO "settings"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 DROP COLUMN（旧版），保留列；仅回滚 settings 结构与索引。
    for (const table of [
      "sessions",
      "session_messages",
      "pending_messages",
      "llm_calls",
      "model_configs",
      "cron_jobs",
    ]) {
      await queryRunner.query(
        `DROP INDEX IF EXISTS "idx_${table}_cloud_user_id"`,
      );
    }
    await queryRunner.query(`
      CREATE TABLE "settings_old" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL)
    `);
    await queryRunner.query(`DROP TABLE "settings"`);
    await queryRunner.query(`ALTER TABLE "settings_old" RENAME TO "settings"`);
  }
}
```

- [ ] **Step 2: 写 `cloud_identity` 重建迁移**

`1780200000000-CloudIdentityMultiRow.ts`：

```typescript
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * cloud_identity 单行（id='default'）→ 多行（PK=cloud_user_id）+ logged_in 列。
 * 旧单行无法可靠映射到具体账号，直接重建（D7「从空开始」，用户重新登录）。
 */
export class CloudIdentityMultiRow1780200000000 implements MigrationInterface {
  name = "CloudIdentityMultiRow1780200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cloud_identity"`);
    await queryRunner.query(`
      CREATE TABLE "cloud_identity" (
        "cloud_user_id"          TEXT PRIMARY KEY NOT NULL,
        "email"                  TEXT NOT NULL,
        "display_name"           TEXT NOT NULL,
        "org_id"                 TEXT,
        "org_name"               TEXT,
        "role"                   TEXT,
        "cloud_token"            TEXT NOT NULL,
        "cloud_token_expires_at" TEXT,
        "logged_in"              INTEGER NOT NULL DEFAULT 0,
        "created_at"             DATETIME NOT NULL DEFAULT (datetime('now')),
        "updated_at"             DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_cloud_identity_logged_in" ON "cloud_identity" ("logged_in")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cloud_identity"`);
    await queryRunner.query(`
      CREATE TABLE "cloud_identity" (
        "id"                     TEXT PRIMARY KEY NOT NULL,
        "cloud_user_id"          TEXT NOT NULL,
        "email"                  TEXT NOT NULL,
        "display_name"           TEXT NOT NULL,
        "org_id"                 TEXT,
        "org_name"               TEXT,
        "role"                   TEXT,
        "cloud_token"            TEXT NOT NULL,
        "cloud_token_expires_at" TEXT,
        "created_at"             DATETIME NOT NULL DEFAULT (datetime('now')),
        "updated_at"             DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }
}
```

- [ ] **Step 3: 验证迁移能跑（用临时库）**

Run: `cd apps/server-agent && MESHBOT_HOME=/tmp/meshbot-migtest pnpm migration run`（若该脚本不存在，用 `pnpm --filter @meshbot/server-agent build && MESHBOT_HOME=/tmp/meshbot-migtest node dist/main.js` 启动观察迁移日志后 Ctrl-C）
Expected: 迁移 `AddCloudUserIdToAccountTables1780100000000`、`CloudIdentityMultiRow1780200000000` 成功执行无报错。清理：`rm -rf /tmp/meshbot-migtest`

---

### Task 1.4：`CloudIdentityService` 多行化

**Files:**
- Modify: `apps/server-agent/src/services/cloud-identity.service.ts`
- Test: `apps/server-agent/src/services/cloud-identity.service.spec.ts`

- [ ] **Step 1: 写失败单测**

`cloud-identity.service.spec.ts`（用内存 sqlite DataSource，参考仓库现有 service spec 的 TestingModule 装配方式）：

```typescript
describe("CloudIdentityService（多行）", () => {
  // ... beforeEach 建内存 DataSource + Repository<CloudIdentity>，注入 service

  it("upsert 后 get(cloudUserId) 返回该账号且 loggedIn=true", async () => {
    await service.upsert({
      cloudUserId: "u1",
      email: "a@x.com",
      displayName: "A",
      cloudToken: "t1",
      cloudTokenExpiresAt: null,
      orgId: "o1",
      orgName: "Org",
      role: "owner",
    });
    const got = await service.get("u1");
    expect(got?.cloudUserId).toBe("u1");
    expect(got?.loggedIn).toBe(true);
    expect(await service.get("u2")).toBeNull();
  });

  it("两个账号互不覆盖", async () => {
    await service.upsert({ cloudUserId: "u1", email: "a", displayName: "A", cloudToken: "t1", cloudTokenExpiresAt: null, orgId: null, orgName: null, role: null });
    await service.upsert({ cloudUserId: "u2", email: "b", displayName: "B", cloudToken: "t2", cloudTokenExpiresAt: null, orgId: null, orgName: null, role: null });
    expect((await service.get("u1"))?.email).toBe("a");
    expect((await service.get("u2"))?.email).toBe("b");
  });

  it("setLoggedOut 只清该账号 loggedIn，行与 token 保留", async () => {
    await service.upsert({ cloudUserId: "u1", email: "a", displayName: "A", cloudToken: "t1", cloudTokenExpiresAt: null, orgId: null, orgName: null, role: null });
    await service.setLoggedOut("u1");
    const got = await service.get("u1");
    expect(got?.loggedIn).toBe(false);
    expect(got?.cloudToken).toBe("t1");
  });

  it("listLoggedIn 仅返回 loggedIn=true 的账号", async () => {
    await service.upsert({ cloudUserId: "u1", email: "a", displayName: "A", cloudToken: "t1", cloudTokenExpiresAt: null, orgId: null, orgName: null, role: null });
    await service.upsert({ cloudUserId: "u2", email: "b", displayName: "B", cloudToken: "t2", cloudTokenExpiresAt: null, orgId: null, orgName: null, role: null });
    await service.setLoggedOut("u2");
    const ids = (await service.listLoggedIn()).map((r) => r.cloudUserId);
    expect(ids).toEqual(["u1"]);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @meshbot/server-agent test -- cloud-identity.service`
Expected: FAIL（方法签名不符 / `id` 列已删导致编译或运行错误）

- [ ] **Step 3: 实现多行 service**

`cloud-identity.service.ts` 全量替换为：

```typescript
import { InjectRepository } from "@nestjs/typeorm";
import { Injectable } from "@nestjs/common";
import { Repository } from "typeorm";
import { CloudIdentity } from "../entities/cloud-identity.entity";

/** 云端身份镜像访问（v3 多行，按 cloudUserId 键）。CloudIdentity 是账号注册表本身，不走账号作用域。 */
@Injectable()
export class CloudIdentityService {
  constructor(
    @InjectRepository(CloudIdentity)
    private readonly repo: Repository<CloudIdentity>,
  ) {}

  /** 取指定账号的身份镜像；不存在返回 null。 */
  async get(cloudUserId: string): Promise<CloudIdentity | null> {
    return this.repo.findOne({ where: { cloudUserId } });
  }

  /** 登录时 upsert 该账号镜像并置 loggedIn=true。 */
  async upsert(fields: {
    cloudUserId: string;
    email: string;
    displayName: string;
    cloudToken: string;
    cloudTokenExpiresAt: string | null;
    orgId: string | null;
    orgName: string | null;
    role: string | null;
  }): Promise<void> {
    await this.repo.save({ ...fields, loggedIn: true });
  }

  /** 更新某账号当前组织。 */
  async updateActiveOrg(
    cloudUserId: string,
    orgId: string | null,
    orgName: string | null,
    role: string | null,
  ): Promise<void> {
    await this.repo.update({ cloudUserId }, { orgId, orgName, role });
  }

  /** 登出：置 loggedIn=false，保留行与 token（D5 离线可用）。 */
  async setLoggedOut(cloudUserId: string): Promise<void> {
    await this.repo.update({ cloudUserId }, { loggedIn: false });
  }

  /** 当前已登录账号列表（D9 重启恢复用）。 */
  async listLoggedIn(): Promise<CloudIdentity[]> {
    return this.repo.find({ where: { loggedIn: true } });
  }
}
```

> 注意：原 `clear()`（删行）被 `setLoggedOut()` 取代。`ImRelayClientService` 的 `connect_error` 里原调用 `cloudIdentityService.clear()`，在 Phase 3 账号化 relay 时改为 `setLoggedOut(cloudUserId)`。原 `CloudClientService` 工厂里 `setUnauthorizedHandler(() => identity.clear())` 同样在 Phase 4 调整。

- [ ] **Step 4: 跑绿 + typecheck**

Run: `pnpm --filter @meshbot/server-agent test -- cloud-identity.service && pnpm --filter @meshbot/server-agent typecheck`
Expected: 测试 PASS。typecheck 可能仍报 `cloud-auth.service.ts`/`im-relay-client.service.ts`/`cloud-org.service.ts`/`auth.module.ts` 用旧签名（`get()` 无参、`clear()`、`updateActiveOrg(3 参)`）——这些在 Phase 3/4 修。**本 Task 仅保证 service 自身 + 其 spec 绿**；若 typecheck 阻塞，临时在调用方用 `// @ts-expect-error Phase 3/4 修` 标注或先跳过，但**不 commit 带 ts-expect-error**——正确做法是把 Task 1.4 与 Phase 4 的 `cloud-auth.service` 改动连续做。为保持本阶段可独立 commit，加 Step 5 的最小占位适配。

- [ ] **Step 5: 最小占位适配（让全包 typecheck 过，行为不变）**

临时改 `cloud-auth.service.ts`、`cloud-org.service.ts`、`im-relay-client.service.ts`、`auth.module.ts` 中对 `identity.get()/clear()/updateActiveOrg()` 的调用以匹配新签名，但**逻辑仍是单账号**（用 `auth.user.id` / 从 socket 无法取时留 TODO）。具体：
  - `cloud-auth.service.ts` `afterCloudAuth`：`get()` → 该方法本就有 `auth.user.id`，`logout()` 暂用 `identity.setLoggedOut(<当前>)`——但 logout 无 cloudUserId 入参，**先临时空实现**（Phase 4 正式接入 AccountContext）。为不破坏行为，logout 暂改为 `// Phase 4 接入；当前 noop 以待重写` 保留 `imRelay.disconnect()`。
  - `im-relay-client.service.ts` `connect()`：`cloudIdentityService.get()` → `get(/* Phase 3 账号化 */)` 暂传一个占位——**这会破坏单例 relay**，所以更稳妥的做法是：**把 Task 1.4 合并进 Phase 4 第一个 Task 一起做**，不在此独立 commit。

> **实施建议（覆盖上面纠结）**：Task 1.1–1.3（实体+迁移）独立 commit；**Task 1.4 暂不单独 commit，留到 Phase 4 Task 4.1 一起改**（因为多行化会连锁改 auth/relay 调用方）。Phase 1 的「可独立测试软件」边界 = 迁移能跑 + 实体编译。CloudIdentityService 的 spec 先写好放着（红→Phase 4 转绿）。

- [ ] **Step 6: Commit（仅实体 + 迁移 + spec 文件，不含 service 实现）**

```bash
git add apps/server-agent/src/entities/cloud-identity.entity.ts \
        apps/server-agent/src/migrations/1780100000000-AddCloudUserIdToAccountTables.ts \
        apps/server-agent/src/migrations/1780200000000-CloudIdentityMultiRow.ts \
        apps/server-agent/src/services/cloud-identity.service.spec.ts
git commit -m "feat(agent): cloud_identity 多行实体 + cloud_user_id 迁移（service 实现见 Phase 4）"
```

> typecheck 在此 commit 点可能因 `cloud-identity.service.ts` 旧实现与新实体不符而红。为保证 Phase 1 commit 干净，**把 Task 1.2 的实体改动也推迟到 Phase 4 Task 4.1**，Phase 1 只交付 7 张账号表的 `cloud_user_id`（Task 1.1）+ 其迁移（Task 1.3 的 `1780100000000` 文件）。`cloud_identity` 多行（Task 1.2 实体 + `1780200000000` 迁移 + Task 1.4 service）整体并入 Phase 4 Task 4.1。**这样 Phase 1 边界清晰、可独立 typecheck/commit。**

**→ Phase 1 最终交付**：Task 1.1（7 表加 `cloud_user_id`，settings 复合主键）+ `1780100000000` 迁移。`cloud_identity` 相关全部移交 Phase 4 Task 4.1。

---

## Phase 2：请求级账号上下文 + 集中作用域 + 静态围栏

> 本阶段是 spec §6 的核心风险缓解。产出：`AccountContextService`、`ScopedRepository` + 工厂、JWT→上下文拦截器、`check:scope` 围栏，并把 7 个归属 Service 接入。新建 `apps/server-agent/src/account/` 目录归拢账号基础设施。

### 架构定位（贯穿 Phase 2/3，先读）

**`AccountContextService` 落在 `libs/agent`（不是 apps/server-agent）。** 原因：Phase 3 的 libs/agent 运行时代码（`MeshbotConfigService`/`SkillService`/`PromptService`/`McpService`）要读「当前账号」，而依赖方向只允许 `apps/server-agent → libs/agent`，libs/agent 不能反向依赖 server-agent。AsyncLocalStorage 单例须全进程共享，所以 `AccountContextService` 由 libs/agent 的一个 `@Global()` 模块提供、被 `AgentModule`（已被 AppModule 导入）传递，server-agent 侧的 `ScopedRepository`/拦截器从 `@meshbot/agent` 注入同一单例。

**错误码分层**：`NO_ACCOUNT_CONTEXT` 由 libs/agent 的 `AccountContextService` 抛 → 定义在 **libs/agent 的错误码注册处**（libs/agent 用 `defineErrorCode` 的文件，code 取该 lib 域允许区间内下一个值，`check:error-code` 校验区间）。`CROSS_ACCOUNT_WRITE`（ScopedRepository 防御性跨账号写校验）定义在 **server-agent** `agent.error-codes.ts`。

### Task 2.1：错误码

**Files:**
- Modify: libs/agent 的错误码注册文件（实施者定位：libs/agent / libs/types-agent 中现有 `defineErrorCode` 处）—— 加 `NO_ACCOUNT_CONTEXT`
- Modify: `apps/server-agent/src/errors/agent.error-codes.ts` —— 加 `CROSS_ACCOUNT_WRITE`

- [ ] **Step 1: libs/agent 加 `NO_ACCOUNT_CONTEXT`**

在 libs/agent 错误码注册处加（message `"account.noContext"`，httpStatus 500，code 取该 lib 域区间内下一个未占用值）。

- [ ] **Step 2: server-agent 加 `CROSS_ACCOUNT_WRITE`**

在 `agent.error-codes.ts` 紧接 `IM_NOT_CONNECTED: { code: 3005 }` 之后加：

```typescript
  CROSS_ACCOUNT_WRITE: {
    code: 3006,
    message: "account.crossWrite",
    httpStatus: 403,
  },
```

- [ ] **Step 3: i18n 补 key**

在 server-agent `i18n/en/*.json`、`i18n/zh/*.json` 与（如适用）libs/agent 的 i18n 补 `account.noContext`（en `"No active account context"` / zh `"无活跃账号上下文"`）、`account.crossWrite`（en `"Cross-account write rejected"` / zh `"拒绝跨账号写入"`）。

- [ ] **Step 4: check:error-code + commit**

Run: `pnpm check:error-code`
Expected: PASS（无 GAP/重复/越界）

```bash
git add -A
git commit -m "feat(agent): 账号上下文错误码 NO_ACCOUNT_CONTEXT(libs/agent)/CROSS_ACCOUNT_WRITE(server-agent)"
```

---

### Task 2.2：`AccountContextService`（AsyncLocalStorage，落 libs/agent）

**Files:**
- Create: `libs/agent/src/account/account-context.service.ts`
- Create: `libs/agent/src/account/account-context.module.ts`（`@Global()`）
- Modify: `libs/agent/src/agent.module.ts`（imports 加 `AccountContextModule`）+ libs/agent 包导出（index.ts 导出 `AccountContextService`）
- Test: `libs/agent/src/account/account-context.service.spec.ts`（**vitest**，libs/agent 用 vitest）

- [ ] **Step 1: 写失败单测**

```typescript
import { AccountContextService } from "./account-context.service";
import { AppError } from "@meshbot/common";

describe("AccountContextService", () => {
  let svc: AccountContextService;
  beforeEach(() => {
    svc = new AccountContextService();
  });

  it("run 内 get 返回该账号", () => {
    svc.run("u1", () => {
      expect(svc.get()).toBe("u1");
    });
  });

  it("run 外 get 返回 null", () => {
    expect(svc.get()).toBeNull();
  });

  it("嵌套 run 取最内层", () => {
    svc.run("u1", () => {
      svc.run("u2", () => expect(svc.get()).toBe("u2"));
      expect(svc.get()).toBe("u1");
    });
  });

  it("异步连续体内仍保留上下文", async () => {
    await svc.run("u1", async () => {
      await Promise.resolve();
      expect(svc.get()).toBe("u1");
    });
  });

  it("getOrThrow 无上下文抛 NO_ACCOUNT_CONTEXT", () => {
    expect(() => svc.getOrThrow()).toThrow(AppError);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @meshbot/agent test -- account-context`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 service**（libs/agent）

```typescript
import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";
import { AppError } from "@meshbot/common";
import { AgentDomainErrorCode } from "<libs/agent 错误码注册路径>";

interface AccountStore {
  cloudUserId: string;
}

/**
 * 进程内「当前账号上下文」（v3 请求级隔离）。
 * - 请求路径：JWT 鉴权后由 AccountContextInterceptor 注入 sub。
 * - 后台路径（cron / runner）：执行前显式 run(cloudUserId, fn)。
 * 基于 AsyncLocalStorage，异步连续体自动继承。
 */
@Injectable()
export class AccountContextService {
  private readonly als = new AsyncLocalStorage<AccountStore>();

  /** 在指定账号上下文中运行 fn（同步或异步）。 */
  run<T>(cloudUserId: string, fn: () => T): T {
    return this.als.run({ cloudUserId }, fn);
  }

  /** 当前账号；无上下文返回 null。 */
  get(): string | null {
    return this.als.getStore()?.cloudUserId ?? null;
  }

  /** 当前账号；无上下文抛 NO_ACCOUNT_CONTEXT。 */
  getOrThrow(): string {
    const id = this.get();
    if (!id) {
      throw new AppError(AgentDomainErrorCode.NO_ACCOUNT_CONTEXT);
    }
    return id;
  }
}
```

- [ ] **Step 4: 建 `@Global()` AccountContextModule（libs/agent）+ 导出**

```typescript
import { Global, Module } from "@nestjs/common";
import { AccountContextService } from "./account-context.service";

/** 全局账号上下文（AsyncLocalStorage 单例），供 libs/agent 与 server-agent 共享同一实例。 */
@Global()
@Module({
  providers: [AccountContextService],
  exports: [AccountContextService],
})
export class AccountContextModule {}
```

在 `libs/agent/src/agent.module.ts` 的 `imports` 加 `AccountContextModule`；在 libs/agent 包入口（index.ts / 公共导出）导出 `AccountContextService` 与 `AccountContextModule`，使 server-agent 可 `import { AccountContextService } from "@meshbot/agent"`。

- [ ] **Step 5: 跑绿**

Run: `pnpm --filter @meshbot/agent test -- account-context`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add libs/agent/src/account libs/agent/src/agent.module.ts libs/agent/src/index.ts
git commit -m "feat(agent): AccountContextService + @Global AccountContextModule（libs/agent，全进程共享 ALS）"
```

---

### Task 2.3：`ScopedRepository` + 工厂

**Files:**
- Create: `apps/server-agent/src/account/scoped-repository.ts`
- Create: `apps/server-agent/src/account/scoped-repository.factory.ts`
- Test: `apps/server-agent/src/account/scoped-repository.spec.ts`

- [ ] **Step 1: 写失败单测**（用内存 sqlite + 一个测试实体，验证自动过滤/带账号/跨账号写拒绝/unscoped 逃逸）

```typescript
// 用一个带 cloudUserId 的测试实体 ScopedTestEntity（id, cloudUserId, value）
// beforeEach：内存 DataSource + AccountContextService + ScopedRepositoryFactory
describe("ScopedRepository", () => {
  it("save 自动带上当前账号 cloud_user_id", async () => {
    await ctx.run("u1", () => scoped.save({ id: "a", value: "x" } as any));
    const raw = await rawRepo.findOneBy({ id: "a" });
    expect(raw?.cloudUserId).toBe("u1");
  });

  it("find 自动按当前账号过滤", async () => {
    await rawRepo.save([{ id: "a", cloudUserId: "u1", value: "x" }, { id: "b", cloudUserId: "u2", value: "y" }]);
    const rows = await ctx.run("u1", () => scoped.find());
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("findOneBy 合并账号过滤", async () => {
    await rawRepo.save([{ id: "a", cloudUserId: "u1", value: "x" }, { id: "a2", cloudUserId: "u2", value: "y" }]);
    expect(await ctx.run("u2", () => scoped.findOneBy({ value: "x" } as any))).toBeNull();
  });

  it("update 限定在当前账号（不误改他账号同条件行）", async () => {
    await rawRepo.save([{ id: "a", cloudUserId: "u1", value: "x" }, { id: "b", cloudUserId: "u2", value: "x" }]);
    await ctx.run("u1", () => scoped.update({ value: "x" } as any, { value: "z" } as any));
    expect((await rawRepo.findOneBy({ id: "b" }))?.value).toBe("x");
  });

  it("无上下文调用抛 NO_ACCOUNT_CONTEXT", async () => {
    await expect(scoped.find()).rejects.toThrow();
  });

  it("unscoped() 绕过过滤（系统级读）", async () => {
    await rawRepo.save([{ id: "a", cloudUserId: "u1", value: "x" }, { id: "b", cloudUserId: "u2", value: "y" }]);
    const all = await scoped.unscoped().find();
    expect(all.length).toBe(2);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @meshbot/server-agent test -- scoped-repository`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `ScopedRepository`**

```typescript
import type {
  DeepPartial,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  Repository,
  ObjectLiteral,
} from "typeorm";
import type { AccountContextService } from "@meshbot/agent";

/**
 * 账号作用域仓库包装：自动把 cloud_user_id = 当前账号 合并进读/写条件。
 * 唯一受审的越权出口是 unscoped()（系统级读，如按 session 反查属主）。
 * check:scope 围栏禁止归属 Service 直接调用裸 Repository 查询方法。
 */
export class ScopedRepository<T extends ObjectLiteral> {
  constructor(
    private readonly repo: Repository<T>,
    private readonly ctx: AccountContextService,
  ) {}

  /** 逃逸出口：返回裸 Repository，跳过账号过滤（系统级，慎用，受 check:scope 显式放行）。 */
  unscoped(): Repository<T> {
    return this.repo;
  }

  private acct(): string {
    return this.ctx.getOrThrow();
  }

  private mergeWhere(
    where?: FindOptionsWhere<T> | FindOptionsWhere<T>[],
  ): FindOptionsWhere<T> | FindOptionsWhere<T>[] {
    const acct = this.acct();
    const inject = { cloud_user_id: acct } as unknown as FindOptionsWhere<T>;
    if (Array.isArray(where)) {
      return where.map((w) => ({ ...w, ...inject }));
    }
    return { ...(where ?? {}), ...inject };
  }

  find(options?: FindManyOptions<T>): Promise<T[]> {
    return this.repo.find({ ...options, where: this.mergeWhere(options?.where) });
  }

  findOne(options: FindOneOptions<T>): Promise<T | null> {
    return this.repo.findOne({
      ...options,
      where: this.mergeWhere(options.where),
    });
  }

  findOneBy(where: FindOptionsWhere<T>): Promise<T | null> {
    return this.repo.findOne({ where: this.mergeWhere(where) });
  }

  findBy(where: FindOptionsWhere<T>): Promise<T[]> {
    return this.repo.find({ where: this.mergeWhere(where) });
  }

  count(options?: FindManyOptions<T>): Promise<number> {
    return this.repo.count({ ...options, where: this.mergeWhere(options?.where) });
  }

  async save<E extends DeepPartial<T>>(entity: E): Promise<E> {
    const acct = this.acct();
    return this.repo.save({ ...entity, cloud_user_id: acct } as E) as Promise<E>;
  }

  update(
    where: FindOptionsWhere<T>,
    partial: Parameters<Repository<T>["update"]>[1],
  ) {
    return this.repo.update(this.mergeWhere(where), partial);
  }

  delete(where: FindOptionsWhere<T>) {
    return this.repo.delete(this.mergeWhere(where));
  }

  /** 作用域化的 QueryBuilder：自动加 alias.cloud_user_id = :acct。 */
  scopedQueryBuilder(alias: string) {
    const acct = this.acct();
    return this.repo
      .createQueryBuilder(alias)
      .where(`${alias}.cloud_user_id = :__acct`, { __acct: acct });
  }
}
```

> **注意**：`cloud_user_id` 作为字面 key 注入 where（TypeORM 接受 DB 列名或属性名；属性名是 `cloudUserId`）。**统一用属性名 `cloudUserId`**——把上面 `cloud_user_id` 全改为 `cloudUserId` 以匹配实体属性（TypeORM where 用属性名）。save 的注入键同样用 `cloudUserId`。实现时以「实体属性名 `cloudUserId`」为准。

- [ ] **Step 4: 实现工厂**

```typescript
import { Injectable } from "@nestjs/common";
import type { ObjectLiteral, Repository } from "typeorm";
import { AccountContextService } from "@meshbot/agent";
import { ScopedRepository } from "./scoped-repository";

/** 把裸 Repository 包成 ScopedRepository。归属 Service 在构造里调用。 */
@Injectable()
export class ScopedRepositoryFactory {
  constructor(private readonly ctx: AccountContextService) {}

  create<T extends ObjectLiteral>(repo: Repository<T>): ScopedRepository<T> {
    return new ScopedRepository<T>(repo, this.ctx);
  }
}
```

- [ ] **Step 5: 跑绿（先把 spec 里 `cloud_user_id` 字面改 `cloudUserId`）**

Run: `pnpm --filter @meshbot/server-agent test -- scoped-repository`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server-agent/src/account/scoped-repository.ts \
        apps/server-agent/src/account/scoped-repository.factory.ts \
        apps/server-agent/src/account/scoped-repository.spec.ts
git commit -m "feat(agent): ScopedRepository 账号作用域仓库 + 工厂（unscoped 逃逸出口）"
```

---

### Task 2.4：JWT → 账号上下文拦截器

**Files:**
- Create: `apps/server-agent/src/account/account-context.interceptor.ts`
- Create: `apps/server-agent/src/account/account.module.ts`
- Modify: `apps/server-agent/src/app.module.ts`（注册全局拦截器 + 导入 AccountModule）
- Test: `apps/server-agent/src/account/account-context.interceptor.spec.ts`

- [ ] **Step 1: 写失败单测**（验证从 `request.user.id` 注入 ALS，且在 observable 订阅期间上下文有效）

```typescript
import { of } from "rxjs";
import { AccountContextService } from "./account-context.service";
import { AccountContextInterceptor } from "./account-context.interceptor";

describe("AccountContextInterceptor", () => {
  it("把 request.user.id 注入上下文供下游读取", (done) => {
    const ctx = new AccountContextService();
    const interceptor = new AccountContextInterceptor(ctx);
    const exec: any = {
      switchToHttp: () => ({ getRequest: () => ({ user: { id: "u1" } }) }),
    };
    const next: any = {
      handle: () => of(ctx.get()),
    };
    interceptor.intercept(exec, next).subscribe((seen) => {
      expect(seen).toBe("u1");
      done();
    });
  });

  it("无 user 时不报错、原样放行", (done) => {
    const ctx = new AccountContextService();
    const interceptor = new AccountContextInterceptor(ctx);
    const exec: any = { switchToHttp: () => ({ getRequest: () => ({}) }) };
    const next: any = { handle: () => of("ok") };
    interceptor.intercept(exec, next).subscribe((v) => {
      expect(v).toBe("ok");
      done();
    });
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @meshbot/server-agent test -- account-context.interceptor`
Expected: FAIL

- [ ] **Step 3: 实现拦截器（订阅期处于 ALS 上下文）**

```typescript
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { AccountContextService } from "@meshbot/agent";

/**
 * 全局拦截器：在 JwtAuthGuard 之后运行，把 request.user.id（= JWT sub = cloudUserId）
 * 注入 AccountContext，使下游 service 的 ScopedRepository 自动按账号过滤。
 * 用手动 Observable 订阅确保订阅期（即 controller 同步调用 + 其异步连续体）处于 ALS 上下文内。
 */
@Injectable()
export class AccountContextInterceptor implements NestInterceptor {
  constructor(private readonly ctx: AccountContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ user?: { id?: string } }>();
    const cloudUserId = req?.user?.id;
    if (!cloudUserId) {
      return next.handle();
    }
    return new Observable((subscriber) => {
      this.ctx.run(cloudUserId, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
```

- [ ] **Step 4: 建 AccountModule（全局，导出上下文 + 工厂）**

```typescript
import { Global, Module } from "@nestjs/common";
import { ScopedRepositoryFactory } from "./scoped-repository.factory";

/**
 * server-agent 账号基础设施（全局）：作用域仓库工厂。
 * AccountContextService 由 libs/agent 的 @Global AccountContextModule 提供（AgentModule 已导入），
 * 此处不重复 provide，确保全进程同一 ALS 单例。
 */
@Global()
@Module({
  providers: [ScopedRepositoryFactory],
  exports: [ScopedRepositoryFactory],
})
export class AccountModule {}
```

- [ ] **Step 5: app.module.ts 注册**

在 `imports` 加 `AccountModule`；在 `providers` 加全局拦截器（在全局 guard 之后，保证 guard 先跑设置 `request.user`）：

```typescript
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AccountContextInterceptor } from "./account/account-context.interceptor";
// ...
    { provide: APP_INTERCEPTOR, useClass: AccountContextInterceptor },
```

> 注意已有 `ResponseInterceptor` 经 `app.useGlobalInterceptors` 注册在 main.ts。APP_INTERCEPTOR provider 与 useGlobalInterceptors 二者都生效；执行顺序：APP_INTERCEPTOR 先于 useGlobalInterceptors 注册的。账号上下文需尽量外层，APP_INTERCEPTOR 合适。

- [ ] **Step 6: 跑绿 + typecheck + 启动冒烟**

Run: `pnpm --filter @meshbot/server-agent test -- account-context.interceptor && pnpm --filter @meshbot/server-agent typecheck`
Expected: PASS。再 `pnpm --filter @meshbot/server-agent build && node dist/main.js`（占用 3100 则换 `MESHBOT_PORT=3199`）观察启动到 "Nest application successfully started" 无 DI 报错，Ctrl-C。

- [ ] **Step 7: Commit**

```bash
git add apps/server-agent/src/account/account-context.interceptor.* \
        apps/server-agent/src/account/account.module.ts \
        apps/server-agent/src/app.module.ts
git commit -m "feat(agent): JWT→账号上下文拦截器 + 全局 AccountModule"
```

---

### Task 2.5：归属 Service 接入 ScopedRepository —— SessionService（含 PendingMessage）

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`
- Test: `apps/server-agent/src/services/session.service.spec.ts`（补两账号隔离用例）

- [ ] **Step 1: 写失败单测（两账号隔离）**

在 session.service.spec.ts 增加：

```typescript
it("两账号会话互不可见", async () => {
  await ctx.run("u1", () => service.create({ title: "s-u1" }));
  await ctx.run("u2", () => service.create({ title: "s-u2" }));
  const listU1 = await ctx.run("u1", () => service.list());
  expect(listU1.every((s) => s.title === "s-u1")).toBe(true);
  expect(listU1.length).toBe(1);
});

it("跨账号取他人 session 返回空/拒绝", async () => {
  const s = await ctx.run("u1", () => service.create({ title: "s" }));
  expect(await ctx.run("u2", () => service.findOrNull(s.id))).toBeNull();
});
```

> spec 的 TestingModule 需 provide `AccountContextService` + `ScopedRepositoryFactory`（真实实例），并用 `ctx.run` 包裹调用。

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @meshbot/server-agent test -- session.service`
Expected: FAIL（当前无账号过滤，u2 能看到 u1 的会话）

- [ ] **Step 3: 改造 SessionService 用 ScopedRepository**

构造函数改为注入裸 repo + 工厂，build 出 scoped：

```typescript
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
// ...
  private readonly sessionRepo: ScopedRepository<Session>;
  private readonly pendingRepo: ScopedRepository<PendingMessage>;

  constructor(
    @InjectRepository(Session) rawSessionRepo: Repository<Session>,
    @InjectRepository(PendingMessage) rawPendingRepo: Repository<PendingMessage>,
    scopedFactory: ScopedRepositoryFactory,
    // ...其余依赖不变
  ) {
    this.sessionRepo = scopedFactory.create(rawSessionRepo);
    this.pendingRepo = scopedFactory.create(rawPendingRepo);
  }
```

逐个把方法体里的 `this.sessionRepo.*` / `this.pendingRepo.*` 调用迁到 ScopedRepository API（语义不变，账号自动注入）。已知调用点（来自测绘，行号以现网为准）：
  - `sessionRepo`: `save`（createSessionInTx）、`findOneBy`（×2，getOrThrow/peek）、`update`（×3：setStatus、rename、markTitleGenerated 带 `titleGenerated:false` 条件）、`delete`、`createQueryBuilder`（list 复杂 ORDER BY → 用 `scopedQueryBuilder("s")`）。
  - `pendingRepo`: `save`（×2）、`findOneBy`、`find`（×3：含 `where` 数组形态、failed、pending）、`update`（×6：In(ids) 各状态流转、`{status:"processing"}→{status:"pending"}` 全量回滚）、`delete`（×2：by id+sessionId+status、by sessionId）。
  - **关键**：`rollbackProcessingToPending()`（RunnerService.onModuleInit 调）当前是 `update({status:"processing"},{status:"pending"})` 全量回滚——v3 下它在**无账号上下文的 boot 阶段**跑，会因 `getOrThrow` 抛错。**该方法改用 `this.pendingRepo.unscoped().update(...)`**（系统级全量回滚是 D9 重启恢复的一部分，跨账号回滚 processing 是正确的）。
  - `In(...)` 条件：ScopedRepository.update 的 where 用 `{ id: In(ids) }`，工厂会并入 `cloudUserId`，确保只回滚本账号的。

- [ ] **Step 4: 跑绿**

Run: `pnpm --filter @meshbot/server-agent test -- session.service`
Expected: PASS（含新隔离用例 + 原有用例）

- [ ] **Step 5: check + commit**

Run: `pnpm check:tx && pnpm check:naming`（确保 `@Transactional` 私有方法命名仍合规）

```bash
git add apps/server-agent/src/services/session.service.ts apps/server-agent/src/services/session.service.spec.ts
git commit -m "feat(agent): SessionService 接入 ScopedRepository（Session/PendingMessage 账号隔离）"
```

---

### Task 2.6：SessionMessageService 接入 ScopedRepository

**Files:**
- Modify: `apps/server-agent/src/services/session-message.service.ts`
- Test: `apps/server-agent/src/services/session-message.service.spec.ts`

- [ ] **Step 1: 写失败单测**：两账号各写消息，`ctx.run("u1")` 下 `getHistory`/`activitySince` 只见 u1 的。

- [ ] **Step 2: 跑红** `pnpm --filter @meshbot/server-agent test -- session-message.service` → FAIL

- [ ] **Step 3: 改造**：构造注入 `@InjectRepository(SessionMessage) raw` + 工厂 → `this.repo = factory.create(raw)`。迁移调用点（来自测绘）：`insertWithSeq` 的 `createQueryBuilder().insert()`（insert 需手动带 `cloudUserId`：在 values 对象加 `cloudUserId: this.ctx.getOrThrow()`——为此 service 需额外注入 `AccountContextService`；或新增 `ScopedRepository.insertRows()` 助手。**采用注入 AccountContextService**，insert/复杂 QB 显式 `.andWhere("m.cloud_user_id = :acct")` + values 带 `cloudUserId`）；`findOneBy`（×5）、`find`（getHistory，`order/take`）、`createQueryBuilder("m")`（×2：round-up、activitySince base → 改 `scopedQueryBuilder("m")` 或裸 QB + andWhere）、`delete`（×2：by sessionId、by sessionId+seq>cutoff）、`update`（metadata）、`find`（select id 子集）。

> seq 子查询（insertWithSeq）用相关子查询计算序号——其 `WHERE session_id = ?` 需追加 `AND cloud_user_id = ?` 确保序号按账号+会话独立。该 SQL 在 Step 3 手改。

- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: check + commit** `git commit -m "feat(agent): SessionMessageService 账号作用域化"`

---

### Task 2.7：LlmCallService 接入 ScopedRepository

**Files:**
- Modify: `apps/server-agent/src/services/llm-call.service.ts`
- Test: `apps/server-agent/src/services/llm-call.service.spec.ts`

- [ ] **Step 1: 失败单测**：两账号各 record，`getByMessageIds`/`sumTokens`/`topModel` 只统计当前账号。
- [ ] **Step 2: 跑红** → FAIL
- [ ] **Step 3: 改造**：迁移调用点（测绘）：`save(create(...))`（record，create 后 save 自动带账号）、`find`（×2 by sessionId、by sessionId）、`find`（messageId In(...)）、`delete`（×2）、`findOne`（latest）、`createQueryBuilder("c")`（×2 sum/topModel → `scopedQueryBuilder("c")`）。
- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: check + commit** `git commit -m "feat(agent): LlmCallService 账号作用域化"`

---

### Task 2.8：ModelConfigService 接入 ScopedRepository

**Files:**
- Modify: `apps/server-agent/src/services/model-config.service.ts`
- Test: `apps/server-agent/src/services/model-config.service.spec.ts`

- [ ] **Step 1: 失败单测**：u1 建 model config，u2 `listEnabled`/`list` 看不到；u2 `findOneOrFail(u1 的 id)` 抛 NOT_FOUND。
- [ ] **Step 2: 跑红** → FAIL
- [ ] **Step 3: 改造**：调用点（测绘）：`find({where:{enabled:true}})`、`find()`、`findOneBy({id})`、`create(...)+save`、`findOneOrFail+Object.assign+save`、`remove`（注意 `remove(entity)` 是按实体主键删，本身已限定具体行；但取实体用的 `findOneOrFail` 已账号过滤，故安全）、`countBy({enabled:true})`。`remove` 在 ScopedRepository 未实现 → 用 `findOneOrFail` 取到本账号实体后 `this.repo.unscoped().remove(entity)`（实体已确属本账号，安全）。或给 ScopedRepository 加 `remove` 透传（实体已含 PK）。**采用 unscoped().remove(entity)**，因为 entity 来自 scoped 读，已账号校验。
- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: check + commit** `git commit -m "feat(agent): ModelConfigService 账号作用域化"`

---

### Task 2.9：SettingService 接入 ScopedRepository

**Files:**
- Modify: `apps/server-agent/src/services/setting.service.ts`
- Test: `apps/server-agent/src/services/setting.service.spec.ts`

- [ ] **Step 1: 失败单测**：u1 set key=`theme` value=`dark`，u2 get `theme` 为 null；u2 set 同 key 不覆盖 u1。
- [ ] **Step 2: 跑红** → FAIL
- [ ] **Step 3: 改造**：调用点：`find()`、`findOneBy({key})`（×2）、`create({key,value})+save`、`delete({key})`。save 自动带 `cloudUserId`；复合主键 `(cloudUserId,key)` 保证 upsert 按账号。
- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: check + commit** `git commit -m "feat(agent): SettingService 账号作用域化"`

---

### Task 2.10：ScheduleService（CronJob）接入 ScopedRepository

**Files:**
- Modify: `apps/server-agent/src/services/schedule.service.ts`
- Test: `apps/server-agent/src/services/schedule.service.spec.ts`

- [ ] **Step 1: 失败单测**：u1 建 cron job，u2 `list()` 看不到；u2 `findById(u1 的 id)` 抛/空。
- [ ] **Step 2: 跑红** → FAIL
- [ ] **Step 3: 改造**：调用点：`create+save`、`find({where:{...,sessionId}})`、`findOneBy({id})`（×2）、`save(row)`、`delete({id})`、`find({where:{sessionId}})+delete({sessionId})`、`update({id},patch)`。
  - **例外**：`ScheduleExecutor.onApplicationBootstrap` 调 `schedule.list()` 在**无账号上下文**下加载全部 job 注册（Phase 6 改为遍历各账号）。为不在 Phase 2 破坏启动，给 ScheduleService 加一个 `listAllAccountsForBootstrap(): Promise<CronJob[]>` 用 `this.repo.unscoped().find(...)`，Phase 6 替换调用方。本 Task 仅把账号 API 改 scoped，**保留** executor 现用的 list 走 unscoped bootstrap 方法。
- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: check + commit** `git commit -m "feat(agent): ScheduleService 账号作用域化（bootstrap 列表走 unscoped）"`

---

### Task 2.11：`check:scope` 静态围栏

**Files:**
- Create: `scripts/check-scope-access.ts`
- Create: `scripts/check-scope-access.spec.ts`（围栏单测，CLAUDE.md 要求）
- Create: `docs/audits/scope-fence/`（基线目录，首次运行生成）
- Modify: `package.json`（`check:scope` + 串/并行 `check` + `check:strict`）

- [ ] **Step 1: 写围栏单测（先定行为）**

参考 `scripts/lib/ts-files.ts` + ts-morph。围栏规则：**归属账号隔离实体（7 张表对应实体）的 Service，禁止对 `@InjectRepository(ScopedEntity)` 注入的裸 Repository 直接调用查询方法**（find/findOne/findOneBy/findBy/save/update/delete/count/insert/upsert/remove/createQueryBuilder）。合法出口：把裸 repo 传给 `ScopedRepositoryFactory.create(...)`，或在显式标注 `// scope-check: allow-unscoped` 的行调用（系统级）。

`check-scope-access.spec.ts`：

```typescript
import { runScopeCheck } from "./check-scope-access";

const SCOPED_ENTITY = `@Entity("sessions") export class Session { @Column({name:"cloud_user_id"}) cloudUserId!: string }`;

it("裸 repo.find 直接调用 → 违规", () => {
  const findings = runScopeCheck({
    "session.entity.ts": SCOPED_ENTITY,
    "session.service.ts": `
      @Injectable() export class SessionService {
        constructor(@InjectRepository(Session) private repo: Repository<Session>) {}
        list() { return this.repo.find(); }
      }`,
  });
  expect(findings.some((f) => f.type === "UNSCOPED_QUERY")).toBe(true);
});

it("repo 仅传入工厂 → 合规", () => {
  const findings = runScopeCheck({
    "session.entity.ts": SCOPED_ENTITY,
    "session.service.ts": `
      @Injectable() export class SessionService {
        private repo: ScopedRepository<Session>;
        constructor(@InjectRepository(Session) raw: Repository<Session>, f: ScopedRepositoryFactory) {
          this.repo = f.create(raw);
        }
        list() { return this.repo.find(); }
      }`,
  });
  expect(findings.length).toBe(0);
});

it("非账号实体（CloudIdentity）裸 repo 不报", () => {
  const findings = runScopeCheck({
    "cloud-identity.entity.ts": `@Entity("cloud_identity") export class CloudIdentity { @PrimaryColumn() cloudUserId!: string }`,
    "cloud-identity.service.ts": `
      @Injectable() export class CloudIdentityService {
        constructor(@InjectRepository(CloudIdentity) private repo: Repository<CloudIdentity>) {}
        get(id: string) { return this.repo.findOneBy({ cloudUserId: id }); }
      }`,
  });
  expect(findings.length).toBe(0);
});

it("allow-unscoped 标注的行豁免", () => {
  const findings = runScopeCheck({
    "session.entity.ts": SCOPED_ENTITY,
    "session.service.ts": `
      @Injectable() export class SessionService {
        constructor(@InjectRepository(Session) private repo: Repository<Session>) {}
        // scope-check: allow-unscoped
        rollback() { return this.repo.update({ status: "x" }, { status: "y" }); }
      }`,
  });
  expect(findings.length).toBe(0);
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm --filter-none tsx scripts/check-scope-access.spec.ts`（或加到 root jest：`pnpm test -- check-scope-access`）
Expected: FAIL（脚本不存在）

- [ ] **Step 3: 实现围栏**（结构对齐 `scripts/check-repo-access.ts`：ts-morph 加载 tsconfig.base.json、collectTsFiles、`@Entity` 扫账号实体集合、扫 Service 构造里 `@InjectRepository(ScopedEntity)` 的字段名、查该字段的 `.method(` 调用；`f.create(raw)` 形态视为合规；导出 `runScopeCheck(fileMap)` 供测试喂内存代码；CLI 跑全仓 + 基线 `docs/audits/scope-fence/<YYYY-MM-DD-HHmm>.{md,json}` + 增量 finding 判定 + `--strict`/`--json` 标志）。账号实体集合 = 实体类中含 `@Column({ name: "cloud_user_id" })` 或 `@PrimaryColumn({ name: "cloud_user_id" })` 的（自动发现，避免硬编码 7 张表名）。

- [ ] **Step 4: 跑绿（单测）**

Run: `pnpm test -- check-scope-access`
Expected: PASS

- [ ] **Step 5: 全仓跑围栏 + 生成基线**

Run: `pnpm exec tsx scripts/check-scope-access.ts --force-report`
Expected: 0 违规（Task 2.5–2.10 已把 7 个 service 全改 scoped；若有残留违规，回到对应 service 修）。生成 `docs/audits/scope-fence/*.json` 基线。

- [ ] **Step 6: package.json 接入**

```json
"check:scope": "tsx scripts/check-scope-access.ts",
"check": "pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:repo && pnpm check:scope && pnpm check:dead && pnpm check:error-code",
"check:parallel": "... 追加 check:scope ...",
"check:strict": "... && pnpm check:scope -- --strict && ..."
```

并把 `check:scope` 加进 pre-commit 钩子的并行围栏组（`.husky/pre-commit` 或其调用的脚本里那串 `/^check:(tx|naming|lock-tx|repo|dead|error-code)$/` → 加 `scope`）。

- [ ] **Step 7: 全套 check + commit**

Run: `pnpm check`
Expected: 全绿（含 check:scope）

```bash
git add scripts/check-scope-access.ts scripts/check-scope-access.spec.ts docs/audits/scope-fence package.json .husky
git commit -m "feat(fence): check:scope 静态围栏（账号表查询必须经 ScopedRepository）"
```

---

**→ Phase 2 交付**：账号上下文 + 作用域仓库 + JWT 注入 + 7 service 隔离 + check:scope 围栏。此时同一进程内不同 JWT 的请求已数据隔离（后台 runner/cron 的上下文在 Phase 4/6 补）。

---

## Phase 3：每账号运行时注册表 + 文件账号化 + 热重载

> 关键前提（已核实）：图为单例，但工具**动态解析**——`asLangChainBindable()` 每次 supervisor 运行调用、`registry.get(name)` 每次工具调用解析。故内置工具全局、MCP 工具按账号键，靠 ALS 当前账号合并即可，无需重建图。

### Task 3.1：`MeshbotConfigService` 文件 getter 账号化

**Files:**
- Modify: `libs/agent/src/config/meshbot-config.service.ts`
- Test: `libs/agent/src/config/meshbot-config.service.spec.ts`（vitest）

- [ ] **Step 1: 失败单测**

```typescript
// 用真实 AccountContextService 实例注入；MESHBOT_HOME 指向临时目录
it("文件 getter 随当前账号返回 accounts/<id>/...", () => {
  ctx.run("u1", () => {
    expect(config.getSkillsDir().endsWith("/accounts/u1/skills")).toBe(true);
    expect(config.getPromptDir().endsWith("/accounts/u1/prompt")).toBe(true);
    expect(config.getMcpConfigPath().endsWith("/accounts/u1/mcp.json")).toBe(true);
    expect(config.getWorkspaceDir().endsWith("/accounts/u1/workspace")).toBe(true);
  });
});
it("DB 路径固定共享，不随账号变", () => {
  const a = ctx.run("u1", () => config.getDatabasePath());
  const b = ctx.run("u2", () => config.getDatabasePath());
  expect(a).toBe(b);
  expect(a.endsWith("/agent.db")).toBe(true);
});
it("无账号上下文调用文件 getter 抛 NO_ACCOUNT_CONTEXT", () => {
  expect(() => config.getSkillsDir()).toThrow();
});
```

- [ ] **Step 2: 跑红** `pnpm --filter @meshbot/agent test -- meshbot-config` → FAIL

- [ ] **Step 3: 实现**

注入 `AccountContextService`；新增私有 `accountDir()`；文件 getter 走账号目录，DB 不变：

```typescript
import { AccountContextService } from "../account/account-context.service";
// ...
  constructor(private readonly account: AccountContextService) {
    this.meshbotDir = resolveMeshbotDir();
  }

  /** 当前账号目录 accounts/<cloudUserId>，必要时 mkdir。 */
  private accountDir(): string {
    const id = this.account.getOrThrow();
    const dir = path.join(this.meshbotDir, "accounts", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  getPromptDir(): string {
    return path.join(this.accountDir(), "prompt");
  }
  getSkillsDir(): string {
    return path.join(this.accountDir(), "skills");
  }
  getMcpConfigPath(): string {
    return path.join(this.accountDir(), "mcp.json");
  }
  getWorkspaceDir(): string {
    if (process.env.MESHBOT_WORKSPACE) return process.env.MESHBOT_WORKSPACE;
    const dir = path.join(this.accountDir(), "workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  // getDatabasePath() 不变：path.join(this.meshbotDir, "agent.db")
  // getMeshbotDir() 不变（顶层 root）
```

> `MeshbotConfigModule` 需能注入 `AccountContextService` —— 因 `AccountContextModule` 是 `@Global`（Task 2.2），自动可用，无需改 imports。

- [ ] **Step 4: 跑绿** `pnpm --filter @meshbot/agent test -- meshbot-config` → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(agent): MeshbotConfigService 文件 getter 账号化（DB 路径固定共享）"`

> **影响面（来自测绘）**：`SkillService.list/load` 每次调 `getSkillsDir()`（无缓存）→ 自动账号化，无需改（Task 3.4 仅补隔离测试）。`BashTool` 调 `getWorkspaceDir()` → 自动账号化。`GraphService` 调 `getDatabasePath()` → 仍共享（正确）。`PromptService` 用 `getMeshbotDir()` 构造期缓存 → 需改（Task 3.4）。`McpService.loadConfig` 调 `getMcpConfigPath()` → 配合 Task 3.3。

---

### Task 3.2：`ToolRegistry` MCP 工具按账号键

**Files:**
- Modify: `libs/agent/src/tools/tool-registry.ts`
- Test: `libs/agent/src/tools/tool-registry.spec.ts`（vitest）

- [ ] **Step 1: 失败单测**

```typescript
// 内置工具经 onModuleInit 注册；模拟一个内置 + 两账号各一 MCP 工具
it("asLangChainBindable = 内置 + 当前账号 MCP 工具", () => {
  registry.registerForAccount("u1", mcpToolU1, lcU1);
  registry.registerForAccount("u2", mcpToolU2, lcU2);
  const u1Names = ctx.run("u1", () => registry.list().map((t) => t.name));
  expect(u1Names).toContain("builtin");
  expect(u1Names).toContain(mcpToolU1.name);
  expect(u1Names).not.toContain(mcpToolU2.name);
});
it("无账号上下文只见内置工具", () => {
  expect(registry.list().map((t) => t.name)).toEqual(["builtin"]);
});
it("get(name) 解析当前账号 MCP 工具；他账号工具不可达", () => {
  registry.registerForAccount("u1", mcpToolU1, lcU1);
  expect(ctx.run("u2", () => registry.get(mcpToolU1.name))).toBeUndefined();
});
it("unregisterAccount 清掉该账号 MCP 工具", () => {
  registry.registerForAccount("u1", mcpToolU1, lcU1);
  registry.unregisterAccount("u1");
  expect(ctx.run("u1", () => registry.get(mcpToolU1.name))).toBeUndefined();
});
```

- [ ] **Step 2: 跑红** → FAIL

- [ ] **Step 3: 实现**

ToolRegistry 注入 `AccountContextService`；保留全局 `entries`（内置）；新增 `accountEntries: Map<cloudUserId, Map<name, Entry>>`：

```typescript
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly account: AccountContextService,
  ) {}

  private readonly entries = new Map<string, Entry>();          // 内置（全局）
  private readonly accountEntries = new Map<string, Map<string, Entry>>(); // MCP（按账号）

  /** MCP 工具注册到指定账号命名空间。 */
  registerForAccount(
    cloudUserId: string,
    tool: MeshbotTool,
    lcTool: StructuredToolInterface,
  ): void {
    let m = this.accountEntries.get(cloudUserId);
    if (!m) {
      m = new Map();
      this.accountEntries.set(cloudUserId, m);
    }
    m.set(tool.name, { meshbotTool: tool, lcTool });
  }

  /** teardown 某账号 MCP 工具。 */
  unregisterAccount(cloudUserId: string): void {
    this.accountEntries.delete(cloudUserId);
  }

  private currentAccountEntries(): Map<string, Entry> {
    const id = this.account.get();
    return (id && this.accountEntries.get(id)) || new Map();
  }

  asLangChainBindable(): StructuredToolInterface[] {
    return [
      ...this.entries.values(),
      ...this.currentAccountEntries().values(),
    ].map((e) => e.lcTool);
  }

  get(name: string): MeshbotTool | undefined {
    return (
      this.entries.get(name)?.meshbotTool ??
      this.currentAccountEntries().get(name)?.meshbotTool
    );
  }

  list(): MeshbotTool[] {
    return [
      ...this.entries.values(),
      ...this.currentAccountEntries().values(),
    ].map((e) => e.meshbotTool);
  }
```

`register()`（内置注册，onModuleInit 用）与 `registerInternal` 保持写 `entries` 不变。

- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(agent): ToolRegistry MCP 工具按账号键（内置全局 + ALS 合并）"`

---

### Task 3.3：`McpService` 每账号 init/teardown

**Files:**
- Modify: `libs/agent/src/mcp/mcp.service.ts`
- Test: `libs/agent/src/mcp/mcp.service.spec.ts`（vitest，用可注入的 client 工厂桩）

- [ ] **Step 1: 失败单测**：`initAccount("u1")` 后该账号 MCP 工具进 registry（账号键）；`teardownAccount("u1")` 后清空且 client.close 被调；重复 init 幂等（先 teardown）。用桩工厂替换 `MultiServerMCPClient`（构造注入一个 `mcpClientFactory`，默认真实，测试传桩）。

- [ ] **Step 2: 跑红** → FAIL

- [ ] **Step 3: 实现**

把 onModuleInit 的逻辑抽成 `initAccount(cloudUserId)`，onModuleDestroy 抽成对全部账号 teardown。状态改 `Map<cloudUserId, { client, names }>`：

```typescript
  private readonly perAccount = new Map<
    string,
    { client: MultiServerMCPClient; names: Set<string> }
  >();

  /** 为某账号按其 mcp.json 起 MCP（幂等：已存在先 teardown）。在账号上下文内调用。 */
  async initAccount(cloudUserId: string): Promise<void> {
    await this.teardownAccount(cloudUserId);
    const cfg = this.loadConfig(); // 读 getMcpConfigPath()，已账号化（需在 ctx.run 内）
    if (!cfg || Object.keys(cfg.mcpServers).length === 0) return;
    const client = new MultiServerMCPClient({ /* 同原配置 */ } as never);
    let tools: StructuredToolInterface[];
    try {
      tools = (await client.getTools()) as StructuredToolInterface[];
    } catch (err) {
      this.logger.error(/* ... */);
      return;
    }
    const names = new Set<string>();
    for (const lcTool of tools) {
      try {
        const { meshbot } = buildMcpToolAdapter(lcTool);
        this.registry.registerForAccount(cloudUserId, meshbot, lcTool);
        names.add(meshbot.name);
      } catch (err) { /* warn skip */ }
    }
    this.perAccount.set(cloudUserId, { client, names });
  }

  /** teardown 某账号 MCP（断连 + 清工具）。幂等。 */
  async teardownAccount(cloudUserId: string): Promise<void> {
    const entry = this.perAccount.get(cloudUserId);
    if (!entry) return;
    this.registry.unregisterAccount(cloudUserId);
    try {
      await entry.client.close();
    } catch (err) { /* warn */ }
    this.perAccount.delete(cloudUserId);
  }

  async onModuleDestroy(): Promise<void> {
    for (const id of [...this.perAccount.keys()]) {
      await this.teardownAccount(id);
    }
  }
```

删除原 `onModuleInit`（全局起一次）—— 起停改由 `AccountRuntimeRegistry`（Task 3.5）按账号驱动。`loadConfig()` 内 `getMcpConfigPath()` 依赖 ALS，故 `initAccount` 必须在 `ctx.run(cloudUserId, ...)` 内被调用（注册表负责）。

- [ ] **Step 2-fix:** 因 McpService 不再 `implements OnModuleInit`，从 class 声明去掉 `OnModuleInit` 并删 import。保留 `OnModuleDestroy`。

- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(agent): McpService 每账号 init/teardown（幂等，账号目录 mcp.json）"`

---

### Task 3.4：`PromptService` 账号化 + 技能隔离测试

**Files:**
- Modify: `libs/agent/src/prompt/prompt.service.ts` + `libs/agent/src/agent.module.ts`（去掉 useFactory，改普通 provider）
- Test: `libs/agent/src/prompt/prompt.service.spec.ts`、`libs/agent/src/skills/skill.service.spec.ts`（vitest）

- [ ] **Step 1: 失败单测**：`PromptService` 在 `ctx.run("u1")` 下 `getPrompt("system")` 读 accounts/u1/prompt/system.md；u2 读各自；缓存按账号键、互不串。`SkillService.list()` 在 u1/u2 下分别只见各自 skills 目录内容。

- [ ] **Step 2: 跑红** → FAIL

- [ ] **Step 3: 实现 PromptService 账号化**

改为注入 `MeshbotConfigService` + `AccountContextService`，缓存按账号键，按当前账号 promptDir 读：

```typescript
@Injectable()
export class PromptService {
  private readonly byAccount = new Map<string, PromptMap>();
  constructor(
    private readonly config: MeshbotConfigService,
    private readonly account: AccountContextService,
  ) {}

  private dir(): string {
    return this.config.getPromptDir(); // 账号化
  }
  private cache(): PromptMap {
    const id = this.account.getOrThrow();
    let m = this.byAccount.get(id);
    if (!m) {
      m = this.loadFrom(this.dir());
      this.byAccount.set(id, m);
    }
    return m;
  }
  getPrompt(name: string): string | undefined {
    return this.cache().get(name)?.content;
  }
  reloadIfChanged(): void { /* 对当前账号 dir 比 mtime，变了重载该账号缓存 */ }
  /** 切账号/改配置时失效某账号缓存（AccountRuntimeRegistry teardown 调用）。 */
  evict(cloudUserId: string): void {
    this.byAccount.delete(cloudUserId);
  }
  // loadFrom(dir): PromptMap —— 原 loadPrompts 逻辑改为纯函数返回 Map
}
```

`agent.module.ts`：把 `PromptService` 的 `useFactory` 改为普通 class provider（`PromptService` 现在靠 DI 注入 config + account，不再需要构造期 getMeshbotDir）。`GraphService` 调 `promptService.reloadIfChanged()` + `getPrompt("system")` 的位置：现在它在图执行期（runner 已设 ALS 账号）调用，自动按账号。**确认 GraphService 的 stream 路径处于 runner 的 `ctx.run` 内**（Phase 4 Task 4.5 保证）。

`SkillService` 无需改实现（已每次读 `getSkillsDir()`），仅补隔离测试。

- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(agent): PromptService 账号化缓存 + 技能账号隔离测试"`

---

### Task 3.5：`AccountRuntimeRegistry`

**Files:**
- Create: `apps/server-agent/src/account/account-runtime.registry.ts`
- Modify: `apps/server-agent/src/account/account.module.ts`（provide + export）
- Test: `apps/server-agent/src/account/account-runtime.registry.spec.ts`（jest）

- [ ] **Step 1: 失败单测**：`createRuntime("u1")` 调用 `mcp.initAccount("u1")` 与 `relay.connect("u1")`（均在 u1 上下文内，用 spy）；`has("u1")` true；`teardownRuntime("u1")` 调 `mcp.teardownAccount` + `relay.disconnect("u1")` + `prompt.evict("u1")`，`has` 转 false；`reloadRuntime` = teardown+create；create 幂等。

- [ ] **Step 2: 跑红** → FAIL

- [ ] **Step 3: 实现**

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { AccountContextService, McpService, PromptService } from "@meshbot/agent";
import { ImRelayClientService } from "../cloud/im-relay-client.service";

/**
 * 每账号运行时注册表（v3）：登录 createRuntime / 登出 teardownRuntime / 改配置 reloadRuntime。
 * 运行时 = MCP 连接 + 技能/提示词缓存 + 云端（IM relay）连接。
 */
@Injectable()
export class AccountRuntimeRegistry {
  private readonly logger = new Logger(AccountRuntimeRegistry.name);
  private readonly live = new Set<string>();

  constructor(
    private readonly ctx: AccountContextService,
    private readonly mcp: McpService,
    private readonly prompt: PromptService,
    private readonly relay: ImRelayClientService,
  ) {}

  has(cloudUserId: string): boolean {
    return this.live.has(cloudUserId);
  }

  /** 构建某账号运行时（幂等）。在该账号上下文内初始化 MCP（文件 getter 依赖 ALS）。 */
  async createRuntime(cloudUserId: string): Promise<void> {
    await this.teardownRuntime(cloudUserId);
    await this.ctx.run(cloudUserId, async () => {
      await this.mcp.initAccount(cloudUserId);
    });
    await this.relay.connect(cloudUserId);
    this.live.add(cloudUserId);
  }

  /** 拆除某账号运行时（卸 MCP/技能/提示词/云连接）。幂等。满足「登出卸载」。 */
  async teardownRuntime(cloudUserId: string): Promise<void> {
    await this.mcp.teardownAccount(cloudUserId);
    this.prompt.evict(cloudUserId);
    this.relay.disconnect(cloudUserId);
    this.live.delete(cloudUserId);
  }

  /** 改配置/切目录时重载（teardown+create）。 */
  async reloadRuntime(cloudUserId: string): Promise<void> {
    await this.createRuntime(cloudUserId);
  }
}
```

`account.module.ts` 加 `AccountRuntimeRegistry` 到 providers/exports。注意它依赖 `McpService`/`PromptService`（来自 `@meshbot/agent`，AgentModule 已导出）与 `ImRelayClientService`（AuthModule 导出）——确保 AccountModule 能解析这些（AgentModule/AuthModule 在 AppModule 内；若 AccountModule 先于它们加载需调整 import 顺序或让 AccountModule imports AuthModule/AgentModule）。

- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(agent): AccountRuntimeRegistry（登录建/登出拆/改配置重载）"`

---

### Task 3.6：`ImRelayClientService` 账号化

**Files:**
- Modify: `apps/server-agent/src/cloud/im-relay-client.service.ts` + 其 spec
- Modify: 调用方 `apps/server-agent/src/ws/im.gateway.ts`、`apps/server-agent/src/services/cloud-im.service.ts`（send/read 传账号）、`auth.module.ts`（工厂签名）

- [ ] **Step 1: 失败单测**：`connect("u1")` 用 `identity.get("u1")` 的 token 建 socket，键存 `u1`；`connect("u2")` 另建；`isConnected("u1")`；`disconnect("u1")` 只断 u1；`send("u1", input)` 用 u1 socket；`connect_error(unauthorized)` 调 `setLoggedOut("u1")`。ioFactory 桩按账号返回不同 socket 桩。

- [ ] **Step 2: 跑红** → FAIL

- [ ] **Step 3: 实现账号化**

`socket`/`pingTimer`/`connecting` 改 `Map<cloudUserId, ...>`；所有方法加 `cloudUserId` 参数；`connect(cloudUserId)` 调 `identity.get(cloudUserId)`；`connect_error` 调 `identity.setLoggedOut(cloudUserId)`（替换原 `clear()`）。删 `onModuleInit` 自动 connect（改由注册表/登录驱动）；`onModuleDestroy` 断开全部账号。`send/read` 签名变 `(cloudUserId, input)`。

- [ ] **Step 4: 改调用方**

- `cloud-im.service.ts` / `im.gateway.ts`：调 `relay.send/read` 处补 `cloudUserId`（从 `AccountContextService.getOrThrow()` 取——这些是请求/WS 路径，ALS 已有账号；WS 网关若不在 HTTP 拦截器链内，需在 socket 鉴权后自行 `ctx.run`，见下「风险/补充」）。
- `auth.module.ts`：`ImRelayClientService` 工厂签名不变（仍注入 identity/emitter/config），其方法签名变化由调用方适配。
- `cloud-org.service.ts`/`cloud-auth.service.ts` 里原 `imRelay.connect()`（无参）→ Phase 4 改为经 `AccountRuntimeRegistry.createRuntime`（不再直接调 relay.connect）。本 Task 先让 relay 自身账号化 + 编译通过（旧无参调用临时改 `connect(<当前账号>)` 或在 Phase 4 一并删）。

- [ ] **Step 5: 跑绿 + typecheck** → PASS
- [ ] **Step 6: Commit** `git commit -m "feat(agent): ImRelayClientService 账号化（每账号独立云连接）"`

> **补充（WS 账号上下文）**：`session.gateway`/`im.gateway` 的 WS 消息不走 HTTP `AccountContextInterceptor`。需在 WS 连接鉴权（握手时校验本地 JWT）后，于每个消息处理包 `ctx.run(socket.cloudUserId, ...)`。若现网 WS 已用本地 JWT 鉴权握手，则在 gateway 基类/handler 包一层；作为本 Task 的子步骤补一个 `ctx.run` 包装 + 隔离测试。

**→ Phase 3 交付**：每账号运行时（MCP/技能/提示词/云连接）可建可拆可重载；文件按账号解析；工具按账号可见。尚未接到登录/登出（Phase 4）。

---

## Phase 4：登录/登出生命周期 + 重启恢复

### Task 4.1：落地 CloudIdentity 多行（合并 Phase 1 推迟项）

**Files:**
- Modify: `apps/server-agent/src/entities/cloud-identity.entity.ts`（Task 1.2 的实体改动）
- Create: `apps/server-agent/src/migrations/1780200000000-CloudIdentityMultiRow.ts`（Task 1.3 的迁移）
- Modify: `apps/server-agent/src/services/cloud-identity.service.ts`（Task 1.4 的多行实现）
- Modify: 调用方 `cloud-auth.service.ts`、`cloud-org.service.ts`、`im-relay-client.service.ts`、`auth.module.ts`（`CloudClientService` 工厂的 `setUnauthorizedHandler`）

- [ ] **Step 1**: 套用 Task 1.2 实体 + Task 1.3 的 `1780200000000` 迁移 + Task 1.4 service 实现与其 spec（此时 spec 转绿）。
- [ ] **Step 2**: 改调用方匹配新签名：
  - `cloud-auth.service.afterCloudAuth`：`identity.upsert({...})`（已含 cloudUserId）不变；`updateActiveOrg` 调用点改 4 参（加 cloudUserId）。
  - `cloud-org.service`：`updateActiveOrg(cloudUserId, orgId, orgName, role)`——cloudUserId 从 `AccountContextService.getOrThrow()`（org 路由是已鉴权请求）。
  - `im-relay-client.service.connect_error`：`setLoggedOut(cloudUserId)`（已在 Task 3.6）。
  - `auth.module.ts` `CloudClientService` 工厂 `setUnauthorizedHandler(() => identity.clear())`：`clear` 已删 → 改为「按当前账号 setLoggedOut」。但工厂期无账号上下文 → 改为接收 cloudUserId 的形态需重构 CloudClientService 的 401 处理：401 发生在某账号的云请求中，handler 应知道是哪个账号。**最简**：CloudClientService 的 unauthorized handler 改为「无操作 + 由调用方 try/catch 处理」，或 handler 入参带 cloudUserId。实施者按 CloudClientService 现状择一（记 TODO 注释，避免误删行为）。
- [ ] **Step 3**: typecheck 全包过 + 迁移可跑（临时库）。
- [ ] **Step 4: Commit** `git commit -m "feat(agent): 落地 CloudIdentity 多行 + 多行 service + 调用方适配"`

### Task 4.2：登录建运行时 + 签 JWT

**Files:** Modify `apps/server-agent/src/services/cloud-auth.service.ts`、`auth.module.ts`（注入 `AccountRuntimeRegistry`）；Test `cloud-auth.service.spec.ts`

- [ ] **Step 1: 失败单测**：`login`/`register` 成功后 `identity.upsert(loggedIn=true)` + `runtimeRegistry.createRuntime(cloudUserId)` 被调（spy），返回带 `access_token`（sub=cloudUserId）。
- [ ] **Step 2: 跑红** → FAIL
- [ ] **Step 3: 实现**：`afterCloudAuth` 末尾在签 JWT 之前/之后调用 `await this.runtime.createRuntime(auth.user.id)`；删除 `login/register` 里旧的 `void this.imRelay.connect()`（云连接现由 createRuntime 内的 relay.connect 负责）。注入 `AccountRuntimeRegistry`（AccountModule 导出）。
- [ ] **Step 4: 跑绿 + check** → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(agent): 登录/注册建账号运行时 + 签 JWT(sub=cloudUserId)"`

### Task 4.3：登出拆运行时

**Files:** Modify `cloud-auth.service.ts`（logout）；Test 补用例

- [ ] **Step 1: 失败单测**：`ctx.run("u1", () => cloudAuth.logout())` 调 `runtimeRegistry.teardownRuntime("u1")` + `identity.setLoggedOut("u1")`。
- [ ] **Step 2: 跑红** → FAIL
- [ ] **Step 3: 实现**：`logout()` 取 `const id = this.account.getOrThrow()`（注入 AccountContextService）→ `await this.runtime.teardownRuntime(id)` + `await this.identity.setLoggedOut(id)`。删旧 `imRelay.disconnect()` 裸调用（并入 teardownRuntime）。
- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(agent): 登出拆账号运行时（卸 MCP/技能/云）+ logged_in=false"`

### Task 4.4：重启恢复全部已登录账号（D9）

**Files:** Create `apps/server-agent/src/account/account-bootstrap.service.ts`；Modify `account.module.ts`；Test spec

- [ ] **Step 1: 失败单测**：`onApplicationBootstrap` 调 `identity.listLoggedIn()` 返回 [u1,u2] → 对每个调 `runtimeRegistry.createRuntime`；单账号 create 抛错不影响其他（try/catch + 日志）。
- [ ] **Step 2: 跑红** → FAIL
- [ ] **Step 3: 实现**：

```typescript
@Injectable()
export class AccountBootstrapService implements OnApplicationBootstrap {
  constructor(
    private readonly identity: CloudIdentityService,
    private readonly runtime: AccountRuntimeRegistry,
  ) {}
  async onApplicationBootstrap(): Promise<void> {
    const accounts = await this.identity.listLoggedIn();
    for (const a of accounts) {
      try {
        await this.runtime.createRuntime(a.cloudUserId);
      } catch (err) {
        // 单账号失败不拖垮整体（D9 风险：重连风暴/单点失败）
        this.logger.error(`恢复账号 ${a.cloudUserId} 运行时失败`, err as Error);
      }
    }
  }
}
```

- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(agent): 重启恢复全部已登录账号运行时（D9）"`

### Task 4.5：runner 按 session 属主重建账号上下文

**Files:** Modify `apps/server-agent/src/services/runner.service.ts`、`session.service.ts`（加 unscoped 属主查询）；Test `runner.service.spec.ts`

- [ ] **Step 1: 失败单测**：`SessionService.findOwner(sessionId)`（unscoped）返回该会话 `cloudUserId`；`runner.kick(sessionId)` 的处理在 `ctx.run(owner, ...)` 内（验证：处理期间 `ctx.get()` === 该会话属主；跨账号 session 不串）。
- [ ] **Step 2: 跑红** → FAIL
- [ ] **Step 3: 实现**：
  - `SessionService.findOwner(sessionId)`：`this.sessionRepo.unscoped().findOne({ where: { id: sessionId }, select: { cloudUserId: true } })` → 返回 cloudUserId（带 `// scope-check: allow-unscoped`，系统级反查属主是上下文 bootstrap，合法）。
  - `runner.kickAndWait(sessionId)` 开头：`const owner = await this.sessions.findOwner(sessionId); if (!owner) return;` 然后整段处理包 `await this.account.run(owner, async () => { ...原逻辑... })`（注入 AccountContextService）。这样 runner 内所有 service 查询、图执行（提示词/技能/MCP 工具）都在属主账号上下文。
  - `onModuleInit` 的 `rollbackProcessingToPending()` 已是 unscoped 全量（Task 2.5），无需账号上下文。
- [ ] **Step 4: 跑绿 + check:scope**（findOwner 的 unscoped 经 allow-unscoped 放行）→ PASS
- [ ] **Step 5: Commit** `git commit -m "feat(agent): runner 按 session 属主建账号上下文（图/工具/查询账号化）"`

**→ Phase 4 交付**：登录建运行时+签 JWT、登出拆运行时、重启恢复、后台 runner 账号化。后端多账号并发隔离闭环。

---

## Phase 5：前端多账号 token 管理

> web-agent 无 jsdom 单测基础设施（已核实），本阶段以实现 + typecheck + 手动验证为主；逻辑尽量下沉到可单测的纯函数（token store）。

### Task 5.1：多账号 token store（web-common）

**Files:** Modify `packages/web-common/src/api/client.ts`；Test `packages/web-common/src/api/client.spec.ts`（若 web-common 有 vitest/jest 则加纯函数测试；否则仅 typecheck）

- [ ] **Step 1（有测试基础设施时）: 失败单测**：`addAccount(cloudUserId, token)` 存入账号表；`setActiveAccount(id)` 切换；`getAccessToken()` 返回当前活跃账号 token；`listAccounts()`；`removeAccount(id)` 后若有其余账号自动切其一、否则清空。
- [ ] **Step 2: 实现**：在现有单槽 `meshbot_access_token` 基础上增加 `meshbot_accounts`（JSON：`{ activeId, tokens: Record<cloudUserId, {token, email, displayName}> }`）。`getAccessToken()` 返回活跃账号 token（兼容旧单槽：迁移读取）。新增 `addAccount/setActiveAccount/listAccounts/removeAccount`，并让 `setAccessToken` 同步写活跃槽。请求拦截器仍读 `getAccessToken()`（活跃账号），无需改。
- [ ] **Step 3: typecheck** `pnpm --filter @meshbot/web-common typecheck` → PASS
- [ ] **Step 4: Commit** `git commit -m "feat(web-common): 多账号 token store（活跃账号 + 账号表）"`

### Task 5.2：登录写入账号表 + 新增账号入口

**Files:** Modify `apps/web-agent/src/rest/auth.ts`（login 后 addAccount+setActive）、`workspace-rail.tsx`（用户菜单加「切换账号/新增账号」）

- [ ] **Step 1: 实现**：`login()` 成功后除 `setAccessToken` 外调 `addAccount(cloudUserId, token, {email,displayName})` + `setActiveAccount(cloudUserId)`（cloudUserId 从 profile 或 JWT 解析）。
- [ ] **Step 2: 实现切换 UI**：`workspace-rail` 用户菜单（现有 DropdownMenu，含 Org/Logout）加：已知账号列表（点击 = `setActiveAccount` + 失效 react-query profile/会话缓存 + 视图刷新）、「新增账号」（→ `/login`，登录后并存）。
- [ ] **Step 3: typecheck + 手动验证**：两账号登录 → 菜单可切 → 切后会话/设置视图变为该账号数据。
- [ ] **Step 4: Commit** `git commit -m "feat(web-agent): 用户菜单账号切换 + 新增账号入口"`

### Task 5.3：登出仅移除当前账号

**Files:** Modify `apps/web-agent/src/rest/auth.ts`（useLogout）、`workspace-rail.tsx`（handleLogout）

- [ ] **Step 1: 实现**：登出 `onSettled` 改为 `removeAccount(currentId)`（而非清全部）；若仍有其余账号 → `setActiveAccount(其一)` + 失效缓存 + 留在应用；否则 `clearAccessToken()` + 跳 `/login`。后端 `/api/auth/logout` 仍按当前 token 的账号 teardown 运行时（Phase 4）。
- [ ] **Step 2: typecheck + 手动验证**：双账号下登出 A → 自动切到 B、A 的运行时后端已 teardown；登出最后一个 → 回登录页。
- [ ] **Step 3: Commit** `git commit -m "feat(web-agent): 登出仅移除当前账号，余者自动切换"`

**→ Phase 5 交付**：前端可并存多账号 token、菜单切换/新增、按账号登出。配合后端实现「desktop 一账号 + 浏览器另一账号」并发调试（各持各自 token 打 :3100）。

---

## Phase 6：CronJob 跨账号作用域（D8）

### Task 6.1：启动按账号注册到期任务

**Files:** Modify `apps/server-agent/src/services/schedule-executor.service.ts`、`schedule.service.ts`（加 unscoped 全量列表）；Test `schedule-executor.service.spec.ts`

- [ ] **Step 1: 失败单测**：两账号各有 enabled cron job → `onApplicationBootstrap` 对每个 job 用其 `cloudUserId` 注册（验证注册时记住了各自账号）。
- [ ] **Step 2: 实现**：`ScheduleService.listAllForBootstrap()`：`this.repo.unscoped().find({ where: { enabled: true } })`（`// scope-check: allow-unscoped`，启动全量装载是系统级）。`onApplicationBootstrap` 遍历全部 job，注册时把 `job.cloudUserId` 一并记住（注册表 entry 带账号）。
- [ ] **Step 3: 跑绿 + check:scope** → PASS
- [ ] **Step 4: Commit** `git commit -m "feat(agent): cron 启动按账号装载全部账号到期任务"`

### Task 6.2：fire 在账号上下文执行 + 仅已登录账号

**Files:** Modify `schedule-executor.service.ts`；Test 补用例

- [ ] **Step 1: 失败单测**：`fire(jobId)`：取 job 的 `cloudUserId`（unscoped by id）；若该账号 `runtimeRegistry.has(cloudUserId)` 为 false（已登出）→ 跳过不执行（D8）；为 true → 在 `ctx.run(cloudUserId, ...)` 内 `appendMessage` + `runner.kick`，断言期间上下文正确、他账号不受影响。
- [ ] **Step 2: 实现**：`fire` 开头 `const job = await this.schedule.findByIdUnscoped(jobId)`（新 unscoped 取 job + cloudUserId，`allow-unscoped`）；`if (!this.runtime.has(job.cloudUserId)) return;`；其余逻辑包 `await this.ctx.run(job.cloudUserId, async () => { ... })`。注入 `AccountContextService` + `AccountRuntimeRegistry`。
- [ ] **Step 3: 跑绿** → PASS
- [ ] **Step 4: Commit** `git commit -m "feat(agent): cron fire 在账号上下文执行，仅跑已登录账号（D8）"`

### Task 6.3：登录/登出联动 cron 注册

**Files:** Modify `account-runtime.registry.ts`（create/teardown 时注册/注销该账号 cron）或在 `schedule-executor` 暴露 `registerAccount/deregisterAccount`；Test

- [ ] **Step 1: 失败单测**：`createRuntime("u1")` 后 u1 的 enabled cron 进调度；`teardownRuntime("u1")` 后 u1 的 cron 注销（不再 fire）。
- [ ] **Step 2: 实现**：`ScheduleExecutor.registerAccountJobs(cloudUserId)`（`ctx.run` 内 scoped `list()` 注册）/ `deregisterAccountJobs(cloudUserId)`（注销该账号所有已注册 job）。`AccountRuntimeRegistry.createRuntime` 末尾调 `registerAccountJobs`，`teardownRuntime` 调 `deregisterAccountJobs`。避免与 6.1 启动装载重复注册（用 SchedulerRegistry 是否已存在判重）。
- [ ] **Step 3: 跑绿 + 全套 check** → PASS
- [ ] **Step 4: Commit** `git commit -m "feat(agent): 登录建/登出注销该账号 cron 调度（D8 闭环）"`

**→ Phase 6 交付**：cron 按已登录账号并发、各在本账号上下文执行、登出即停。

---

## 最终验收（全部阶段后）

- [ ] **集成测试（jest，server-agent）**：构造两个本地 JWT（sub=u1/u2），交错调 `/api/sessions`、`/api/settings`、`/api/model-configs` → 断言互不可见；登出 u1 → u1 运行时 teardown（MCP 工具消失、cron 停）、u2 不受影响；模拟重启（重新 bootstrap）→ 已登录账号运行时恢复。
- [ ] **`pnpm check` 全绿**（含 `check:scope`）、`pnpm typecheck` 全包过。
- [ ] **真机冒烟**：起 server-main（Postgres/Redis）+ server-agent；浏览器登录账号 A、另一浏览器/隐身窗口登录账号 B（或 desktop A + 浏览器 B）→ 各自会话/设置隔离；A 配 MCP、B 不配 → A 有 MCP 工具 B 没有；A 登出 → A 的 MCP 连接断开、cron 停，B 正常。
- [ ] **最终 code review**：dispatch 一个 reviewer 子代理审全实现（对照 spec v3 §6 防串数据、§7 teardown 幂等、D8/D9）。

## 自审记录（写计划后）

- **spec 覆盖**：§5 数据模型→Phase1+4.1；§6 作用域+围栏→Phase2；§7 文件/运行时/reload→Phase3；§8 登录登出→Phase4；§9 cron→Phase6；§10 桌面→无需改（Phase5 说明并发调试拓扑）；D8→Phase6；D9→Task4.4。
- **依赖方向**：`AccountContextService` 落 libs/agent（架构定位段），server-agent 从 `@meshbot/agent` 注入同一单例；ScopedRepository/Registry 在 server-agent。check:repo/check:scope 不被违反（ScopedRepository 是受审封装）。
- **类型一致**：`AccountContextService.run/get/getOrThrow`、`ScopedRepository`(+`unscoped`/`scopedQueryBuilder`)、`AccountRuntimeRegistry.createRuntime/teardownRuntime/reloadRuntime/has`、`McpService.initAccount/teardownAccount`、`ToolRegistry.registerForAccount/unregisterAccount`、`ImRelayClientService.connect/disconnect/send/read(cloudUserId,...)`、`CloudIdentityService.get/upsert/updateActiveOrg/setLoggedOut/listLoggedIn`、`SessionService.findOwner` —— 全计划一致。
- **已知待实施者定权的细节**：libs/agent 错误码注册文件位置与 code 值（Task 2.1）；`CloudClientService` 401 handler 的账号归属（Task 4.1 Step 2）；WS 网关账号上下文包装（Task 3.6 补充）。这些不阻塞架构，实施期对照现网代码定。
