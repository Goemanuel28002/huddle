const { app, BrowserWindow, Menu, ipcMain, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const setupPath = path.join(__dirname, 'renderer', 'index.html');
const setupUrl = pathToFileURL(setupPath).href;
const settingsPath = () => path.join(app.getPath('userData'), 'server.json');
let mainWindow;
let setupWindow;
let serverUrl = '';

function normalizeServerUrl(value) {
  let parsed;
  try { parsed = new URL(String(value).trim()); }
  catch { throw new Error('Gib eine gültige HTTPS-Adresse für deinen Server ein.'); }
  const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new Error('Erlaubt sind eine HTTPS-Adresse oder eine lokale HTTP-Adresse ohne Pfad.');
  }
  return parsed.origin;
}

function readServerUrl() {
  try { return normalizeServerUrl(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).url); }
  catch { return ''; }
}

function isSetupFrame(url) { return url === setupUrl; }

async function saveServer(event, input) {
  if (!isSetupFrame(event.senderFrame?.url ?? '')) throw new Error('Servereinstellungen können nur im Connect Together Setup geändert werden.');
  const normalized = normalizeServerUrl(input);
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ url: normalized }, null, 2), { encoding: 'utf8', mode: 0o600 });
  serverUrl = normalized;
  if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(serverUrl);
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
  return { ok: true };
}

ipcMain.handle('desktop:get-server', (event) => {
  if (!isSetupFrame(event.senderFrame?.url ?? '')) throw new Error('Nicht autorisiert.');
  return serverUrl;
});
ipcMain.handle('desktop:connect', saveServer);

function applyWindowPolicy(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, targetUrl) => {
    let trustedServerOrigin = false;
    try { trustedServerOrigin = Boolean(serverUrl && new URL(targetUrl).origin === serverUrl); }
    catch { /* A malformed or non-URL navigation is never trusted. */ }
    if (targetUrl === setupUrl || trustedServerOrigin) return;
    event.preventDefault();
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 840,
    minHeight: 600,
    show: false,
    title: 'Connect Together',
    backgroundColor: '#18181d',
    icon: path.join(__dirname, 'assets', 'connect-together.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyWindowPolicy(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  void mainWindow.loadURL(serverUrl || setupUrl);
}

function openSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 520,
    height: 600,
    resizable: false,
    parent: mainWindow ?? undefined,
    modal: Boolean(mainWindow),
    title: 'Connect Together — Server verbinden',
    backgroundColor: '#18181d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyWindowPolicy(setupWindow);
  setupWindow.on('closed', () => { setupWindow = null; });
  void setupWindow.loadURL(setupUrl);
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Connect Together', submenu: [{ label: 'Server verbinden …', click: openSetupWindow }, { type: 'separator' }, { role: 'quit', label: 'Beenden' }] },
    { label: 'Ansicht', submenu: [{ role: 'reload', label: 'Neu laden' }, { role: 'togglefullscreen', label: 'Vollbild' }, { type: 'separator' }, { role: 'zoomIn', label: 'Vergrößern' }, { role: 'zoomOut', label: 'Verkleinern' }, { role: 'resetZoom', label: 'Zoom zurücksetzen' }] },
  ]));
}

app.whenReady().then(() => {
  serverUrl = readServerUrl();
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return Boolean(serverUrl && requestingOrigin === serverUrl && ['media', 'notifications'].includes(permission));
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingOrigin = details.requestingUrl ? new URL(details.requestingUrl).origin : '';
    callback(Boolean(serverUrl && requestingOrigin === serverUrl && ['media', 'notifications'].includes(permission)));
  });
  installMenu();
  createMainWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createMainWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
