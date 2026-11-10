'use strict';
// Tower Controller for Mac: the game in its own window. The game itself is the web game (the same files, inside the app);
// this shell gives it a proper window and menu, the microphone, and (in later steps) engines the browser can't run.
const { app, BrowserWindow, Menu, protocol, session, shell, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { mimeFor, resolveAppPath } = require('./lib/serve');

const ROOT = path.join(__dirname, 'app');
const ORIGIN = 'tower://app';

protocol.registerSchemesAsPrivileged([
  { scheme: 'tower', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 820, minHeight: 600, show: false, backgroundColor: '#0b0b0d', title: 'Tower Controller',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(`${ORIGIN}/index.html`);
  // links go to the browser; the window never leaves the game
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ]));
}

app.whenReady().then(() => {
  // the game's files, from the app's own folder
  protocol.handle('tower', async (request) => {
    const file = resolveAppPath(ROOT, new URL(request.url).pathname);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': mimeFor(file), 'cache-control': 'no-cache' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // the microphone, for this game only (macOS asks the player once)
  const ours = (url) => typeof url === 'string' && url.startsWith(ORIGIN);
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => ours(origin) && ['media', 'fullscreen'].includes(permission));
  session.defaultSession.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (!ours(details.requestingUrl) || !['media', 'fullscreen'].includes(permission)) return callback(false);
    if (permission === 'media' && process.platform === 'darwin' && details.mediaTypes?.includes('audio')) {
      try { return callback(await systemPreferences.askForMediaAccess('microphone')); } catch { return callback(false); }
    }
    return callback(true);
  });

  buildMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
