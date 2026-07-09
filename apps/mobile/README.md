# @meshbot/mobile

meshbot 移动端 App（Expo SDK 55 + Expo Router + NativeWind v5 + i18next）。

pnpm/Turbo monorepo 内的一个 workspace 包，依赖 `@meshbot/types`（跨域 Zod schema）共享数据模型。属于本地优先 + 云端协同架构里的移动端接入点，本期仅搭手脚架（占位首屏 + 数据层约定 stub），不含登录/鉴权与真实业务逻辑。

## 技术栈

- **Expo SDK 55** + **Expo Router**（文件路由，`src/app/`）
- **NativeWind v5**（Tailwind v4 语法写 RN 样式）
- **TanStack Query** + **jotai**（服务端状态 / 客户端状态，`src/lib`、`src/store`）
- **axios** + **socket.io-client**（HTTP / WS 客户端 stub，`src/lib`）
- **i18next** + **react-i18next**（按系统语言切换 en/zh，`src/i18n`）
- **zod**（经 `@meshbot/types` 复用跨域 schema）

## 常用命令

从仓库根目录执行（本包不单独 `cd` 进去跑，依赖 pnpm workspace 解析）：

```bash
pnpm --filter @meshbot/mobile dev       # expo start
pnpm --filter @meshbot/mobile ios       # expo start --ios
pnpm --filter @meshbot/mobile android   # expo start --android
pnpm --filter @meshbot/mobile typecheck # tsc --noEmit
pnpm --filter @meshbot/mobile exec expo export -p ios  # 验证可打包(CI/本地自检)
```

## 目录结构

```
src/
├── app/      Expo Router 页面(文件路由)
├── lib/      数据层约定(query client / axios / socket stub)
├── store/    jotai 客户端状态
└── i18n/     i18next 初始化 + messages
```

## 说明

- 仅本包内改动不触发后端静态围栏（无 Entity/Service/Repository）。
- 提交前请在仓库根跑 `pnpm typecheck` / `pnpm lint` / `pnpm check`。
