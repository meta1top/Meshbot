# apps/mobile — RN + Expo 脚手架接入 monorepo 设计

- 日期：2026-07-09
- 状态：待评审
- 范围：**仅脚手架 + 数据层约定**，接入现有 pnpm/Turbo monorepo，不实现任何业务功能

## 1. 目标与非目标

### 目标

1. 在 `apps/mobile` 新建一个 Expo（React Native）工程，包名 `@meshbot/mobile`。
2. 接入现有 monorepo：pnpm workspace、Turbo（`typecheck` / `lint` / `dev`）、共享 `@meshbot/types`、根 TS、Biome。
3. 预铺一套与 web-agent 对齐的**数据层约定**：TanStack Query + jotai + axios 客户端 stub + zod/共享 schema + i18n（RN 版）+ NativeWind。
4. `expo start` 能起，占位首屏渲染一段**由导入的 `@meshbot/types` schema 派生**的内容，证明 Metro 能解析 workspace 包。

### 非目标（YAGNI）

- 不实现登录/鉴权、会话聊天、设备管理、模型配置等任何业务功能。
- 不建活的 WebSocket 连接（仅留 `socket.ts` stub 约定）。
- 不接 EAS Build / EAS Update / 推送（后续单独立项）。
- 不产出原生 `ios/` `android/` 目录（走 CNG/prebuild，按需生成，不进仓）。
- 不改动其它 app 或 libs。

## 2. 关键技术决策

| 决策点 | 选型 | 理由 |
|--------|------|------|
| 目录/包名 | `apps/mobile` / `@meshbot/mobile` | 与 web-agent/server-agent 命名风格一致 |
| Expo SDK | **SDK 55**（稳定） | 不追 main/SDK 56 beta；React 19，与 web-agent 完全一致 |
| 路由 | **Expo Router**（文件路由） | 与 web-agent 的 `src/app` 心智对齐；官方默认 |
| 服务端状态 | `@tanstack/react-query` | 与 web-agent 同 |
| 客户端状态 | `jotai` | 与 web-agent 同 |
| HTTP | `axios` | 与 web-agent 同；`src/lib/api.ts` 客户端 stub |
| 校验/契约 | `zod` + `@meshbot/types` | 直接复用共享 schema |
| i18n | **i18next + react-i18next + expo-localization** | RN 生态最成熟；next-intl 是 Next 专用，RN 用不了 |
| UI/样式 | **NativeWind**（Tailwind-for-RN） | 与 web-agent 的 Tailwind 心智对齐；`@meshbot/design`（Radix/shadcn）是 web DOM，RN 用不了 |

### Metro monorepo 配置（重要）

自 Expo SDK 52 起，`expo/metro-config` **自动**为 monorepo（含 pnpm）配置 `watchFolders` 与 `resolver.nodeModulesPaths`；SDK 54+ 连 isolated 依赖也自动处理。本仓 `nodeLinker: hoisted`（扁平 `node_modules`）对 Metro 更友好。

**结论：不手写 `watchFolders` / `nodeModulesPaths`。** `metro.config.js` 只做 NativeWind 的 `withNativewind(getDefaultConfig(...))` 包装。

### NativeWind 版本（实现期首要验证项）

- NativeWind 有两条线：**v4.2.0 稳定版配 Tailwind v3**，以及 **v5 预发布版配 Tailwind v4**（能与 web-agent 的 Tailwind v4 对齐）。
- **默认走 v4.2.0 稳定版 + Tailwind v3**（mobile 自带一份独立 Tailwind config，与 web-agent 的 v4 互不影响；地基不押预发布版）。
- **实现期首要验证**：确认 NativeWind v4.2.0 与 SDK 55 的 RN 版本兼容。若不兼容，回退到 NativeWind v5（面向 Tailwind v4 / 当前 RN 栈）。以 NativeWind 官方 SDK-55 安装指南为准。

## 3. 目录结构

```
apps/mobile/
├── src/
│   ├── app/                 # Expo Router 文件路由
│   │   ├── _layout.tsx      # 根布局：挂 Providers(Query / jotai / i18n / SafeArea)
│   │   └── index.tsx        # 占位首屏（渲染 @meshbot/types 派生内容）
│   ├── lib/
│   │   ├── api.ts           # axios 客户端；baseURL 读 EXPO_PUBLIC_API_BASE_URL
│   │   ├── query.ts         # QueryClient 单例
│   │   └── socket.ts        # socket.io-client stub（不建活连接）
│   ├── store/
│   │   └── index.ts         # jotai atoms（占位一个）
│   ├── i18n/
│   │   └── config.ts        # i18next 初始化 + expo-localization 取系统语言
│   └── components/          # RN 组件（占位）
├── messages/
│   ├── en.json              # 镜像 web-agent/messages 布局，未来可经 sync:locales 共享
│   └── zh.json
├── assets/                  # create-expo-app 默认图标/启动图
├── global.css               # @tailwind 指令（NativeWind）
├── app.json                 # expo 配置；newArchEnabled: true
├── metro.config.js          # withNativewind(getDefaultConfig(__dirname))
├── babel.config.js          # babel-preset-expo + nativewind/babel
├── tailwind.config.js        # content 指向 src/**；nativewind preset
├── nativewind-env.d.ts      # NativeWind 类型
├── tsconfig.json            # extends expo/tsconfig.base；"@/*" → "./src/*"
└── package.json
```

Expo Router 原生支持把路由根放在 `src/app`（自动探测 `app` 或 `src/app`），因此全部源码收敛在 `src/` 下，与 web-agent 一致。

## 4. Monorepo 接线细节

### pnpm

- `apps/*` glob 已覆盖，无需改 `pnpm-workspace.yaml`。
- `package.json` 依赖 `@meshbot/types: workspace:*`。
- 若 Expo/RN 相关原生依赖在 hoisted 下有 postinstall 构建需求，按需补 `pnpm-workspace.yaml` 的 `allowBuilds`（实现期视报错再加，不预先猜）。

### Turbo

- mobile **不产出** web/server 那种 `dist`（原生构建交给 EAS，本期不涉及），因此**不给它加 `build` task**，`turbo run build` 会自然跳过（无 build 脚本）。
- `package.json` 提供 `typecheck`（`tsc --noEmit`）与 `lint` 脚本，被现有 `turbo run typecheck` / 根 Biome 覆盖。
- `dev` 走现有 `dev` task（persistent、no-cache）：`"dev": "expo start"`。
- 根 `package.json` 加脚本 `"dev:mobile": "turbo run dev --filter=@meshbot/mobile"`。

### Biome

- Biome `useIgnoreFile: true` + `includes: ["**", ...]`，靠 git ignore 排除生成物。
- 保证 `apps/mobile/.gitignore` 覆盖：`.expo/`、`dist/`、`ios/`、`android/`、`node_modules/`、`*.log`。
- `expo-env.d.ts` / `nativewind-env.d.ts` 提交入仓。
- `css.parser.tailwindDirectives: true` 已开，`global.css` 的 `@tailwind` 指令天然被接受。

### TypeScript

- `tsconfig.json` `extends: "expo/tsconfig.base"`，`strict: true`，`paths: { "@/*": ["./src/*"] }`。
- 根 `turbo run typecheck` 纳入 mobile。

## 5. 数据层约定（预铺内容）

- **`src/lib/query.ts`**：导出单例 `QueryClient`；`_layout.tsx` 用 `QueryClientProvider` 包裹。
- **`src/lib/api.ts`**：`axios.create({ baseURL: process.env.EXPO_PUBLIC_API_BASE_URL })`；预留请求/响应拦截器占位（鉴权 header 留 TODO 注释，本期不实现逻辑）。
- **`src/lib/socket.ts`**：导出一个惰性创建 `socket.io-client` 实例的工厂 stub（`autoConnect: false`），仅立约定，不在本期建连。
- **`src/store/index.ts`**：一个占位 jotai atom，示范约定。
- **`src/i18n/config.ts`**：i18next 初始化，resources 读 `messages/{en,zh}.json`，`lng` 由 `expo-localization` 的系统语言推断，`fallbackLng: 'en'`。
- **共享契约**：`src/app/index.tsx` 从 `@meshbot/types` 导入一个现成 zod schema，用它派生/渲染一段占位内容（如 schema 的字段名或一个 parse 后的默认值），作为 workspace 解析打通的可见证据。

## 6. 首屏（占位）行为

`src/app/index.tsx`：

- 用 NativeWind className 排版（验证 NativeWind 生效）。
- 显示：应用名、一段来自 i18next 的文案（验证 i18n）、一段由 `@meshbot/types` schema 派生的文本（验证共享包 + Metro 解析）。
- 不发任何网络请求。

## 7. 验收标准

1. `pnpm install` 能解析并装上 `@meshbot/mobile`。
2. `pnpm --filter @meshbot/mobile dev`（`expo start`）能起；在 iOS 模拟器 / Android / Expo Go（Development Build）任一环境加载后，占位首屏渲染成功，且可见「由 `@meshbot/types` 派生」的那段内容。
3. `pnpm typecheck` 覆盖 mobile 且通过。
4. `pnpm lint`（Biome）对 `apps/mobile` 干净。
5. NativeWind className 实际生效（首屏样式按 Tailwind 类渲染）。
6. i18next 按系统语言切换 en/zh 文案。

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| NativeWind v4.2.0 与 SDK 55 的 RN 版本不兼容 | 实现期**首要验证**；不兼容则回退 NativeWind v5（Tailwind v4）。以官方 SDK-55 安装指南为准 |
| pnpm hoisted 下个别原生包 postinstall 被拦 | 按报错逐个加入 `pnpm-workspace.yaml` 的 `allowBuilds`，不预先猜 |
| Metro 解析 `@meshbot/types`（编译产物 dist）失败 | `@meshbot/types` 已 `tsc` 出 `dist` 并声明 `main`/`types`；SDK 55 自动 monorepo 配置应可解析。验收步骤 2 即为此的显式验证 |
| Biome 误扫生成物 | 靠 `apps/mobile/.gitignore` 覆盖 `.expo/`/`ios/`/`android/`/`dist/` |

## 9. 后续（本期之外，仅记录方向）

- 登录/鉴权：复用云端轨设备授权 / cloud identity 流程。
- 与后端连接目标：手机端跑不了本地 `server-agent`（Node 进程），大概率对接云端轨 `server-main`（含 IM 反向通道）。
- EAS Build / EAS Update / Expo Notifications（后台 WS 靠推送唤醒）。
- locale 资源与 web-agent 经 `sync:locales` 共享。
- UI 组件层：是否升级 NativeWind v5 对齐 Tailwind v4，或沉淀一套 RN 组件库。
