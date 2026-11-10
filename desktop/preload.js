'use strict';
// Tells the game it is running in the desktop app (it then uses its own recogniser: the browser's does not work here).
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('towerDesktop', { platform: process.platform, arch: process.arch, electron: process.versions.electron });
