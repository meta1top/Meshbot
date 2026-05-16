# MeshBot Monorepo 初始化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 初始化 MeshBot monorepo 骨架，包含 5 个应用、2 个后端库、2 个前端包，能通过 `pnpm install && pnpm build`。

**Architecture:** pnpm workspace 管理 9 个子包，Turborepo 编排构建。底层库（types）先构建，上层应用依赖它们。各 NestJS 应用作为独立 standalone 项目，不使用 NestJS 内置 monorepo 模式。

**Tech Stack:** pnpm, Turborepo, TypeScript, NestJS, Next.js (App Router), Electron, Tailwind CSS v4, shadcn/ui, Zod

---

## 文件结构总览

```
meshbot/
├── package.json                          # 根级配置
├── pnpm-workspace.yaml                   # workspace 声明
├── turbo.json                            # Turborepo pipeline
├── tsconfig.base.json                    # 共享 TS 配置
├── .gitignore                            # (已存在)
├── libs/
│   ├── types/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   └── shared/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/index.ts
├── packages/
│   ├── common/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   └── design/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/index.ts
├── apps/
│   ├── server-agent/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── nest-cli.json
│   │   └── src/
│   │       ├── main.ts
│   │       └── app.module.ts
│   ├── server-main/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── nest-cli.json
│   │   └── src/
│   │       ├── main.ts
│   │       └── app.module.ts
│   ├── web-agent/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── next.config.ts
│   │   ├── postcss.config.mjs
│   │   └── src/app/
│   │       ├── layout.tsx
│   │       ├── page.tsx
│   │       └── globals.css
│   ├── web-main/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── next.config.ts
│   │   ├── postcss.config.mjs
│   │   └── src/app/
│   │       ├── layout.tsx
│   │       ├── page.tsx
│   │       └── globals.css
│   └── desktop/
│       ├── package.json
│       ├── tsconfig.json
│       ├── electron-builder.yml
│       └── src/
│           ├── main.ts
│           └── preload.ts
```

---

### Task 1: 根级配置文件

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`

- [ ] **Step 1: 创建根 `package.json`**

```json
{
  "name": "meshbot",
  "private": true,
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "clean": "turbo run clean && rm -rf node_modules"
  },
  "devDependencies": {
    "turbo": "^2",
    "typescript": "^5"
  },
  "packageManager": "pnpm@10.8.1"
}
```

- [ ] **Step 2: 创建 `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'libs/*'
  - 'packages/*'
```

- [ ] **Step 3: 创建 `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "clean": {
      "cache": false
    }
  }
}
```

- [ ] **Step 4: 创建 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "node",
    "incremental": true
  },
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json
git commit -m "chore: add root monorepo config files"
```

---

### Task 2: libs/types — @meshbot/types

**Files:**
- Create: `libs/types/package.json`
- Create: `libs/types/tsconfig.json`
- Create: `libs/types/src/index.ts`

- [ ] **Step 1: 创建 `libs/types/package.json`**

```json
{
  "name": "@meshbot/types",
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
    "zod": "^3"
  }
}
```

- [ ] **Step 2: 创建 `libs/types/tsconfig.json`**

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

- [ ] **Step 3: 创建 `libs/types/src/index.ts`**

```typescript
export {};
```

- [ ] **Step 4: 提交**

```bash
git add libs/types/
git commit -m "chore: add @meshbot/types package skeleton"
```

---

### Task 3: libs/shared — @meshbot/shared

**Files:**
- Create: `libs/shared/package.json`
- Create: `libs/shared/tsconfig.json`
- Create: `libs/shared/src/index.ts`

- [ ] **Step 1: 创建 `libs/shared/package.json`**

```json
{
  "name": "@meshbot/shared",
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
    "@meshbot/types": "workspace:*"
  },
  "peerDependencies": {
    "@nestjs/common": "^11",
    "@nestjs/core": "^11"
  }
}
```

- [ ] **Step 2: 创建 `libs/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 `libs/shared/src/index.ts`**

```typescript
export {};
```

- [ ] **Step 4: 提交**

```bash
git add libs/shared/
git commit -m "chore: add @meshbot/shared package skeleton"
```

---

### Task 4: packages/common — @meshbot/common

**Files:**
- Create: `packages/common/package.json`
- Create: `packages/common/tsconfig.json`
- Create: `packages/common/src/index.ts`

- [ ] **Step 1: 创建 `packages/common/package.json`**

```json
{
  "name": "@meshbot/common",
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
    "@meshbot/types": "workspace:*"
  }
}
```

- [ ] **Step 2: 创建 `packages/common/tsconfig.json`**

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

- [ ] **Step 3: 创建 `packages/common/src/index.ts`**

```typescript
export {};
```

- [ ] **Step 4: 提交**

```bash
git add packages/common/
git commit -m "chore: add @meshbot/common package skeleton"
```

---

### Task 5: packages/design — @meshbot/design

**Files:**
- Create: `packages/design/package.json`
- Create: `packages/design/tsconfig.json`
- Create: `packages/design/src/index.ts`

导出 TSX 源码，不预编译。消费方 Next.js 通过 `transpilePackages` 编译。

- [ ] **Step 1: 创建 `packages/design/package.json`**

```json
{
  "name": "@meshbot/design",
  "version": "0.0.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "echo 'no build needed — consumed as source'",
    "clean": "echo 'nothing to clean'",
    "typecheck": "tsc --project tsconfig.json --noEmit"
  },
  "dependencies": {
    "tailwind-merge": "^3",
    "clsx": "^2",
    "class-variance-authority": "^0.7"
  },
  "peerDependencies": {
    "react": "^19",
    "react-dom": "^19"
  },
  "devDependencies": {
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "tailwindcss": "^4"
  }
}
```

- [ ] **Step 2: 创建 `packages/design/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 `packages/design/src/index.ts`**

```typescript
export {};
```

- [ ] **Step 4: 提交**

```bash
git add packages/design/
git commit -m "chore: add @meshbot/design package skeleton"
```

---

### Task 6: apps/server-agent — @meshbot/server-agent

**Files:**
- Create: `apps/server-agent/package.json`
- Create: `apps/server-agent/tsconfig.json`
- Create: `apps/server-agent/nest-cli.json`
- Create: `apps/server-agent/src/main.ts`
- Create: `apps/server-agent/src/app.module.ts`

- [ ] **Step 1: 创建 `apps/server-agent/package.json`**

```json
{
  "name": "@meshbot/server-agent",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "start": "node dist/main",
    "clean": "rm -rf dist",
    "typecheck": "tsc --project tsconfig.json --noEmit"
  },
  "dependencies": {
    "@meshbot/shared": "workspace:*",
    "@meshbot/types": "workspace:*",
    "@nestjs/common": "^11",
    "@nestjs/core": "^11",
    "@nestjs/platform-express": "^11",
    "reflect-metadata": "^0.2",
    "rxjs": "^7"
  },
  "devDependencies": {
    "@nestjs/cli": "^11"
  }
}
```

- [ ] **Step 2: 创建 `apps/server-agent/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 `apps/server-agent/nest-cli.json`**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true
  }
}
```

- [ ] **Step 4: 创建 `apps/server-agent/src/app.module.ts`**

```typescript
import { Module } from '@nestjs/common';

@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
```

- [ ] **Step 5: 创建 `apps/server-agent/src/main.ts`**

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3100);
}
bootstrap();
```

- [ ] **Step 6: 提交**

```bash
git add apps/server-agent/
git commit -m "chore: add @meshbot/server-agent app skeleton"
```

---

### Task 7: apps/server-main — @meshbot/server-main

**Files:**
- Create: `apps/server-main/package.json`
- Create: `apps/server-main/tsconfig.json`
- Create: `apps/server-main/nest-cli.json`
- Create: `apps/server-main/src/main.ts`
- Create: `apps/server-main/src/app.module.ts`

- [ ] **Step 1: 创建 `apps/server-main/package.json`**

```json
{
  "name": "@meshbot/server-main",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "start": "node dist/main",
    "clean": "rm -rf dist",
    "typecheck": "tsc --project tsconfig.json --noEmit"
  },
  "dependencies": {
    "@meshbot/shared": "workspace:*",
    "@meshbot/types": "workspace:*",
    "@nestjs/common": "^11",
    "@nestjs/core": "^11",
    "@nestjs/platform-express": "^11",
    "reflect-metadata": "^0.2",
    "rxjs": "^7"
  },
  "devDependencies": {
    "@nestjs/cli": "^11"
  }
}
```

- [ ] **Step 2: 创建 `apps/server-main/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 `apps/server-main/nest-cli.json`**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true
  }
}
```

- [ ] **Step 4: 创建 `apps/server-main/src/app.module.ts`**

```typescript
import { Module } from '@nestjs/common';

@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
```

- [ ] **Step 5: 创建 `apps/server-main/src/main.ts`**

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3200);
}
bootstrap();
```

- [ ] **Step 6: 提交**

```bash
git add apps/server-main/
git commit -m "chore: add @meshbot/server-main app skeleton"
```

---

### Task 8: apps/web-agent — @meshbot/web-agent

**Files:**
- Create: `apps/web-agent/package.json`
- Create: `apps/web-agent/tsconfig.json`
- Create: `apps/web-agent/next.config.ts`
- Create: `apps/web-agent/postcss.config.mjs`
- Create: `apps/web-agent/src/app/globals.css`
- Create: `apps/web-agent/src/app/layout.tsx`
- Create: `apps/web-agent/src/app/page.tsx`

- [ ] **Step 1: 创建 `apps/web-agent/package.json`**

```json
{
  "name": "@meshbot/web-agent",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "next build",
    "dev": "next dev --port 3001",
    "start": "next start",
    "clean": "rm -rf .next out",
    "typecheck": "tsc --project tsconfig.json --noEmit"
  },
  "dependencies": {
    "@meshbot/common": "workspace:*",
    "@meshbot/design": "workspace:*",
    "@meshbot/types": "workspace:*",
    "next": "^15",
    "react": "^19",
    "react-dom": "^19"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "tailwindcss": "^4"
  }
}
```

- [ ] **Step 2: 创建 `apps/web-agent/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src", "next-env.d.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: 创建 `apps/web-agent/next.config.ts`**

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  transpilePackages: ['@meshbot/design', '@meshbot/common'],
};

export default nextConfig;
```

- [ ] **Step 4: 创建 `apps/web-agent/postcss.config.mjs`**

```javascript
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
```

- [ ] **Step 5: 创建 `apps/web-agent/src/app/globals.css`**

```css
@import 'tailwindcss';
```

- [ ] **Step 6: 创建 `apps/web-agent/src/app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MeshBot',
  description: 'MeshBot Agent',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 7: 创建 `apps/web-agent/src/app/page.tsx`**

```tsx
export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-bold">MeshBot Agent</h1>
    </main>
  );
}
```

- [ ] **Step 8: 提交**

```bash
git add apps/web-agent/
git commit -m "chore: add @meshbot/web-agent app skeleton"
```

---

### Task 9: apps/web-main — @meshbot/web-main

**Files:**
- Create: `apps/web-main/package.json`
- Create: `apps/web-main/tsconfig.json`
- Create: `apps/web-main/next.config.ts`
- Create: `apps/web-main/postcss.config.mjs`
- Create: `apps/web-main/src/app/globals.css`
- Create: `apps/web-main/src/app/layout.tsx`
- Create: `apps/web-main/src/app/page.tsx`

- [ ] **Step 1: 创建 `apps/web-main/package.json`**

```json
{
  "name": "@meshbot/web-main",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "next build",
    "dev": "next dev --port 3002",
    "start": "next start",
    "clean": "rm -rf .next out",
    "typecheck": "tsc --project tsconfig.json --noEmit"
  },
  "dependencies": {
    "@meshbot/common": "workspace:*",
    "@meshbot/design": "workspace:*",
    "@meshbot/types": "workspace:*",
    "next": "^15",
    "react": "^19",
    "react-dom": "^19"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "tailwindcss": "^4"
  }
}
```

- [ ] **Step 2: 创建 `apps/web-main/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src", "next-env.d.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: 创建 `apps/web-main/next.config.ts`**

注意：`web-main` 是云平台前端，不需要 `output: 'export'`，走标准 SSR 模式。

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@meshbot/design', '@meshbot/common'],
};

export default nextConfig;
```

- [ ] **Step 4: 创建 `apps/web-main/postcss.config.mjs`**

```javascript
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
```

- [ ] **Step 5: 创建 `apps/web-main/src/app/globals.css`**

```css
@import 'tailwindcss';
```

- [ ] **Step 6: 创建 `apps/web-main/src/app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MeshBot Platform',
  description: 'MeshBot Agent Management Platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 7: 创建 `apps/web-main/src/app/page.tsx`**

```tsx
export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-bold">MeshBot Platform</h1>
    </main>
  );
}
```

- [ ] **Step 8: 提交**

```bash
git add apps/web-main/
git commit -m "chore: add @meshbot/web-main app skeleton"
```

---

### Task 10: apps/desktop — @meshbot/desktop

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/preload.ts`

- [ ] **Step 1: 创建 `apps/desktop/package.json`**

```json
{
  "name": "@meshbot/desktop",
  "version": "0.0.0",
  "private": true,
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "start": "electron dist/main.js",
    "clean": "rm -rf dist",
    "typecheck": "tsc --project tsconfig.json --noEmit",
    "pack": "electron-builder --dir",
    "dist": "electron-builder"
  },
  "dependencies": {
    "electron-updater": "^6"
  },
  "devDependencies": {
    "electron": "^35",
    "electron-builder": "^25"
  }
}
```

- [ ] **Step 2: 创建 `apps/desktop/tsconfig.json`**

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

- [ ] **Step 3: 创建 `apps/desktop/electron-builder.yml`**

```yaml
appId: com.meshbot.desktop
productName: MeshBot
directories:
  output: release
files:
  - dist/**/*
mac:
  target:
    - dmg
    - zip
win:
  target:
    - nsis
linux:
  target:
    - AppImage
```

- [ ] **Step 4: 创建 `apps/desktop/src/preload.ts`**

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  onServerReady: (callback: () => void) =>
    ipcRenderer.on('server-ready', () => callback()),
});
```

- [ ] **Step 5: 创建 `apps/desktop/src/main.ts`**

```typescript
import { app, BrowserWindow } from 'electron';
import * as path from 'path';

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:3001');
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
```

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/
git commit -m "chore: add @meshbot/desktop app skeleton"
```

---

### Task 11: 安装依赖并验证构建

- [ ] **Step 1: 安装所有依赖**

```bash
pnpm install
```

Expected: 依赖全部安装成功，workspace 链接正确建立。

- [ ] **Step 2: 运行全量构建**

```bash
pnpm build
```

Expected: 所有 9 个包构建成功（`@meshbot/design` 输出 "no build needed"）。

- [ ] **Step 3: 如果构建失败，修复问题并重新构建**

根据错误信息修复。常见问题：
- 类型版本不匹配：检查各包的 `tsconfig.json` 是否正确 extends
- workspace 引用失败：检查 `pnpm-workspace.yaml` 路径
- NestJS 编译错误：检查 `reflect-metadata` 是否安装

- [ ] **Step 4: 提交 lockfile**

```bash
git add pnpm-lock.yaml
git commit -m "chore: add pnpm lockfile after initial install"
```

---

### Task 12: 更新 .cursor/rules 规范文件

**Files:**
- Modify: `.cursor/rules/`

按实际仓库结构创建规约文件。详见 Phase 2 的 skills 同步任务。
