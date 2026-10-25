/* PhotoLab Electron 主进程：
 *  - 拉起 Python sidecar（打包后 resources/backend/photolab-server.exe，开发时 .venv 的 python）
 *  - 解析 stdout 的 PHOTOLAB_SERVER_READY 行拿到端口与 token，加载本地 UI
 *  - 原生打开/保存对话框（渲染数据由后端 /api/render 生成，主进程负责落盘）
 *  - 生产环境尝试 electron-updater 自动更新（GitHub Releases） */
const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron')
const { spawn, exec } = require('child_process')
const path = require('path')
const fs = require('fs')

let backend = null
let mainWindow = null
let quitting = false

const IMAGE_FILTERS = [
  { name: '图像（含 RAW）', extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'bmp',
    'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raw', 'rw2',
    'raf', 'orf', 'pef', 'x3f', 'erf', 'kdc', 'dcr', 'mef', 'mos', 'mrw', 'fff', 'r3d'] },
]

function killBackend() {
  if (!backend) return
  const pid = backend.pid
  backend = null
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${pid} /T /F`, () => {})
  } else {
    try { process.kill(-pid) } catch { try { backend.kill() } catch {} }
  }
}

function startBackend() {
  return new Promise((resolve, reject) => {
    let exe, args, cwd
    if (app.isPackaged) {
      const dir = path.join(process.resourcesPath, 'backend')
      exe = path.join(dir, 'photolab-server.exe')
      args = []
      cwd = dir
    } else {
      const root = path.join(__dirname, '..')
      const venvPython = path.join(root, '.venv', 'Scripts', 'python.exe')
      exe = fs.existsSync(venvPython) ? venvPython : 'python'
      args = [path.join(root, 'server.py')]
      cwd = root
    }
    const child = spawn(exe, args, { cwd, windowsHide: true })
    let buf = ''
    const timer = setTimeout(() => reject(new Error('后端启动超时')), 30000)
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      const m = buf.match(/PHOTOLAB_SERVER_READY (http:\/\/127\.0\.0\.1:(\d+))(?: token=(\S+))?/)
      if (m) {
        clearTimeout(timer)
        resolve({ url: m[1], token: m[3] || '', child })
      }
    })
    child.stderr.on('data', (chunk) => console.error('[backend]', chunk.toString().trim()))
    child.on('exit', (code) => {
      backend = null
      if (!quitting && mainWindow) {
        dialog.showErrorBox('PhotoLab', `渲染服务异常退出（code=${code}），应用将关闭。`)
        app.quit()
      }
    })
    resolve.pending = child
  })
}

function createWindow(url, token) {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#101014',
    title: 'PhotoLab',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  Menu.setApplicationMenu(null)
  const target = token ? `${url}/?token=${encodeURIComponent(token)}` : `${url}/`
  win.loadURL(target)
  win.on('closed', () => { mainWindow = null })
  return win
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      const { url, token, child } = await startBackend()
      backend = child
      mainWindow = createWindow(url, token)
    } catch (err) {
      dialog.showErrorBox('PhotoLab', '渲染服务启动失败：\n' + (err?.message || err))
      app.quit()
    }

    // 生产环境自动更新（无发布配置时静默跳过）
    if (app.isPackaged) {
      try {
        const { autoUpdater } = require('electron-updater')
        autoUpdater.checkForUpdatesAndNotify().catch(() => {})
      } catch { /* 未配置 publish 时忽略 */ }
    }
  })

  app.on('window-all-closed', () => {
    quitting = true
    killBackend()
    app.quit()
  })
  app.on('before-quit', () => { quitting = true; killBackend() })
  process.on('exit', () => killBackend())
}

// ------------------------------------------------------------ IPC：原生对话框
ipcMain.handle('open-image-dialog', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '打开图像（可多选）',
    filters: IMAGE_FILTERS,
    properties: ['openFile', 'multiSelections'],
  })
  return r.canceled || !r.filePaths.length ? null : r.filePaths
})

ipcMain.handle('save-image-dialog', async (_ev, { defaultName }) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '保存图像',
    defaultPath: defaultName || 'photolab.png',
    filters: [
      { name: 'PNG', extensions: ['png'] },
      { name: 'JPEG', extensions: ['jpg'] },
      { name: 'WebP', extensions: ['webp'] },
      { name: 'TIFF', extensions: ['tif'] },
    ],
  })
  return r.canceled || !r.filePath ? null : r.filePath
})

ipcMain.handle('write-file', async (_ev, { filePath, bytes }) => {
  await fs.promises.writeFile(filePath, Buffer.from(bytes))
  return true
})
