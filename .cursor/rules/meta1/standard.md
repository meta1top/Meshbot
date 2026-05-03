# 编码规范

## 适用范围

本文档定义了基于 Nodejs 的 Monorepo 全栈工程的通用编码规范，适用于所有使用相同技术栈的项目。

## 技术栈

这是一套基于 Nodejs 的 Monorepo 全栈工程，主要的技术栈为：
1. 后端 Nestjs
2. 前端 Nextjs
3. 桌面端 Electron

## 工程结构

```
anybot/
├── apps/
│   ├── desktop/          # Electron 桌面壳
│   ├── server-agent/     # NestJS 本地 agent
│   ├── server-main/      # NestJS 云平台后端
│   ├── web-agent/        # Next.js 桌面端 UI
│   └── web-main/         # Next.js 云平台前端
├── libs/
│   ├── types/            # 前后端共享类型（Zod）
│   └── shared/           # NestJS 共享模块
├── packages/
│   ├── common/           # Web 公共逻辑（网络请求、工具函数）
│   └── design/           # Tailwind + shadcn 统一组件库
├── scripts/              # 工具脚本
└── README.md
```

## 使用指南

- [接口的定义与使用](./api.md)
- [服务端全局默认行为](./global.md)
- [前端组件使用](./ui.md)
- [用户习惯](./user.md)
