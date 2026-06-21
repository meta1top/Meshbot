# SP3-3a：libs/assets(@meshbot/assets) 对象存储抽象（minio）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `@meshbot/assets` 库，提供可注入的 `AssetService`（put/get/getStream/delete/exists/getSignedUrl）+ minio 实现 + `AssetsModule.forRoot(config)`，供后续 SP3-3b 的 server-main 技能市场托管技能包 tar.gz。

**Architecture:** `AssetService` 为抽象类（兼 DI token），`MinioAssetService extends AssetService` 用 minio npm client 实现；`AssetsModule.forRoot(config)` 工厂绑定 AssetService→MinioAssetService、`onModuleInit` 确保 bucket 存在。provider 可换（s3/oss 以后加新子类），消费方只认 `AssetService`。配置由调用方（server-main）从 env 读好后经 forRoot 传入，库自身不读 env。

**Tech Stack:** NestJS 11、minio ^8、TypeScript、root Jest（`testEnvironment: node`，`*.spec.ts`）。minio v8 自带 TS 类型，无需 @types/minio。

## Global Constraints
- 仅新建 `libs/assets`，不改其他包（server-main 接线属 3b）。
- 依赖方向：`server-main → libs/assets → libs/common`（基础设施库，可依赖 NestJS，性质同 libs/common）。
- 库不读 env：配置经 `AssetsModule.forRoot(config)` 传入，便于测试与多 provider。
- provider 抽象：本期仅实现 `MinioAssetService`；s3/oss 仅在类型/注释预留，不实现。
- 对象键（key）由调用方给定（如 `skills/<slug>/<version>.tar.gz`），库不拼 key。
- minio v8 client API：`new Client({endPoint,port,useSSL,accessKey,secretKey})`、`bucketExists(b)`、`makeBucket(b)`、`putObject(b,key,buf,size,metaData)`、`getObject(b,key)→Readable`、`removeObject(b,key)`、`statObject(b,key)`、`presignedGetObject(b,key,expirySec)`。
- 单测 mock minio Client（不连真实 minio）。
- 中文 JSDoc（公开方法）；提交中文 conventional，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 每 Task 后 `pnpm --filter @meshbot/assets typecheck` + `pnpm test -- --roots libs/assets` 必过；`pnpm exec biome check --write <改动文件>`。

## File Structure
- `libs/assets/package.json` — 包定义（name `@meshbot/assets`，dep minio，peer @nestjs/common）。
- `libs/assets/tsconfig.json` — 仿 libs/common。
- `libs/assets/src/index.ts` — 导出 AssetService / AssetsModule / 类型。
- `libs/assets/src/asset.types.ts` — `MinioConfig` / `AssetsConfig` / `AssetStat`。
- `libs/assets/src/asset.service.ts` — 抽象类 `AssetService`（接口 + DI token）。
- `libs/assets/src/providers/minio-asset.service.ts` — `MinioAssetService extends AssetService`（minio 实现 + `ensureBucket`）。
- `libs/assets/src/providers/minio-asset.service.spec.ts` — 单测（mock minio）。
- `libs/assets/src/assets.module.ts` — `AssetsModule.forRoot(config)` 动态模块。
- `libs/assets/src/assets.module.spec.ts` — 模块解析 + onModuleInit ensureBucket 单测。
- 修改 `jest.config.ts` — 加 `@meshbot/assets` moduleNameMapper。

---

### Task 1: 包脚手架 + 类型 + 抽象 AssetService + minio 实现

**Files:**
- Create: `libs/assets/package.json`, `libs/assets/tsconfig.json`, `libs/assets/src/index.ts`,
  `libs/assets/src/asset.types.ts`, `libs/assets/src/asset.service.ts`,
  `libs/assets/src/providers/minio-asset.service.ts`,
  `libs/assets/src/providers/minio-asset.service.spec.ts`
- Modify: `jest.config.ts`（moduleNameMapper 加 @meshbot/assets）

**Interfaces:**
- Produces:
  ```ts
  export interface MinioConfig {
    endPoint: string; port: number; useSSL: boolean;
    accessKey: string; secretKey: string; bucket: string;
  }
  export interface AssetsConfig { provider: "minio"; minio: MinioConfig; }
  export interface AssetStat { size: number; contentType?: string; }
  export abstract class AssetService {
    abstract put(key: string, body: Buffer, contentType: string): Promise<void>;
    abstract get(key: string): Promise<Buffer>;
    abstract getStream(key: string): Promise<NodeJS.ReadableStream>;
    abstract delete(key: string): Promise<void>;
    abstract exists(key: string): Promise<boolean>;
    abstract getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
    abstract ensureBucket(): Promise<void>;
  }
  export class MinioAssetService extends AssetService { constructor(cfg: MinioConfig) }
  ```

- [ ] **Step 1: 安装 minio 到新包**

Run:
```bash
cd /Users/grant/Meta1/meshbot
mkdir -p libs/assets/src/providers
```
先写 `libs/assets/package.json`：
```json
{
  "name": "@meshbot/assets",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "clean": "rm -rf dist",
    "typecheck": "tsc --project tsconfig.json --noEmit",
    "test": "jest --config ../../jest.config.ts --roots libs/assets"
  },
  "dependencies": {
    "minio": "^8"
  },
  "peerDependencies": {
    "@nestjs/common": "^11",
    "reflect-metadata": "*"
  }
}
```
然后安装（pnpm 装到该包并写 lockfile）：
```bash
pnpm --filter @meshbot/assets install
```
Expected: 安装成功，`node_modules/minio` 存在。

- [ ] **Step 2: tsconfig + 类型 + 抽象类 + index**

`libs/assets/tsconfig.json`：
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": false,
    "declaration": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src/**/*"]
}
```
`libs/assets/src/asset.types.ts`：
```ts
/** minio 连接配置（由调用方从 env 读好后传入 AssetsModule.forRoot）。 */
export interface MinioConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

/** 资产存储配置。本期仅 minio；s3/oss 以后扩 provider 联合类型。 */
export interface AssetsConfig {
  provider: "minio";
  minio: MinioConfig;
}

/** 对象元信息。 */
export interface AssetStat {
  size: number;
  contentType?: string;
}
```
`libs/assets/src/asset.service.ts`：
```ts
import type { AssetStat } from "./asset.types";

/**
 * 对象存储服务（抽象类兼 NestJS DI token）。消费方注入 `AssetService`，
 * 具体实现由 AssetsModule.forRoot 按配置绑定（本期 MinioAssetService）。
 * key 由调用方给定（如 `skills/<slug>/<version>.tar.gz`），本服务不拼 key。
 */
export abstract class AssetService {
  /** 写入对象（覆盖同 key）。 */
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** 读对象为完整 Buffer。 */
  abstract get(key: string): Promise<Buffer>;
  /** 读对象为可读流（大文件/转发用）。 */
  abstract getStream(key: string): Promise<NodeJS.ReadableStream>;
  /** 删除对象（不存在不报错）。 */
  abstract delete(key: string): Promise<void>;
  /** 对象是否存在。 */
  abstract exists(key: string): Promise<boolean>;
  /** 取临时下载签名 URL。 */
  abstract getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  /** 确保 bucket 存在（模块初始化时调）。 */
  abstract ensureBucket(): Promise<void>;
}
```
`libs/assets/src/index.ts`：
```ts
export type { AssetStat, AssetsConfig, MinioConfig } from "./asset.types";
export { AssetService } from "./asset.service";
export { MinioAssetService } from "./providers/minio-asset.service";
export { AssetsModule } from "./assets.module";
```
（`assets.module` 在 Task 2 创建；本 index 先引会让 typecheck 报缺失——故本步先**不**导出 AssetsModule，Task 2 再补该行。）改为本步 index 仅：
```ts
export type { AssetStat, AssetsConfig, MinioConfig } from "./asset.types";
export { AssetService } from "./asset.service";
export { MinioAssetService } from "./providers/minio-asset.service";
```

- [ ] **Step 3: 写失败单测（MinioAssetService，mock minio）**

`libs/assets/src/providers/minio-asset.service.spec.ts`：
```ts
import { Readable } from "node:stream";

const mockClient = {
  bucketExists: jest.fn(),
  makeBucket: jest.fn(),
  putObject: jest.fn(),
  getObject: jest.fn(),
  removeObject: jest.fn(),
  statObject: jest.fn(),
  presignedGetObject: jest.fn(),
};
jest.mock("minio", () => ({
  Client: jest.fn(() => mockClient),
}));

import { MinioAssetService } from "./minio-asset.service";

const CFG = {
  endPoint: "localhost",
  port: 9000,
  useSSL: false,
  accessKey: "ak",
  secretKey: "sk",
  bucket: "meshbot",
};

describe("MinioAssetService", () => {
  let svc: MinioAssetService;
  beforeEach(() => {
    for (const fn of Object.values(mockClient)) fn.mockReset();
    svc = new MinioAssetService(CFG);
  });

  it("put 调 putObject(bucket,key,buf,size,Content-Type)", async () => {
    mockClient.putObject.mockResolvedValue({ etag: "x" });
    const buf = Buffer.from("hello");
    await svc.put("skills/a/1.0.0.tar.gz", buf, "application/gzip");
    expect(mockClient.putObject).toHaveBeenCalledWith(
      "meshbot",
      "skills/a/1.0.0.tar.gz",
      buf,
      buf.length,
      { "Content-Type": "application/gzip" },
    );
  });

  it("get 把 getObject 流聚合为 Buffer", async () => {
    mockClient.getObject.mockResolvedValue(Readable.from([Buffer.from("ab"), Buffer.from("c")]));
    const out = await svc.get("k");
    expect(out.toString()).toBe("abc");
    expect(mockClient.getObject).toHaveBeenCalledWith("meshbot", "k");
  });

  it("getStream 直接返回 getObject 流", async () => {
    const stream = Readable.from([Buffer.from("x")]);
    mockClient.getObject.mockResolvedValue(stream);
    expect(await svc.getStream("k")).toBe(stream);
  });

  it("delete 调 removeObject", async () => {
    mockClient.removeObject.mockResolvedValue(undefined);
    await svc.delete("k");
    expect(mockClient.removeObject).toHaveBeenCalledWith("meshbot", "k");
  });

  it("exists：statObject 成功→true", async () => {
    mockClient.statObject.mockResolvedValue({ size: 3 });
    expect(await svc.exists("k")).toBe(true);
  });

  it("exists：statObject 抛错→false", async () => {
    mockClient.statObject.mockRejectedValue(new Error("NotFound"));
    expect(await svc.exists("k")).toBe(false);
  });

  it("getSignedUrl 调 presignedGetObject(bucket,key,ttl)", async () => {
    mockClient.presignedGetObject.mockResolvedValue("http://signed");
    expect(await svc.getSignedUrl("k", 600)).toBe("http://signed");
    expect(mockClient.presignedGetObject).toHaveBeenCalledWith("meshbot", "k", 600);
  });

  it("ensureBucket：不存在则 makeBucket", async () => {
    mockClient.bucketExists.mockResolvedValue(false);
    mockClient.makeBucket.mockResolvedValue(undefined);
    await svc.ensureBucket();
    expect(mockClient.makeBucket).toHaveBeenCalledWith("meshbot");
  });

  it("ensureBucket：已存在则不 makeBucket", async () => {
    mockClient.bucketExists.mockResolvedValue(true);
    await svc.ensureBucket();
    expect(mockClient.makeBucket).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `cd /Users/grant/Meta1/meshbot && pnpm test -- --roots libs/assets`
Expected: FAIL（`minio-asset.service` 尚未创建，Cannot find module）。

- [ ] **Step 5: 注册 jest moduleNameMapper**

Modify `jest.config.ts`，在 `moduleNameMapper` 里（紧挨 `@meshbot/common` 两行后）加：
```ts
    "^@meshbot/assets$": "<rootDir>/libs/assets/src",
    "^@meshbot/assets/(.*)$": "<rootDir>/libs/assets/src/$1",
```

- [ ] **Step 6: 实现 MinioAssetService**

`libs/assets/src/providers/minio-asset.service.ts`：
```ts
import { Client } from "minio";
import { AssetService } from "../asset.service";
import type { MinioConfig } from "../asset.types";

/**
 * minio 实现。key 由调用方给定，全部操作落在 cfg.bucket。
 * 单测通过 jest.mock("minio") 注入假 Client，不连真实服务。
 */
export class MinioAssetService extends AssetService {
  private readonly client: Client;
  private readonly bucket: string;

  constructor(cfg: MinioConfig) {
    super();
    this.bucket = cfg.bucket;
    this.client = new Client({
      endPoint: cfg.endPoint,
      port: cfg.port,
      useSSL: cfg.useSSL,
      accessKey: cfg.accessKey,
      secretKey: cfg.secretKey,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.putObject(this.bucket, key, body, body.length, {
      "Content-Type": contentType,
    });
  }

  async get(key: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    return this.client.getObject(this.bucket, key);
  }

  async delete(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, key);
      return true;
    } catch {
      return false;
    }
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    return this.client.presignedGetObject(this.bucket, key, ttlSeconds);
  }

  async ensureBucket(): Promise<void> {
    const ok = await this.client.bucketExists(this.bucket);
    if (!ok) {
      await this.client.makeBucket(this.bucket);
    }
  }
}
```

- [ ] **Step 7: 运行确认通过 + typecheck + biome**

Run:
```bash
cd /Users/grant/Meta1/meshbot
pnpm test -- --roots libs/assets
pnpm --filter @meshbot/assets typecheck
pnpm exec biome check --write libs/assets/src jest.config.ts
```
Expected: 单测全绿（9 例）；typecheck Done；biome 干净。

- [ ] **Step 8: 提交**

```bash
git add libs/assets jest.config.ts pnpm-lock.yaml
git commit -m "feat(assets): 新建 @meshbot/assets + minio 实现(put/get/delete/exists/signedUrl/ensureBucket)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: AssetsModule.forRoot 动态模块 + onModuleInit 确保 bucket

**Files:**
- Create: `libs/assets/src/assets.module.ts`, `libs/assets/src/assets.module.spec.ts`
- Modify: `libs/assets/src/index.ts`（补导出 AssetsModule）

**Interfaces:**
- Consumes: `AssetService`、`MinioAssetService`、`AssetsConfig`（Task 1）。
- Produces:
  ```ts
  // AssetsModule.forRoot(config: AssetsConfig): DynamicModule
  // 提供并导出 AssetService（绑定 MinioAssetService）；模块初始化时 ensureBucket()。
  ```

- [ ] **Step 1: 写失败单测（模块解析 + ensureBucket）**

`libs/assets/src/assets.module.spec.ts`：
```ts
const mockClient = {
  bucketExists: jest.fn().mockResolvedValue(true),
  makeBucket: jest.fn(),
  putObject: jest.fn(),
  getObject: jest.fn(),
  removeObject: jest.fn(),
  statObject: jest.fn(),
  presignedGetObject: jest.fn(),
};
jest.mock("minio", () => ({ Client: jest.fn(() => mockClient) }));

import { Test } from "@nestjs/testing";
import { AssetService } from "./asset.service";
import { AssetsModule } from "./assets.module";

const CFG = {
  provider: "minio" as const,
  minio: {
    endPoint: "localhost",
    port: 9000,
    useSSL: false,
    accessKey: "ak",
    secretKey: "sk",
    bucket: "meshbot",
  },
};

describe("AssetsModule.forRoot", () => {
  beforeEach(() => {
    for (const fn of Object.values(mockClient)) fn.mockReset();
    mockClient.bucketExists.mockResolvedValue(true);
  });

  it("解析出 AssetService 实例且可用", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AssetsModule.forRoot(CFG)],
    }).compile();
    const svc = moduleRef.get(AssetService);
    expect(svc).toBeInstanceOf(AssetService);
    mockClient.statObject.mockResolvedValue({ size: 1 });
    expect(await svc.exists("k")).toBe(true);
  });

  it("init() 时调 ensureBucket（bucket 不存在则建）", async () => {
    mockClient.bucketExists.mockResolvedValue(false);
    const moduleRef = await Test.createTestingModule({
      imports: [AssetsModule.forRoot(CFG)],
    }).compile();
    await moduleRef.init();
    expect(mockClient.makeBucket).toHaveBeenCalledWith("meshbot");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- --roots libs/assets`
Expected: FAIL（`assets.module` 不存在）。

- [ ] **Step 3: 实现 AssetsModule**

`libs/assets/src/assets.module.ts`：
```ts
import {
  type DynamicModule,
  Module,
  type OnModuleInit,
} from "@nestjs/common";
import { AssetService } from "./asset.service";
import type { AssetsConfig } from "./asset.types";
import { MinioAssetService } from "./providers/minio-asset.service";

/**
 * 对象存储模块。`forRoot(config)` 按 provider 绑定 AssetService（本期仅 minio），
 * 模块初始化时确保 bucket 存在。消费方 import 后注入 `AssetService`。
 */
@Module({})
export class AssetsModule implements OnModuleInit {
  constructor(private readonly asset: AssetService) {}

  static forRoot(config: AssetsConfig): DynamicModule {
    return {
      module: AssetsModule,
      providers: [
        {
          provide: AssetService,
          useFactory: () => new MinioAssetService(config.minio),
        },
      ],
      exports: [AssetService],
    };
  }

  async onModuleInit(): Promise<void> {
    await this.asset.ensureBucket();
  }
}
```
补 `libs/assets/src/index.ts` 末尾：
```ts
export { AssetsModule } from "./assets.module";
```

- [ ] **Step 4: 运行确认通过 + typecheck + biome**

Run:
```bash
pnpm test -- --roots libs/assets
pnpm --filter @meshbot/assets typecheck
pnpm exec biome check --write libs/assets/src
```
Expected: 全绿（含 Task 1 的 9 例 + 本 2 例）。

- [ ] **Step 5: 提交**

```bash
git add libs/assets
git commit -m "feat(assets): AssetsModule.forRoot 动态模块 + onModuleInit 确保 bucket

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review
- **Spec 覆盖**：3a 要求 = AssetService 接口(put/get/getStream/delete/exists/getSignedUrl) + MinioAssetProvider(minio client、ensure bucket) + AssetsModule.forRoot + s3/oss 留接口不实现 + 单测 → Task 1(类型+抽象+minio 实现+9 测) + Task 2(forRoot+ensureBucket+2 测) 全覆盖；s3/oss 在 `AssetsConfig.provider` 联合类型预留（注释说明），未实现 ✓。
- **占位符**：无 TBD；所有步骤含完整代码与命令。注意 Task1 Step2 已澄清 index.ts 本步不导出 AssetsModule（Task2 Step3 再补），避免中途 typecheck 报错。
- **类型一致**：AssetService 抽象方法签名（Task1 接口块）与 MinioAssetService 实现（Task1 Step6）、AssetsModule 工厂（Task2 Step3）一致；config 形态 `AssetsConfig{provider:"minio",minio:MinioConfig}` 三处一致。
- **依赖**：minio ^8 自带类型；peer @nestjs/common ^11 与仓库一致；jest mapper 已加。
