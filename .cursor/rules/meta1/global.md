# 服务端全局默认行为

## 统一的导出

使用 * 导出所有，不进行命名导出。
错误的实例：
```typescript
export * from "./session.dto";
export { SessionDetailDto, SessionDto } from "./session.dto";
```
正确的实例：
```typescript
export * from "./session.dto";
export * from "./tool.dto";
```


## 接口返回

所有的数据都会被包装成如下结构：

```json
{
    "code": 0,
    "success": true,
    "message": "success",
    "data": {
        "enable": false
    },
    "timestamp": "2025-11-28T07:58:02.212Z",
    "path": "/api/session/list"
}
```

业务只需要返回 `data` 部分，如：

```json
{
  "enable": false
}
```


## Service 处理

- 返回 Dto 声明的格式
- 遇到错误，抛出异常，框架会全局包装后

### 如何抛出异常

#### code 定义
在各自模块的 shared 定义。

libs/{module}/src/shared/{module}.error-code.ts 示例：
```typescript
import type { AppErrorCode } from "@meta-1/nest-common";

export const ErrorCode: Record<string, AppErrorCode> = {
  SESSION_NOT_FOUND: { code: 2000, message: "会话不存在" },
  TOOL_NOT_FOUND: { code: 2001, message: "工具不存在" },
} as const;
```

#### throw 错误

```typescript
...
import { AppError } from "@meta-1/nest-common";

  async findSession(id: string): Promise<SessionDto> {
    ...
    if (!session) {
      throw new AppError(ErrorCode.SESSION_NOT_FOUND);
    }
    ...
  }
```

### 事务

修改数据的方法，需要添加事务装饰器。使用示例：

```typescript
...

import { ..., Transactional } from "@meta-1/nest-common";

@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(Session) private repository: Repository<Session>,
    ...
  ) {}

  @Transactional()
  async createSession(dto: CreateSessionDto): Promise<SessionDto> {
    ...
  }
}
```
