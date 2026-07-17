# 模型配置读时合并（代理云端 + 本地 sqlite）实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 server-agent 的模型配置真相来源从「云端同步落本地 sqlite」改为「读时合并」——模型接口 = 实时代理云端（server-main）模型列表 + 读本地 sqlite `source='local'` 行，合并返回；同时退役同步机制、一次性清存量 cloud 行、重启本地模型写入（REST + web-agent UI）。

**Architecture:** 新增 `CloudModelConfigProxyService`（短 TTL 内存缓存 + `modelConfigChanged` 失效 + 云端不可达降级返回空）代理云端列表；`ModelConfigService` 6 个读方法改为「本地 `source='local'` ∪ 云端代理」合并视图，runner/列表/gate 透明受益；删 `ModelConfigSyncService` 与 `replaceCloudConfigs`，新增迁移 `DELETE FROM model_configs WHERE source='cloud'`；controller/service 重启 create/update/delete/setEnabled（只碰 `source='local'`）；web-agent 恢复本地模型写表单。

**Tech Stack:** NestJS + TypeORM(better-sqlite3) + EventEmitter2 + Zod(`createZodDto`) + Jest（后端）/ Next.js + react-hook-form + `@meshbot/design` Form/FormItem + `useSchema` + TanStack Query（前端）。

## Global Constraints

**Spec 锁定决策（verbatim）：**
- **D1**：云端模型**实时代理、不落本地**；列表 + runner 按 id 解析两处都走合并视图。云端不可达 → 云端模型解析不出（本来就要网关在线才能跑，非离线倒退）；本地模型不受影响。
- **D2**：存量 `source='cloud'` sqlite 行**一次性清掉**（迁移删除），之后 sqlite 只留 `source='local'`。
- **D3**：代理云端列表时效 = **短 TTL 内存缓存（~45s，账号作用域）** + 既有 `modelConfigChanged` 事件主动失效。
- **D4**：本地模型写入**重启**：create/edit/enable/delete REST + web-agent UI，只操作 `source='local'`，绝不碰云端。

**仓库铁律：**
- **Repository 访问规范（check:repo）**：`ModelConfig` 唯一归属 `ModelConfigService`（唯一持有 `@InjectRepository(ModelConfig)`）；Controller / Gateway / Tool 禁止直接注入 Repository；`CloudModelConfigProxyService` 不注入任何 Repository（只调 cloud）。
- **事务命名（check:naming）**：`@Transactional()` **仅跨表写时用**；本地模型写全是单表 upsert/update/delete → **不挂 `@Transactional`**；私有 `@Transactional` 方法名须命中 `*InDb`/`*InTx`/`*InTransaction`/`persist*`（本轮删掉唯一的 `persistCloudConfigs`，写方法不再有事务）。
- **本地轨不用 `@WithLock`**（单进程 + SQLite，锁是云端轨设施）。
- **SQLite schema 用 TypeORM 迁移文件管理**（`synchronize:false` + `migrationsRun:true` 启动自动跑），与 DBA 无关；迁移命名 `<epochMs>-<PascalName>.ts`，新 epoch 须 > `1781300000000`。
- **`libs/types-*` 禁依赖 NestJS / TypeORM**（共享 Zod schema 放 `libs/types-agent`，纯 zod）。
- **用户可见串走 next-intl**（zh/en 双语，`pnpm sync:locales` 后 missing=0）；表单走 `Form/FormItem` + `useSchema`（web-form-convention）。
- **改 module/DI 必须真启动验证**（临时 `MESHBOT_HOME`，不碰仓库根 / `~/.meshbot`）。
- **`pnpm test -- <path>` 有 quirk**，跑单测用 `npx jest <path>`。
- **`check:dead` 不扫 `apps/web-*`**。
- **中文 JSDoc + conventional commit（中文）**；commit 前跑 `pnpm check`。

**关键类型/命名跨任务契约（后续任务一字不差引用）：**
- `CloudModelConfigProxyService.getCloudConfigs(): Promise<ModelConfig[]>`（返回内存构造、`source: 'cloud'` 的 `ModelConfig` 形对象，不 save）。
- `ModelConfigService` 对外读方法签名**保持不变**，仅换实现：`findAll(): Promise<ModelConfig[]>`、`findAllEnabled(): Promise<ModelConfig[]>`、`findEnabled(): Promise<ModelConfig | null>`、`findByIdOrName(idOrName: string): Promise<ModelConfig | null>`、`findOneOrFail(id: string): Promise<ModelConfig>`、`hasEnabledModels(): Promise<boolean>`。
- `ModelConfigService` 新增写方法：`create(dto: CreateModelConfigDto): Promise<ModelConfig>`、`update(id: string, dto: UpdateModelConfigDto): Promise<ModelConfig>`、`setEnabled(id: string, enabled: boolean): Promise<ModelConfig>`、`delete(id: string): Promise<void>`。
- 合并去重规则：**按 `id` 去重，本地优先**（`source='local'` 行覆盖同 id 云端行）。
- 云端条目写操作一律拒：新增错误码 `AgentErrorCode.MODEL_CONFIG_READONLY`（code `3018`，httpStatus `409`）。

---

## 任务总览

- **T1（A）** `CloudModelConfigProxyService`：代理 `/api/agent/model-configs`（device token）+ 45s TTL 账号作用域内存缓存 + `@OnEvent(modelConfigChanged)` 清缓存并 emit `updated` + 云端不可达返回空不抛。
- **T2（B）** `ModelConfigService` 6 读方法改「本地 `source='local'` ∪ 云端代理」合并；确认 runner 透明受益、不改 runner。
- **T3（C）** 退役 sync：删 `ModelConfigSyncService`（+5 触发器 + module 注册）、删 `replaceCloudConfigs`/`persistCloudConfigs`/`CloudModelConfigRow`/`txAnchorRepo`；新增迁移 `DELETE FROM model_configs WHERE source='cloud'`；boot 验证。
- **T4（D·后端）** 重启本地写：controller 加 `POST`/`PATCH :id`/`PATCH :id/enabled`/`DELETE :id`（只作用 `source='local'`）；service 加 create/update/setEnabled/delete；DTO 走 `createZodDto` + `libs/types-agent` 共享 Zod schema；新增 `MODEL_CONFIG_READONLY` 错误码 + i18n。
- **T5（D·web-agent + E）** 本地写 UI：`/more/models` 管理页（按 source 徽标区分本地/云端，云端只读）+ 可复用 `ModelConfigForm`；`ModelSetupGate` 加「配置本地模型」入口 + 改文案；rest 层写函数/mutation；纯逻辑单测。
- **T6** 终验：typecheck + 相关 `npx jest` + build + `pnpm check` + `sync:locales` + 临时 `MESHBOT_HOME` 真启动跑迁移 + grep 确认无残留。

---

### Task 1: `CloudModelConfigProxyService`（云端模型代理 + 短 TTL 缓存）

**Files:**
- Create: `apps/server-agent/src/services/cloud-model-config-proxy.service.ts`
- Create: `apps/server-agent/src/services/cloud-model-config-proxy.service.spec.ts`
- Modify: `apps/server-agent/src/session.module.ts`（providers 加 `CloudModelConfigProxyService`）

**Interfaces:**
- Consumes：`CloudClientService.get<T>(path, token?)`、`CloudIdentityService.get(cloudUserId): Promise<CloudIdentity | null>`（`.deviceToken`）、`AccountContextService.getOrThrow(): string`、`ConfigService.getOrThrow<string>("MESHBOT_CLOUD_URL")`、`EventEmitter2.emit`、`CLOUD_GATEWAY_API_KEY_PLACEHOLDER`（`@meshbot/lib-agent`）、`AgentModelConfig`（`@meshbot/types`，`{ id, name, contextWindow, enabled }`）、`IM_RELAY_EVENTS.modelConfigChanged` + `ImRelayModelConfigChangedEvent`（`../cloud/im-relay.events`）、`MODEL_CONFIG_EVENTS.updated` + `ModelConfigUpdatedEvent`（`@meshbot/types-agent`）、`ModelConfig`（entity 形状）。
- Produces：`getCloudConfigs(): Promise<ModelConfig[]>`（T2 消费）；`@OnEvent(IM_RELAY_EVENTS.modelConfigChanged) onModelConfigChanged(payload)`（迁自旧 sync）。

- [ ] **Step 1: 写失败测试**

Create `apps/server-agent/src/services/cloud-model-config-proxy.service.spec.ts`：

```ts
import { AccountContextService } from "@meshbot/lib-agent";
import type { AgentModelConfig } from "@meshbot/types";
import { CloudModelConfigProxyService } from "./cloud-model-config-proxy.service";

const CLOUD_URL = "http://cloud.test";

function sampleConfigs(): AgentModelConfig[] {
  return [
    { id: "cfg-1", name: "GPT-4o", contextWindow: 128_000, enabled: true },
    { id: "cfg-2", name: "DS Chat", contextWindow: 64_000, enabled: false },
  ];
}

function build() {
  const account = new AccountContextService();
  const cloud = { get: jest.fn() };
  const identity = { get: jest.fn() };
  const config = { getOrThrow: jest.fn().mockReturnValue(CLOUD_URL) };
  const emitter = { emit: jest.fn() };
  const service = new CloudModelConfigProxyService(
    cloud as never,
    identity as never,
    account,
    config as never,
    emitter as never,
  );
  return { account, cloud, identity, config, emitter, service };
}

describe("CloudModelConfigProxyService", () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("getCloudConfigs：device token 拉云端并映射成 source='cloud' 的网关坐标行", async () => {
    const { account, cloud, identity, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockResolvedValue(sampleConfigs());

    const rows = await account.run("u1", () => service.getCloudConfigs());

    expect(cloud.get).toHaveBeenCalledWith("/api/agent/model-configs", "mbd_x");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "cfg-1",
      providerType: "openai-compatible",
      baseUrl: `${CLOUD_URL}/api/v1`,
      model: "cfg-1",
      apiKey: "__cloud__",
      name: "GPT-4o",
      contextWindow: 128_000,
      enabled: true,
      source: "cloud",
      cloudUserId: "u1",
    });
  });

  it("TTL 内二次读命中缓存，不再打云端", async () => {
    const { account, cloud, identity, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockResolvedValue(sampleConfigs());

    await account.run("u1", () => service.getCloudConfigs());
    await account.run("u1", () => service.getCloudConfigs());

    expect(cloud.get).toHaveBeenCalledTimes(1);
  });

  it("TTL 过期后重新打云端", async () => {
    jest.useFakeTimers();
    const { account, cloud, identity, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockResolvedValue(sampleConfigs());

    await account.run("u1", () => service.getCloudConfigs());
    jest.advanceTimersByTime(46_000);
    await account.run("u1", () => service.getCloudConfigs());

    expect(cloud.get).toHaveBeenCalledTimes(2);
  });

  it("modelConfigChanged 清该账号缓存并 emit model-config.updated", async () => {
    const { account, cloud, identity, emitter, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockResolvedValue(sampleConfigs());

    await account.run("u1", () => service.getCloudConfigs());
    service.onModelConfigChanged({ cloudUserId: "u1" });
    await account.run("u1", () => service.getCloudConfigs());

    expect(cloud.get).toHaveBeenCalledTimes(2);
    expect(emitter.emit).toHaveBeenCalledWith("model-config.updated", {
      cloudUserId: "u1",
    });
  });

  it("云端不可达 → 返回空数组、不抛、不缓存（下次重试）", async () => {
    const { account, cloud, identity, service } = build();
    identity.get.mockResolvedValue({ deviceToken: "mbd_x" });
    cloud.get.mockRejectedValueOnce(new Error("network down"));

    const rows = await account.run("u1", () => service.getCloudConfigs());
    expect(rows).toEqual([]);

    cloud.get.mockResolvedValue(sampleConfigs());
    const rows2 = await account.run("u1", () => service.getCloudConfigs());
    expect(rows2).toHaveLength(2);
    expect(cloud.get).toHaveBeenCalledTimes(2);
  });

  it("无 deviceToken → 返回空数组，不打云端", async () => {
    const { account, cloud, identity, service } = build();
    identity.get.mockResolvedValue({ deviceToken: null });

    const rows = await account.run("u1", () => service.getCloudConfigs());
    expect(rows).toEqual([]);
    expect(cloud.get).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest apps/server-agent/src/services/cloud-model-config-proxy.service.spec.ts`
Expected: FAIL —— `Cannot find module './cloud-model-config-proxy.service'`。

- [ ] **Step 3: 实现 `CloudModelConfigProxyService`**

Create `apps/server-agent/src/services/cloud-model-config-proxy.service.ts`：

```ts
import {
  AccountContextService,
  CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
} from "@meshbot/lib-agent";
import type { AgentModelConfig } from "@meshbot/types";
import {
  MODEL_CONFIG_EVENTS,
  type ModelConfigUpdatedEvent,
} from "@meshbot/types-agent";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { CloudClientService } from "../cloud/cloud-client.service";
import {
  IM_RELAY_EVENTS,
  type ImRelayModelConfigChangedEvent,
} from "../cloud/im-relay.events";
import { CloudIdentityService } from "./cloud-identity.service";
import { ModelConfig } from "../entities/model-config.entity";

/** 云端模型列表内存缓存 TTL（毫秒），账号作用域（D3）。 */
const CACHE_TTL_MS = 45_000;
/** contextWindow 兜底值（与 entity 列默认一致），云端未给时使用。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 单账号缓存条目：取回时间戳 + 映射后的云端坐标行。 */
interface CacheEntry {
  at: number;
  rows: ModelConfig[];
}

/**
 * 云端组织模型配置读时代理（读时合并架构 A）。
 *
 * 用 device token 实时拉云端 `GET /api/agent/model-configs`，映射为指向本地
 * 网关的 openai-compatible 坐标行（`source='cloud'`，内存构造、绝不落库），
 * 供 ModelConfigService 合并读方法兜底。短 TTL 缓存（45s，key=cloudUserId）
 * 削打云端频次；云端广播 modelConfigChanged 时主动清缓存并通知前端刷新。
 * 云端不可达时返回空 cloud 列表（不抛、不缓存），本地模型不受影响（D1）。
 */
@Injectable()
export class CloudModelConfigProxyService {
  private readonly logger = new Logger(CloudModelConfigProxyService.name);
  /** 账号作用域缓存：cloudUserId → 云端坐标行 + 取回时间。 */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
    private readonly config: ConfigService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * 取当前账号的云端模型配置（映射为网关坐标行、打 source='cloud' 标）。
   * TTL 内命中缓存直接返回；过期/未命中打云端；云端不可达返回空、不抛。
   */
  async getCloudConfigs(): Promise<ModelConfig[]> {
    const cloudUserId = this.account.getOrThrow();
    const cached = this.cache.get(cloudUserId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;

    const id = await this.identity.get(cloudUserId);
    if (!id?.deviceToken) return [];
    try {
      const configs = await this.cloud.get<AgentModelConfig[]>(
        "/api/agent/model-configs",
        id.deviceToken,
      );
      const rows = configs.map((c) => this.toGatewayRow(c, cloudUserId));
      this.cache.set(cloudUserId, { at: Date.now(), rows });
      return rows;
    } catch (err) {
      this.logger.warn(
        `云端模型配置代理失败（账号 ${cloudUserId}）: ${String(err)}`,
      );
      return [];
    }
  }

  /**
   * 云端广播模型配置变更（失效信号）：清该账号缓存 + emit 前端刷新事件。
   * 语义从旧 sync 的「重新同步落库」改为「清缓存」——下次读实时取云端。
   */
  @OnEvent(IM_RELAY_EVENTS.modelConfigChanged)
  onModelConfigChanged({ cloudUserId }: ImRelayModelConfigChangedEvent): void {
    this.cache.delete(cloudUserId);
    this.emitter.emit(MODEL_CONFIG_EVENTS.updated, {
      cloudUserId,
    } satisfies ModelConfigUpdatedEvent);
  }

  /**
   * 把云端「可见列表」`AgentModelConfig` 映射为指向本地网关的 openai-compatible
   * 坐标行：`model` 用云端配置 id 做调用引用，`apiKey` 是占位符（真实厂商 key
   * 只在云端网关持有），`source='cloud'`、内存构造不落库。
   */
  private toGatewayRow(
    config: AgentModelConfig,
    cloudUserId: string,
  ): ModelConfig {
    const cloudUrl = this.config.getOrThrow<string>("MESHBOT_CLOUD_URL");
    return {
      id: config.id,
      cloudUserId,
      providerType: "openai-compatible",
      baseUrl: `${cloudUrl.replace(/\/$/, "")}/api/v1`,
      model: config.id,
      apiKey: CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
      name: config.name,
      contextWindow: config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      enabled: config.enabled,
      source: "cloud",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as ModelConfig;
  }
}
```

- [ ] **Step 4: 注册到 session.module（providers）**

Modify `apps/server-agent/src/session.module.ts`：
- import：`import { CloudModelConfigProxyService } from "./services/cloud-model-config-proxy.service";`
- `providers` 数组加入 `CloudModelConfigProxyService`（与 `ModelConfigService` 同列，紧邻其上）。**暂不导出**（仅本模块 `ModelConfigService` 注入 + 自身 `@OnEvent` 监听）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx jest apps/server-agent/src/services/cloud-model-config-proxy.service.spec.ts`
Expected: PASS（6 个用例全绿）。

- [ ] **Step 6: 提交**

```bash
git add apps/server-agent/src/services/cloud-model-config-proxy.service.ts \
        apps/server-agent/src/services/cloud-model-config-proxy.service.spec.ts \
        apps/server-agent/src/session.module.ts
git commit -m "feat(server-agent): 新增 CloudModelConfigProxyService（读时代理云端模型 + 45s TTL 缓存 + modelConfigChanged 失效）"
```

---

### Task 2: `ModelConfigService` 读方法改合并视图

**Files:**
- Modify: `apps/server-agent/src/services/model-config.service.ts`（构造注入 proxy + 6 读方法改合并 + `mergeById` 私有助手）
- Modify: `apps/server-agent/src/services/model-config.service.spec.ts`（构造加 proxy mock + 合并断言）

**Interfaces:**
- Consumes：`CloudModelConfigProxyService.getCloudConfigs(): Promise<ModelConfig[]>`（T1）。
- Produces：读方法签名不变（见 Global Constraints 契约）；实现改为本地 `source='local'` ∪ 云端代理，按 id 去重、本地优先。

- [ ] **Step 1: 改测试（构造加 proxy mock + 新增合并断言）**

Modify `apps/server-agent/src/services/model-config.service.spec.ts`：

1. `beforeEach` 里给 `rawService` 构造第三参 proxy mock，并暴露到闭包便于逐例覆盖返回：

```ts
  let proxyGet: jest.Mock;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [ModelConfig],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    proxyGet = jest.fn().mockResolvedValue([]);
    rawService = new ModelConfigService(
      ds.getRepository(ModelConfig),
      scopedFactory,
      { getCloudConfigs: proxyGet } as never,
    );
    service = wrapInAccount(rawService, ctx, DEFAULT_USER);
  });
```

2. 追加合并用例（放在既有读方法 describe 之后）：

```ts
  /** 造一条内存态云端坐标行（source='cloud'，proxy 返回形状）。 */
  function cloudRow(overrides: Partial<ModelConfig> = {}): ModelConfig {
    const id = overrides.id ?? "cloud-1";
    return {
      id,
      cloudUserId: DEFAULT_USER,
      providerType: "openai-compatible",
      name: "Cloud GPT-4o",
      model: id,
      apiKey: "__cloud__",
      baseUrl: "http://cloud.test/api/v1",
      enabled: true,
      contextWindow: 128_000,
      source: "cloud",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...overrides,
    } as ModelConfig;
  }

  it("findAll 合并本地 local 行 + 云端代理行", async () => {
    await seedModelConfig(ds, { cloudUserId: DEFAULT_USER, name: "Local A" });
    proxyGet.mockResolvedValue([cloudRow({ id: "cloud-1", name: "Cloud A" })]);

    const all = await service.findAll();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.source).sort()).toEqual(["cloud", "local"]);
  });

  it("findAll 只取本地 source='local'（存量 cloud 行被排除，只由代理提供云端）", async () => {
    await seedModelConfig(ds, {
      cloudUserId: DEFAULT_USER,
      name: "Stale Cloud",
      source: "cloud",
    });
    proxyGet.mockResolvedValue([]);

    const all = await service.findAll();
    expect(all).toHaveLength(0);
  });

  it("findAll 按 id 去重、本地优先", async () => {
    const local = await seedModelConfig(ds, {
      cloudUserId: DEFAULT_USER,
      name: "Local Wins",
    });
    proxyGet.mockResolvedValue([cloudRow({ id: local.id, name: "Cloud Dup" })]);

    const all = await service.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Local Wins");
    expect(all[0].source).toBe("local");
  });

  it("findAllEnabled 合并后按 enabled 过滤", async () => {
    await seedModelConfig(ds, {
      cloudUserId: DEFAULT_USER,
      name: "Local Off",
      enabled: false,
    });
    proxyGet.mockResolvedValue([
      cloudRow({ id: "c1", name: "Cloud On", enabled: true }),
      cloudRow({ id: "c2", name: "Cloud Off", enabled: false }),
    ]);

    const enabled = await service.findAllEnabled();
    expect(enabled.map((c) => c.name)).toEqual(["Cloud On"]);
  });

  it("findByIdOrName 本地优先命中，不打云端", async () => {
    const local = await seedModelConfig(ds, {
      cloudUserId: DEFAULT_USER,
      name: "Local X",
    });
    const found = await service.findByIdOrName(local.id);
    expect(found?.id).toBe(local.id);
    expect(proxyGet).not.toHaveBeenCalled();
  });

  it("findByIdOrName 本地未命中 → 云端代理兜底", async () => {
    proxyGet.mockResolvedValue([cloudRow({ id: "cloud-9", name: "Cloud Y" })]);
    const found = await service.findByIdOrName("cloud-9");
    expect(found?.name).toBe("Cloud Y");
    expect(found?.source).toBe("cloud");
  });

  it("findByIdOrName 本地与云端都未命中 → null（云端不可达即空列表，不抛）", async () => {
    proxyGet.mockResolvedValue([]);
    const found = await service.findByIdOrName("ghost");
    expect(found).toBeNull();
  });

  it("findOneOrFail 云端 id 命中返回云端行；都无则抛 NotFound", async () => {
    proxyGet.mockResolvedValue([cloudRow({ id: "cloud-7" })]);
    const found = await service.findOneOrFail("cloud-7");
    expect(found.source).toBe("cloud");
    await expect(service.findOneOrFail("nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("hasEnabledModels 仅云端有 enabled 时也放行", async () => {
    proxyGet.mockResolvedValue([cloudRow({ id: "c1", enabled: true })]);
    expect(await service.hasEnabledModels()).toBe(true);
  });
```

> 注：既有 `replaceCloudConfigs` 相关用例本任务保留（方法 T3 才删）；本任务只加 proxy 构造参数与合并断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest apps/server-agent/src/services/model-config.service.spec.ts`
Expected: FAIL —— 构造函数第三参未被使用 / `findAll` 未合并（新增用例挂红）。

- [ ] **Step 3: 改实现（注入 proxy + 合并读）**

Modify `apps/server-agent/src/services/model-config.service.ts` 构造函数与读方法（保留 `replaceCloudConfigs`/`persistCloudConfigs`/`txAnchorRepo`/`CloudModelConfigRow` 到 T3 再删）：

```ts
  constructor(
    @InjectRepository(ModelConfig)
    rawRepo: Repository<ModelConfig>,
    scopedFactory: ScopedRepositoryFactory,
    private readonly proxy: CloudModelConfigProxyService,
  ) {
    this.repo = scopedFactory.create(rawRepo);
    this.txAnchorRepo = rawRepo;
  }

  /** 列出当前账号所有 ModelConfig（本地 local 行 + 云端代理行，按 id 去重、本地优先）。 */
  async findAll(): Promise<ModelConfig[]> {
    const local = await this.repo.find({ where: { source: "local" } });
    const cloud = await this.proxy.getCloudConfigs();
    return this.mergeById(local, cloud);
  }

  /** 列出当前账号所有已启用的 ModelConfig（合并后按 enabled 过滤）。 */
  async findAllEnabled(): Promise<ModelConfig[]> {
    const all = await this.findAll();
    return all.filter((c) => c.enabled);
  }

  /** 取第一条已启用的 ModelConfig；无则返 null。供 ContextCompactor 使用。 */
  async findEnabled(): Promise<ModelConfig | null> {
    const rows = await this.findAllEnabled();
    return rows[0] ?? null;
  }

  /**
   * 按 id 查单条：本地 local 行优先，未命中查云端代理；都无则抛 NotFoundException。
   * 云端不可达时代理返回空列表 → 相当于云端未命中。
   */
  async findOneOrFail(id: string): Promise<ModelConfig> {
    const local = await this.repo.findOneBy({ id, source: "local" });
    if (local) return local;
    const cloud = await this.proxy.getCloudConfigs();
    const found = cloud.find((c) => c.id === id);
    if (!found) throw new NotFoundException(`ModelConfig ${id} not found`);
    return found;
  }

  /** 判断当前账号是否有已启用的 ModelConfig（本地或云端任一有 enabled）。 */
  async hasEnabledModels(): Promise<boolean> {
    return (await this.findAllEnabled()).length > 0;
  }

  /**
   * 按 id 优先、name 次之查模型配置（dispatch model 覆盖 / runner 解析用；含未启用）。
   * 本地 local 行优先（id→name），未命中查云端代理（id→name）；都无返回 null。
   */
  async findByIdOrName(idOrName: string): Promise<ModelConfig | null> {
    const localById = await this.repo.findOneBy({
      id: idOrName,
      source: "local",
    });
    if (localById) return localById;
    const localByName = await this.repo.findOneBy({
      name: idOrName,
      source: "local",
    });
    if (localByName) return localByName;
    const cloud = await this.proxy.getCloudConfigs();
    return cloud.find((c) => c.id === idOrName || c.name === idOrName) ?? null;
  }

  /** 按 id 去重合并两组配置，本地行覆盖同 id 云端行（本地优先）。 */
  private mergeById(local: ModelConfig[], cloud: ModelConfig[]): ModelConfig[] {
    const seen = new Set(local.map((c) => c.id));
    return [...local, ...cloud.filter((c) => !seen.has(c.id))];
  }
```

顶部 import 加：`import { CloudModelConfigProxyService } from "./cloud-model-config-proxy.service";`

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest apps/server-agent/src/services/model-config.service.spec.ts`
Expected: PASS（合并用例 + 既有读用例全绿；`replaceCloudConfigs` 用例仍在、仍绿）。

- [ ] **Step 5: 确认 runner 透明受益、不改 runner**

Run: `grep -n "modelConfig\.\(findByIdOrName\|findEnabled\|findOneOrFail\|findAll\)" apps/server-agent/src/services/runner.service.ts`
Expected：runner 仅调 `ModelConfigService` 的读方法（如 `findEnabled()` :336、按 `session.modelConfigId || agent.defaultModelConfigId` 解析），签名未变 → 合并对 runner 透明，**不改 runner.service.ts**。若 grep 显示 runner 直接读 repo 或依赖 `source='cloud'` 行，停下反馈（预期不会）。

- [ ] **Step 6: 提交**

```bash
git add apps/server-agent/src/services/model-config.service.ts \
        apps/server-agent/src/services/model-config.service.spec.ts
git commit -m "feat(server-agent): ModelConfigService 读方法改本地+云端代理合并视图（按 id 去重本地优先）"
```

---

### Task 3: 退役同步 + 清存量 cloud 行

**Files:**
- Delete: `apps/server-agent/src/services/model-config-sync.service.ts`
- Delete: `apps/server-agent/src/services/model-config-sync.service.spec.ts`
- Modify: `apps/server-agent/src/session.module.ts`（移除 `ModelConfigSyncService` import + provider）
- Modify: `apps/server-agent/src/services/model-config.service.ts`（删 `replaceCloudConfigs`/`persistCloudConfigs`/`CloudModelConfigRow`/`txAnchorRepo` + 相关 import）
- Modify: `apps/server-agent/src/services/model-config.service.spec.ts`（删 `replaceCloudConfigs`/`cloudConfigRow` 相关用例与 import）
- Modify: `libs/types-agent/src/model-config.events.ts`（更新 `updated` 事件 JSDoc 语义）
- Create: `apps/server-agent/src/migrations/1781400000000-DropCloudModelConfigRows.ts`
- Create: `apps/server-agent/src/migrations/__tests__/1781400000000-DropCloudModelConfigRows.spec.ts`

**Interfaces:**
- Consumes：无新增。
- Produces：`ModelConfigService` 不再含云端写入口（`replaceCloudConfigs` 消失）；DB 启动后 `model_configs` 无 `source='cloud'` 行。

- [ ] **Step 1: 写迁移幂等性失败测试**

Create `apps/server-agent/src/migrations/__tests__/1781400000000-DropCloudModelConfigRows.spec.ts`：

```ts
import { DataSource } from "typeorm";
import { ModelConfig } from "../../entities/model-config.entity";
import { DropCloudModelConfigRows1781400000000 } from "../1781400000000-DropCloudModelConfigRows";

describe("DropCloudModelConfigRows1781400000000", () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [ModelConfig],
      synchronize: true,
    });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  async function seed(source: "cloud" | "local", name: string) {
    const repo = ds.getRepository(ModelConfig);
    await repo.save(
      repo.create({
        cloudUserId: "u1",
        providerType: "openai",
        name,
        model: "gpt-4o",
        apiKey: "k",
        baseUrl: "",
        enabled: true,
        contextWindow: 128_000,
        source,
      }),
    );
  }

  it("up 删除全部 source='cloud' 行，保留 source='local' 行", async () => {
    await seed("cloud", "Cloud A");
    await seed("cloud", "Cloud B");
    await seed("local", "Local A");

    const runner = ds.createQueryRunner();
    await new DropCloudModelConfigRows1781400000000().up(runner);
    await runner.release();

    const rows = await ds.getRepository(ModelConfig).find();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Local A");
  });

  it("up 幂等：无 cloud 行时再跑不报错", async () => {
    await seed("local", "Local Only");
    const runner = ds.createQueryRunner();
    const migration = new DropCloudModelConfigRows1781400000000();
    await migration.up(runner);
    await migration.up(runner);
    await runner.release();

    const rows = await ds.getRepository(ModelConfig).find();
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest apps/server-agent/src/migrations/__tests__/1781400000000-DropCloudModelConfigRows.spec.ts`
Expected: FAIL —— `Cannot find module '../1781400000000-DropCloudModelConfigRows'`。

- [ ] **Step 3: 写迁移文件**

Create `apps/server-agent/src/migrations/1781400000000-DropCloudModelConfigRows.ts`：

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 读时合并改造（D2）：一次性清掉存量 source='cloud' 缓存行。
 * 云端模型配置改由 CloudModelConfigProxyService 读时实时代理、不落本地，
 * sqlite 之后只保留用户本地维护的 source='local' 行。
 * 幂等（无 cloud 行时 DELETE 影响 0 行）；SQLite 无法「撤销删除」，down 留空。
 */
export class DropCloudModelConfigRows1781400000000
  implements MigrationInterface
{
  name = "DropCloudModelConfigRows1781400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "model_configs" WHERE "source" = 'cloud'`,
    );
  }

  public async down(): Promise<void> {
    // 数据删除不可逆（云端行本就无需回填，实时代理即可重建视图），down 留空。
  }
}
```

> **表名 `model_configs`（复数）**——entity 是 `@Entity("model_configs")`，spec 正文写的 `model_config` 是笔误，以 entity 为准。

- [ ] **Step 4: 跑迁移测试确认通过**

Run: `npx jest apps/server-agent/src/migrations/__tests__/1781400000000-DropCloudModelConfigRows.spec.ts`
Expected: PASS。

- [ ] **Step 5: 删 `ModelConfigSyncService` 及其 spec + module 注册**

```bash
git rm apps/server-agent/src/services/model-config-sync.service.ts \
       apps/server-agent/src/services/model-config-sync.service.spec.ts
```

Modify `apps/server-agent/src/session.module.ts`：
- 删 `import { ModelConfigSyncService } from "./services/model-config-sync.service";`
- 从 `providers` 删 `ModelConfigSyncService`
- 更新模块顶部 JSDoc 中提到 `ModelConfigSyncService` 的两处描述（改述为「读时合并，云端模型由 `CloudModelConfigProxyService` 实时代理，无同步落库」）。

- [ ] **Step 6: 删 `ModelConfigService` 云端写入口 + txAnchor**

Modify `apps/server-agent/src/services/model-config.service.ts`：
- 删 `replaceCloudConfigs` + `persistCloudConfigs`（含 `@Transactional`）
- 删 `CloudModelConfigRow` interface + 顶部注释块
- 删 `txAnchorRepo` 字段 + 构造里 `this.txAnchorRepo = rawRepo;`（已无 `@Transactional` 方法，DataSource 反射锚点不再需要）
- 删已无用 import：`Transactional`（`@meshbot/common`）、`Repository`（若仅 txAnchor 用则删；`rawRepo: Repository<ModelConfig>` 构造参数仍需 `Repository` 类型 → **保留 `import { Repository } from "typeorm"`**）
- 删 `DEFAULT_CONTEXT_WINDOW` 常量（仅 persistCloudConfigs 用过）

Modify `apps/server-agent/src/services/model-config.service.spec.ts`：
- 删 `replaceCloudConfigs`/`persistCloudConfigs` 相关 describe/用例、`cloudConfigRow` 辅助函数、`import type { CloudModelConfigRow }`。

- [ ] **Step 7: 更新事件 JSDoc 语义**

Modify `libs/types-agent/src/model-config.events.ts`——`updated` 注释改：

```ts
  /** 云端模型配置变更（代理缓存已失效）——前端应重拉合并后的模型列表。 */
  updated: "model-config.updated",
```

- [ ] **Step 8: 跑相关单测 + typecheck 确认无残留引用**

Run: `npx jest apps/server-agent/src/services/model-config.service.spec.ts apps/server-agent/src/migrations/__tests__/1781400000000-DropCloudModelConfigRows.spec.ts`
Expected: PASS。

Run: `grep -rn "ModelConfigSyncService\|replaceCloudConfigs\|persistCloudConfigs\|CloudModelConfigRow" apps/server-agent/src`
Expected: 无输出（零残留）。

- [ ] **Step 9: 提交**

```bash
git add -A apps/server-agent/src/services apps/server-agent/src/session.module.ts \
          apps/server-agent/src/migrations libs/types-agent/src/model-config.events.ts
git commit -m "refactor(server-agent): 退役 ModelConfigSyncService，新增迁移清 source=cloud 存量行（读时合并 C）"
```

---

### Task 4: 重启本地模型写入（后端 REST + service + DTO + 错误码）

**Files:**
- Modify: `libs/types-agent/src/ai/providers.ts`（新增 `modelConfigUpdateSchema`、`modelConfigEnabledSchema`）
- Create: `apps/server-agent/src/dto/model-config.dto.ts`
- Modify: `apps/server-agent/src/controllers/model-config.controller.ts`（加写端点）
- Modify: `apps/server-agent/src/services/model-config.service.ts`（加 create/update/setEnabled/delete + 私有 `findLocalOrReject`）
- Modify: `apps/server-agent/src/services/model-config.service.spec.ts`（写方法用例）
- Modify: `apps/server-agent/src/errors/agent.error-codes.ts`（加 `MODEL_CONFIG_READONLY`）
- Create: `apps/server-agent/i18n/zh/model-config.json`、`apps/server-agent/i18n/en/model-config.json`

**Interfaces:**
- Consumes：`modelConfigSchema`（已存在，`{ providerType, name, model, apiKey, baseUrl?, contextWindow? }`）、`resolveContextWindow(model, contextWindow?)`（`@meshbot/types-agent`）、`createZodDto`（`@meshbot/common`）、`AppError` + `AgentErrorCode`、`CloudModelConfigProxyService.getCloudConfigs()`（T1）。
- Produces：`CreateModelConfigDto`、`UpdateModelConfigDto`、`SetModelConfigEnabledDto`；service 写方法（见 Global Constraints 契约）；`AgentErrorCode.MODEL_CONFIG_READONLY`。

- [ ] **Step 1: 新增共享 update/enabled Zod schema**

Modify `libs/types-agent/src/ai/providers.ts`（`modelConfigSchema` 定义之后追加）：

```ts
/** 本地模型配置更新 Schema（局部字段；不允许改 providerType）。 */
export const modelConfigUpdateSchema = z.object({
  name: z.string().min(1, "请输入名称").optional(),
  model: z.string().min(1, "请输入或选择模型").optional(),
  apiKey: z.string().min(1, "请输入 API Key").optional(),
  baseUrl: z.string().optional(),
  enabled: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
});
export type ModelConfigUpdateInput = z.infer<typeof modelConfigUpdateSchema>;

/** 启用/停用切换 Schema。 */
export const modelConfigEnabledSchema = z.object({
  enabled: z.boolean(),
});
export type ModelConfigEnabledInput = z.infer<typeof modelConfigEnabledSchema>;
```

确认 `libs/types-agent/src/ai/index.ts` 已 `export * from "./providers"` 或显式补出上述三名（与 `modelConfigSchema` 同出口）。若是显式列举，追加 `modelConfigUpdateSchema` / `modelConfigEnabledSchema` / 两个类型。

- [ ] **Step 2: 写 service 写方法失败测试**

Modify `apps/server-agent/src/services/model-config.service.spec.ts`（追加）：

```ts
  it("create 写入 source='local'（enabled 默认 true）", async () => {
    const created = await service.create({
      providerType: "openai",
      name: "My Local",
      model: "gpt-4o",
      apiKey: "sk-x",
    } as never);
    expect(created.source).toBe("local");
    expect(created.enabled).toBe(true);
    const rows = await ds.getRepository(ModelConfig).find();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("local");
  });

  it("update 改本地行字段", async () => {
    const created = await service.create({
      providerType: "openai",
      name: "Old",
      model: "gpt-4o",
      apiKey: "sk-x",
    } as never);
    const updated = await service.update(created.id, { name: "New" } as never);
    expect(updated.name).toBe("New");
  });

  it("setEnabled 切换本地行启用态", async () => {
    const created = await service.create({
      providerType: "openai",
      name: "M",
      model: "gpt-4o",
      apiKey: "sk-x",
    } as never);
    const toggled = await service.setEnabled(created.id, false);
    expect(toggled.enabled).toBe(false);
  });

  it("delete 删本地行", async () => {
    const created = await service.create({
      providerType: "openai",
      name: "M",
      model: "gpt-4o",
      apiKey: "sk-x",
    } as never);
    await service.delete(created.id);
    expect(await ds.getRepository(ModelConfig).find()).toHaveLength(0);
  });

  it("update 云端条目被拒（MODEL_CONFIG_READONLY，code 3018）", async () => {
    proxyGet.mockResolvedValue([cloudRow({ id: "cloud-ro" })]);
    await expect(
      service.update("cloud-ro", { name: "X" } as never),
    ).rejects.toMatchObject({ code: 3018 });
  });

  it("delete 云端条目被拒（MODEL_CONFIG_READONLY）", async () => {
    proxyGet.mockResolvedValue([cloudRow({ id: "cloud-ro" })]);
    await expect(service.delete("cloud-ro")).rejects.toMatchObject({
      code: 3018,
    });
  });

  it("update 完全不存在的 id → NotFound", async () => {
    proxyGet.mockResolvedValue([]);
    await expect(
      service.update("ghost", { name: "X" } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
```

> 需把 T3 中删除的 `cloudRow` 辅助函数保留/复原到本 spec（写方法拒云端用例依赖它）。在 T2 已定义 `cloudRow`；T3 删的是 `cloudConfigRow`（replaceCloudConfigs 专用），`cloudRow` 应保留——确认 T3 Step 6 只删 `cloudConfigRow` 不删 `cloudRow`。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx jest apps/server-agent/src/services/model-config.service.spec.ts`
Expected: FAIL —— `service.create/update/setEnabled/delete is not a function` 及 `3018` 未定义。

- [ ] **Step 4: 加错误码 + i18n**

Modify `apps/server-agent/src/errors/agent.error-codes.ts`（`REMOTE_QUERY_UNAVAILABLE` 之后、闭合 `})` 之前追加）：

```ts
  MODEL_CONFIG_READONLY: {
    code: 3018,
    message: "modelConfig.readonly",
    httpStatus: 409,
  },
```

Create `apps/server-agent/i18n/zh/model-config.json`：

```json
{
  "readonly": "云端组织模型为只读，请到云端组织设置中修改"
}
```

Create `apps/server-agent/i18n/en/model-config.json`：

```json
{
  "readonly": "Cloud organization models are read-only; edit them in cloud org settings"
}
```

- [ ] **Step 5: 实现 service 写方法**

Modify `apps/server-agent/src/services/model-config.service.ts`（顶部补 import）：

```ts
import { AppError } from "@meshbot/common";
import { resolveContextWindow } from "@meshbot/types-agent";
import { AgentErrorCode } from "../errors/agent.error-codes";
import type {
  CreateModelConfigDto,
  UpdateModelConfigDto,
} from "../dto/model-config.dto";
```

追加方法（类内）：

```ts
  /** 新建本地模型配置（source='local'，enabled 默认 true）。单表写，无需 @Transactional。 */
  async create(dto: CreateModelConfigDto): Promise<ModelConfig> {
    return this.repo.save({
      providerType: dto.providerType,
      name: dto.name,
      model: dto.model,
      apiKey: dto.apiKey,
      baseUrl: dto.baseUrl ?? "",
      enabled: true,
      contextWindow: resolveContextWindow(dto.model, dto.contextWindow),
      source: "local",
    } as ModelConfig);
  }

  /**
   * 更新本地模型配置（只碰 source='local'）。contextWindow 策略：
   * 显式给值 → 覆盖；未给但 model 变了 → 按新 model 重解析；否则保留原值。
   * 目标是云端条目 → MODEL_CONFIG_READONLY；不存在 → NotFound。
   */
  async update(id: string, dto: UpdateModelConfigDto): Promise<ModelConfig> {
    const entity = await this.findLocalOrReject(id);
    const modelChanged = dto.model !== undefined && dto.model !== entity.model;
    Object.assign(entity, dto);
    if (dto.contextWindow !== undefined) {
      entity.contextWindow = dto.contextWindow;
    } else if (modelChanged) {
      entity.contextWindow = resolveContextWindow(entity.model);
    }
    return this.repo.save(entity);
  }

  /** 切换本地模型配置启用态（只碰 source='local'）。 */
  async setEnabled(id: string, enabled: boolean): Promise<ModelConfig> {
    const entity = await this.findLocalOrReject(id);
    entity.enabled = enabled;
    return this.repo.save(entity);
  }

  /** 删除本地模型配置（只碰 source='local'）。 */
  async delete(id: string): Promise<void> {
    await this.findLocalOrReject(id);
    await this.repo.delete({ id, source: "local" });
  }

  /**
   * 定位可写的本地行：命中 source='local' 返回；否则查云端代理——
   * 命中云端 → MODEL_CONFIG_READONLY（编辑去云端 org），都无 → NotFound。
   */
  private async findLocalOrReject(id: string): Promise<ModelConfig> {
    const local = await this.repo.findOneBy({ id, source: "local" });
    if (local) return local;
    const cloud = await this.proxy.getCloudConfigs();
    if (cloud.some((c) => c.id === id)) {
      throw new AppError(AgentErrorCode.MODEL_CONFIG_READONLY);
    }
    throw new NotFoundException(`ModelConfig ${id} not found`);
  }
```

- [ ] **Step 6: 跑 service 测试确认通过**

Run: `npx jest apps/server-agent/src/services/model-config.service.spec.ts`
Expected: PASS（写方法 + 拒云端 + NotFound 用例全绿）。

- [ ] **Step 7: 建 DTO + 加 controller 写端点**

Create `apps/server-agent/src/dto/model-config.dto.ts`：

```ts
import { createZodDto } from "@meshbot/common";
import {
  modelConfigEnabledSchema,
  modelConfigSchema,
  modelConfigUpdateSchema,
} from "@meshbot/types-agent";

/** 新建本地模型配置入参。 */
export class CreateModelConfigDto extends createZodDto(modelConfigSchema) {}

/** 更新本地模型配置入参（局部字段）。 */
export class UpdateModelConfigDto extends createZodDto(
  modelConfigUpdateSchema,
) {}

/** 启用/停用切换入参。 */
export class SetModelConfigEnabledDto extends createZodDto(
  modelConfigEnabledSchema,
) {}
```

Modify `apps/server-agent/src/controllers/model-config.controller.ts`：

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import {
  CreateModelConfigDto,
  SetModelConfigEnabledDto,
  UpdateModelConfigDto,
} from "../dto/model-config.dto";
import { ModelConfigService } from "../services/model-config.service";

/**
 * 模型配置接口：GET 返回本地 + 云端合并视图；写端点只作用于本地
 * source='local' 行（改/删云端条目由 service 拒为 MODEL_CONFIG_READONLY）。
 */
@Controller("api/model-configs")
export class ModelConfigController {
  constructor(private readonly service: ModelConfigService) {}

  @Get()
  findAll() {
    // 含停用行：前端选择器自行按 enabled 过滤，历史用量的模型名解析需要停用行
    return this.service.findAll();
  }

  @Post()
  create(@Body() dto: CreateModelConfigDto) {
    return this.service.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateModelConfigDto) {
    return this.service.update(id, dto);
  }

  @Patch(":id/enabled")
  setEnabled(@Param("id") id: string, @Body() dto: SetModelConfigEnabledDto) {
    return this.service.setEnabled(id, dto.enabled);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.service.delete(id);
  }
}
```

- [ ] **Step 8: typecheck + 围栏 + error-code 校验**

Run: `pnpm typecheck` → Expected: 通过。
Run: `pnpm check:error-code` → Expected: 通过（3018 在 3000-3999）。
Run: `pnpm check:repo && pnpm check:tx && pnpm check:naming` → Expected: 通过（controller 不注 Repo；写方法单表无 `@Transactional`；无违规命名）。

- [ ] **Step 9: 提交**

```bash
git add libs/types-agent/src/ai/providers.ts libs/types-agent/src/ai/index.ts \
        apps/server-agent/src/dto/model-config.dto.ts \
        apps/server-agent/src/controllers/model-config.controller.ts \
        apps/server-agent/src/services/model-config.service.ts \
        apps/server-agent/src/services/model-config.service.spec.ts \
        apps/server-agent/src/errors/agent.error-codes.ts \
        apps/server-agent/i18n/zh/model-config.json \
        apps/server-agent/i18n/en/model-config.json
git commit -m "feat(server-agent): 重启本地模型写入 REST（create/update/enabled/delete，只碰 source=local，云端只读拒改）"
```

---

### Task 5: web-agent 本地写 UI + gate（D + E）

**Files:**
- Modify: `apps/web-agent/src/rest/model-config.ts`（`ModelConfig.source` + 写函数 + mutation hooks）
- Create: `apps/web-agent/src/lib/model-config-form.ts`（纯逻辑：payload 构造 + source 徽标判定）
- Create: `apps/web-agent/src/lib/model-config-form.spec.ts`
- Create: `apps/web-agent/src/components/settings/model-config-form.tsx`（可复用表单）
- Create: `apps/web-agent/src/app/(shell)/more/models/page.tsx`（管理页）
- Modify: `apps/web-agent/src/components/shell/more-sidebar.tsx`（加「模型」入口）
- Modify: `apps/web-agent/src/components/model-setup-gate.tsx`（加本地建模入口 + 改文案）
- Modify: `apps/web-agent/messages/zh.json`、`apps/web-agent/messages/en.json`（i18n；实际扁平 stub 由 `sync:locales` 补）

**Interfaces:**
- Consumes：`apiClient`（`@meshbot/web-common`）、`ModelConfigInput` + `PROVIDERS` + `ProviderDef` + `modelConfigSchema`（`@meshbot/types-agent`）、`Form`/`FormItem`（`@meshbot/design/form`）、`useSchema`（`@meshbot/design/hooks`）、`useModelConfigs`（现有）。
- Produces：`createModelConfig`/`updateModelConfig`/`setModelConfigEnabled`/`deleteModelConfig` + 对应 mutation hooks；`buildModelConfigPayload`/`isLocalConfig` 纯函数；`ModelConfigForm` 组件；`/more/models` 页面。

- [ ] **Step 1: 纯逻辑失败测试**

Create `apps/web-agent/src/lib/model-config-form.spec.ts`：

```ts
import { buildModelConfigPayload, isLocalConfig } from "./model-config-form";

describe("model-config-form pure helpers", () => {
  it("buildModelConfigPayload 空 name 用 provider+model 兜底、空串归 undefined", () => {
    const payload = buildModelConfigPayload(
      { name: "", model: "gpt-4o", apiKey: "sk", baseUrl: "", contextWindow: "" },
      { type: "openai", name: "OpenAI" },
    );
    expect(payload).toEqual({
      providerType: "openai",
      name: "OpenAI - gpt-4o",
      model: "gpt-4o",
      apiKey: "sk",
      baseUrl: undefined,
      contextWindow: undefined,
    });
  });

  it("buildModelConfigPayload contextWindow 字符串转数字", () => {
    const payload = buildModelConfigPayload(
      { name: "X", model: "m", apiKey: "k", baseUrl: "http://h", contextWindow: "8000" },
      { type: "openai-compatible", name: "OpenAI 兼容" },
    );
    expect(payload.contextWindow).toBe(8000);
    expect(payload.baseUrl).toBe("http://h");
    expect(payload.name).toBe("X");
  });

  it("isLocalConfig 按 source 判定可编辑", () => {
    expect(isLocalConfig({ source: "local" } as never)).toBe(true);
    expect(isLocalConfig({ source: "cloud" } as never)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest apps/web-agent/src/lib/model-config-form.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现纯逻辑**

Create `apps/web-agent/src/lib/model-config-form.ts`：

```ts
import type { ModelConfigInput } from "@meshbot/types-agent";
import type { ModelConfig } from "@/rest/model-config";

/** 表单收集值（contextWindow 以字符串收，提交时转 number）。 */
export interface ModelConfigFormValues {
  name?: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  contextWindow?: string;
}

/** 供 payload 构造用的 provider 最小形状。 */
export interface ProviderLike {
  type: string;
  name: string;
}

/** 表单值 → 后端入参：空 name 用 `provider - model` 兜底，空串字段归 undefined。 */
export function buildModelConfigPayload(
  values: ModelConfigFormValues,
  provider: ProviderLike,
): ModelConfigInput {
  return {
    providerType: provider.type,
    name: values.name?.trim() || `${provider.name} - ${values.model}`,
    model: values.model,
    apiKey: values.apiKey,
    baseUrl: values.baseUrl?.trim() || undefined,
    contextWindow: values.contextWindow
      ? Number(values.contextWindow)
      : undefined,
  };
}

/** 是否为本地可编辑配置（云端条目只读）。 */
export function isLocalConfig(config: Pick<ModelConfig, "source">): boolean {
  return config.source === "local";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest apps/web-agent/src/lib/model-config-form.spec.ts`
Expected: PASS。

- [ ] **Step 5: rest 层加 source + 写函数 + hooks**

Modify `apps/web-agent/src/rest/model-config.ts`：
- `ModelConfig` interface 加 `source: "cloud" | "local";`
- 追加：

```ts
import type { ModelConfigInput } from "@meshbot/types-agent";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/** 更新本地模型配置的可选字段。 */
export interface ModelConfigUpdate {
  name?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  enabled?: boolean;
  contextWindow?: number;
}

export async function createModelConfig(
  input: ModelConfigInput,
): Promise<ModelConfig> {
  const { data } = await apiClient.post<ModelConfig>("/api/model-configs", input);
  return data;
}

export async function updateModelConfig(
  id: string,
  patch: ModelConfigUpdate,
): Promise<ModelConfig> {
  const { data } = await apiClient.patch<ModelConfig>(
    `/api/model-configs/${id}`,
    patch,
  );
  return data;
}

export async function setModelConfigEnabled(
  id: string,
  enabled: boolean,
): Promise<ModelConfig> {
  const { data } = await apiClient.patch<ModelConfig>(
    `/api/model-configs/${id}/enabled`,
    { enabled },
  );
  return data;
}

export async function deleteModelConfig(id: string): Promise<void> {
  await apiClient.delete(`/api/model-configs/${id}`);
}

/** 本地模型配置写操作后统一失效 ["model-configs"] 重拉合并列表。 */
export function useModelConfigMutations() {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["model-configs"] });
  return {
    create: useMutation({ mutationFn: createModelConfig, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: ModelConfigUpdate }) =>
        updateModelConfig(v.id, v.patch),
      onSuccess: invalidate,
    }),
    setEnabled: useMutation({
      mutationFn: (v: { id: string; enabled: boolean }) =>
        setModelConfigEnabled(v.id, v.enabled),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteModelConfig, onSuccess: invalidate }),
  };
}
```

- [ ] **Step 6: 建可复用 `ModelConfigForm` 组件**

Create `apps/web-agent/src/components/settings/model-config-form.tsx`（走 `Form`/`FormItem` + `useSchema(modelConfigSchema)`；provider 下拉 + 字段；提交用 `buildModelConfigPayload`）：

```tsx
"use client";

import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import { modelConfigSchema, PROVIDERS } from "@meshbot/types-agent";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type ZodType, z } from "zod";
import {
  buildModelConfigPayload,
  type ModelConfigFormValues,
} from "@/lib/model-config-form";
import type { ModelConfigInput } from "@meshbot/types-agent";

interface ModelConfigFormProps {
  /** 编辑态初值（不传=新建）。 */
  initial?: Partial<ModelConfigFormValues> & { providerType?: string };
  submitting: boolean;
  error: string | null;
  onSubmit: (payload: ModelConfigInput) => Promise<void>;
}

/** 本地模型配置表单（新建/编辑复用）。云端条目只读，不经此表单。 */
export function ModelConfigForm({
  initial,
  submitting,
  error,
  onSubmit,
}: ModelConfigFormProps) {
  const t = useTranslations("modelForm");
  const [providerType, setProviderType] = useState(
    initial?.providerType ?? PROVIDERS[0].type,
  );
  const provider =
    PROVIDERS.find((p) => p.type === providerType) ?? PROVIDERS[0];
  const schema = useSchema(modelConfigSchema) as unknown as ZodType<
    z.infer<typeof modelConfigSchema>
  >;

  const handle = async (values: ModelConfigFormValues) => {
    await onSubmit(buildModelConfigPayload(values, provider));
  };

  return (
    <div className="flex flex-col gap-4">
      <Select value={providerType} onValueChange={setProviderType}>
        <SelectTrigger>
          <SelectValue placeholder={t("selectProvider")} />
        </SelectTrigger>
        <SelectContent>
          {PROVIDERS.map((p) => (
            <SelectItem key={p.type} value={p.type}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Form
        key={providerType}
        schema={schema}
        defaultValues={{
          name: initial?.name ?? "",
          model: initial?.model ?? provider.models[0] ?? "",
          apiKey: initial?.apiKey ?? "",
          baseUrl: initial?.baseUrl ?? provider.default_base_url,
          contextWindow: initial?.contextWindow ?? "",
        }}
        onSubmit={handle}
        className="flex flex-col gap-4"
      >
        <FormItem name="name" label={t("name")}>
          <Input placeholder={t("namePlaceholder")} />
        </FormItem>
        <FormItem name="model" label={t("model")}>
          <Input placeholder={t("modelInputPlaceholder")} />
        </FormItem>
        <FormItem name="apiKey" label={t("apiKey")}>
          <Input type="password" placeholder={t("apiKeyPlaceholder")} />
        </FormItem>
        <FormItem name="baseUrl" label={t("baseUrl")}>
          <Input placeholder={t("baseUrlPlaceholder")} />
        </FormItem>
        <FormItem name="contextWindow" label={t("contextWindow")}>
          <Input placeholder={t("contextWindowPlaceholder")} />
        </FormItem>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={submitting}>
          {t("submit")}
        </Button>
      </Form>
    </div>
  );
}
```

> `modelConfigSchema` 的 `contextWindow` 是 `z.number()`，表单以字符串收——提交前 `buildModelConfigPayload` 转 number；`Form` 的 `schema` 主要驱动必填校验（provider/name/model/apiKey）。若 `useSchema`+`Form` 对 number 字段字符串输入报错，改在本组件内用 `modelConfigSchema.extend({ contextWindow: z.string().optional() })` 包一层再传（保持 buildModelConfigPayload 转换不变）。执行者据实际 `Form` 行为二选一。

- [ ] **Step 7: 建 `/more/models` 管理页**

Create `apps/web-agent/src/app/(shell)/more/models/page.tsx`：列出 `useModelConfigs()`，每行显示 name + source 徽标（`isLocalConfig` → 「本地」可编辑，`cloud` → 「云端」只读、无编辑/删除入口，仅展示 enabled 态）；「新建本地模型」按钮打开 `ModelConfigForm`（Dialog/Sheet）；本地行提供编辑/删除/启用切换（调 `useModelConfigMutations`）。页头/侧栏容器范式对齐 `MorePage`（`ToolPage` + `MoreSidebar`）。用户可见串全部 `useTranslations("modelSettings")`。

- [ ] **Step 8: MoreSidebar 加「模型」入口**

Modify `apps/web-agent/src/components/shell/more-sidebar.tsx`：
- import 一个图标（如 `Bot` from `lucide-react`）
- `activeKey` 加 `pathname.startsWith("/more/models") ? "models" : ...`
- `groups[0].items` 加：`{ key: "models", label: t("models"), icon: <Bot />, onClick: () => router.push("/more/models") }`

- [ ] **Step 9: ModelSetupGate 加本地建模入口 + 改文案**

Modify `apps/web-agent/src/components/model-setup-gate.tsx`：
- 卡片按钮区加第三个按钮「配置本地模型」，点击打开内嵌 `ModelConfigForm`（Dialog）；创建成功后 `invalidateQueries(["model-configs"])`，AuthGuard 检测到有 enabled 即自动切回正常内容。
- 文案改：`t("description")` 不再暗示「必须云端 org」，改述「可在云端组织配置，或直接新建本地模型」（i18n 值在 Step 10 改）。

- [ ] **Step 10: i18n 键**

Modify `apps/web-agent/messages/zh.json`（英同源在 en.json）新增/改：
- 新 namespace `modelSettings`（页面）：`title` / `newLocalModel` / `badgeLocal`（本地）/ `badgeCloud`（云端）/ `edit` / `delete` / `enable` / `disable` / `cloudReadonlyHint` / `empty`
- 复原 `modelForm` 组 key：`name` / `namePlaceholder` / `model` / `modelInputPlaceholder` / `apiKey` / `apiKeyPlaceholder` / `baseUrl` / `baseUrlPlaceholder` / `contextWindow` / `contextWindowPlaceholder` / `selectProvider` / `submit`
- `settingsSidebar.models`（侧栏项）= 「模型」/「Models」
- 改 `modelSetupGate.description` 文案；加 `modelSetupGate.configureLocal`（配置本地模型）

Run: `pnpm sync:locales --write` → 补齐扁平 stub（新增嵌套 t() 的扁平空值属正常）。

- [ ] **Step 11: 跑纯逻辑测试 + typecheck + lint**

Run: `npx jest apps/web-agent/src/lib/model-config-form.spec.ts` → Expected: PASS。
Run: `pnpm typecheck` → Expected: 通过。
Run: `pnpm lint` → Expected: 通过（`check:dead` 不扫 web-*，无需担心导出）。

- [ ] **Step 12: 提交**

```bash
git add apps/web-agent/src/rest/model-config.ts \
        apps/web-agent/src/lib/model-config-form.ts \
        apps/web-agent/src/lib/model-config-form.spec.ts \
        apps/web-agent/src/components/settings/model-config-form.tsx \
        "apps/web-agent/src/app/(shell)/more/models/page.tsx" \
        apps/web-agent/src/components/shell/more-sidebar.tsx \
        apps/web-agent/src/components/model-setup-gate.tsx \
        apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): 本地模型配置管理页 + ModelSetupGate 本地建模逃生口（source 徽标区分本地/云端只读）"
```

---

### Task 6: 终验（DI 真启动 + 迁移跑通 + 全量围栏 + 零残留）

**Files:** 无（验证任务）。

- [ ] **Step 1: 全仓 typecheck**

Run: `pnpm typecheck`
Expected: 全绿。

- [ ] **Step 2: 相关单测**

Run: `npx jest apps/server-agent/src/services/cloud-model-config-proxy.service.spec.ts apps/server-agent/src/services/model-config.service.spec.ts apps/server-agent/src/migrations/__tests__/1781400000000-DropCloudModelConfigRows.spec.ts apps/web-agent/src/lib/model-config-form.spec.ts`
Expected: 全绿。

- [ ] **Step 3: 全量围栏**

Run: `pnpm check`
Expected: 6 项围栏（tx / naming / lock-tx / repo / dead / error-code）全绿。重点确认 `check:repo`（ModelConfig 仍唯一归属 ModelConfigService、controller 不注 Repo）、`check:naming`（无遗留 `persist*`/`*InTx` 违规）、`check:error-code`（3018 合法）。

- [ ] **Step 4: 真启动 + 迁移跑通（临时 MESHBOT_HOME）**

```bash
MESHBOT_HOME="$(mktemp -d)" pnpm dev:server-agent
```
观察启动日志：`migrationsRun` 跑到 `DropCloudModelConfigRows1781400000000` 无报错；无 DI 报错（`CloudModelConfigProxyService` 正确注入 `ModelConfigService`，`ModelConfigSyncService` 已移除无悬挂 provider）。确认端口起来后 Ctrl-C；**不碰 `~/.meshbot` / 仓库根**。
Expected：启动成功、迁移日志出现、无 `Nest can't resolve dependencies` / `EntityMetadataNotFound`。

- [ ] **Step 5: 零残留 grep**

Run: `grep -rn "ModelConfigSyncService\|replaceCloudConfigs\|persistCloudConfigs\|CloudModelConfigRow" apps/server-agent apps/web-agent libs`
Expected: 无输出。

- [ ] **Step 6: build**

Run: `pnpm build`
Expected: Turbo 拓扑构建全绿（server-agent + web-agent + types-agent）。

- [ ] **Step 7: 收尾提交（如有 sync:locales 产物或格式化残留）**

```bash
git add -A
git commit -m "chore(model-config): 读时合并终验（迁移跑通 + 围栏 + i18n stub 同步）"
```
（若无改动可跳过。）

---

## 自审（Self-Review）

**1. Spec 覆盖：**
- **A（云端代理 + 短 TTL 缓存）** → T1（getCloudConfigs + 45s TTL + modelConfigChanged 失效 + 不可达返空）。✅
- **B（6 读方法合并）** → T2（findAll/findAllEnabled/findEnabled/findByIdOrName/findOneOrFail/hasEnabledModels 全改 + runner 透明确认）。✅
- **C（退役同步 + 清存量）** → T3（删 sync 服务/5 触发器/module 注册、删 replaceCloudConfigs/persistCloudConfigs、迁移 DELETE source='cloud'）。✅
- **D（重启本地写）** → 后端 T4（controller POST/PATCH/PATCH enabled/DELETE + service create/update/setEnabled/delete + DTO + 只碰 local + 拒云端）、前端 T5（管理页 + 表单 + rest 写函数）。✅
- **E（Gate）** → T5 Step 9（ModelSetupGate 加本地建模入口 + 改文案），合并视图使 gate 自动读本地或云端 enabled（B 已覆盖 hasEnabledModels）。✅
- **错误处理**：云端不可达 → T1 返空/T2 findByIdOrName 返 null（不静默：runner 现有 null→报错路径）；改/删云端条目拒 → T4 MODEL_CONFIG_READONLY（3018）；gate 合并空可本地逃生 → T5。✅
- **测试节**：proxy 缓存/失效/不可达 → T1；合并四类 → T2；本地写 + 拒云端 → T4；迁移幂等 → T3；gate 放行由 hasEnabledModels 合并 → T2；前端纯逻辑 → T5。✅

**2. 占位符扫描：** 无 TBD/TODO/「类似 TaskN」；每代码步骤给完整代码块，每命令给期望输出。T5 Step 6/7 的表单与页面 UI 描述较高层，但给了完整可运行的表单组件代码 + 明确字段/数据源/i18n namespace + 复用的纯函数——非占位（页面装配是确定性组合，已锚定 `MorePage`/`agent-editor-sheet` 现成范式）。✅

**3. 类型一致：** `getCloudConfigs(): Promise<ModelConfig[]>`（T1 产出 = T2/T4 消费，一字不差）；读方法签名 T2 保持不变；写方法名 `create/update/setEnabled/delete`（T4 service = controller = T5 rest 一致）；`MODEL_CONFIG_READONLY`/code `3018`（T4 定义 = T4 spec 断言一致）；合并规则「按 id 本地优先」（Global Constraints = T2 `mergeById` 实现一致）；表名 `model_configs`（T3 迁移 = entity 一致，已纠 spec 笔误）。✅

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-model-config-read-through-merge.md`. Two execution options:

1. Subagent-Driven（推荐）—— 每任务派新 subagent，任务间 review，快速迭代。
2. Inline Execution —— 本会话内按 executing-plans 批量执行 + 检查点。

选哪种？
