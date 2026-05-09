# Desktop 开发与生产模式加载逻辑设计

## 目标

让 `@anybot/desktop` 在开发模式下加载 web-agent dev server，在生产模式下加载打包到应用内的 web-agent 静态文件，API 请求始终指向由 CLI 启动的 server-agent（`localhost:3100`）。

## 背景

当前 `apps/desktop/src/main.ts` 在开发和生产模式下都固定加载 `http://localhost:3100`，即 server-agent 的地址。这导致：
- 开发时需要 server-agent 提供 web-agent 的静态文件服务
- 生产时 desktop 只是一个空壳，无法独立运行

web-agent 已配置 `output: "export"`，`next build` 会生成纯静态文件到 `apps/web-agent/out/`。`@anybot/common` 中的 `apiClient` 已处理 `file://` 协议场景：当页面从本地文件加载时，base URL 自动回退到 `http://127.0.0.1:3100`。

## 方案选择：方案 B

在 `electron-builder.yml` 中直接引用 web-agent 的 out 目录，build 脚本保持不变。

## 具体改动

### 1. `apps/desktop/src/main.ts`

用 `app.isPackaged` 区分开发模式和生产模式：

- **开发模式**（`!app.isPackaged`）：`win.loadURL("http://localhost:3001")`
- **生产模式**（`app.isPackaged`）：`win.loadFile(path.join(__dirname, "web-agent", "index.html"))`

`getAgentUrl()` 同步调整为返回对应的加载地址，供 `createWindow` 使用。

### 2. `apps/desktop/electron-builder.yml`

在 `files` 中增加 web-agent 静态文件：

```yaml
files:
  - dist/**/*
  - from: ../../web-agent/out
    to: web-agent
```

这样打包后的应用内会包含 `web-agent/index.html` 等静态资源，`__dirname + "/web-agent"` 即可定位到。

### 3. 无改动项

- **web-agent**：`apiClient` 已兼容 `file://` 协议，无需修改。
- **server-agent**：不内嵌到 desktop，继续由 CLI `anybot start` 独立启动。
- **desktop build 脚本**：不需要额外复制步骤。

## 数据流

```
开发模式:
  desktop (main) ──loadURL──► localhost:3001 (next dev server)
                                    │
                                    ▼
                              API calls ──► localhost:3100 (server-agent)

生产模式:
  desktop (main) ──loadFile──► file://.../web-agent/index.html
                                    │
                                    ▼
                              API calls ──► localhost:3100 (server-agent)
```

## 测试计划

1. 开发模式：`pnpm dev:desktop` 能正常打开窗口并加载 localhost:3001
2. 生产模式：`pnpm dist` 打包后，运行应用能正常加载 UI 并调用 API
3. 确认 Linux after-pack 脚本不受影响
