const { app, BrowserWindow, ipcMain, safeStorage, clipboard } = require('electron')
const path = require('node:path')
const { readFile } = require('node:fs/promises')

let window, server, runtime, state, settings
let status = '未连接', expressions = []
function snapshot() { return { config: state.config, status, details: runtime?.getStatus(), expressions, overlayUrl: server.overlayUrl, secretConfigured: !!state.apiKey } }
function updateStatus(text) { status = text; if (window && !window.isDestroyed()) window.webContents.send('state-changed', snapshot()) }
function register(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('未经授权的调用')
    return handler(...args)
  })
}
async function start() {
  const { createOverlayServer } = await import('./backend/server.js')
  const { createRuntime } = await import('./backend/runtime.js')
  settings = await import('./backend/settings.js')
  const directory = app.getPath('userData')
  state = await settings.loadSettings(directory, safeStorage)
  const assets = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, '../assets')
  const manifest = JSON.parse(await readFile(path.join(assets, 'model/manifest.json'), 'utf8'))
  expressions = Object.keys(manifest.expressions)
  server = await createOverlayServer({ stageDir: path.join(__dirname, 'stage'), assetsDir: assets })
  runtime = createRuntime({ broadcast: event => server.broadcast(event), onStatus: updateStatus, expressions })
  window = new BrowserWindow({ width: 900, height: 850, minWidth: 640, minHeight: 500, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  register('state', () => snapshot())
  register('save-config', async input => {
    if (!input || typeof input !== 'object') throw new Error('配置无效')
    const apiKey = typeof input.apiKey === 'string' && input.apiKey ? input.apiKey : state.apiKey
    const config = await settings.saveSettings(directory, safeStorage, input, apiKey)
    runtime.stop()
    state = { config, apiKey }
    updateStatus('设置已保存，请重新连接')
    return snapshot()
  })
  register('connect', authCode => { runtime.start(state.config, state.apiKey, authCode); return snapshot() })
  register('disconnect', () => { runtime.stop(); return snapshot() })
  register('perform', payload => { if (!payload || typeof payload !== 'object') throw new Error('动作无效'); runtime.perform(payload) })
  register('copy-overlay-url', () => clipboard.writeText(server.overlayUrl))
  await window.loadFile(path.join(__dirname, 'ui/index.html'))
}
app.whenReady().then(start).catch(error => { console.error('启动失败:', error); app.exit(1) })
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { runtime?.stop(); server?.close() })
