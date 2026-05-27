---
name: shared-data-model
description: "前后端共享数据模型 — types / types-<domain> schema、业务 DTO、Entity 分层 Use when files matching libs/types/**,libs/types-*/**,libs/**/src/dto/**,apps/**/src/rest/**,packages/common/**/types/** change, or when explicitly invoked."
---

# 共享数据模型（类型包 + 业务模块）

## 类型包分层

类型包分为**公共类型**和**域专属类型**两级（详见 `.claude/CLAUDE.md`「项目架构」节）：

| 包 | 别名 | 内容范围 |
|----|------|---------|
| `libs/types` | `@meshbot/types` | 跨域公共类型：`common/`、`zod/`、`assets/`、`message/` |
| `libs/types-agent` | `@meshbot/types-agent` | Agent 域类型（本地 agent / 桌面端 / cli-agent） |
| `libs/types-main` | `@meshbot/types-main` | 云端 main 域类型（server-main / web-main） |
| `libs/types-<domain>` | `@meshbot/types-<domain>` | 新增其他域时按上述命名约定建立 |

所有类型包的共同规范：

1. 用 **Zod** 定义 **Schema**（`*.schema.ts`），并导出 `z.infer` 得到的 **TypeScript 类型**。  
2. **字段描述**：每个对象字段在链式末尾使用 **`.describe("…")`** 写明语义、单位或格式（如 ISO 8601、枚举含义）。说明供 OpenAPI、协作与 `createI18nZodDto` 构建时采集；新建或修改 Schema 时应补齐。**优先使用中文短句**；全文件内语言风格保持一致。  
3. 可放置与 HTTP/分页等相关的**纯类型**（如 `RestResult`、`PageData`），供前后端与 Nest 共用。  
4. **禁止**在类型包中依赖 NestJS 或 TypeORM。

## 业务库 DTO

业务域库（如 `libs/agent`）在 **`src/<sub-domain>/dto/`** 中基于对应类型包的 Schema，用 **`createI18nZodDto`**（`@meshbot/common`）包装成 **DTO 类**，用于校验、OpenAPI、控制器入参/出参声明；该工厂会在构建时采集 Schema 中的校验文案以支持 **i18n**（`nestjs-zod` 的 `createZodDto` 仅作其内部实现，业务代码不要直接使用）。

- **不要**在 DTO 文件里重复手写与类型包不一致的 `z.object`；Schema 的单一来源是 `libs/types` 或 `libs/types-<domain>`。  
- **`src/tools/`**（MCP 等，**TODO：当前仓库尚未落地，规划中的预留约定**）若组合类型包中的 Zod 片段，请使用 **`import { z } from "zod"`**，与类型包一致；避免与 `zod/v3` 混用导致类型推断过深或实例化错误。落地时请同步把 `libs/**/src/tools/**` 加回顶部 `globs`。

## Entity

仍放在对应业务域库的 **`entity/`**（或子域 `<sub-domain>/entity/`），只面向数据库与 ORM；**不要**把 Entity 与对外 API 的 Zod Schema 混在同一职责里。

## 前端（如 `apps/web-agent`）

- 公共类型从 **`@meshbot/types`** 引用
- 域专属类型从 **`@meshbot/types-agent`** 等引用
- **避免**在 `rest` 层手写与后端重复的 `type`/`interface`

## 命名与导出

- Schema 文件建议以 `*.schema.ts` 结尾；导出 `XxxSchema` 与 `XxxData` / 领域名类型（如 `AdminProfile`）便于前后端一致引用。  
- 业务库如需对外暴露 Schema，可从 DTO 文件 **re-export** 类型包中的同名符号，避免分叉。

## 主键策略（Phase 5 起）

每个新 Entity 选 **UUID** 或 **Snowflake** 之一，按下表决策：

| 场景 | 推荐 | 理由 |
|------|------|------|
| 本地单进程实体（`server-agent`：`User` / `Setting` / `ModelConfig` 等） | **UUID**（`@PrimaryGeneratedColumn("uuid")`） | 简单；单机无并发冲突；无需配 NODE_ID |
| 对外暴露的随机不可猜测 token（refresh token / invite token / api key 等） | **UUID 或 base64url(randomBytes)** | 安全优先；不需要时间序 |
| 云端多实例可能并发插入的业务实体（`server-main`：未来的会话 / 消息 / 事件 / 任务等） | **Snowflake**（`@meshbot/common` 的 `generateSnowflakeId`） | 时间有序（DB B+ 树友好）+ 多节点无冲突 + ID 长度 ~19 位（UUID 36 字符的约一半）|
| 需要时间排序的实体（消息流 / 日志 / 审计 / 事件等） | **Snowflake** | ID 本身即时间戳，避免单独存 sort key |

### Snowflake 用法

```ts
import { generateSnowflakeId } from "@meshbot/common";
import { BeforeInsert, Entity, PrimaryColumn } from "typeorm";

@Entity("agent_event")
export class AgentEvent {
  @PrimaryColumn({ type: "varchar", length: 20 })
  id!: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) this.id = generateSnowflakeId();
  }

  // ...其余列
}
```

### Snowflake 多实例部署

server-main 多实例 / k8s 横向扩容时，**每个节点必须设置唯一 `MESHBOT_NODE_ID`**（0-1023 整数），否则同毫秒可能 ID 冲突。

部署方式：
- Docker compose：`environment: { MESHBOT_NODE_ID: ${REPLICA_ID} }`
- k8s：从 `metadata.name`（hash 取低 10 bit）或 statefulset ordinal 派生
- 单实例 / 本地：留空（默认 0）

详见 `libs/common/src/utils/snowflake.ts` 文件注释。

