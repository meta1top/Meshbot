# web-agent 直连 server-agent 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 web-agent 从 Electron IPC 代理模式改为 HTTP 直连 server-agent，支持浏览器/局域网独立访问，并加入账号注册 + JWT 登录认证。

**Architecture:** web-agent（Next.js 静态导出）通过 axios 直接请求 server-agent（NestJS :3100）。server-agent 新增 Auth 模块（注册/登录/JWT），绑定 0.0.0.0 + CORS。Electron 主进程不再代理 API，仅负责窗口管理和桌面专属能力。

**Tech Stack:** NestJS 11, TypeORM, better-sqlite3, bcrypt, @nestjs/jwt, @nestjs/passport, passport-jwt, axios, @tanstack/react-query, Next.js 15, React 19, Zod

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `libs/types-agent/package.json` | 包配置 |
| `libs/types-agent/tsconfig.json` | TS 配置 |
| `libs/types-agent/src/index.ts` | 统一导出 |
| `libs/types-agent/src/auth.ts` | Auth DTO Zod schema |
| `libs/types/src/api-response.ts` | 通用 ApiResponse 类型 |
| `packages/common/src/api/client.ts` | axios 实例封装 |
| `apps/server-agent/src/entities/user.entity.ts` | User 实体 |
| `apps/server-agent/src/dto/auth.dto.ts` | Auth DTO（class-validator） |
| `apps/server-agent/src/services/auth.service.ts` | 注册/登录/JWT 逻辑 |
| `apps/server-agent/src/controllers/auth.controller.ts` | Auth API |
| `apps/server-agent/src/guards/jwt-auth.guard.ts` | JWT 全局守卫 |
| `apps/server-agent/src/strategies/jwt.strategy.ts` | Passport JWT 策略 |
| `apps/server-agent/src/auth.module.ts` | Auth NestJS 模块 |
| `apps/web-agent/src/lib/query-client.ts` | TanStack Query 客户端 |
| `apps/web-agent/src/components/providers.tsx` | QueryClientProvider 包装 |
| `apps/web-agent/src/rest/auth.ts` | Auth API 函数 + hooks |
| `apps/web-agent/src/rest/model-config.ts` | ModelConfig API 函数 + hooks |
| `apps/web-agent/src/rest/index.ts` | 统一导出 |
| `apps/web-agent/src/app/login/page.tsx` | 登录页 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `libs/types/src/index.ts` | 导出 ApiResponse |
| `packages/common/src/index.ts` | 导出 api client |
| `apps/server-agent/src/main.ts` | 绑定 0.0.0.0 + CORS |
| `apps/server-agent/src/app.module.ts` | 注册 AuthModule、User entity |
| `apps/server-agent/src/controllers/setup.controller.ts` | 改用 auth status 判断 |
| `apps/server-agent/package.json` | 新增 bcrypt、@nestjs/jwt、@nestjs/passport、passport-jwt 依赖 |
| `apps/web-agent/package.json` | 新增 axios、@tanstack/react-query 依赖 |
| `apps/web-agent/src/app/layout.tsx` | 包裹 QueryClientProvider |
| `apps/web-agent/src/app/page.tsx` | 去掉 electronAPI，用 REST hooks |
| `apps/web-agent/src/app/setup/page.tsx` | 合并注册 + 模型配置，用 REST |
| `apps/web-agent/src/components/setup/model-form.tsx` | 类型 import 改为从 types-agent |

### 删除文件

| 文件 | 原因 |
|------|------|
| `apps/desktop/src/database.ts` | 不再需要主进程代发 HTTP |
| `apps/web-agent/src/types/electron.d.ts` | 不再需要 ElectronAPI 类型 |

### 精简文件

| 文件 | 改动 |
|------|------|
| `apps/desktop/src/ipc-handlers.ts` | 删除所有 API 代理 handler，保留空壳 |
| `apps/desktop/src/preload.ts` | 删除 API 相关暴露，保留 isElectron 标识 |
| `apps/desktop/src/main.ts` | 去掉 getSetupStatus 判断、database import |

---

## Task 1: 创建 libs/types-agent 包

**Files:**
- Create: `libs/types-agent/package.json`
- Create: `libs/types-agent/tsconfig.json`
- Create: `libs/types-agent/src/index.ts`
- Create: `libs/types-agent/src/auth.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@meshbot/types-agent",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --project tsconfig.json --noEmit"
  },
  "dependencies": {
    "@meshbot/types": "workspace:*",
    "zod": "^3"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 auth.ts — Auth 相关 Zod schema**

在 `libs/types-agent/src/auth.ts` 中：

```typescript
import { z } from "zod";

export const registerSchema = z.object({
  username: z.string().min(1, "请输入用户名").max(50),
  password: z.string().min(6, "密码至少 6 位").max(100),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export type LoginInput = z.infer<typeof loginSchema>;

export interface AuthStatus {
  initialized: boolean;
  needsSetup: boolean;
}

export interface LoginResponse {
  access_token: string;
}

export interface UserInfo {
  id: string;
  username: string;
}
```

- [ ] **Step 4: 创建 index.ts — 统一导出**

在 `libs/types-agent/src/index.ts` 中：

```typescript
export {
  registerSchema,
  loginSchema,
  type RegisterInput,
  type LoginInput,
  type AuthStatus,
  type LoginResponse,
  type UserInfo,
} from "./auth";
```

- [ ] **Step 5: 安装依赖并验证类型**

```bash
cd /Users/grant/Meta1/meshbot && pnpm install
cd libs/types-agent && pnpm typecheck
```

Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add libs/types-agent/
git commit -m "feat: create @meshbot/types-agent package with auth schemas"
```

---

## Task 2: 添加通用 API 响应类型到 libs/types

**Files:**
- Create: `libs/types/src/api-response.ts`
- Modify: `libs/types/src/index.ts`

- [ ] **Step 1: 创建 api-response.ts**

在 `libs/types/src/api-response.ts` 中：

```typescript
export interface ApiResponse<T = unknown> {
  data: T;
  message?: string;
}

export interface PaginatedRequest {
  page?: number;
  limit?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}
```

- [ ] **Step 2: 更新 index.ts 导出**

将 `libs/types/src/index.ts` 替换为：

```typescript
export type {
  ApiResponse,
  PaginatedRequest,
  PaginatedResponse,
} from "./api-response";
```

- [ ] **Step 3: 验证类型**

```bash
cd /Users/grant/Meta1/meshbot/libs/types && pnpm typecheck
```

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add libs/types/
git commit -m "feat: add ApiResponse and pagination types to @meshbot/types"
```

---

## Task 3: 在 packages/common 中封装 axios 客户端

**Files:**
- Create: `packages/common/src/api/client.ts`
- Modify: `packages/common/src/index.ts`
- Modify: `packages/common/package.json`

- [ ] **Step 1: 添加 axios 依赖**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/common add axios
```

- [ ] **Step 2: 创建 client.ts**

在 `packages/common/src/api/client.ts` 中：

```typescript
import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from "axios";

const TOKEN_KEY = "meshbot_access_token";

function resolveBaseURL(): string {
  if (typeof window === "undefined") {
    return "http://localhost:3100";
  }
  const { hostname } = window.location;
  return `http://${hostname}:3100`;
}

export function createApiClient(
  baseURL?: string,
): AxiosInstance {
  const client = axios.create({
    baseURL: baseURL ?? resolveBaseURL(),
    timeout: 30000,
    headers: { "Content-Type": "application/json" },
  });

  client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    if (typeof window !== "undefined") {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  });

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        if (typeof window !== "undefined") {
          localStorage.removeItem(TOKEN_KEY);
          const currentPath = window.location.pathname;
          if (currentPath !== "/login" && currentPath !== "/setup") {
            window.location.href = "/login";
          }
        }
      }
      return Promise.reject(error);
    },
  );

  return client;
}

export const apiClient = createApiClient();

export function setAccessToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAccessToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function getAccessToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
```

- [ ] **Step 3: 更新 index.ts 导出**

在 `packages/common/src/index.ts` 末尾追加：

```typescript
export {
  apiClient,
  createApiClient,
  setAccessToken,
  clearAccessToken,
  getAccessToken,
} from "./api/client";
```

- [ ] **Step 4: 验证类型**

```bash
cd /Users/grant/Meta1/meshbot/packages/common && pnpm typecheck
```

Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add packages/common/
git commit -m "feat: add axios API client with JWT interceptor to @meshbot/common"
```

---

## Task 4: server-agent 添加 Auth 模块

**Files:**
- Create: `apps/server-agent/src/entities/user.entity.ts`
- Create: `apps/server-agent/src/dto/auth.dto.ts`
- Create: `apps/server-agent/src/services/auth.service.ts`
- Create: `apps/server-agent/src/controllers/auth.controller.ts`
- Create: `apps/server-agent/src/strategies/jwt.strategy.ts`
- Create: `apps/server-agent/src/guards/jwt-auth.guard.ts`
- Create: `apps/server-agent/src/auth.module.ts`
- Modify: `apps/server-agent/src/app.module.ts`
- Modify: `apps/server-agent/src/main.ts`
- Modify: `apps/server-agent/package.json`
- Modify: `apps/server-agent/src/controllers/setup.controller.ts`

- [ ] **Step 1: 安装依赖**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/server-agent add @nestjs/jwt @nestjs/passport passport passport-jwt bcrypt
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/server-agent add -D @types/passport-jwt @types/bcrypt
```

- [ ] **Step 2: 创建 User 实体**

在 `apps/server-agent/src/entities/user.entity.ts` 中：

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ unique: true })
  username!: string;

  @Column({ name: "password_hash" })
  passwordHash!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
```

- [ ] **Step 3: 创建 Auth DTO**

在 `apps/server-agent/src/dto/auth.dto.ts` 中：

```typescript
import { IsNotEmpty, IsString, MinLength } from "class-validator";

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
```

- [ ] **Step 4: 创建 Auth Service**

在 `apps/server-agent/src/services/auth.service.ts` 中：

```typescript
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly jwtService: JwtService,
  ) {}

  async register(
    username: string,
    password: string,
  ): Promise<{ access_token: string }> {
    const existingUser = await this.userRepo.count();
    if (existingUser > 0) {
      throw new ConflictException("已存在注册用户，不允许重复注册");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = this.userRepo.create({ username, passwordHash });
    await this.userRepo.save(user);

    return this.signToken(user);
  }

  async login(
    username: string,
    password: string,
  ): Promise<{ access_token: string }> {
    const user = await this.userRepo.findOneBy({ username });
    if (!user) {
      throw new UnauthorizedException("用户名或密码错误");
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException("用户名或密码错误");
    }

    return this.signToken(user);
  }

  async getStatus(): Promise<{ initialized: boolean; needsSetup: boolean }> {
    const userCount = await this.userRepo.count();
    return {
      initialized: userCount > 0,
      needsSetup: userCount === 0,
    };
  }

  async validateUser(userId: string): Promise<User | null> {
    return this.userRepo.findOneBy({ id: userId });
  }

  private signToken(user: User): { access_token: string } {
    const payload = { sub: user.id, username: user.username };
    return { access_token: this.jwtService.sign(payload) };
  }
}
```

- [ ] **Step 5: 创建 JWT Strategy**

在 `apps/server-agent/src/strategies/jwt.strategy.ts` 中：

```typescript
import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

export const JWT_SECRET =
  process.env.MESHBOT_JWT_SECRET ?? "meshbot-local-jwt-secret-key";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: JWT_SECRET,
    });
  }

  validate(payload: { sub: string; username: string }) {
    return { id: payload.sub, username: payload.username };
  }
}
```

- [ ] **Step 6: 创建 JWT Auth Guard**

在 `apps/server-agent/src/guards/jwt-auth.guard.ts` 中：

```typescript
import { type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }
}
```

- [ ] **Step 7: 创建 Auth Controller**

在 `apps/server-agent/src/controllers/auth.controller.ts` 中：

```typescript
import { Body, Controller, Get, Post } from "@nestjs/common";
import { LoginDto, RegisterDto } from "../dto/auth.dto";
import { Public } from "../guards/jwt-auth.guard";
import { AuthService } from "../services/auth.service";

@Controller("api/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("register")
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.username, dto.password);
  }

  @Public()
  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.username, dto.password);
  }

  @Public()
  @Get("status")
  getStatus() {
    return this.authService.getStatus();
  }
}
```

- [ ] **Step 8: 创建 Auth Module**

在 `apps/server-agent/src/auth.module.ts` 中：

```typescript
import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthController } from "./controllers/auth.controller";
import { User } from "./entities/user.entity";
import { AuthService } from "./services/auth.service";
import { JWT_SECRET, JwtStrategy } from "./strategies/jwt.strategy";

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    PassportModule,
    JwtModule.register({
      secret: JWT_SECRET,
      signOptions: { expiresIn: "7d" },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
```

- [ ] **Step 9: 更新 app.module.ts**

将 `apps/server-agent/src/app.module.ts` 替换为：

```typescript
import { homedir } from "node:os";
import path from "node:path";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "./auth.module";
import { ModelConfigController } from "./controllers/model-config.controller";
import { SettingController } from "./controllers/setting.controller";
import { SetupController } from "./controllers/setup.controller";
import { ModelConfig } from "./entities/model-config.entity";
import { Setting } from "./entities/setting.entity";
import { User } from "./entities/user.entity";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { ModelConfigService } from "./services/model-config.service";
import { SettingService } from "./services/setting.service";

const meshbotDir = process.env.MESHBOT_DIR ?? path.join(homedir(), ".meshbot");

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "better-sqlite3",
      database: path.join(meshbotDir, "agent.db"),
      entities: [ModelConfig, Setting, User],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([ModelConfig, Setting]),
    AuthModule,
  ],
  controllers: [ModelConfigController, SettingController, SetupController],
  providers: [
    ModelConfigService,
    SettingService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
```

- [ ] **Step 10: 更新 main.ts — 绑定 0.0.0.0 + CORS**

将 `apps/server-agent/src/main.ts` 替换为：

```typescript
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const meshbotDir = process.env.MESHBOT_DIR ?? path.join(homedir(), ".meshbot");
  mkdirSync(meshbotDir, { recursive: true });
  mkdirSync(path.join(meshbotDir, "logs"), { recursive: true });

  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: [
      "http://localhost:3001",
      /^http:\/\/192\.168\.\d+\.\d+:3001$/,
      /^http:\/\/10\.\d+\.\d+\.\d+:3001$/,
      /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+:3001$/,
    ],
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(3100, "0.0.0.0");
}
bootstrap();
```

- [ ] **Step 11: 更新 setup.controller.ts — 改用 auth status**

将 `apps/server-agent/src/controllers/setup.controller.ts` 替换为：

```typescript
import { PROVIDERS } from "@meshbot/common";
import { Controller, Get } from "@nestjs/common";
import { Public } from "../guards/jwt-auth.guard";
import { ModelConfigService } from "../services/model-config.service";
import { AuthService } from "../services/auth.service";

@Controller("api")
export class SetupController {
  constructor(
    private readonly modelConfigService: ModelConfigService,
    private readonly authService: AuthService,
  ) {}

  @Public()
  @Get("setup-status")
  async getSetupStatus() {
    const { initialized } = await this.authService.getStatus();
    if (!initialized) {
      return { needsSetup: true, step: "register" };
    }
    const hasModels = await this.modelConfigService.hasEnabledModels();
    if (!hasModels) {
      return { needsSetup: true, step: "model" };
    }
    return { needsSetup: false, step: null };
  }

  @Public()
  @Get("providers")
  getProviders() {
    return PROVIDERS;
  }
}
```

- [ ] **Step 12: 验证编译**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/server-agent typecheck
```

Expected: 无错误

- [ ] **Step 13: Commit**

```bash
git add apps/server-agent/
git commit -m "feat: add auth module with JWT login, CORS, and 0.0.0.0 binding to server-agent"
```

---

## Task 5: web-agent 添加依赖和基础设施

**Files:**
- Modify: `apps/web-agent/package.json`
- Create: `apps/web-agent/src/lib/query-client.ts`
- Create: `apps/web-agent/src/components/providers.tsx`
- Modify: `apps/web-agent/src/app/layout.tsx`

- [ ] **Step 1: 安装依赖**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/web-agent add axios @tanstack/react-query @meshbot/types-agent
```

- [ ] **Step 2: 创建 query-client.ts**

在 `apps/web-agent/src/lib/query-client.ts` 中：

```typescript
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});
```

- [ ] **Step 3: 创建 providers.tsx**

在 `apps/web-agent/src/components/providers.tsx` 中：

```tsx
"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
```

- [ ] **Step 4: 更新 layout.tsx**

将 `apps/web-agent/src/app/layout.tsx` 替换为：

```tsx
import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "MeshBot",
  description: "MeshBot Agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

- [ ] **Step 5: 验证类型**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/web-agent typecheck
```

Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add apps/web-agent/src/lib/ apps/web-agent/src/components/providers.tsx apps/web-agent/src/app/layout.tsx apps/web-agent/package.json
git commit -m "feat: add TanStack Query and axios to web-agent"
```

---

## Task 6: web-agent REST 接口层

**Files:**
- Create: `apps/web-agent/src/rest/auth.ts`
- Create: `apps/web-agent/src/rest/model-config.ts`
- Create: `apps/web-agent/src/rest/index.ts`

- [ ] **Step 1: 创建 auth.ts**

在 `apps/web-agent/src/rest/auth.ts` 中：

```typescript
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiClient, setAccessToken } from "@meshbot/common";
import type { AuthStatus, LoginInput, LoginResponse, RegisterInput } from "@meshbot/types-agent";

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const { data } = await apiClient.get<AuthStatus>("/api/auth/status");
  return data;
}

export async function login(input: LoginInput): Promise<LoginResponse> {
  const { data } = await apiClient.post<LoginResponse>("/api/auth/login", input);
  setAccessToken(data.access_token);
  return data;
}

export async function register(input: RegisterInput): Promise<LoginResponse> {
  const { data } = await apiClient.post<LoginResponse>("/api/auth/register", input);
  setAccessToken(data.access_token);
  return data;
}

export function useAuthStatus() {
  return useQuery({
    queryKey: ["auth", "status"],
    queryFn: fetchAuthStatus,
  });
}

export function useLogin() {
  return useMutation({
    mutationFn: login,
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: register,
  });
}
```

- [ ] **Step 2: 创建 model-config.ts**

在 `apps/web-agent/src/rest/model-config.ts` 中：

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@meshbot/common";
import type { ProviderDef, ModelConfigInput } from "@meshbot/common";

export interface ModelConfig {
  id: string;
  providerType: string;
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function fetchProviders(): Promise<ProviderDef[]> {
  const { data } = await apiClient.get<ProviderDef[]>("/api/providers");
  return data;
}

export async function fetchModelConfigs(): Promise<ModelConfig[]> {
  const { data } = await apiClient.get<ModelConfig[]>("/api/model-configs");
  return data;
}

export async function createModelConfig(
  input: ModelConfigInput,
): Promise<ModelConfig> {
  const { data } = await apiClient.post<ModelConfig>("/api/model-configs", input);
  return data;
}

export function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: fetchProviders,
  });
}

export function useModelConfigs() {
  return useQuery({
    queryKey: ["model-configs"],
    queryFn: fetchModelConfigs,
  });
}

export function useCreateModelConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createModelConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model-configs"] });
    },
  });
}
```

- [ ] **Step 3: 创建 index.ts**

在 `apps/web-agent/src/rest/index.ts` 中：

```typescript
export {
  useAuthStatus,
  useLogin,
  useRegister,
} from "./auth";

export {
  useProviders,
  useModelConfigs,
  useCreateModelConfig,
} from "./model-config";
```

- [ ] **Step 4: 验证类型**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/web-agent typecheck
```

Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add apps/web-agent/src/rest/
git commit -m "feat: add REST API layer with TanStack Query hooks to web-agent"
```

---

## Task 7: web-agent 登录页

**Files:**
- Create: `apps/web-agent/src/app/login/page.tsx`

- [ ] **Step 1: 创建登录页**

在 `apps/web-agent/src/app/login/page.tsx` 中：

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuthStatus, useLogin } from "@/rest/auth";

export default function LoginPage() {
  const router = useRouter();
  const { data: authStatus, isLoading: statusLoading } = useAuthStatus();
  const loginMutation = useLogin();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (statusLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-400">加载中...</p>
      </main>
    );
  }

  if (authStatus?.needsSetup) {
    router.replace("/setup");
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await loginMutation.mutateAsync({ username, password });
      router.push("/");
    } catch {
      // error is available via loginMutation.error
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-bold text-gray-900">
          登录 MeshBot
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              用户名
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {loginMutation.error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {loginMutation.error instanceof Error
                ? loginMutation.error.message
                : "登录失败，请重试"}
            </div>
          )}

          <button
            type="submit"
            disabled={!username || !password || loginMutation.isPending}
            className="mt-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loginMutation.isPending ? "登录中..." : "登录"}
          </button>
        </form>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: 验证类型**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/web-agent typecheck
```

Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/app/login/
git commit -m "feat: add login page to web-agent"
```

---

## Task 8: 改造 web-agent 首页和 Setup 页

**Files:**
- Modify: `apps/web-agent/src/app/page.tsx`
- Modify: `apps/web-agent/src/app/setup/page.tsx`
- Modify: `apps/web-agent/src/components/setup/model-form.tsx`
- Delete: `apps/web-agent/src/types/electron.d.ts`

- [ ] **Step 1: 改造首页**

将 `apps/web-agent/src/app/page.tsx` 替换为：

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuthStatus } from "@/rest/auth";
import { getAccessToken } from "@meshbot/common";

export default function Home() {
  const router = useRouter();
  const { data: authStatus, isLoading } = useAuthStatus();

  useEffect(() => {
    if (isLoading) return;

    if (!getAccessToken()) {
      if (authStatus?.needsSetup) {
        router.replace("/setup");
      } else {
        router.replace("/login");
      }
      return;
    }

    if (authStatus?.needsSetup) {
      router.replace("/setup");
    }
  }, [authStatus, isLoading, router]);

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-gray-400">加载中...</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-bold">MeshBot Agent</h1>
      <p className="ml-4 text-sm text-gray-400">已就绪</p>
    </main>
  );
}
```

- [ ] **Step 2: 改造 Setup 页**

将 `apps/web-agent/src/app/setup/page.tsx` 替换为：

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import ModelForm from "@/components/setup/model-form";
import ProviderCard from "@/components/setup/provider-card";
import { useAuthStatus, useRegister } from "@/rest/auth";
import { useProviders, useCreateModelConfig } from "@/rest/model-config";
import { getAccessToken } from "@meshbot/common";
import type { ProviderDef, ModelConfigInput } from "@meshbot/common";

type SetupStep = "register" | "model";

export default function SetupPage() {
  const router = useRouter();

  const { data: authStatus, isLoading: statusLoading } = useAuthStatus();
  const { data: providers = [], isLoading: providersLoading } = useProviders();
  const registerMutation = useRegister();
  const createModelMutation = useCreateModelConfig();

  const [step, setStep] = useState<SetupStep>("register");
  const [selected, setSelected] = useState<ProviderDef | null>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);

  if (statusLoading || providersLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-400">加载中...</p>
      </main>
    );
  }

  if (authStatus && !authStatus.needsSetup) {
    router.replace("/");
    return null;
  }

  if (authStatus?.initialized && getAccessToken()) {
    if (step === "register") {
      setStep("model");
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegisterError(null);

    if (password !== confirmPassword) {
      setRegisterError("两次输入的密码不一致");
      return;
    }

    try {
      await registerMutation.mutateAsync({ username, password });
      setStep("model");
    } catch (err) {
      setRegisterError(
        err instanceof Error ? err.message : "注册失败，请重试",
      );
    }
  };

  const handleModelSubmit = async (data: ModelConfigInput) => {
    await createModelMutation.mutateAsync(data);
    router.push("/");
  };

  return (
    <main className="min-h-screen bg-gray-50 py-10">
      <div className="mx-auto max-w-lg px-4">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">
          欢迎使用 MeshBot
        </h1>
        <p className="mb-8 text-gray-500">
          {step === "register" ? "创建账号以开始使用" : "请配置模型以开始使用"}
        </p>

        {step === "register" && (
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-gray-700">
              创建账号
            </h2>
            <form onSubmit={handleRegister} className="flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  用户名 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  密码 <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  确认密码 <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {registerError && (
                <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                  {registerError}
                </div>
              )}

              <button
                type="submit"
                disabled={
                  !username ||
                  !password ||
                  !confirmPassword ||
                  registerMutation.isPending
                }
                className="mt-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {registerMutation.isPending ? "创建中..." : "创建账号并继续"}
              </button>
            </form>
          </div>
        )}

        {step === "model" && (
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">
              选择供应商
            </h2>

            <div className="mb-6 grid grid-cols-2 gap-2">
              {providers.map((p) => (
                <ProviderCard
                  key={p.type}
                  name={p.name}
                  description={p.description}
                  selected={selected?.type === p.type}
                  onSelect={() => setSelected(p)}
                />
              ))}
            </div>

            {selected && (
              <>
                <div className="mb-4 border-t border-gray-100" />
                <h2 className="mb-3 text-sm font-semibold text-gray-700">
                  模型配置
                </h2>
                <ModelForm
                  key={selected.type}
                  provider={selected}
                  onSubmit={handleModelSubmit}
                  submitting={createModelMutation.isPending}
                  error={
                    createModelMutation.error instanceof Error
                      ? createModelMutation.error.message
                      : createModelMutation.error
                        ? "保存失败，请重试"
                        : null
                  }
                />
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: 更新 model-form.tsx 类型引用**

将 `apps/web-agent/src/components/setup/model-form.tsx` 中的 import 从：

```typescript
import type { ModelConfigData, ProviderInfo } from "@/types/electron";
```

替换为：

```typescript
import type { ProviderDef, ModelConfigInput } from "@meshbot/common";
```

同时将 `ModelFormProps` 中的类型对齐：

```typescript
interface ModelFormProps {
  provider: ProviderDef;
  onSubmit: (data: ModelConfigInput) => Promise<void>;
  submitting: boolean;
  error: string | null;
}
```

`handleSubmit` 内部构造的对象已经和 `ModelConfigInput` 兼容（`providerType`, `name`, `model`, `apiKey`, `baseUrl?`），无需改动。

- [ ] **Step 4: 删除 electron.d.ts**

删除文件 `apps/web-agent/src/types/electron.d.ts`。

- [ ] **Step 5: 验证类型**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/web-agent typecheck
```

Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add apps/web-agent/
git commit -m "feat: refactor web-agent pages to use REST API instead of Electron IPC"
```

---

## Task 9: desktop 瘦身

**Files:**
- Delete: `apps/desktop/src/database.ts`
- Modify: `apps/desktop/src/ipc-handlers.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/main.ts`

- [ ] **Step 1: 删除 database.ts**

删除文件 `apps/desktop/src/database.ts`。

- [ ] **Step 2: 精简 ipc-handlers.ts**

将 `apps/desktop/src/ipc-handlers.ts` 替换为：

```typescript
import { type BrowserWindow, ipcMain } from "electron";

export function registerIpcHandlers(
  _getMainWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle("is-electron", () => true);
}
```

- [ ] **Step 3: 精简 preload.ts**

将 `apps/desktop/src/preload.ts` 替换为：

```typescript
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
});
```

- [ ] **Step 4: 更新 main.ts**

将 `apps/desktop/src/main.ts` 替换为：

```typescript
import { type ChildProcess, fork } from "node:child_process";
import * as http from "node:http";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { registerIpcHandlers } from "./ipc-handlers";

const MESHBOT_DIR = path.join(homedir(), ".meshbot");

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

function ensureDirs(): void {
  mkdirSync(MESHBOT_DIR, { recursive: true });
  mkdirSync(path.join(MESHBOT_DIR, "logs"), { recursive: true });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadURL("http://localhost:3001");

  if (!app.isPackaged) {
    win.webContents.openDevTools();
  }

  return win;
}

function pollForReady(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const endTime = Date.now() + timeoutMs;

    const poll = () => {
      if (Date.now() >= endTime) {
        reject(new Error(`server-agent start timeout (${timeoutMs / 1000}s)`));
        return;
      }

      const req = http.get(
        "http://localhost:3100",
        (res: http.IncomingMessage) => {
          res.resume();
          resolve();
        },
      );
      req.on("error", () => {
        setTimeout(poll, 500);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(poll, 500);
      });
    };
    setTimeout(poll, 1000);
  });
}

async function forkServerAgent(): Promise<void> {
  const serverAgentPath = path.join(
    process.resourcesPath,
    "server-agent",
    "main.js",
  );
  let restartCount = 0;

  return new Promise((resolve, reject) => {
    const doFork = () => {
      serverProcess = fork(serverAgentPath, [], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          MESHBOT_DIR: MESHBOT_DIR,
        },
      });

      let stderr = "";

      serverProcess.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      serverProcess.on("error", (err) => {
        reject(new Error(`server-agent fork failed: ${err.message}`));
      });

      serverProcess.on("exit", (code) => {
        if (code !== 0 && code !== null && restartCount < 3) {
          restartCount++;
          stderr = "";
          setTimeout(doFork, 2000);
        } else if (code !== 0 && code !== null) {
          reject(
            new Error(
              `server-agent exited with code ${code} after ${restartCount + 1} attempts\n${stderr}`,
            ),
          );
        }
      });

      pollForReady(30000)
        .then(resolve)
        .catch((_err) => {
          if (serverProcess) {
            serverProcess.kill();
            serverProcess = null;
          }
          reject(new Error(`server-agent start timeout (30s)\n${stderr}`));
        });
    };

    doFork();
  });
}

function startServerAgent(): Promise<void> {
  if (app.isPackaged) {
    return forkServerAgent();
  }
  return connectToServerAgent();
}

async function connectToServerAgent(): Promise<void> {
  while (true) {
    try {
      await pollForReady(10000);
      return;
    } catch {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "server-agent 未启动",
        message:
          "开发模式下需要手动启动 server-agent。\n\n请在终端运行：pnpm dev:server-agent\n然后点击「重试」。",
        buttons: ["重试", "退出"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 1) {
        app.quit();
        return;
      }
    }
  }
}

app.whenReady().then(async () => {
  try {
    ensureDirs();

    await startServerAgent();

    registerIpcHandlers(() => mainWindow);

    mainWindow = createWindow();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      "启动失败",
      `无法初始化应用：${message}\n\n请检查 ${MESHBOT_DIR} 目录权限`,
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
  }
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.send("shutdown");
    setTimeout(() => {
      if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
      }
    }, 3000);
  }
});
```

- [ ] **Step 5: 验证类型**

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/desktop typecheck
```

Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/
git commit -m "refactor: remove API proxy from desktop, keep only window management"
```

---

## Task 10: 全局验证与最终提交

- [ ] **Step 1: 全量类型检查**

```bash
cd /Users/grant/Meta1/meshbot && pnpm typecheck
```

Expected: 所有包无错误

- [ ] **Step 2: 格式检查与修复**

```bash
cd /Users/grant/Meta1/meshbot && pnpm check
```

Expected: 无格式错误（biome 自动修复）

- [ ] **Step 3: 构建验证**

```bash
cd /Users/grant/Meta1/meshbot && pnpm build
```

Expected: 所有包构建成功

- [ ] **Step 4: 手动冒烟测试**

1. 启动 server-agent：`pnpm dev:server-agent`
2. 启动 web-agent：`pnpm dev:web-agent`
3. 浏览器打开 `http://localhost:3001`
4. 验证：
   - 首次访问 → 跳转 Setup 页
   - 注册账号 → 进入模型配置
   - 配置模型 → 跳转首页
   - 关闭浏览器重新打开 → 跳转登录页
   - 登录 → 进入首页

- [ ] **Step 5: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: address issues found during smoke test"
```
