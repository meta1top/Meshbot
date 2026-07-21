# #1 模型配置读时合并（代理云端 + 本地 sqlite），退役云端→本地同步 + 重启本地写入

> 设计 spec。触发：真机冒烟 #1（re-login 后模型要重新同步 + 本地云端割裂 + `ModelSetupGate` 强制云端 org 配置）。
> 关联：云端模型网关（server-main `/api/v1/chat/completions` OpenAI 兼容代理，厂商 key 不下发端侧）、配置云端化（子项目 A，`OrgModelConfig`）。

## Goal

把模型配置的真相来源从「云端**同步落**本地 sqlite」改为「**读时合并**」：server-agent 的模型接口 = 实时代理云端（server-main）模型列表 + 读本地 sqlite `source='local'` 行，合并后返回。云端模型**永不落本地**、每次实时取（短 TTL 缓存）。同时**重启本地模型写入**（create/edit/enable，写侧 REST + UI）。

**解决**：① re-login/换设备后不用重新同步（云端始终实时）；② 本地 + 云端模型统一成一个列表；③ `ModelSetupGate` 不再强制云端 org 有模型——本地也能配、也算数。

## 背景与现状（已确认）

- **同步机制（要退役）**：`model-config-sync.service.ts` 有 5 个事件触发（bootstrap / authorized / relayConnected / modelConfigChanged / runtimeCreated）→ `syncNow(cloudUserId)` → `cloud.get('/api/agent/model-configs')`（device token）→ `ModelConfigService.replaceCloudConfigs(rows)` → `persistCloudConfigs`（`@Transactional` 删 `source='cloud'` 旧行 + 插新行）落 sqlite。
- **读方法（6 个，都读本地 repo）**：`findAll` / `findAllEnabled` / `findEnabled` / `findByIdOrName` / `findOneOrFail` / `hasEnabledModels`。当前 repo 含「同步下来的 cloud 行 + local 行」。
- **两个消费方**：① 列表 UI（web-agent `useModelConfigs`，query key `["model-configs"]` → `GET /api/model-configs`）；② **runner 调用**（`session.modelConfigId || agent.defaultModelConfigId` → 按 id 解析成完整配置 → 建 ChatModel；云端模型 baseUrl 指向云端网关 `/api/v1`，本地模型指向厂商）。
- **写侧已下线**：`ModelConfigController` 只剩 `GET`（注释：「本地写 REST create/update/delete 已下线」）。
- **云端接口形状**：`GET /api/agent/model-configs`（server-main `agent-config.controller`，`OrgModelConfigService`）返回完整行 `CloudModelConfigRow = { id, providerType, name, model, apiKey, baseUrl, enabled, contextWindow }`，`baseUrl` = 云端网关 `/api/v1`。

## 锁定决策

| # | 决策 | 取值 |
|---|------|------|
| D1 | 云端模型解析方式 | **实时代理、不落本地**；列表 + runner 按 id 解析两处都走合并视图。云端不可达 → 云端模型解析不出（本来就要网关在线才能跑，非离线倒退）；本地模型不受影响 |
| D2 | 存量 `source='cloud'` sqlite 行 | **一次性清掉**（迁移删除），之后 sqlite 只留 `source='local'` |
| D3 | 代理云端列表时效 | **短 TTL 内存缓存（~45s，账号作用域）** + 既有 `modelConfigChanged` 事件主动失效 |
| D4 | 本地模型写入 | **重启**：create/edit/enable/delete REST + web-agent UI，只操作 `source='local'`，绝不碰云端 |

## 架构：读时合并

### A. 云端模型代理 + 短 TTL 缓存

新增 `CloudModelConfigProxyService`（server-agent）：
- `getCloudConfigs(): Promise<ModelConfigView[]>` —— `cloud.get('/api/agent/model-configs', deviceToken)`（复用 `CloudClientService` + `CloudIdentityService` 取 token，同 `remote-agents.service` 范式），结果打 `source: 'cloud'` 标。
- **短 TTL 内存缓存**（~45s，key = cloudUserId）：命中直接返回；过期或未命中才打云端。
- **失效钩子**：`@OnEvent(modelConfigChanged)` → 清该账号缓存（原 `model-config-sync` 的 `onModelConfigChanged` 处理器迁移到这里，语义从「重新同步落库」改「清缓存」）。
- **云端不可达降级**：TTL 内命中缓存正常；缓存过期 + 云端不可达 → 返回**空 cloud 列表**（不抛，不阻塞本地模型），记日志。UI 表现为「暂时只列出本地模型」，恢复后下次读自动补回。

### B. `ModelConfigService` 读方法改「本地 source=local + 云端代理」合并

6 个读方法全部改为合并视图（本地只读 `source='local'` 行 + `proxy.getCloudConfigs()`）：
- `findAll()` → local(local) ∪ cloud proxy（含停用行，UI/历史用量解析需要）。
- `findAllEnabled()` / `findEnabled()` → 合并后过滤 `enabled`。
- `findByIdOrName(idOrName)` → **先查本地 local 行，未命中查云端代理**（runner 调用 + dispatch model 覆盖用）。
- `findOneOrFail(id)` → 合并解析，查不到抛既有错误码。
- `hasEnabledModels()` → 合并后有无 `enabled`（gate 用）。

合并去重按 `id`（云端 OrgModelConfig 雪花 id 与本地雪花 id 不冲突；万一同 id 以本地优先或明确规则，plan 定）。合并结果类型 = 现有 `ModelConfig` 字段形状 + `source` 标；云端条目**在内存构造、不 save**。

### C. 退役同步 + 清存量

- **删** `ModelConfigSyncService`（服务 + 5 个事件处理器 + module 注册）。`modelConfigChanged` 事件订阅迁到 `CloudModelConfigProxyService`（改为清缓存）。
- **删** `ModelConfigService.replaceCloudConfigs` / `persistCloudConfigs`（及其 `@Transactional`）。
- **一次性清存量**：新增本地轨 TypeORM 迁移，`DELETE FROM model_config WHERE source = 'cloud'`（幂等）。启动自动跑（`migrationsRun:true`）。

### D. 重启本地模型写入

- `ModelConfigController` 加回写端点（`POST` 建 / `PATCH :id` 改 / `DELETE :id` / `PATCH :id/enabled` 切换），**只作用于 `source='local'`**：改/删前校验目标行 `source==='local'`，云端条目（内存、无本地行）操作一律拒（既有错误码或新增，plan 定）。
- `ModelConfigService` 加回 `create`/`update`/`delete`/`setEnabled`（写 `source='local'`；单表写，按 CLAUDE.md 单表不需 `@Transactional`）。
- DTO 走 `createZodDto` + 共享 Zod schema（`libs/types-agent`）。
- web-agent UI：模型配置页/设置里恢复「新建/编辑/启用本地模型」表单（`Form/FormItem` + `useSchema`，走 `web-form-convention`）；列表按 `source` 标区分本地/云端，云端条目只读（不给编辑入口，编辑去云端 org）。

### E. Gate

`ModelSetupGate` / `auth-guard` 的判定（`modelConfigs.some(c => c.enabled)` / `hasEnabledModels`）自动读合并视图——本地或云端任一有可用模型即放行。无云端 org 模型时，用户可新建本地模型escape gate（D4）。文案若仍暗示「必须云端 org 配」需同步改（`modelSetupGate.description`）。

## 数据流

- **列表**：web-agent `GET /api/model-configs` → `findAll()` → 合并 → 统一列表（`source` 标驱动本地/云端徽标）。
- **调用**：runner id → `findByIdOrName(id)` → 本地或云端代理 → 完整配置 → 建 ChatModel（云端 → 网关 baseUrl + key，本地 → 厂商）。
- **本地写**：web-agent 新建 → `POST /api/model-configs` → 存 `source='local'` 行 → `["model-configs"]` 失效重拉。
- **云端变更**：server-main `OrgModelConfig` 改 → `modelConfigChanged`（ws/events）→ server-agent 清代理缓存 → 下次读实时。

## 错误处理

- **云端不可达**：代理 TTL 内命中缓存；过期 + 不可达 → 空 cloud 列表，本地模型仍列/可用；调用云端模型时 `findByIdOrName` 返回 null → 清晰报错（模型不可用/云端不可达），**不静默**。
- **改/删云端条目**：拒（云端只读投影，编辑去云端 org）。
- **gate**：合并空 → gate 显示，但本地可建模型逃出（D4）。

## 测试

- `CloudModelConfigProxyService`：缓存命中/过期/`modelConfigChanged` 失效、云端不可达返回空不抛（mock `cloud.get`）。
- `ModelConfigService` 合并：`findByIdOrName` 本地优先→云端兜底、`findAll` 并集去重、`hasEnabledModels` 合并、`findAllEnabled` 过滤。
- 本地写：create/update/delete/setEnabled 只碰 `source='local'`；改/删云端条目被拒。
- 迁移：`DELETE ... source='cloud'` 幂等、启动跑通（临时 MESHBOT_HOME boot 验证 DI + 迁移）。
- gate：合并有/无 enabled 的放行/拦截。
- web-agent UI：本地模型表单纯逻辑（schema 校验、source 徽标）单测。

## 交付顺序（建议）

后端（A 代理 + B 合并读 + C 退役/清存量）→ 后端 D 写端点 → web-agent（列表 source 徽标 + 本地写 UI + gate 文案）→ 终验（含真启动跑迁移）。

## 不在本轮

- 云端模型的编辑（云端只读投影，去云端 org admin 改，既有能力）。
- 云端模型网关本身（`/api/v1/chat/completions` 代理）不改。
- 模型选择器 UI 大改版（本轮只加 source 徽标 + 本地写表单，不重排）。
