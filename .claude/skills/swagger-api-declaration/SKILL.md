---
name: swagger-api-declaration
description: "NestJS Controller Swagger 文档声明规范 — 所有端点必须完整声明输入输出类型 Use when files matching apps/server-*/src/**/*.controller.ts, libs/*/src/dto/**/*.ts change, or when explicitly invoked."
---

# NestJS Controller Swagger 文档声明规范

所有 Controller 端点**必须**完整声明 Swagger 文档元数据，包括操作描述、响应类型和请求体类型。

## 必选装饰器

每个端点方法必须包含以下装饰器：

| 装饰器 | 何时必须 |
|---|---|
| `@ApiOperation({ summary: "..." })` | **所有**端点 |
| `@ApiOkResponse({ type: XDto })` | 返回具体数据的 200 端点 |
| `@ApiCreatedResponse({ type: XDto })` | 201 创建端点 |
| `@ApiNoContentResponse({ description: "..." })` | 204 无内容端点（配合 `@HttpCode(HttpStatus.NO_CONTENT)`） |
| `@ApiBody({ type: XDto })` | POST/PUT/PATCH 含 `@Body()` 参数的端点 |

Controller 类级别必须包含：

| 装饰器 | 何时必须 |
|---|---|
| `@ApiTags("...")` | **所有** Controller 类 |
| `@ApiExtraModels(...)` | 使用 `createPageSchema` 的 Controller |

## 响应类型声明模式

### 单对象响应

```typescript
@ApiOkResponse({ description: "技能详情", type: AgentSkillDataDto })
async findOne(): Promise<AgentSkillData> { ... }
```

### 数组响应

```typescript
@ApiOkResponse({ description: "技能列表", type: AgentSkillDataDto, isArray: true })
async list(): Promise<AgentSkillData[]> { ... }
```

### 分页响应（PageData）

```typescript
import { createPageModels, createPageSchema } from "@meshbot/common";

@ApiExtraModels(...createPageModels(AgentSkillDataDto))  // 放在类级别
@Controller("api/agent/skills")
export class AgentSkillController {

  @ApiOkResponse({ description: "技能列表（分页）", schema: createPageSchema(AgentSkillDataDto) })
  async list(): Promise<PageData<AgentSkillData>> { ... }
}
```

### 无内容响应（void + 204）

```typescript
@HttpCode(HttpStatus.NO_CONTENT)
@ApiNoContentResponse({ description: "删除成功" })
async remove(): Promise<void> { ... }
```

### 无内容响应（void + 200）

```typescript
@ApiOkResponse({ description: "操作成功" })
async doSomething(): Promise<void> { ... }
```

### 简单内联对象（无对应 Schema）

```typescript
@ApiOkResponse({
  description: "操作结果",
  schema: { properties: { success: { type: "boolean" } } },
})
async cancel(): Promise<{ success: boolean }> { ... }
```

## DTO 创建规范

### 响应 DTO

- 每个 Zod Schema（`libs/types-agent/src/`）的导出类型若用作 Controller 响应，**必须**在 `libs/agent/src/dto/` 中创建对应 DTO 类
- 使用 `createI18nZodDto` 从 Schema 生成：

```typescript
import { createI18nZodDto } from "@meshbot/common";
import { AgentSkillSchema } from "@meshbot/types-agent";

export class AgentSkillDataDto extends createI18nZodDto(AgentSkillSchema) {}
```

- 新 DTO 必须在 `libs/agent/src/dto/index.ts` 中导出

### 请求 DTO

- POST/PUT/PATCH 的 `@Body()` 参数同理，需要 DTO 类
- 已有的 Zod Schema（如 `CreateSkillRequestSchema`）→ `createI18nZodDto` → DTO 类

## 导入路径

| 内容 | 导入源 |
|---|---|
| DTO 类（`AgentSkillDataDto` 等） | `@meshbot/types-agent` |
| `createPageSchema`、`createPageModels` | `@meshbot/common` |
| `PageData`、`CursorPageData` | `@meshbot/types` |
| `ApiOkResponse`、`ApiBody` 等 | `@nestjs/swagger` |

## 禁止

- **不要**只写 `@ApiOkResponse({ description: "..." })` 而省略 `type` / `schema`（void 端点除外）
- **不要**对 `PageData<T>` 响应使用 `isArray: true`（`PageData` 是对象不是数组）
- **不要**用 TypeScript `type` / `interface` 作为 `@ApiOkResponse` 的 `type`（Swagger 需要带 `@ApiProperty` 的类）

## 新增端点检查清单

1. ✅ `@ApiOperation({ summary })` 已声明
2. ✅ 2xx 响应装饰器已声明（含 `type` 或 `schema`）
3. ✅ `@Body()` 参数有对应 `@ApiBody({ type })` 
4. ✅ 若返回 `PageData`，类级别有 `@ApiExtraModels`
5. ✅ 响应 DTO 已在 `libs/agent/src/dto/` 中创建并导出

