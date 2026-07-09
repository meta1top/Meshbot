# apps/mobile — RN + Expo 脚手架接入 monorepo 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `apps/mobile` 建一个接入 monorepo 的 Expo(RN)脚手架,预铺与 web-agent 对齐的数据层约定,`expo start` 能起且首屏可见「由 `@meshbot/types` 派生」的内容。

**Architecture:** Expo SDK 55 + Expo Router(文件路由,`src/app`)+ React 19。经 pnpm workspace / Turbo(`typecheck`/`dev`)/ 根 Biome 接入;共享 `@meshbot/types`;Metro monorepo 自动配置(不手写 watchFolders)。数据层:TanStack Query + jotai + axios stub + socket stub;UI:NativeWind;i18n:i18next + react-i18next + expo-localization。

**Tech Stack:** Expo SDK 55、Expo Router、React 19、React Native、NativeWind、TanStack Query、jotai、axios、socket.io-client、i18next、react-i18next、expo-localization、zod、`@meshbot/types`。

## Global Constraints

- Expo SDK **55** 稳定版;React **19**(与 web-agent 对齐);`newArchEnabled: true`。
- 包名 `@meshbot/mobile`,`private: true`,`version: 0.0.0`。
- **不手写 `metro.config.js` 的 `watchFolders` / `resolver.nodeModulesPaths`**(SDK 52+ 自动 monorepo 配置)。`metro.config.js` 仅做 NativeWind 包装。
- **不给 mobile 加 Turbo `build` task**(原生构建交给 EAS,本期不涉及)。
- 源码全部收敛在 `apps/mobile/src/`;Expo Router 路由根为 `src/app`。
- TS `strict: true`;`tsconfig` extends `expo/tsconfig.base`;路径别名 `@/*` → `./src/*`。
- 共享 JS 库版本与 web-agent 对齐:`@tanstack/react-query ^5.100.9`、`jotai ^2.20.0`、`axios ^1.16.0`、`socket.io-client ^4.8.3`、`zod ^3.25.76`。
- RN 原生依赖用 `expo install`(选 SDK 兼容版本);纯 JS 库用 `pnpm --filter @meshbot/mobile add`。
- 面向用户字符串走 i18n,不裸写(骨架首屏用 i18next)。
- 公开方法/导出补中文 JSDoc(与仓库约定一致)。
- **NativeWind 版本为实现期首要风险**:默认 v4.2.0(Tailwind v3),若与 SDK 55 的 RN 版本不兼容则回退 v5(Tailwind v4);以 NativeWind 官方 SDK-55 安装指南为准。

## 执行前置(由执行者在 execution 时完成,非本计划任务)

- 当前仓库 `main` 有分支保护 + 活 dev 从主检出热重载。**必须用 git worktree 隔离**执行本计划(见 `superpowers:using-git-worktrees`),不要在主检出上切分支。
- 首个提交把已评审的 spec(`docs/superpowers/specs/2026-07-09-mobile-app-rn-expo-scaffold-design.md`)与本计划一并带上。

---

### Task 1: 生成 Expo SDK 55 脚手架到 apps/mobile

**Files:**
- Create: `apps/mobile/**`(由 `create-expo-app` 生成)
- 目录调整:`apps/mobile/app/` → `apps/mobile/src/app/`

**Interfaces:**
- Produces:一个可 `expo start` 的裸 Expo Router 工程,路由根在 `apps/mobile/src/app/`,含 `_layout.tsx` 与 `index.tsx`。

- [ ] **Step 1: 用 SDK 55 模板生成(不自动安装依赖)**

从仓库根运行:

```bash
npx create-expo-app@latest apps/mobile --template default@sdk-55 --no-install
```

说明:`--no-install` 避免 create-expo-app 用 npm 触碰 pnpm workspace。若该 flag 在当前 create-expo-app 版本不被识别,改为生成到 scratchpad 再拷入:
```bash
npx create-expo-app@latest /private/tmp/mobile-gen --template default@sdk-55 --no-install
cp -R /private/tmp/mobile-gen/. apps/mobile/
rm -rf apps/mobile/node_modules
```

- [ ] **Step 2: 把路由目录挪到 src/app,清理示例**

```bash
mkdir -p apps/mobile/src
git -C apps/mobile mv app src/app 2>/dev/null || mv apps/mobile/app apps/mobile/src/app
```

删除模板自带的示例 tab 路由 / 示例组件,只保留 `src/app/_layout.tsx` 与 `src/app/index.tsx`;把 `_layout.tsx` 精简为一个 `Stack`,`index.tsx` 精简为一个占位 `Text`。若模板生成了 `components/`、`hooks/`、`constants/` 等示例目录,一并删除(本期从零铺)。

`apps/mobile/src/app/_layout.tsx`(临时最小版,后续 Task 5 扩展):
```tsx
import { Stack } from "expo-router";

export default function RootLayout() {
  return <Stack />;
}
```

`apps/mobile/src/app/index.tsx`(临时最小版,后续 Task 3/4/6 扩展):
```tsx
import { Text, View } from "react-native";

export default function Home() {
  return (
    <View>
      <Text>meshbot mobile</Text>
    </View>
  );
}
```

- [ ] **Step 3: 确认路由根被 Expo Router 识别**

Expo Router 自动探测 `app` 或 `src/app`。确认 `apps/mobile/package.json` 的 `main` 为 `expo-router/entry`(模板默认如此);若模板用了 `app.json` 里的 `expo.entryPoint` 或其它入口,保持默认即可。

Run(仅确认文件结构):
```bash
ls apps/mobile/src/app
```
Expected: 输出包含 `_layout.tsx` 与 `index.tsx`。

- [ ] **Step 4: 提交**

```bash
git add apps/mobile docs/superpowers
git commit -m "feat(mobile): 生成 Expo SDK 55 脚手架并收敛路由到 src/app"
```

---

### Task 2: 接入 monorepo(package.json / tsconfig / gitignore / 根脚本)

**Files:**
- Modify: `apps/mobile/package.json`
- Create/Modify: `apps/mobile/tsconfig.json`
- Modify: `apps/mobile/.gitignore`
- Modify: `package.json`(仓库根,加 `dev:mobile`)

**Interfaces:**
- Consumes:Task 1 的裸工程。
- Produces:`@meshbot/mobile` 包被 pnpm/Turbo 识别;`typecheck` 脚本可被 `turbo run typecheck` 拾取;根 `dev:mobile` 脚本。

- [ ] **Step 1: 改写 apps/mobile/package.json 的 name/scripts**

把 `name` 改为 `@meshbot/mobile`,`version` 设 `0.0.0`,`private: true`,并设置脚本。保留模板生成的 `expo` / `react` / `react-native` / `expo-router` 等依赖版本不动,仅改 name 与 scripts:

```jsonc
{
  "name": "@meshbot/mobile",
  "version": "0.0.0",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "dev": "expo start",
    "ios": "expo start --ios",
    "android": "expo start --android",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf .expo dist"
  }
  // dependencies / devDependencies 保留模板生成内容,Task 3-6 再增补
}
```

说明:不加 `build` / `lint` 脚本 —— 原生构建交 EAS(本期不做);lint 由仓库根 `biome lint .` 统一覆盖。

- [ ] **Step 2: 写 tsconfig.json**

`apps/mobile/tsconfig.json`:
```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "resolveJsonModule": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": [
    "**/*.ts",
    "**/*.tsx",
    ".expo/types/**/*.ts",
    "expo-env.d.ts",
    "nativewind-env.d.ts"
  ]
}
```

- [ ] **Step 3: 补 .gitignore**

确认 `apps/mobile/.gitignore` 覆盖以下项(模板通常已含 `.expo`、`node_modules`、`ios`、`android`;缺则补齐,并显式加 `dist/`):
```
node_modules/
.expo/
dist/
ios/
android/
*.log
```

- [ ] **Step 4: 根 package.json 加 dev:mobile**

在仓库根 `package.json` 的 `scripts` 中,`dev:cli` 一行后加:
```json
    "dev:mobile": "turbo run dev --filter=@meshbot/mobile",
```

- [ ] **Step 5: 安装并验证 pnpm 解析**

从仓库根:
```bash
pnpm install
```
Expected: 成功,`@meshbot/mobile` 出现在 workspace(无 `ERR_PNPM`)。若某原生包 postinstall 被 hoisted 拦下报错,按报错把该包加入 `pnpm-workspace.yaml` 的 `allowBuilds` 后重装。

- [ ] **Step 6: 验证 typecheck 通过并被 Turbo 拾取**

```bash
pnpm --filter @meshbot/mobile exec tsc --noEmit
```
Expected: 无输出、退出码 0(PASS)。

```bash
pnpm typecheck
```
Expected: Turbo 运行包含 `@meshbot/mobile#typecheck` 且全绿。

- [ ] **Step 7: 验证 Biome 干净**

```bash
pnpm exec biome check apps/mobile
```
Expected: `Checked N files ... No fixes needed`(或仅格式化后干净)。如有可自动修的格式问题:`pnpm exec biome check --write apps/mobile`。

- [ ] **Step 8: 提交**

```bash
git add apps/mobile package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore(mobile): 接入 pnpm/Turbo/TS/Biome"
```

---

### Task 3: 共享 @meshbot/types 依赖 + Metro 解析验证

**Files:**
- Modify: `apps/mobile/package.json`(加 `@meshbot/types` 依赖)
- Modify: `apps/mobile/src/app/index.tsx`

**Interfaces:**
- Consumes:`@meshbot/types` 导出的 `PageRequestSchema`(`z.object({ page, size })`,`parse({})` → `{ page: 1, size: 20 }`)。
- Produces:首屏渲染一段由该 schema 派生的文本,作为 workspace + Metro 解析打通的可见证据。

- [ ] **Step 1: 加依赖**

```bash
pnpm --filter @meshbot/mobile add @meshbot/types@workspace:*
```
Expected: `apps/mobile/package.json` 出现 `"@meshbot/types": "workspace:*"`。

- [ ] **Step 2: index.tsx 导入并派生渲染**

`apps/mobile/src/app/index.tsx`:
```tsx
import { PageRequestSchema } from "@meshbot/types";
import { Text, View } from "react-native";

export default function Home() {
  const page = PageRequestSchema.parse({});
  return (
    <View>
      <Text>meshbot mobile</Text>
      <Text>
        @meshbot/types → page {page.page} / size {page.size}
      </Text>
    </View>
  );
}
```

- [ ] **Step 3: typecheck 验证类型解析**

```bash
pnpm build:types && pnpm --filter @meshbot/mobile exec tsc --noEmit
```
Expected: PASS(证明 TS 能解析 `@meshbot/types` 的类型)。

- [ ] **Step 4: expo export 验证 Metro 解析(确定性、非交互)**

```bash
pnpm --filter @meshbot/mobile exec expo export -p ios
```
Expected: 打包成功、产物写入 `apps/mobile/dist/`,**无** `Unable to resolve "@meshbot/types"` 之类报错 —— 证明 Metro 在 monorepo 下解析到了 workspace 包。

- [ ] **Step 5: 手动可视核对(可选,记录用)**

```bash
pnpm --filter @meshbot/mobile dev
```
在 iOS 模拟器 / Expo Go 打开,应见 "meshbot mobile" 与 "@meshbot/types → page 1 / size 20"。核对后 `Ctrl-C` 结束。

- [ ] **Step 6: 提交**

```bash
git add apps/mobile
git commit -m "feat(mobile): 引用 @meshbot/types 并在首屏验证 workspace 解析"
```

---

### Task 4: NativeWind(Tailwind-for-RN)

**Files:**
- Modify: `apps/mobile/package.json`(nativewind + tailwindcss)
- Create: `apps/mobile/babel.config.js`、`apps/mobile/metro.config.js`、`apps/mobile/tailwind.config.js`、`apps/mobile/global.css`、`apps/mobile/nativewind-env.d.ts`
- Modify: `apps/mobile/src/app/index.tsx`(加 className)

**Interfaces:**
- Consumes:Task 3 的首屏。
- Produces:NativeWind 生效;首屏用 `className` 排版。

- [ ] **Step 1: 先定版本(实现期首要验证项)**

查 NativeWind 官方 SDK-55 安装指南,确认与 SDK 55 的 RN 版本兼容的 NativeWind 版本:默认目标 **nativewind v4.2.0 + tailwindcss v3**;若指南表明需 v5(Tailwind v4),则改用 v5,并以指南给出的 babel/metro/tailwind/postcss 配置为准(覆盖下面 Step 2-5 的 v4 写法)。记录最终选定版本。

安装(v4 路径):
```bash
pnpm --filter @meshbot/mobile add nativewind
pnpm --filter @meshbot/mobile add -D tailwindcss@^3.4
```

- [ ] **Step 2: babel.config.js**

`apps/mobile/babel.config.js`:
```js
module.exports = (api) => {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }], "nativewind/babel"],
  };
};
```

- [ ] **Step 3: metro.config.js(仅做 NativeWind 包装,不碰 monorepo 配置)**

`apps/mobile/metro.config.js`:
```js
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: "./global.css" });
```

- [ ] **Step 4: tailwind.config.js + global.css + 类型声明**

`apps/mobile/tailwind.config.js`:
```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: { extend: {} },
  plugins: [],
};
```

`apps/mobile/global.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`apps/mobile/nativewind-env.d.ts`:
```ts
/// <reference types="nativewind/types" />
```

- [ ] **Step 5: index.tsx 加 className**

`apps/mobile/src/app/index.tsx`:
```tsx
import { PageRequestSchema } from "@meshbot/types";
import { Text, View } from "react-native";

export default function Home() {
  const page = PageRequestSchema.parse({});
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-white">
      <Text className="text-2xl font-bold text-neutral-900">meshbot mobile</Text>
      <Text className="text-sm text-neutral-400">
        @meshbot/types → page {page.page} / size {page.size}
      </Text>
    </View>
  );
}
```

- [ ] **Step 6: 验证**

```bash
pnpm --filter @meshbot/mobile exec tsc --noEmit
```
Expected: PASS(`className` 被 nativewind 类型接受)。

```bash
pnpm --filter @meshbot/mobile exec expo export -p ios
```
Expected: 打包成功,无 NativeWind / CSS 相关报错。

手动核对:`pnpm --filter @meshbot/mobile dev` → 首屏文字居中、标题加粗(样式生效)。

- [ ] **Step 7: 提交**

```bash
git add apps/mobile
git commit -m "feat(mobile): 接入 NativeWind 并在首屏应用 Tailwind 类"
```

---

### Task 5: 数据层约定(TanStack Query + jotai + axios/socket stub)

**Files:**
- Modify: `apps/mobile/package.json`
- Create: `apps/mobile/src/lib/query.ts`、`apps/mobile/src/lib/api.ts`、`apps/mobile/src/lib/socket.ts`、`apps/mobile/src/store/index.ts`
- Modify: `apps/mobile/src/app/_layout.tsx`

**Interfaces:**
- Consumes:Task 1 的 `_layout.tsx`。
- Produces:根布局挂 `QueryClientProvider` + jotai `Provider`;导出 `queryClient`、`apiClient`、`getSocket()`、`appReadyAtom`。

- [ ] **Step 1: 加依赖(版本对齐 web-agent)**

```bash
pnpm --filter @meshbot/mobile add @tanstack/react-query@^5.100.9 jotai@^2.20.0 axios@^1.16.0 socket.io-client@^4.8.3 zod@^3.25.76
```

- [ ] **Step 2: src/lib/query.ts**

```ts
import { QueryClient } from "@tanstack/react-query";

/** 全局 QueryClient 单例(与 web-agent 的服务端状态约定对齐)。 */
export const queryClient = new QueryClient();
```

- [ ] **Step 3: src/lib/api.ts**

```ts
import axios from "axios";

/**
 * 全局 axios 客户端。baseURL 走 Expo 公有环境变量 `EXPO_PUBLIC_API_BASE_URL`。
 * 鉴权 header 注入留待后续(本期不实现登录/鉴权)。
 */
export const apiClient = axios.create({
  baseURL: process.env.EXPO_PUBLIC_API_BASE_URL ?? "",
});
```

- [ ] **Step 4: src/lib/socket.ts**

```ts
import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * 惰性创建 socket.io 客户端(stub)。`autoConnect: false` —— 本期仅立约定,不建活连接。
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(process.env.EXPO_PUBLIC_API_BASE_URL ?? "", { autoConnect: false });
  }
  return socket;
}
```

- [ ] **Step 5: src/store/index.ts**

```ts
import { atom } from "jotai";

/** 占位客户端状态,示范 jotai 约定。 */
export const appReadyAtom = atom(false);
```

- [ ] **Step 6: _layout.tsx 挂 Providers**

`apps/mobile/src/app/_layout.tsx`:
```tsx
import "../../global.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { Provider as JotaiProvider } from "jotai";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { queryClient } from "@/lib/query";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <JotaiProvider>
        <QueryClientProvider client={queryClient}>
          <Stack screenOptions={{ headerShown: false }} />
        </QueryClientProvider>
      </JotaiProvider>
    </SafeAreaProvider>
  );
}
```

说明:`react-native-safe-area-context` 是 expo-router 的 peer 依赖,模板通常已装;若 `tsc` 报缺失,`pnpm --filter @meshbot/mobile exec expo install react-native-safe-area-context`。`global.css` 从 `src/app/_layout.tsx` 到项目根为 `../../global.css`。

- [ ] **Step 7: 验证**

```bash
pnpm --filter @meshbot/mobile exec tsc --noEmit
```
Expected: PASS。

```bash
pnpm --filter @meshbot/mobile exec expo export -p ios
```
Expected: 打包成功。

- [ ] **Step 8: 提交**

```bash
git add apps/mobile
git commit -m "feat(mobile): 预铺数据层约定(Query/jotai/axios/socket stub)"
```

---

### Task 6: i18n(i18next + react-i18next + expo-localization)

**Files:**
- Modify: `apps/mobile/package.json`
- Create: `apps/mobile/src/i18n/config.ts`、`apps/mobile/messages/en.json`、`apps/mobile/messages/zh.json`
- Modify: `apps/mobile/src/app/_layout.tsx`(引入 i18n 初始化)、`apps/mobile/src/app/index.tsx`(用 `t()`)

**Interfaces:**
- Consumes:Task 5 的 `_layout.tsx`、Task 4 的 `index.tsx`。
- Produces:i18next 初始化(按系统语言选 en/zh,fallback en);首屏文案走 `t()`。

- [ ] **Step 1: 加依赖**

```bash
pnpm --filter @meshbot/mobile add i18next@^25 react-i18next@^15
pnpm --filter @meshbot/mobile exec expo install expo-localization
```
说明:`expo-localization` 用 `expo install` 选 SDK 兼容版本;i18next/react-i18next 版本以安装时最新稳定为准(上面为下限)。

- [ ] **Step 2: messages/en.json 与 zh.json**

`apps/mobile/messages/en.json`:
```json
{
  "home": {
    "title": "meshbot mobile",
    "subtitle": "Scaffold ready"
  }
}
```

`apps/mobile/messages/zh.json`:
```json
{
  "home": {
    "title": "meshbot 移动端",
    "subtitle": "脚手架就绪"
  }
}
```

- [ ] **Step 3: src/i18n/config.ts**

```ts
import { getLocales } from "expo-localization";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const systemLanguage = getLocales()[0]?.languageCode ?? "en";

/** i18next 初始化:按系统语言选 zh/en,fallback en。resources 复用 messages/*.json。 */
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: systemLanguage.startsWith("zh") ? "zh" : "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
```

- [ ] **Step 4: _layout.tsx 引入 i18n 初始化(副作用导入)**

在 `apps/mobile/src/app/_layout.tsx` 顶部,`global.css` 导入之后加一行:
```tsx
import "../../global.css";
import "@/i18n/config";
```
(其余 `_layout.tsx` 内容保持 Task 5 的版本不变。)

- [ ] **Step 5: index.tsx 用 t()**

`apps/mobile/src/app/index.tsx`:
```tsx
import { PageRequestSchema } from "@meshbot/types";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

export default function Home() {
  const { t } = useTranslation();
  const page = PageRequestSchema.parse({});
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-white">
      <Text className="text-2xl font-bold text-neutral-900">{t("home.title")}</Text>
      <Text className="text-base text-neutral-500">{t("home.subtitle")}</Text>
      <Text className="text-sm text-neutral-400">
        @meshbot/types → page {page.page} / size {page.size}
      </Text>
    </View>
  );
}
```

- [ ] **Step 6: 验证**

```bash
pnpm --filter @meshbot/mobile exec tsc --noEmit
```
Expected: PASS(`resolveJsonModule` 已开,JSON import 通过类型)。

```bash
pnpm --filter @meshbot/mobile exec expo export -p ios
```
Expected: 打包成功。

手动核对:`pnpm --filter @meshbot/mobile dev` → 首屏显示 title/subtitle 文案;系统语言为中文时显示中文。

- [ ] **Step 7: 提交**

```bash
git add apps/mobile
git commit -m "feat(mobile): 接入 i18next 并本地化首屏文案"
```

---

### Task 7: 全量验收 + 收尾

**Files:**
- 无新增;跑全仓验证。

**Interfaces:**
- Consumes:Task 1-6 的全部产物。
- Produces:通过 spec 第 7 节全部验收标准。

- [ ] **Step 1: 全仓 typecheck**

```bash
pnpm typecheck
```
Expected: 全绿,含 `@meshbot/mobile#typecheck`。

- [ ] **Step 2: 全仓 Biome**

```bash
pnpm lint
```
Expected: 干净(如需修复:`pnpm check:format`)。

- [ ] **Step 3: 逐条核对 spec 验收标准**

对照 `docs/superpowers/specs/2026-07-09-mobile-app-rn-expo-scaffold-design.md` 第 7 节逐项打勾:
1. `pnpm install` 解析 `@meshbot/mobile` ✓(Task 2)
2. `expo start` 起 + 首屏见 `@meshbot/types` 派生内容 ✓(Task 3 手动核对)
3. `pnpm typecheck` 覆盖并通过 ✓(本任务 Step 1)
4. `pnpm lint` 干净 ✓(本任务 Step 2)
5. NativeWind className 生效 ✓(Task 4 手动核对)
6. i18next 按系统语言切换 ✓(Task 6 手动核对)

- [ ] **Step 4: 静态围栏(确认 mobile 不触发后端围栏)**

```bash
pnpm check
```
Expected: 全绿。mobile 无 Entity/Service/事务/Repository,后端围栏应对其无影响;若某围栏误扫前端目录,记录并按围栏脚本的 include 规则排除(仅当确为误报)。

- [ ] **Step 5: 最终提交(若前几步有格式/微调改动)**

```bash
git add -A
git commit -m "chore(mobile): 通过全量 typecheck/lint/围栏验收"
```

---

## Self-Review

**1. Spec coverage(逐节核对 spec):**
- §1 目标/非目标 → 全部任务范围内;WS 仅 stub(Task 5)、无鉴权/业务(未建任务,符合非目标)✓
- §2 决策(SDK55/Router/Query/jotai/axios/zod/i18next/NativeWind)→ Task 1/3/4/5/6 覆盖 ✓
- §2 Metro 自动配置(不手写)→ Task 4 Step 3 明确 ✓
- §2 NativeWind 版本风险 → Task 4 Step 1 首要验证 ✓
- §3 目录结构 → Task 1(src/app)、Task 5(lib/store)、Task 6(i18n/messages)✓
- §4 接线(pnpm/Turbo 不加 build/Biome/TS)→ Task 2 ✓
- §5 数据层每个文件 → Task 5 全覆盖;i18n → Task 6 ✓
- §6 首屏行为(NativeWind+i18n+types 派生、不发网络请求)→ Task 6 最终 index.tsx ✓
- §7 验收 6 条 → Task 7 Step 3 逐条 ✓

**2. Placeholder scan:** 无 "TBD/TODO 待补";api.ts 的「鉴权留待后续」是 spec 明确的范围边界注释,非计划占位。所有代码步骤含完整代码。✓

**3. Type consistency:** `queryClient`(query.ts↔_layout)、`apiClient`(api.ts)、`getSocket()`(socket.ts)、`appReadyAtom`(store)、`PageRequestSchema.parse({})→{page,size}`(index.tsx)、`t("home.title"/"home.subtitle")` 与 messages 键一致、`withNativeWind`/`nativewind/preset`/`nativewind/babel` 命名一致。index.tsx 跨 Task 3→4→6 增量演进,最终版与 §6 一致。✓
