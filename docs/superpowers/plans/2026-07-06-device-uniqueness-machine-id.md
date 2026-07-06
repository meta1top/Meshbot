# 设备唯一性(machineId 去重)实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入本机指纹 `machineId`,让「同机 + 同账号」在云端只对应一台 Device 行;同机重授权复用同行并轮换 token,而非新增行。

**Architecture:** server-agent 用 `node-machine-id` 采集本机指纹(dev 加 `dev-` 前缀),exchange 时随请求体上传;server-main `DeviceService.issueDevice` 按 `(user_id, machine_id)` 去重(命中复用行+轮换 token),`@WithLock` 串行化 + 部分唯一索引兜底。

**Tech Stack:** NestJS / TypeORM(Postgres) / Zod / Jest / `node-machine-id@^1.1.12`。

## Global Constraints

- 设计真相源:`docs/superpowers/specs/2026-07-06-device-uniqueness-machine-id-design.md`。
- `machine_id`:Postgres `varchar(80)`,nullable(老行保持 null)。
- 去重键:`(user_id, machine_id)`(Device 实体列名是 `user_id`,非 cloud_user_id)。
- token 轮换:命中复用行时覆盖 `token_hash`,新明文返回。
- `@WithLock` 必须在 `@Transactional` 外层;`issueDevice` 单表写,**不挂** `@Transactional`。
- DDL:`apps/server-main/migrations/`,幂等(`IF NOT EXISTS`)、snake_case、逻辑外键、文件不可变、DBA 手动执行;server-main e2e 由 `test-db.ts` 按文件名顺序应用全部 `*.sql`。
- 无数据库级外键;实体继承 `SnowflakeBaseEntity`。
- 公开方法中文 JSDoc;`if` 前一行不放注释。
- 每个 Task 结束前跑 `pnpm check`(静态围栏)+ 相关测试;commit 用中文 conventional commits,带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer。

## File Structure

- `apps/server-agent/package.json` — 加 `node-machine-id` 依赖。
- `apps/server-agent/src/utils/machine-id.ts` (新) — `resolveMachineId()`:采集 + dev 前缀 + 失败降级。
- `apps/server-agent/src/utils/machine-id.spec.ts` (新) — util 单测。
- `apps/server-agent/src/services/device-authorize.service.ts` — exchange 请求体加 machineId。
- `libs/types/src/device-auth/device-auth.schema.ts` — `DeviceAuthExchangeSchema` 加可选 machineId。
- `libs/main/src/entities/device.entity.ts` — 加 `machineId` 列 + 部分唯一索引元数据。
- `libs/main/src/services/device.service.ts` — `issueDevice` 去重 + `@WithLock`。
- `libs/main/src/services/device.service.spec.ts` — 增强 fake(识别 IsNull)+ 去重用例 + 现有用例改用 `buildSvc`。
- `apps/server-main/src/rest/device-auth.controller.ts` — exchange 透传 `dto.machineId`。
- `apps/server-main/migrations/202607062100-device-machine-id.sql` (新) — 加列 + 部分唯一索引。
- `apps/server-main/test/e2e/device-auth-flow.e2e.spec.ts` — 去重 e2e 用例。

---

### Task 1: server-agent machineId 采集 util

**Files:**
- Modify: `apps/server-agent/package.json`(加依赖)
- Create: `apps/server-agent/src/utils/machine-id.ts`
- Test: `apps/server-agent/src/utils/machine-id.spec.ts`

**Interfaces:**
- Produces: `resolveMachineId(): string | null` — 打包版返回原始 machineId,dev 返回 `dev-<machineId>`,采集失败返回 `null`。供 Task 3 的 `device-authorize.service.ts` 消费。
- Consumes: `isPackaged()` from `apps/server-agent/src/utils/meshbot-dir.ts`(现有,`__dirname.includes(".app/Contents/Resources")`);`machineIdSync` from `node-machine-id`。

- [ ] **Step 1: 加依赖**

Run:
```bash
pnpm --filter @meshbot/server-agent add node-machine-id@^1.1.12
```
Expected: `apps/server-agent/package.json` 出现 `"node-machine-id": "^1.1.12"`,`pnpm-lock.yaml` 更新。(该包自带类型 `types/index.d.ts`,无需 `@types`。)

- [ ] **Step 2: 写失败的单测**

Create `apps/server-agent/src/utils/machine-id.spec.ts`:
```ts
jest.mock("node-machine-id", () => ({ machineIdSync: jest.fn() }));
jest.mock("./meshbot-dir", () => ({ isPackaged: jest.fn() }));

import { machineIdSync } from "node-machine-id";
import { isPackaged } from "./meshbot-dir";
import { resolveMachineId } from "./machine-id";

const mockMachineId = machineIdSync as jest.Mock;
const mockIsPackaged = isPackaged as jest.Mock;

describe("resolveMachineId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMachineId.mockReturnValue("abc123");
  });

  it("打包版返回原始 machineId", () => {
    mockIsPackaged.mockReturnValue(true);
    expect(resolveMachineId()).toBe("abc123");
  });

  it("dev 返回 dev- 前缀", () => {
    mockIsPackaged.mockReturnValue(false);
    expect(resolveMachineId()).toBe("dev-abc123");
  });

  it("采集抛错时降级为 null", () => {
    mockIsPackaged.mockReturnValue(true);
    mockMachineId.mockImplementation(() => {
      throw new Error("no machine id");
    });
    expect(resolveMachineId()).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @meshbot/server-agent exec jest src/utils/machine-id.spec.ts`
Expected: FAIL —— `Cannot find module './machine-id'`。

- [ ] **Step 4: 写实现**

Create `apps/server-agent/src/utils/machine-id.ts`:
```ts
import { machineIdSync } from "node-machine-id";
import { isPackaged } from "./meshbot-dir";

/**
 * 采集本机稳定唯一标识,用于云端设备去重。
 *
 * dev(未打包)加 `dev-` 前缀,使同一台机器上的 dev 与打包版被视为两台独立设备,
 * 方便本机同时测试。前缀是确定性的,dev 因此是一个稳定身份、不会每次启动变新设备。
 *
 * 采集失败时返回 null(降级:不参与去重,退回「每次授权新建设备」的旧行为),
 * 不阻断授权流程。
 */
export function resolveMachineId(): string | null {
  try {
    const raw = machineIdSync();
    return isPackaged() ? raw : `dev-${raw}`;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @meshbot/server-agent exec jest src/utils/machine-id.spec.ts`
Expected: PASS(3 passed)。

- [ ] **Step 6: typecheck + commit**

Run: `pnpm --filter @meshbot/server-agent exec tsc --noEmit`
Expected: 无错误。
```bash
git add apps/server-agent/package.json pnpm-lock.yaml apps/server-agent/src/utils/machine-id.ts apps/server-agent/src/utils/machine-id.spec.ts
git commit -m "feat(server-agent): 加 machineId 采集(node-machine-id,dev 加 dev- 前缀)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: server-main issueDevice 去重(实体 + DDL + 逻辑 + 单测)

**Files:**
- Create: `apps/server-main/migrations/202607062100-device-machine-id.sql`
- Modify: `libs/main/src/entities/device.entity.ts`(加 `machineId` 列 + 索引元数据)
- Modify: `libs/main/src/services/device.service.ts`(`issueDevice` 去重 + `@WithLock`)
- Test: `libs/main/src/services/device.service.spec.ts`

**Interfaces:**
- Produces: `DeviceService.issueDevice(input: { userId: string; orgId: string | null; name: string; platform: string; machineId?: string | null }): Promise<{ device: Device; token: string }>` —— input 新增可选 `machineId`;命中 `(userId, machineId)` 活跃行则复用+轮换 token。Task 3 的 controller 消费此签名。
- Produces: `Device.machineId: string | null`(列 `machine_id`)。
- Consumes: `IsNull` from `typeorm`;`@WithLock` from `@meshbot/common`;单测用 `injectLockProvider` / `MemoryLockProvider` from `@meshbot/common`。

- [ ] **Step 1: 确认 e2e schema 机制(只读)**

Run: `grep -nE "synchronize|MIGRATIONS_DIR|readdirSync" apps/server-main/test/setup/test-db.ts`
Expected: 确认 `test-db.ts` 应用 `migrations/*.sql`、`synchronize` 为 false(或未开)。已知结论:e2e 由 DDL 文件建 schema,故本 Task 的新 DDL 会被 e2e 自动应用,实体改动仅为 ORM 映射。若发现 `synchronize:true`,停下反馈(与设计假设冲突)。

- [ ] **Step 2: 写失败的单测(增强 fake + 去重用例)**

Rewrite `libs/main/src/services/device.service.spec.ts` 顶部导入与 `makeRepo`,并新增 `buildSvc` + 去重用例。完整文件:
```ts
import { AppError, injectLockProvider, MemoryLockProvider } from "@meshbot/common";
import { FindOperator, IsNull } from "typeorm";
import type { Device } from "../entities/device.entity";
import {
  DEVICE_TOKEN_PREFIX,
  DeviceService,
  hashDeviceToken,
} from "./device.service";

function makeRepo(rows: Device[]) {
  return {
    create: jest.fn((v: Partial<Device>) => ({ ...v }) as Device),
    save: jest.fn(async (v: Device) => {
      v.id ??= `d${rows.length + 1}`;
      if (!rows.includes(v)) rows.push(v);
      return v;
    }),
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) =>
          Object.entries(where).every(([k, val]) => {
            const rv = (r as Record<string, unknown>)[k];
            if (val instanceof FindOperator) return rv == null;
            return rv === val;
          }),
        ) ?? null,
    ),
    find: jest.fn(async ({ where }: { where: Partial<Device> }) =>
      rows.filter((r) => r.userId === where.userId),
    ),
    update: jest.fn(async (cond: Partial<Device>, patch: Partial<Device>) => {
      for (const r of rows) if (r.id === cond.id) Object.assign(r, patch);
    }),
  };
}

/** 纯 new + 注入进程内锁 provider(issueDevice 挂了 @WithLock,见 device-auth.service.spec 先例)。 */
function buildSvc(rows: Device[]) {
  const svc = new DeviceService(makeRepo(rows) as never);
  injectLockProvider(svc, new MemoryLockProvider());
  return svc;
}

describe("DeviceService", () => {
  it("issueDevice 返回带前缀明文 token,库里只存哈希", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    const { device, token } = await svc.issueDevice({
      userId: "u1",
      orgId: "o1",
      name: "Mac",
      platform: "darwin",
    });
    expect(token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    expect(device.tokenHash).toBe(hashDeviceToken(token));
    expect(rows[0].tokenHash).not.toContain(token.slice(4, 20));
  });

  it("verifyToken 命中返回设备,吊销后抛 DEVICE_TOKEN_INVALID", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    const { token } = await svc.issueDevice({
      userId: "u1",
      orgId: "o1",
      name: "Mac",
      platform: "darwin",
    });
    const dev = await svc.verifyToken(token);
    expect(dev.userId).toBe("u1");
    rows[0].revokedAt = new Date();
    await expect(svc.verifyToken(token)).rejects.toMatchObject({
      name: "AppError",
    });
  });

  it("verifyToken 未知 token 抛错", async () => {
    const svc = buildSvc([]);
    await expect(svc.verifyToken("mbd_unknown")).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("revoke 只能吊销本人设备", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    await svc.issueDevice({
      userId: "u1",
      orgId: null,
      name: "Mac",
      platform: "darwin",
    });
    await expect(svc.revoke("u2", rows[0].id)).rejects.toBeInstanceOf(AppError);
    await svc.revoke("u1", rows[0].id);
    expect(rows[0].revokedAt).toBeInstanceOf(Date);
  });

  it("issueDevice 同 (userId, machineId) 复用行并轮换 token", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    const first = await svc.issueDevice({
      userId: "u1",
      orgId: "o1",
      name: "Mac",
      platform: "darwin",
      machineId: "m-abc",
    });
    const second = await svc.issueDevice({
      userId: "u1",
      orgId: "o2",
      name: "Mac renamed",
      platform: "darwin",
      machineId: "m-abc",
    });
    expect(rows).toHaveLength(1);
    expect(second.device.id).toBe(first.device.id);
    expect(second.token).not.toBe(first.token);
    expect(rows[0].tokenHash).toBe(hashDeviceToken(second.token));
    expect(rows[0].orgId).toBe("o2");
    expect(rows[0].name).toBe("Mac renamed");
  });

  it("issueDevice 无 machineId 每次新建行", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    await svc.issueDevice({ userId: "u1", orgId: null, name: "a", platform: "darwin" });
    await svc.issueDevice({ userId: "u1", orgId: null, name: "b", platform: "darwin" });
    expect(rows).toHaveLength(2);
  });

  it("issueDevice 不同 machineId(dev vs 打包版)同 user 各建一行", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    await svc.issueDevice({ userId: "u1", orgId: null, name: "dev", platform: "darwin", machineId: "dev-m-abc" });
    await svc.issueDevice({ userId: "u1", orgId: null, name: "pkg", platform: "darwin", machineId: "m-abc" });
    expect(rows).toHaveLength(2);
  });

  it("issueDevice 命中行已吊销时仍新建行(IsNull 过滤)", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    const first = await svc.issueDevice({ userId: "u1", orgId: null, name: "Mac", platform: "darwin", machineId: "m-abc" });
    rows[0].revokedAt = new Date();
    const second = await svc.issueDevice({ userId: "u1", orgId: null, name: "Mac", platform: "darwin", machineId: "m-abc" });
    expect(rows).toHaveLength(2);
    expect(second.device.id).not.toBe(first.device.id);
  });

  it("issueDevice 显式引用 IsNull(防 tree-shaking 误删导入)", () => {
    expect(IsNull()).toBeInstanceOf(FindOperator);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm exec jest libs/main/src/services/device.service.spec.ts`
Expected: FAIL —— 去重用例失败(当前 `issueDevice` 无去重,`rows` 长度不符),或 `machineId` 不是 Device 属性的类型错误。

- [ ] **Step 4: 实体加 machine_id 列 + 索引元数据**

Modify `libs/main/src/entities/device.entity.ts` —— 在现有 `@Index("ix_device_user", ...)` 之后、`@Entity("device")` 之前加类级索引;在 `tokenHash` 列附近加 `machineId` 列:
```ts
@Index("uq_device_user_machine", ["userId", "machineId"], {
  unique: true,
  where: '"revoked_at" IS NULL AND "machine_id" IS NOT NULL',
})
```
列(加在 `platform` 之后、`tokenHash` 之前即可):
```ts
@Column({ name: "machine_id", type: "varchar", length: 80, nullable: true })
machineId!: string | null;
```

- [ ] **Step 5: issueDevice 去重实现**

Modify `libs/main/src/services/device.service.ts`:
- 顶部加 `import { IsNull } from "typeorm";`,并确认 `@WithLock` 已从 `@meshbot/common` 导入(未导入则加)。
- 替换 `issueDevice`:
```ts
/**
 * 签发设备:按 (userId, machineId) 去重。
 * 命中同机活跃设备则复用该行并轮换 token;machineId 为空则每次新建(降级)。
 * 明文 token 仅此一次返回,库里只存 sha256 哈希。
 */
@WithLock({ key: "device:issue:#{0.userId}:#{0.machineId}" })
async issueDevice(input: {
  userId: string;
  orgId: string | null;
  name: string;
  platform: string;
  machineId?: string | null;
}): Promise<{ device: Device; token: string }> {
  const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashDeviceToken(token);
  if (input.machineId) {
    const existing = await this.deviceRepo.findOne({
      where: {
        userId: input.userId,
        machineId: input.machineId,
        revokedAt: IsNull(),
      },
    });
    if (existing) {
      existing.tokenHash = tokenHash;
      existing.name = input.name;
      existing.platform = input.platform;
      existing.orgId = input.orgId;
      existing.lastSeenAt = new Date();
      const device = await this.deviceRepo.save(existing);
      return { device, token };
    }
  }
  const device = await this.deviceRepo.save(
    this.deviceRepo.create({
      userId: input.userId,
      orgId: input.orgId,
      name: input.name,
      platform: input.platform,
      machineId: input.machineId ?? null,
      tokenHash,
      lastSeenAt: new Date(),
    }),
  );
  return { device, token };
}
```

- [ ] **Step 6: 写 DDL**

Create `apps/server-main/migrations/202607062100-device-machine-id.sql`:
```sql
-- DBA 手动执行;幂等;snake_case;逻辑外键;文件不可变。
-- Device 加 machine_id(本机指纹,同机同账号去重键)+ 部分唯一索引。
-- 仅约束未吊销且有 machine_id 的行,老行(machine_id 为 null)与已吊销行不占索引。

ALTER TABLE "device" ADD COLUMN IF NOT EXISTS "machine_id" varchar(80);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_device_user_machine"
  ON "device" ("user_id", "machine_id")
  WHERE "revoked_at" IS NULL AND "machine_id" IS NOT NULL;
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm exec jest libs/main/src/services/device.service.spec.ts`
Expected: PASS(9 passed)。

- [ ] **Step 8: typecheck + 静态围栏 + commit**

Run:
```bash
pnpm --filter @meshbot/main exec tsc --noEmit
pnpm check:repo && pnpm check:lock-tx
```
Expected:typecheck 无错误;`check:repo`(Device 仍归 DeviceService)、`check:lock-tx`(issueDevice 仅 @WithLock、无 tx 倒置)均 0 问题。
```bash
git add libs/main/src/entities/device.entity.ts libs/main/src/services/device.service.ts libs/main/src/services/device.service.spec.ts apps/server-main/migrations/202607062100-device-machine-id.sql
git commit -m "feat(server-main): issueDevice 按 (user_id, machine_id) 去重 + 部分唯一索引

命中同机活跃设备复用行并轮换 token;@WithLock 串行化同机并发 exchange。
Device 加 machine_id 列(DDL + 实体)。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 打通链路(schema + controller + agent + e2e)

**Files:**
- Modify: `libs/types/src/device-auth/device-auth.schema.ts`(`DeviceAuthExchangeSchema` 加 machineId)
- Modify: `apps/server-main/src/rest/device-auth.controller.ts`(exchange 透传)
- Modify: `apps/server-agent/src/services/device-authorize.service.ts`(请求体带 machineId)
- Test: `apps/server-main/test/e2e/device-auth-flow.e2e.spec.ts`

**Interfaces:**
- Consumes: Task 1 `resolveMachineId()`;Task 2 `issueDevice({ ..., machineId })`。
- Produces: exchange 端到端携带 machineId → 去重生效。

- [ ] **Step 1: schema 加可选 machineId**

Modify `libs/types/src/device-auth/device-auth.schema.ts` 的 `DeviceAuthExchangeSchema`(:31-35),加字段:
```ts
machineId: z.string().max(80).nullish(),
```
`DeviceAuthExchangeInput` 类型自动更新;`DeviceAuthExchangeDto`(libs/main/src/dto/index.ts,声明合并)自动获得该字段,无需改。

- [ ] **Step 2: controller 透传 machineId**

Modify `apps/server-main/src/rest/device-auth.controller.ts` exchange 方法(:88-93)的 `issueDevice` 调用,加 `machineId`:
```ts
const { token } = await this.devices.issueDevice({
  userId,
  orgId: user.activeOrgId,
  name: deviceName,
  platform,
  machineId: dto.machineId ?? null,
});
```

- [ ] **Step 3: agent exchange 请求体带 machineId**

Modify `apps/server-agent/src/services/device-authorize.service.ts`:
- 顶部加 `import { resolveMachineId } from "../utils/machine-id";`
- `complete()` 里的 exchange 请求体(:84-89)加 `machineId`:
```ts
const ex = await this.cloud.post<DeviceAuthExchangeResult>(
  "/api/device-auth/exchange",
  { requestId, userCode, codeVerifier: p.verifier, machineId: resolveMachineId() },
);
```

- [ ] **Step 4: 写失败的 e2e 去重用例**

Modify `apps/server-main/test/e2e/device-auth-flow.e2e.spec.ts` —— 在 `registerAndToken` 之后加一个跑完整授权周期的 helper,并在末尾追加两个 `it`:
```ts
async function runAuthCycle(userToken: string, machineId?: string): Promise<string> {
  const { verifier, challenge } = makePkce();
  const startRes = await request(app.getHttpServer())
    .post("/api/device-auth/start")
    .send({ deviceName: "Dedup Device", platform: "darwin", codeChallenge: challenge });
  const requestId = startRes.body.data.requestId as string;
  const approveRes = await request(app.getHttpServer())
    .post("/api/device-auth/approve")
    .set("Authorization", `Bearer ${userToken}`)
    .send({ requestId });
  const userCode = approveRes.body.data.userCode as string;
  const exchangeRes = await request(app.getHttpServer())
    .post("/api/device-auth/exchange")
    .send({ requestId, userCode, codeVerifier: verifier, ...(machineId ? { machineId } : {}) });
  expect(exchangeRes.body).toMatchObject({ success: true });
  return exchangeRes.body.data.deviceToken as string;
}
```
用例:
```ts
it("同 machineId 两次授权复用同一设备行,旧 token 轮换失效", async () => {
  if (maybeSkip()) return;
  const carolToken = await registerAndToken("carol@device.io");
  await request(app.getHttpServer())
    .post("/api/orgs")
    .set("Authorization", `Bearer ${carolToken}`)
    .send({ name: "CarolOrg" });

  const token1 = await runAuthCycle(carolToken, "machine-carol-1");
  const token2 = await runAuthCycle(carolToken, "machine-carol-1");
  expect(token2).not.toBe(token1);

  const listRes = await request(app.getHttpServer())
    .get("/api/devices")
    .set("Authorization", `Bearer ${carolToken}`);
  expect(listRes.body.data).toHaveLength(1);

  const p2 = await request(app.getHttpServer())
    .get("/api/auth/profile")
    .set("Authorization", `Bearer ${token2}`);
  expect(p2.status).toBe(200);
  const p1 = await request(app.getHttpServer())
    .get("/api/auth/profile")
    .set("Authorization", `Bearer ${token1}`);
  expect(p1.status).toBe(401);
});

it("不同 machineId 分别建行", async () => {
  if (maybeSkip()) return;
  const daveToken = await registerAndToken("dave@device.io");
  await request(app.getHttpServer())
    .post("/api/orgs")
    .set("Authorization", `Bearer ${daveToken}`)
    .send({ name: "DaveOrg" });
  await runAuthCycle(daveToken, "dave-dev-machine");
  await runAuthCycle(daveToken, "dave-pkg-machine");
  const listRes = await request(app.getHttpServer())
    .get("/api/devices")
    .set("Authorization", `Bearer ${daveToken}`);
  expect(listRes.body.data).toHaveLength(2);
});
```

- [ ] **Step 5: 跑 e2e 确认通过(需 Postgres)**

Run:
```bash
pnpm dev:db:up
pnpm exec jest apps/server-main/test/e2e/device-auth-flow.e2e.spec.ts
```
Expected: PASS(含新增 2 用例;原有 3 用例仍绿——machineId 可选,不带时行为不变)。

- [ ] **Step 6: typecheck + 全量围栏 + commit**

Run:
```bash
pnpm typecheck
pnpm check
```
Expected:全过。
```bash
git add libs/types/src/device-auth/device-auth.schema.ts apps/server-main/src/rest/device-auth.controller.ts apps/server-agent/src/services/device-authorize.service.ts apps/server-main/test/e2e/device-auth-flow.e2e.spec.ts
git commit -m "feat: exchange 携带 machineId 打通设备去重(schema/controller/agent + e2e)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 完成后

三个 Task 完成 + `pnpm test` 全绿后,用 superpowers:finishing-a-development-branch 收尾:验证测试 → 开 PR(CI 门禁)→ 合并。DDL 文件随代码合入,线上由 DBA 手动执行 `202607062100-device-machine-id.sql`。

## Self-Review 检查点

- **Spec 覆盖**:machineId 采集(T1)、去重逻辑+DB(T2)、端到端链路+e2e(T3)——覆盖 spec §3 全部组件。
- **类型一致**:`resolveMachineId(): string | null`(T1)→ 请求体 machineId(T3)→ schema `nullish`(T3)→ `issueDevice` input `machineId?: string | null`(T2)→ 列 `machineId: string | null`(T2),贯穿一致。
- **降级**:采集失败/老客户端不带 machineId → 每次新建(旧行为),不阻断。
- **并发**:`@WithLock` + 部分唯一索引双保险(spec §4②)。
