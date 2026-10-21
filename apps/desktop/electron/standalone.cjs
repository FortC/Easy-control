const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, ipcMain, protocol, safeStorage, Notification, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const { createToolService } = require('./local-tools.cjs');
const { createLiveStudio } = require('./live-studio.cjs');

protocol.registerSchemesAsPrivileged([{ scheme:'easy-media', privileges:{ standard:true, secure:true, supportFetchAPI:true, stream:true, corsEnabled:true } }]);
app.setName('Easy Control');
if (process.env.EASYCONTROL_USER_DATA) app.setPath('userData', path.resolve(process.env.EASYCONTROL_USER_DATA));
let win, stage, tray, backend, tools, live, quitting=false, sleepBlock=null;
const sessionToken = randomBytes(32).toString('hex');
process.env.DESKTOP_SESSION_TOKEN = sessionToken;
let resolveReady, rejectReady;
const ready = new Promise((resolve,reject) => { resolveReady=resolve; rejectReady=reject; });
ready.catch(() => {});
const development = !app.isPackaged && process.env.ELECTRON_START_URL;
const iconPath = path.join(__dirname,'../resources/icon.png');
const icon = () => nativeImage.createFromPath(iconPath);
const windows = () => [win,stage].filter(w => w && !w.isDestroyed());
function broadcast(channel,data) { for (const w of windows()) w.webContents.send(channel,data); }
function freePort() { return new Promise((resolve,reject) => { const s=net.createServer(); s.on('error',reject); s.listen(0,'127.0.0.1',() => { const p=s.address().port; s.close(() => resolve(p)); }); }); }
function protect(w) {
  w.webContents.setWindowOpenHandler(({url}) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); return {action:'deny'}; });
  w.webContents.on('will-navigate',(e,url) => { if (!url.startsWith('file:') && !(development && url.startsWith(development))) e.preventDefault(); });
}
async function load(w,route='') {
  if (development) await w.loadURL(`${development}/#/${route}`);
  else await w.loadFile(path.join(__dirname,'../dist-renderer/index.html'), {hash:`/${route}`});
}
function createWindow() {
  win = new BrowserWindow({ width:1480,height:940,minWidth:1120,minHeight:720,title:'Easy Control',icon:icon(),backgroundColor:'#f5f7fb',show:false,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:true} });
  protect(win); win.once('ready-to-show',() => win.show());
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  void load(win).catch(e => dialog.showErrorBox('工作台加载失败',e.message));
}
async function openStage() {
  if (stage && !stage.isDestroyed()) { stage.show(); return; }
  const portrait=live.snapshot().orientation==='portrait';
  stage = new BrowserWindow({width:portrait?540:1120,height:portrait?960:680,title:'Easy Control · 直播输出',backgroundColor:'#10141e',icon:icon(),autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'} });
  protect(stage);
  stage.on('closed',() => { stage=null; live.command('stop'); updateSleep(); });
  await load(stage,'stage');
}
function updateSleep() {
  if (live.snapshot().status==='running' && sleepBlock===null) sleepBlock=powerSaveBlocker.start('prevent-display-sleep');
  if (live.snapshot().status!=='running' && sleepBlock!==null) { powerSaveBlocker.stop(sleepBlock); sleepBlock=null; }
}
function handle(channel,fn) { ipcMain.handle(channel, async (event,...args) => {
  if (!windows().some(w => w.webContents.id===event.sender.id)) throw new Error('非受信任窗口');
  return fn(...args);
}); }
async function startEngine() {
  const root=app.getPath('userData'); fs.mkdirSync(root,{recursive:true});
  const keyFile=path.join(root,'engine-key.bin');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile,safeStorage.encryptString(randomBytes(32).toString('hex')));
  process.env.JWT_SECRET=safeStorage.decryptString(fs.readFileSync(keyFile));
  process.env.VAULT_SECRET=process.env.JWT_SECRET;
  process.env.DATA_DIR=path.join(root,'data'); fs.mkdirSync(process.env.DATA_DIR,{recursive:true});
  const apiPort=await freePort();
  const req=createRequire(path.join(__dirname,'../package.json'));
  const runtime=app.isPackaged ? path.join(process.resourcesPath,'pglite/dist/index.js') : req.resolve('@electric-sql/pglite').replace(/index\.cjs$/,'index.js');
  process.env.EASYCONTROL_PGLITE_ENTRY=pathToFileURL(runtime).href;
  process.env.EASYCONTROL_DATABASE_PATH=path.join(root,'database');
  backend=await require('./backend.cjs').startEmbeddedBackend({port:apiPort,migrationsDir:path.join(__dirname,'../resources/migrations')});
  resolveReady({port:apiPort,mode:'standalone',sessionToken,version:app.getVersion()});
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',() => { if (win) { win.show(); if(win.isMinimized())win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    tools=createToolService({app,safeStorage,notify:job => { broadcast('tools:changed',{}); if (Notification.isSupported() && !win?.isFocused()) new Notification({title:'Easy Control',body:job.summary}).show(); }});
    live=createLiveStudio({app,dialog,broadcast});
    protocol.handle('easy-media',request => live.serve(request));
    handle('backend:port',() => ready);
    handle('app:info',() => ({version:app.getVersion(),name:'Easy Control',dataPath:app.getPath('userData'),platform:process.platform}));
    handle('app:openData',() => shell.openPath(app.getPath('userData')));
    handle('app:copyText', text => { if(typeof text!=='string'||text.length>100000)throw new Error('复制内容无效'); require('electron').clipboard.writeText(text); return true; });
    handle('app:external',url => { if(typeof url!=='string'||!/^https:\/\//.test(url))throw new Error('仅允许 HTTPS 链接'); return shell.openExternal(url); });
    handle('tools:snapshot',() => tools.snapshot());
    handle('tools:install',id => tools.install(id));
    handle('tools:save',input => tools.upsertTool(input));
    handle('tools:remove',id => tools.removeTool(id));
    handle('accounts:save',input => tools.saveAccount(input));
    handle('accounts:remove',id => tools.removeAccount(id));
    handle('accounts:pause',id => tools.pauseAccount(id));
    handle('tools:enqueue',input => tools.enqueue(input));
    handle('tools:cancel',id => tools.cancel(id));
    handle('tools:choose',async () => { const r=await dialog.showOpenDialog(win,{title:'选择可信的 CLI 入口',filters:[{name:'CLI 入口',extensions:['exe','js','cjs','mjs']}],properties:['openFile']}); return r.canceled ? null : r.filePaths[0]; });
    handle('tools:chooseImage',async () => { const r=await dialog.showOpenDialog(win,{filters:[{name:'图片',extensions:['png','jpg','jpeg','webp']}],properties:['openFile']}); return r.canceled ? null : r.filePaths[0]; });
    handle('tools:export',async () => { const result=await dialog.showSaveDialog(win,{defaultPath:'Easy-Control-操作报告.json',filters:[{name:'JSON',extensions:['json']}]}); if(result.canceled)return false; fs.writeFileSync(result.filePath,JSON.stringify(tools.snapshot().jobs,null,2)); return true; });
    handle('live:get',() => live.snapshot());
    handle('live:save',input => live.update(input));
    handle('live:chooseVideo',() => live.chooseVideo(win));
    handle('live:voices',() => live.voices());
    handle('live:synthesize',input => live.synthesize(input));
    handle('live:open',() => openStage());
    handle('live:command',async action => { if(action==='start'||action==='resume')await openStage(); const r=live.command(action); updateSleep(); return r; });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Easy Control',submenu:[{label:'显示工作台',click:() => win?.show()},{label:'打开数据目录',click:() => shell.openPath(app.getPath('userData'))},{type:'separator'},{label:'退出',click:() => app.quit()}]},{label:'帮助',submenu:[{label:'关于 Easy Control',click:() => void load(win,'about')},{label:'反馈问题',click:() => shell.openExternal('https://github.com/FortC/Easy-control/issues')},...(!app.isPackaged?[{role:'toggleDevTools',label:'开发者工具'}]:[])]}]));
    createWindow();
    tray=new Tray(nativeImage.createFromPath(path.join(__dirname,'../resources/tray.png'))); tray.setToolTip('Easy Control · 本地运营与直播');
    tray.setContextMenu(Menu.buildFromTemplate([{label:'打开工作台',click:() => win.show()},{label:'退出',click:() => app.quit()}])); tray.on('click',() => win.show());
    startEngine().catch(e => { console.error('[engine]',e.message); rejectReady(new Error(e.message)); broadcast('backend:failed',e.message); });
  }).catch(e => dialog.showErrorBox('启动失败',String(e)));
  app.on('before-quit',e => {
    if(quitting)return;
    e.preventDefault(); quitting=true;
    tools?.stop();
    if(sleepBlock!==null)powerSaveBlocker.stop(sleepBlock);
    void (async () => { try { if(backend)await backend.stop(); } catch {} app.exit(0); })();
    setTimeout(() => app.exit(0),10000).unref();
  });
  app.on('window-all-closed',() => {});
}
