// Electron 主进程：安全基线（方案 §4.1 / R8）——contextIsolation、沙箱、禁用 nodeIntegration。
const { app, BrowserWindow, shell, Tray, Menu, nativeImage } = require("electron");
const path = require("node:path");

const START_URL = process.env.ELECTRON_START_URL || `file://${path.join(__dirname, "../dist-renderer/index.html")}`;
const isDev = Boolean(process.env.ELECTRON_START_URL);

let mainWindow = null;
let tray = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#f5f4f0",
    title: "AI People 运营工作台",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(START_URL).then(() => {
    // 确保窗口可见并置前（避免被其他窗口遮挡）
    mainWindow.show();
    mainWindow.focus();
  });
}

function createTray() {
  // 使用 1x1 透明占位图标（正式图标待设计资源）
  const image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("AI People 运营工作台");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示工作台", click: () => mainWindow?.show() },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => (mainWindow?.isMinimized() ? mainWindow.restore() : mainWindow?.show()));
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // 关窗最小化到托盘，Runner 与后台任务不受影响
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
