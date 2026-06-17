import path from "node:path";
import { app, BrowserWindow, dialog, nativeImage } from "electron";
import { startAgentRuntime, stopAgentRuntime } from "./agent-runtime";
import { registerIpcHandlers } from "./ipc-handlers";
import { startStaticServer } from "./static-server";

const APP_NAME = "Meshbot";
const DEV_AGENT_URL = "http://localhost:3001";

// 覆盖应用名（须在 app ready 前调用）：默认菜单的 About / Hide / Quit 文案取自 app.name，
// 不改的话开发期会显示 package.json 的 "@meshbot/desktop"。注意 macOS 菜单栏首项的「粗体
// 应用名」由运行中 bundle 的 CFBundleName 决定 —— 打包产物已是 Meshbot；`electron .` 开发
// 期则锁死为 Electron 自带 bundle，JS 无法改写，仅打包后正确。
app.setName(APP_NAME);

let mainWindow: BrowserWindow | null = null;
let staticServer: { server: import("node:http").Server; port: number } | null =
  null;

function createWindow(agentUrl: string) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: APP_NAME,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: "#1a1a1a",
    ...(process.platform === "win32" && {
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#666666",
        height: 36,
      },
    }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadURL(agentUrl);

  return win;
}

async function getAgentUrl(): Promise<string> {
  // dev：开发者自行启动 dev:server-agent + dev:web-agent，壳只加载 dev URL
  // （可用 MESHBOT_DESKTOP_DEV_URL 覆盖默认地址）
  if (!app.isPackaged) {
    return process.env.MESHBOT_DESKTOP_DEV_URL ?? DEV_AGENT_URL;
  }

  // packaged：server-agent 与 web-agent 都在 app 内 —— 先把内置 server-agent
  // fork 起来并等就绪，再起静态 UI server 加载打包好的 html
  await startAgentRuntime();

  const webAgentPath = path.join(__dirname, "web-agent");
  staticServer = await startStaticServer(webAgentPath);
  return `http://127.0.0.1:${staticServer.port}`;
}

app.whenReady().then(async () => {
  try {
    // macOS「关于」面板标题与版本（默认会显示 Electron 字样）
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
    });

    // 开发期 macOS dock 默认是 Electron 图标；显式贴上品牌图标（打包产物由 bundle 自带 .icns）。
    if (!app.isPackaged && process.platform === "darwin" && app.dock) {
      const devIcon = nativeImage.createFromPath(
        path.join(__dirname, "..", "build", "icon.png"),
      );
      if (!devIcon.isEmpty()) app.dock.setIcon(devIcon);
    }

    const agentUrl = await getAgentUrl();
    registerIpcHandlers(() => mainWindow);
    mainWindow = createWindow(agentUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox("启动失败", message);
    stopAgentRuntime();
    app.quit();
  }
});

app.on("window-all-closed", () => {
  staticServer?.server.close();
  staticServer = null;
  if (process.platform !== "darwin") {
    stopAgentRuntime();
    app.quit();
  }
});

app.on("before-quit", () => {
  stopAgentRuntime();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const agentUrl = await getAgentUrl();
    mainWindow = createWindow(agentUrl);
  }
});
