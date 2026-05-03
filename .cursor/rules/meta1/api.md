
# 接口的定义与使用

## 定义

接口设计前端调用，因此设计的出入参需要按照如下方式进行定义：

### 第一步：定义类型
在 types 里定义 Schema 和 Type，并且按照模块进行组织。

```
libs/types/
├── index.ts                    # 统一导出
├── {module}/                    # 模块目录
│   ├── index.ts                # 模块统一导出
│   └── {module}.schema.ts       # 模块相关的 Schema 和 Type
└── ...
```

libs/types/index.ts 示例：
```typescript
export * from "./{module}";
export * from "./common.types";
```

libs/types/{module}/{module}.schema.ts 示例：
```typescript
import { z } from "zod";

export const CreateSessionSchema = z.object({
  name: z.string().min(1, "请输入会话名称").describe("会话名称"),
  model: z.string().min(1, "请选择模型").describe("模型"),
});

export type CreateSessionData = z.infer<typeof CreateSessionSchema>;
```

### 第二步：定义 DTO

```
libs/{module}/
├── index.ts
├── dto/
│   ├── index.ts
│   └── {module}.dto.ts
├── entity/
└── ...
```

libs/{module}/dto/{module}.dto.ts 示例：
```typescript
import { createZodDto } from "nestjs-zod";

import { CreateSessionSchema } from "@meta-1/anybot-types";

export class CreateSessionDto extends createZodDto(CreateSessionSchema) {}
```

### 第三步：定义 Controller

```typescript
import { Body, Controller, Get, Post, Param } from "@nestjs/common";
import { ApiResponse, ApiTags } from "@nestjs/swagger";

import { CreateSessionDto, SessionDto } from "../dto";
import { SessionService } from "../service";

@ApiTags("SessionController")
@Controller("/api/session")
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Get("/list")
  @ApiResponse({ status: 200, type: [SessionDto] })
  list() {
    return this.sessionService.findAll();
  }

  @Post("/create")
  create(@Body() dto: CreateSessionDto) {
    return this.sessionService.create(dto);
  }
}
```

注意：
1. 获取信息类（通常是GET方法），一定要给出 type 或 schema
2. 创建或更新信息类（通常是POST/PUT/DELETE等方法），没有特殊要求，不返回数据。
3. entity 通常不直接返回，所有返回给客户端的，都是采用schema + dto 的方式。
4. ApiResponse 没有 type 或 schema 的时候，不需要添加
5. ApiResponse 有 type 时候，不需要 description，除非有多种情况。

## 使用

### 定义 rest

在 apps/web/src/rest 里定义。

apps/web/src/rest/{module}.ts 示例：
```typescript
import type { CreateSessionData, Session } from "@meta-1/anybot-types";
import { get, post } from "@/utils/rest";

export const createSession = (data: CreateSessionData) => post<Session, CreateSessionData>("@api/session/create", data);

export const listSessions = () => get<Session[], null>("@api/session/list", null);
```

### 使用 tanstack query

我们封装了 tanstack query，包装了全局错误处理。

在 `apps/web/src/hooks` 提供了：
- useQuery
- useMutation
