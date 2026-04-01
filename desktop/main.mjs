import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(desktopDir)
const isMac = process.platform === 'darwin'

let mainWindow = null
let launcherServer = null
let launcherUrl = null

function resolveAppRoot() {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked')
  }
  return repoRoot
}

async function ensureLauncher() {
  if (launcherServer && launcherUrl) {
    return launcherUrl
  }

  process.env.OPENCLAUDE_APP_ROOT = resolveAppRoot()
  process.env.OPENCLAUDE_RUNTIME_BIN = process.execPath
  process.env.OPENCLAUDE_DATA_DIR = app.getPath('userData')

  const { startLauncherServer } = await import('../scripts/app-launcher.mjs')

  launcherServer = startLauncherServer({
    bindHost: '127.0.0.1',
    bindPort: 0,
    openBrowser: false,
  })

  await new Promise((resolve, reject) => {
    launcherServer.once('listening', resolve)
    launcherServer.once('error', reject)
  })

  const address = launcherServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine launcher address.')
  }

  launcherUrl = `http://127.0.0.1:${address.port}`
  return launcherUrl
}

async function createMainWindow() {
  const url = await ensureLauncher()

  mainWindow = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    title: 'OpenClaude Beta',
    backgroundColor: '#07111f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(desktopDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    void shell.openExternal(targetUrl)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  await mainWindow.loadURL(url)

  if (process.env.OPENCLAUDE_DESKTOP_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

function registerDesktopIpc() {
  ipcMain.handle('desktop:get-meta', () => ({
    appName: app.getName(),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
  }))

  ipcMain.handle('desktop:select-workspace', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose workspace folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true }
    }
    return { canceled: false, path: result.filePaths[0] }
  })

  ipcMain.handle('desktop:open-external', async (_event, url) => {
    if (typeof url === 'string' && url.startsWith('http')) {
      await shell.openExternal(url)
    }
    return { ok: true }
  })
}

async function shutdownLauncher() {
  if (!launcherServer) {
    return
  }
  await new Promise(resolve => launcherServer.close(resolve))
  launcherServer = null
  launcherUrl = null
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (!mainWindow) {
    void createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.focus()
})

app.whenReady().then(async () => {
  registerDesktopIpc()
  await createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit()
  }
})

app.on('before-quit', () => {
  void shutdownLauncher()
})
