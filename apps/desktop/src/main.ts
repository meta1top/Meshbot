import path from "node:path";
import { app, BrowserWindow, dialog, nativeImage, shell } from "electron";
import { startAgentRuntime, stopAgentRuntime } from "./agent-runtime";
import { registerIpcHandlers } from "./ipc-handlers";

const APP_NAME = "Meshbot";
const DEV_AGENT_URL = "http://localhost:3001";

// 覆盖应用名（须在 app ready 前调用）：默认菜单的 About / Hide / Quit 文案取自 app.name，
// 不改的话开发期会显示 package.json 的 "@meshbot/desktop"。注意 macOS 菜单栏首项的「粗体
// 应用名」由运行中 bundle 的 CFBundleName 决定 —— 打包产物已是 Meshbot；`electron .` 开发
// 期则锁死为 Electron 自带 bundle，JS 无法改写，仅打包后正确。
app.setName(APP_NAME);

let mainWindow: BrowserWindow | null = null;
/** cmd+Q 退出标记：mac 点关闭按钮仅隐藏窗口（保留页面状态），退出时才真 close。 */
let isQuitting = false;

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

  // mac 惯例：关闭按钮只隐藏窗口（Dock 重开原样恢复页面状态），cmd+Q 才退出。
  win.on("close", (e) => {
    if (process.platform === "darwin" && !isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 比较 origin 而非 startsWith，规避 agentUrl 携带路径时的误判。
    // new URL() 必须包 try/catch：畸形 http URL（如 http://xn--/）能通过
    // Chromium 校验送达 handler，但 new URL() 会抛 TypeError，主进程无
    // uncaughtException handler，不防护会直接崩整个应用。
    let isExternal: boolean;
    try {
      isExternal =
        /^https?:\/\//.test(url) &&
        new URL(url).origin !== new URL(agentUrl).origin;
    } catch {
      // 解析失败的 URL 一律拒绝，且不交给系统浏览器
      return { action: "deny" };
    }
    if (isExternal) {
      shell
        .openExternal(url)
        .catch((err) => console.error("[desktop] openExternal 失败:", err));
      return { action: "deny" };
    }
    return { action: "allow" };
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

  // packaged：fork 内置 server-agent（自检端口 + 同源伺服打包好的 web-agent），
  // 窗口直接加载它的端口，前端走同源相对地址
  const { port } = await startAgentRuntime();
  return `http://127.0.0.1:${port}`;
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
  if (process.platform !== "darwin") {
    stopAgentRuntime();
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopAgentRuntime();
});

app.on("activate", async () => {
  // 关闭按钮只是 hide——优先恢复既有窗口（页面状态原样保留）。
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    return;
  }
  if (BrowserWindow.getAllWindows().length === 0) {
    // 与 whenReady 同样兜底：startAgentRuntime 已幂等（复用既有 runtime），
    // 但重建窗口链路仍可能抛错，需捕获避免 UnhandledPromiseRejection。
    try {
      const agentUrl = await getAgentUrl();
      mainWindow = createWindow(agentUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dialog.showErrorBox("无法重新打开窗口", message);
    }
  }
});
