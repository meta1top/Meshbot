# 设备唯一性(machineId 去重)设计 spec

**日期**:2026-07-06
**范围**:子项目 A —— 让「同一台机器 + 同一账号」在云端只对应一台设备(Device 行),消除「删数据目录 / 重装 / 换端口重授权」产生的重复设备行。

---

## 1. 目标与动机

当前设备授权 exchange 时,`DeviceService.issueDevice`([device.service.ts:25-42](../../../libs/main/src/services/device.service.ts#L25-L42))**每次无条件 `deviceRepo.save(new Device)`**,没有任何机器级去重。后果:

- 浏览器 + 客户端同机同账号 → 两行 Device。
- 打包版 port 检测换端口重启 → 设备身份不该变,但重授权会再生一行。
- 删除数据目录(`~/.meshbot` 或 `repo/.meshbot`)后重新授权 → 本机丢了 device_token,重授权 → 又一行。

目标:**引入稳定的本机指纹 `machineId`,让 `(user_id, machine_id)` 唯一标识一台设备**;同机重授权复用同一 Device 行并轮换 token,而不是新增行。

### 开发/打包双环境共存

生产模式一台机器只装一个客户端(数据目录 `~/.meshbot`)。但开发时同机会同时跑 dev(`repo/.meshbot`)与打包版(`~/.meshbot`,经 `pnpm run:local`)。这两个是**不同的运行环境**,应表现为**两台设备**以便测试跨设备特性(L2)。

方案:machineId 采集时,**打包版用原始 machineId,dev 用 `dev-` 前缀**(由 `isPackaged()` 判定)。于是同一台物理机恰好产生两个稳定身份——一个 dev、一个打包版,互不干扰;各自重启/重授权都不会再增行。

---

## 2. 架构与数据流

```
[server-agent 本机]                         [server-main 云端]
resolveMachineId()                          POST /api/device-auth/exchange
  = isPackaged() ? raw : "dev-"+raw    ──►    DeviceAuthExchangeDto { …, machineId? }
  (node-machine-id, 采集失败→null)              │
                                              ├─ deviceAuth.exchange(dto) → { userId, deviceName, platform }
DeviceAuthorizeService.complete()             │   (machineId 不经 auth-request,直接取自请求体 dto.machineId)
  请求体加 machineId  ──────────────────────► └─ devices.issueDevice({ userId, orgId, name, platform, machineId })
                                                     │
                                                     ├─ machineId 命中 (user_id, machine_id) 活跃行?
                                                     │    命中 → 复用该行 + 轮换 token(更新 token_hash/name/platform/org/last_seen)
                                                     │    未命中(或 machineId 为空)→ 新建行(写 machine_id)
                                                     └─ 返回 { device, token(新明文) }
◄── deviceToken(新)── 存入 cloud_identity.device_token
```

**关键点**:`machineId` 来自 exchange **请求体**(客户端采集),不经 `device_auth_request`;userId 仍由服务端从 `device_auth_request.userId`(approve 时写入)取得。二者在 controller 的 exchange 方法里汇合后一起传给 `issueDevice`。

---

## 3. 组件与文件清单

### 3.1 新增:machineId 采集(server-agent)

- **依赖**:`apps/server-agent/package.json` 加 `node-machine-id`(纯 JS,读 OS 机器标识:mac=IOPlatformUUID / win=注册表 MachineGuid / linux=/etc/machine-id;**无原生编译**,不影响 desktop 打包与 `rebuild:native`)。
- **新文件** `apps/server-agent/src/utils/machine-id.ts`:
  ```ts
  import { machineIdSync } from "node-machine-id";
  import { isPackaged } from "./meshbot-dir";

  /**
   * 采集本机稳定唯一标识,用于云端设备去重。
   * dev(未打包)加 `dev-` 前缀,使同机 dev 与打包版为两个独立设备。
   * 采集失败返回 null(降级:不参与去重,退回「每次新建」旧行为)。
   */
  export function resolveMachineId(): string | null {
    try {
      const raw = machineIdSync(); // sha256 后的机器标识(64 hex)
      return isPackaged() ? raw : `dev-${raw}`;
    } catch {
      return null;
    }
  }
  ```
  - `isPackaged()` 复用 [meshbot-dir.ts:20-22](../../../apps/server-agent/src/utils/meshbot-dir.ts#L20-L22)。
  - `dev-` 前缀是**确定性**的(不含随机),所以 dev 是一个稳定身份、不会每次启动变新设备。

### 3.2 修改:exchange 请求带 machineId(server-agent)

- [device-authorize.service.ts:84-89](../../../apps/server-agent/src/services/device-authorize.service.ts#L84-L89) 的 exchange 请求体加 `machineId: resolveMachineId()`:
  ```ts
  const ex = await this.cloud.post<DeviceAuthExchangeResult>(
    "/api/device-auth/exchange",
    { requestId, userCode, codeVerifier: p.verifier, machineId: resolveMachineId() },
  );
  ```
  `start()` 处无需改动(machineId 仅在 exchange 用到)。

### 3.3 修改:exchange schema 加 machineId(libs/types)

- [device-auth.schema.ts:31-35](../../../libs/types/src/device-auth/device-auth.schema.ts#L31-L35) 的 `DeviceAuthExchangeSchema` 加**可选**字段:
  ```ts
  machineId: z.string().max(80).nullish(),
  ```
  可选/可空的理由:客户端采集可能失败(返回 null);老客户端不带该字段。服务端把「缺失/空」视为「不去重」。
- `DeviceAuthExchangeDto`([libs/main/src/dto/index.ts:153-156](../../../libs/main/src/dto/index.ts#L153-L156))是 `interface … extends DeviceAuthExchangeInput {}` 的声明合并,**自动获得 machineId**,无需单独改。

### 3.4 修改:issueDevice 去重(libs/main,server-main 域)

- [device.service.ts:25-42](../../../libs/main/src/services/device.service.ts#L25-L42) `issueDevice`:
  - input 加 `machineId?: string | null`。
  - 逻辑:先算 token/tokenHash;**若 machineId 非空**,按 `{ userId, machineId, revokedAt: IsNull() }` 查活跃 Device:
    - 命中 → 复用该行:更新 `tokenHash / name / platform / orgId / lastSeenAt`,`save`,返回 `{ device, token }`(**token 轮换**,见 §4)。
    - 未命中 → 新建行(`create({ ...input })`,input 含 machineId → 写入 `machine_id`)。
  - **并发**:方法上加 `@WithLock({ key: "device:issue:#{0.userId}:#{0.machineId}" })` 串行化同机并发 exchange(防两个不同 requestId 的并发授权各插一行)。issueDevice 是单表写,无需 `@Transactional`(符合项目约定:锁在外、单表不开事务)。
  - 依赖 `import { IsNull } from "typeorm"`。
- Device 仍由 `DeviceService` 独家持有 `@InjectRepository(Device)`,`check:repo` 合规。

### 3.5 修改:controller 透传 machineId(server-main)

- [device-auth.controller.ts:81-99](../../../apps/server-main/src/rest/device-auth.controller.ts#L81-L99) exchange:`issueDevice` 调用加 `machineId: dto.machineId`:
  ```ts
  const { token } = await this.devices.issueDevice({
    userId, orgId: user.activeOrgId, name: deviceName, platform,
    machineId: dto.machineId ?? null,
  });
  ```
  `DeviceAuthService.exchange` 无需改动(machineId 走请求体,不经 auth-request)。

### 3.6 新增:DDL(server-main,Postgres,DBA 手动执行)

- **新文件** `apps/server-main/migrations/202607062100-device-machine-id.sql`(时间戳晚于现有最新 `202607062000`):
  ```sql
  -- DBA 手动执行;幂等;snake_case;逻辑外键。
  -- Device 加 machine_id(本机指纹,同机同账号去重键)+ 部分唯一索引。
  ALTER TABLE "device" ADD COLUMN IF NOT EXISTS "machine_id" varchar(80);

  CREATE UNIQUE INDEX IF NOT EXISTS "uq_device_user_machine"
    ON "device" ("user_id", "machine_id")
    WHERE "revoked_at" IS NULL AND "machine_id" IS NOT NULL;
  ```
- **实体同步** [device.entity.ts](../../../libs/main/src/entities/device.entity.ts):加
  ```ts
  @Index("uq_device_user_machine", ["userId", "machineId"], {
    unique: true,
    where: '"revoked_at" IS NULL AND "machine_id" IS NOT NULL',
  })
  // …
  @Column({ name: "machine_id", type: "varchar", length: 80, nullable: true })
  machineId!: string | null;
  ```
  (类级 `@Index` 与列都要加;`machine_id` nullable,老行保持 null。)

> **e2e schema 落地机制**:server-main e2e 用 `apps/server-main/test/setup/test-db.ts` 建库。写 plan 前需确认它是「应用 DDL 文件」还是「按实体 synchronize」——`agent-dm-ddl.spec` 在删列 DDL 后失败,说明 e2e **应用 DDL 文件**。若如此,新 DDL 会被 e2e 自动应用;实体同时改。plan 里第一步先读 test-db.ts 定论。

---

## 4. 已定设计决策

**① 碰撞时轮换 token(而非保留旧 token)。**
被 exchange 语义决定:同机重授权典型场景是「删数据目录后重授权」,此时本机丢了明文 token,而服务端只存 `token_hash`、拿不回旧明文,exchange 必须发一个新的可用 token 回去。故复用行时**覆盖 `token_hash`**(旧 token 立即失效),把新明文返回客户端存入 `cloud_identity.device_token`。这也顺带解决了「删数据目录算不算新设备」——不算,复用同行、只换 token。

**② 上部分唯一索引 `(user_id, machine_id) WHERE revoked_at IS NULL AND machine_id IS NOT NULL`。**
DB 层兜底:即使 `@WithLock` 因跨实例/异常失效,唯一索引也阻止同机同账号出现两行活跃设备。不影响「换绑另一账号」(不同 `user_id` 是不同索引项)。已吊销行不占索引(可保留历史)。

---

## 5. 边界与降级

- **machineId 采集失败**(`resolveMachineId()` 返回 null):请求体 machineId 为空 → 服务端不去重 → 退回「每次新建」旧行为。安全降级,不阻断授权。
- **老客户端不带 machineId**:同上,按空处理。
- **唯一索引冲突**:`@WithLock` 已串行化,正常路径不会触发;若极端并发下 insert 撞索引,`issueDevice` 抛错(exchange 失败,客户端可重试)。不做静默吞错。
- **已存在的重复设备行**(改造前遗留):`machine_id` 为 null,不受新索引约束,保持现状;用户可在设备列表手动吊销。不做数据回填/自动合并。
- **换绑账号**:machineId 相同但 `user_id` 不同 → 视为不同设备(该机器在 A、B 两账号下各一行),符合预期。

---

## 6. 测试计划(TDD)

- **单元(jest)`device.service.spec.ts`**:
  - 同 `(userId, machineId)` 连续 `issueDevice` 两次 → 返回同一 `device.id`;第二次 `tokenHash` 变化(token 轮换)、`lastSeenAt` 刷新;仍只一行。
  - 无 machineId(null)连续两次 → 两行不同 `device.id`(旧行为)。
  - 不同 machineId 同 userId → 两行(dev vs 打包版场景)。
- **单元(jest)`machine-id.spec.ts`**:mock `isPackaged()` 与 `machineIdSync`,验证打包版返回原值、dev 返回 `dev-` 前缀、采集抛错返回 null。
- **e2e(server-main,Postgres)**:扩展 device-auth exchange e2e —— 同 machineId 走两次完整 start→approve→exchange,断言 `device` 表该用户仅一行且 token_hash 已变;不带 machineId 两次 → 两行。
- **schema 单测**:`DeviceAuthExchangeSchema` 接受带/不带 machineId、拒绝超长(>80)。

---

## 7. 不做(YAGNI)

- 不做已有重复设备的自动合并/回填。
- 不做 machineId 的加密/签名校验(客户端自报,信任模型与现有 device_token 一致——授权链路本身已由 PKCE + userCode 保护)。
- 不改设备列表 UI(L2b 已完成;去重后列表自然变干净)。
- 不碰 cli-agent 单独授权路径(如有,归后续)。
