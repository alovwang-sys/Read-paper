import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, shell } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { startDesktopAI } from './local-ai.mjs';
import { createSettingsStore } from './settings.mjs';
import { APP_URL, SETTINGS_URL, createAppProtocol, canWriteClipboard } from './protocol.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
app.setName('Papertrail');
app.setPath('userData', process.env.PAPERTRAIL_USER_DATA ? resolve(process.env.PAPERTRAIL_USER_DATA) : join(app.getPath('appData'), 'Papertrail'));
protocol.registerSchemesAsPrivileged([{ scheme: 'papertrail', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let mainWindow;
let settingsWindow;
let ai;
let store;
let quitting = false;
let closing;
let closeAllowed = false;
let closeTimer;
let closeDialogOpen = false;

function runtimeEnvironment() {
  const home = app.getPath('home');
  // Finder does not load shell startup files; include common native CLI install locations privately.
  const paths = [...(process.env.PATH || '').split(delimiter).filter(Boolean), ...(process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin'), join(home, '.opencode/bin'), join(home, '.local/node/bin')] : [])];
  return { ...process.env, ...store.environment(), HOME: process.env.HOME || home, PATH: [...new Set(paths)].join(delimiter), AI_AGENT_STATE_DIR: join(app.getPath('userData'), 'agents') };
}

async function unconfirmedClose(detail) {
  if (!mainWindow || mainWindow.isDestroyed() || closeDialogOpen) return;
  clearTimeout(closeTimer);
  closing = undefined;
  mainWindow.webContents.send('papertrail:close-cancelled');
  const wasQuitting = quitting;
  quitting = false;
  closeDialogOpen = true;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: '尚未确认资料已保存', message: '工作台未能确认保存完成。', detail: `${detail}\n强制关闭可能丢失最后尚未保存的编辑。`,
    buttons: ['返回工作台', '重试关闭', '强制关闭'], defaultId: 0, cancelId: 0,
  });
  closeDialogOpen = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (response === 1) { quitting = wasQuitting; mainWindow.close(); }
  if (response === 2) { quitting = wasQuitting; closeAllowed = true; mainWindow.close(); }
}

function trusted(event, target, url) {
  return target && !target.isDestroyed() && event.sender === target.webContents && event.senderFrame === target.webContents.mainFrame && event.senderFrame.url === url;
}
function secureWindow(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(canWriteClipboard({ contents, mainContents: mainWindow?.webContents, permission, details })));
  window.webContents.session.setPermissionCheckHandler((contents, permission, origin, details) => canWriteClipboard({ contents, mainContents: mainWindow?.webContents, permission, origin, details }));
}
function showAISettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({ width: 580, height: 710, minWidth: 500, minHeight: 640, parent: mainWindow, title: '模型连接 · Papertrail', autoHideMenuBar: true, webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  secureWindow(settingsWindow);
  void settingsWindow.loadURL(SETTINGS_URL);
  settingsWindow.on('closed', () => { settingsWindow = undefined; });
}
function createWindow() {
  closeAllowed = false;
  let rendererUnavailable = false;
  mainWindow = new BrowserWindow({ width: 1440, height: 940, minWidth: 900, minHeight: 640, title: 'Papertrail', backgroundColor: '#f6f7f9', show: false, webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  secureWindow(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('render-process-gone', () => { rendererUnavailable = true; if (closing) void unconfirmedClose('工作台进程已停止响应。'); });
  mainWindow.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { rendererUnavailable = true; mainWindow.show(); if (closing) void unconfirmedClose('工作台页面未能加载。'); }
  });
  mainWindow.webContents.on('did-finish-load', () => { rendererUnavailable = false; });
  mainWindow.on('close', event => {
    if (closeAllowed) return;
    event.preventDefault();
    if (closing || closeDialogOpen) return;
    if (rendererUnavailable) { void unconfirmedClose('工作台页面未能正常运行。'); return; }
    closing = randomUUID();
    closeTimer = setTimeout(() => void unconfirmedClose('等待工作台保存确认已超时，可以返回后重试保存。'), 10_000);
    mainWindow.webContents.send('papertrail:prepare-close', closing);
  });
  mainWindow.on('closed', () => {
    clearTimeout(closeTimer);
    mainWindow = undefined;
    settingsWindow = undefined;
    closing = undefined;
    if (quitting) app.quit();
  });
  void mainWindow.loadURL(APP_URL);
}

if (squirrelStartup || !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } else if (store) createWindow(); });
  app.on('before-quit', event => {
    if (mainWindow && !closeAllowed) { event.preventDefault(); quitting = true; mainWindow.close(); }
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' || quitting) app.quit(); });
  app.on('activate', () => { if (!mainWindow && store) createWindow(); });
  app.on('will-quit', () => { void ai?.stop(); });

  // Electron must finish evaluating the ESM entry before it can emit ready.
  void app.whenReady().then(async () => {
  await mkdir(app.getPath('userData'), { recursive: true });
  store = createSettingsStore(app.getPath('userData'), safeStorage);
  try { await store.load(); } catch (error) { dialog.showErrorBox('模型设置需要重新配置', error.message); }
  ai = await startDesktopAI({ env: runtimeEnvironment() });
  protocol.handle('papertrail', createAppProtocol({ distDirectory: join(directory, '..', 'dist'), desktopDirectory: directory, getAI: () => ai }));
  ipcMain.handle('papertrail:project-location', event => {
    if (!trusted(event, mainWindow, APP_URL)) throw new Error('不允许此页面读取研究位置。');
    return app.getPath('documents');
  });
  ipcMain.handle('papertrail:choose-directory', async (event, defaultPath) => {
    if (!trusted(event, mainWindow, APP_URL)) throw new Error('不允许此页面选择研究目录。');
    if (defaultPath !== undefined && (typeof defaultPath !== 'string' || defaultPath.length > 4096 || defaultPath.includes('\0'))) throw new Error('目录路径无效。');
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择研究位置', properties: ['openDirectory'], ...(defaultPath ? { defaultPath } : {}) });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('papertrail:open-ai-settings', event => {
    if (!trusted(event, mainWindow, APP_URL)) throw new Error('不允许此页面打开设置。');
    showAISettings();
  });
  ipcMain.handle('papertrail:get-ai-settings', event => {
    if (!trusted(event, settingsWindow, SETTINGS_URL)) throw new Error('不允许读取设置。');
    return store.summary();
  });
  ipcMain.handle('papertrail:save-ai-settings', async (event, input) => {
    if (!trusted(event, settingsWindow, SETTINGS_URL)) throw new Error('不允许修改设置。');
    const summary = await store.save(input);
    const next = await startDesktopAI({ env: runtimeEnvironment() });
    const previous = ai;
    ai = next;
    await previous?.stop();
    mainWindow?.webContents.send('papertrail:ai-settings-changed');
    return summary;
  });
  ipcMain.on('papertrail:close-prepared', async (event, id, error) => {
    if (!trusted(event, mainWindow, APP_URL) || !closing || id !== closing) return;
    clearTimeout(closeTimer);
    closing = undefined;
    if (error) {
      quitting = false;
      await dialog.showMessageBox(mainWindow, { type: 'error', title: '资料尚未保存', message: '窗口已保留，请重试保存或导出备份后再关闭。', detail: String(error).slice(0, 500), buttons: ['返回工作台'] });
      return;
    }
    closeAllowed = true;
    mainWindow.close();
  });
  const storageMenu = { label: '备份与恢复资料…', click: () => mainWindow?.webContents.send('papertrail:open-storage') };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'Papertrail', submenu: [{ role: 'about' }, { type: 'separator' }, { label: '模型连接…', click: showAISettings }, storageMenu, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '文件', submenu: [{ label: '模型连接…', click: showAISettings }, storageMenu, { type: 'separator' }, { role: process.platform === 'darwin' ? 'close' : 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    { role: 'windowMenu' },
  ]));
  createWindow();
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: '保存导出文件', defaultPath: join(app.getPath('documents'), item.getFilename()) });
    item.once('done', (_done, result) => { if (result === 'interrupted') dialog.showErrorBox('导出未完成', '文件写入失败，请检查可用空间与目录权限，然后重试。'); });
  });
  }).catch(error => {
    dialog.showErrorBox('Papertrail 无法启动', error instanceof Error ? error.message : '请重新安装应用后重试。');
    app.exit(1);
  });
}
