// Electron 主进程：安全基线（方案 §4.1 / R8）——contextIsolation、沙箱、禁用 nodeIntegration。
const { app, BrowserWindow, shell, Tray, Menu, nativeImage, dialog } = require("electron");
const path = require("node:path");

const START_URL = process.env.ELECTRON_START_URL || `file://${path.join(__dirname, "../dist-renderer/index.html")}`;
const isDev = Boolean(process.env.ELECTRON_START_URL);

// 发布人信息（easy-publish-check 统一维护，与 package.json author 一致）
const AUTHOR = Object.freeze({ name: "clb", email: "lamthebest@foxmail.com" });

let mainWindow = null;
let tray = null;

function trayIcon() {
  const image = nativeImage.createFromPath(path.join(__dirname, "../resources/tray.png"));
  return image.resize({ width: 16, height: 16 });
}

function appIcon() {
  return nativeImage.createFromPath(path.join(__dirname, "../resources/icon.png"));
}

function createMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 AI People 运营工作台",
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              icon: appIcon(),
              title: "关于",
              message: "AI People 运营工作台",
              detail: [
                `版本 ${app.getVersion()}`,
                "",
                "面向抖音、小红书与微博的 AI 运营助手。",
                "内容基于你提供的真实资料生成，发布前经人工审核。",
                "",
                `发布人：${AUTHOR.name}`,
                `联系邮箱：${AUTHOR.email}`,
                "许可协议：MIT",
                "",
                "界面图标：Lucide（ISC License）",
              ].join("\n"),
              buttons: ["确定"],
            });
          },
        },
        { type: "separator" },
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#f5f4f0",
    title: "AI People 运营工作台",
    autoHideMenuBar: false,
    icon: appIcon(),
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
  tray = new Tray(trayIcon());
  tray.setToolTip("AI People 运营工作台");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示工作台", click: () => mainWindow?.show() },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => (mainWindow?.isMinimized() ? mainWindow.restore() : mainWindow?.show()));
}

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: "AI People 运营工作台",
    applicationVersion: app.getVersion(),
    copyright: `MIT License © ${AUTHOR.name} (${AUTHOR.email})`,
    credits: "界面图标来自 Lucide（ISC License）",
  });
  createMenu();
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
