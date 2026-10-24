/**
 * Electron main process: window lifecycle, the `ctake://` media protocol, the
 * full IPC surface from src/shared/api.ts, and the localhost control server.
 *
 * Everything the renderer cannot do — filesystem, spawn, network — lives on
 * this side of the bridge. The handlers here are thin: each one delegates to
 * project.ts / ingest.ts / gate.ts / exports.ts, which the control server calls
 * too, so the UI and an agent can never drift apart.
 */

import { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { extname, join, normalize, resolve, sep } from 'path'
import { pathToFileURL } from 'url'

import pkgJson from '../../package.json'
import { MEDIA_EXTENSIONS, type Rating, type Shot } from '../shared/types'
import * as project from './project'
import * as ingest from './ingest'
import * as gate from './gate'
import * as kits from './kits'
import * as exportsApi from './exports'
import { getEngineStatus, refreshEngineStatus, setupEngine } from './pythonEnv'
import { startControlServer } from './control'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// Pin userData BEFORE renaming the app so the managed venv and caches keep a
// stable home (and stay well outside any iCloud-synced folder).
app.setPath('userData', join(app.getPath('appData'), 'circle-take-kids-3d'))
app.setName('Circle Take Kids 3D')

let mainWindow: BrowserWindow | null = null

// Privileged, stream-capable scheme so <video> can play takes with seeking
// without exposing the whole filesystem via file://.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ctake',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      bypassCSP: false,
    },
  },
])

/* -------------------------------- window -------------------------------- */

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1280,
    minHeight: 800,
    title: 'Circle Take',
    backgroundColor: '#0b0e14',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    ...(process.platform === 'linux' ? { icon: join(__dirname, '../../build/icon.png') } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL as string)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const EXTERNAL_LINK_ALLOWLIST = new Set(['wassermanproductions.com', 'wasserman.ai', 'github.com'])
const REPO_URL = 'https://github.com/wassermanproductions/circle-take'

async function openExternal(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    if (parsed.protocol !== 'https:' || !EXTERNAL_LINK_ALLOWLIST.has(host)) return false
    await shell.openExternal(url)
    return true
  } catch {
    return false
  }
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.getName(),
            submenu: [
              {
                label: 'About Circle Take',
                click: () => mainWindow?.webContents.send('menu:about'),
              },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: () => send('menu:newProject') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:openProject') },
        { label: 'Ingest Files…', accelerator: 'CmdOrCtrl+I', click: () => send('menu:ingest') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    {
      role: 'help',
      submenu: [{ label: 'Circle Take on GitHub', click: () => void openExternal(REPO_URL) }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function send(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args)
}

/* ------------------------------ ctake:// ------------------------------- */

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolve a path that MUST stay inside the open project folder. Belt and
 * braces: each segment is rejected if it is a traversal or carries a
 * separator, and the resolved result is re-checked against the root.
 */
function insideProject(...segments: string[]): string {
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || /[/\\]/.test(segment)) {
      throw new Error('path traversal rejected')
    }
  }
  const root = resolve(project.requireProjectDir())
  const target = resolve(root, ...segments.map((s) => normalize(s)))
  if (!target.startsWith(root + sep)) throw new Error('path traversal rejected')
  return target
}

/** Serve a file with byte-range support so <video> can seek. */
async function serveFile(path: string, request: Request): Promise<Response> {
  const info = await stat(path)
  const size = info.size
  const type = mimeFor(path)
  const range = request.headers.get('range')

  if (!range) {
    return new Response(
      Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>,
      {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
        },
      },
    )
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!match) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  let start = rawStart ? Number(rawStart) : 0
  let end = rawEnd ? Number(rawEnd) : size - 1
  if (!rawStart && rawEnd) {
    // Suffix form: "bytes=-500" means the LAST 500 bytes.
    start = Math.max(0, size - Number(rawEnd))
    end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  end = Math.min(end, size - 1)

  return new Response(
    Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream<Uint8Array>,
    {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      },
    },
  )
}

/**
 * ctake://media/<takeId>            the take's video (referenced in place)
 * ctake://thumb/<takeId>/<name>     thumbs/<takeId>/<name>
 * ctake://evidence/<takeId>/<file>  evidence/<takeId>/<file>
 * ctake://kit/<charId>/<file>       kits/<charId>/<file>
 */
async function handleCtake(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const kind = url.hostname
  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s))

  try {
    if (kind === 'media') {
      const takeId = parts[0]
      if (!takeId) return new Response('bad request', { status: 400 })
      const take = project.findTake(takeId)
      if (!take) return new Response('take not found', { status: 404 })
      return await serveFile(take.mediaPath, request)
    }

    const dir = kind === 'thumb' ? 'thumbs' : kind === 'evidence' ? 'evidence' : kind === 'kit' ? 'kits' : null
    if (!dir) return new Response('unknown ctake:// host', { status: 400 })

    const owner = parts[0]
    const file = parts[1]
    if (!owner || !file || parts.length !== 2) {
      return new Response('bad request', { status: 400 })
    }
    const abs = insideProject(dir, owner, file)
    // Images are small and never seeked — let net.fetch handle them.
    return await net.fetch(pathToFileURL(abs).toString())
  } catch (err) {
    const message = (err as Error).message
    const status = message === 'path traversal rejected' ? 403 : 404
    return new Response(message, { status })
  }
}

/* ---------------------------------- IPC --------------------------------- */

function registerIpc(): void {
  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args))
  }

  // ---- project lifecycle ----
  handle('createProject', (parentDir: string, name: string) =>
    project.createProject(parentDir, name),
  )
  handle('openProject', async (ctakePath: string) => {
    const p = await project.openProject(ctakePath)
    ingest.applyWatchFolder(p.settings.watchFolder ?? null)
    return p
  })
  handle('getProject', () => project.getProject())
  handle('getProjectPath', () => project.getProjectPath())
  handle('getRecentProjects', () => project.getRecentProjects())

  // ---- dialogs ----
  handle('chooseMediaFiles', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: MEDIA_EXTENSIONS.map((e) => e.slice(1)) }],
    })
    return res.canceled ? [] : res.filePaths
  })
  handle('chooseImageFiles', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff'] }],
    })
    return res.canceled ? [] : res.filePaths
  })
  handle('chooseFolder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('chooseProjectFile', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Open a .ctake project folder',
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('chooseSavePath', async (defaultName: string) => {
    const res = await dialog.showSaveDialog({ defaultPath: defaultName })
    return res.canceled ? null : (res.filePath ?? null)
  })

  // ---- shots ----
  handle('addShot', (shot: Omit<Shot, 'id' | 'order'>) => project.addShot(shot))
  handle('updateShot', (id: string, patch: Partial<Omit<Shot, 'id'>>) =>
    project.updateShot(id, patch),
  )
  handle('deleteShot', (id: string) => project.deleteShot(id))
  handle('reorderShots', (ids: string[]) => project.reorderShots(ids))

  // ---- takes ----
  handle('ingestFiles', (paths: string[]) => ingest.ingestFiles(paths))
  handle('assignTake', (takeId: string, shotId: string) => project.assignTake(takeId, shotId))
  handle('setProvenance', (takeId: string, prov: Record<string, string>) =>
    project.setProvenance(takeId, prov),
  )
  handle('circleTake', (takeId: string, circled: boolean) => project.circleTake(takeId, circled))
  handle('setRating', (takeId: string, rating: Rating) => project.setRating(takeId, rating))
  handle('setTakeWindow', (takeId: string, inSec: number | null, outSec: number | null) =>
    project.setTakeWindow(takeId, inSec, outSec),
  )
  handle('setProduction', (value: unknown) => project.setProduction(value))
  handle('setModelRates', (rates: Record<string, number>) => project.setModelRates(rates))
  handle('deleteTake', (takeId: string) => project.deleteTake(takeId))

  // ---- gate ----
  handle('runGate', (takeId: string) => gate.runGate(takeId))
  handle('runGateAll', (onlyPending: boolean) => gate.runGateAll(onlyPending))
  handle('cancelGates', () => {
    gate.cancelGates()
  })
  handle('getGateReport', (takeId: string) => gate.getGateReport(takeId))
  handle('getEngineStatus', () => getEngineStatus())
  handle('setupEngine', () => setupEngine())

  // ---- character kits ----
  handle('addCharacter', (name: string) => project.addCharacter(name))
  handle('renameCharacter', (id: string, name: string) => project.renameCharacter(id, name))
  handle('deleteCharacter', (id: string) => project.deleteCharacter(id))
  handle('addKitImages', async (charId: string, imagePaths: string[]) => {
    await kits.addKitImages(charId, imagePaths)
    return project.requireProject()
  })
  handle('removeKitImage', async (charId: string, image: string) => {
    await kits.removeKitImage(charId, image)
    return project.requireProject()
  })
  handle('buildKit', (charId: string) => gate.buildKit(charId))

  // ---- watch folder ----
  handle('setWatchFolder', (path: string | null) => {
    const p = project.setWatchFolder(path)
    ingest.applyWatchFolder(path)
    return p
  })

  // ---- exports ----
  handle('exportFcpxml', (outPath: string) => exportsApi.exportFcpxml(outPath))
  handle('exportEdl', (outPath: string) => exportsApi.exportEdl(outPath))
  handle('exportReshootList', (outPath: string) => exportsApi.exportReshootList(outPath))
  handle('exportCsv', (outPath: string) => exportsApi.exportCsv(outPath))

  // ---- misc ----
  handle('openExternal', (url: string) => openExternal(url))
  // Inline package.json version — app.getVersion() reports Electron's own
  // version in dev/e2e (blockout lesson), so never trust it here.
  handle('appVersion', () => pkgJson.version)
  handle('revealInFinder', (path: string) => {
    shell.showItemInFolder(path)
    return true
  })
}

/* --------------------------------- boot --------------------------------- */

app.whenReady().then(async () => {
  app.setAboutPanelOptions({
    applicationName: 'Circle Take',
    applicationVersion: pkgJson.version,
    version: '',
    copyright: '© 2026 Sam Wasserman',
    credits: 'Created by Sam Wasserman — wassermanproductions.com · wasserman.ai',
  })

  buildAppMenu()
  protocol.handle('ctake', (request) => handleCtake(request))
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  void refreshEngineStatus()
  await startControlServer(() => mainWindow).catch((err: unknown) => {
    console.error('[circle-take] control server failed to start:', (err as Error).message)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// E2E hook: Playwright drives the main process through app.evaluate, where
// dialogs are unavailable. Exposed only under CTAKE_E2E=1; calls the exact
// same mutators the IPC and control-server doors use.
if (process.env.CTAKE_E2E === '1') {
  (globalThis as Record<string, unknown>).__ctakeMain = {
    createProject: (parent: string, name: string) => project.createProject(parent, name),
    projectPath: () => project.getProjectPath(),
    state: () => project.getProject(),
    addShot: (s: Omit<Shot, 'id' | 'order'>) => Promise.resolve(project.addShot(s)),
    ingest: (paths: string[]) => ingest.ingestFiles(paths),
    runGate: (id: string) => gate.runGate(id),
    circleTake: (id: string, circled: boolean) => Promise.resolve(project.circleTake(id, circled)),
    exportFcpxml: (p: string) => exportsApi.exportFcpxml(p),
    exportReshootList: (p: string) => exportsApi.exportReshootList(p),
  }
}

app.on('before-quit', () => {
  ingest.stopWatching()
  gate.cancelGates()
  void project.saveNow().catch(() => {})
})
