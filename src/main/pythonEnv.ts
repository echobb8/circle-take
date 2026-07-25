/**
 * Python environment management for the gate engine.
 *
 * Dev uses the repo-local `.venv` when present; packaged builds own a venv
 * under userData (Application Support — never an iCloud-synced path). Setup
 * progress is pushed to the renderer on the `engine-status` channel so the
 * first-run experience is visible rather than a silent stall.
 *
 * Mirrors Stem Studio's pythonEnv, adapted to the EngineStatus contract in
 * src/shared/api.ts.
 */

import { app, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { access, mkdir } from 'fs/promises'
import { constants } from 'fs'
import { join, resolve } from 'path'
import type { EngineStatus } from '../shared/api'

/** Runtime imports the gate engine needs before it can score anything. */
const REQUIRED_IMPORTS = 'import numpy, cv2'

let status: EngineStatus = { ready: false, stage: 'idle' }
let setupInFlight: Promise<string> | null = null

/* -------------------------------- status -------------------------------- */

export function getEngineStatus(): EngineStatus {
  return status
}

function setStatus(patch: Partial<EngineStatus>): void {
  status = { ...status, ...patch }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('engine-status', status)
  }
}

/* --------------------------------- paths -------------------------------- */

/** Where the python worker package lives. */
export function workerRoot(): string {
  const packaged = join(process.resourcesPath ?? '', 'python')
  const dev = resolve(__dirname, '../../python')
  return app.isPackaged ? packaged : dev
}

function repoVenv(): string {
  return resolve(__dirname, '../../.venv')
}

function userVenv(): string {
  return join(app.getPath('userData'), 'venv')
}

/** Path to the python executable inside a venv (posix/win aware). */
export function venvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/* ------------------------------- detection ------------------------------ */

function pythonCan(py: string, code: string): Promise<boolean> {
  return new Promise((res) => {
    const child = spawn(py, ['-c', code], { stdio: 'ignore' })
    child.on('error', () => res(false))
    child.on('close', (code2) => res(code2 === 0))
  })
}

/** Ready-to-use venv python, or null. Prefers the repo `.venv` in dev. */
export async function findReadyPython(): Promise<string | null> {
  for (const venv of [repoVenv(), userVenv()]) {
    const py = venvPython(venv)
    if ((await exists(py)) && (await pythonCan(py, REQUIRED_IMPORTS))) return py
  }
  return null
}

/** Detect a system python >= 3.10 to bootstrap the venv from. */
export async function detectSystemPython(): Promise<string | null> {
  const candidates = [
    process.env.CIRCLETAKE_PYTHON,
    'python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ].filter((c): c is string => typeof c === 'string' && c.length > 0)

  for (const cand of candidates) {
    const ok = await pythonCan(
      cand,
      'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)',
    )
    if (ok) return cand
  }
  return null
}

/** Engine version string reported by the worker, best-effort. */
async function readEngineVersion(py: string): Promise<string | undefined> {
  return new Promise((res) => {
    let out = ''
    const child = spawn(py, ['-c', 'import circletake_gate as g; print(g.__version__)'], {
      cwd: workerRoot(),
      env: { ...process.env, PYTHONPATH: workerRoot(), PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString()
    })
    child.on('error', () => res(undefined))
    child.on('close', (code) => {
      const v = out.trim().split('\n').pop()?.trim()
      res(code === 0 && v ? v : undefined)
    })
  })
}

/** Refresh the cached status by probing the current environment. */
export async function refreshEngineStatus(): Promise<EngineStatus> {
  const py = await findReadyPython()
  if (!py) {
    setStatus({
      ready: false,
      stage: status.stage === 'installing' || status.stage === 'creating-venv' ? status.stage : 'idle',
      detail: 'Python environment not set up yet.',
    })
    return status
  }
  const [version, anatomy] = await Promise.all([
    readEngineVersion(py),
    pythonCan(py, 'import mediapipe'),
  ])
  setStatus({
    ready: true,
    stage: 'ready',
    detail: undefined,
    engineVersion: version,
    anatomyAvailable: anatomy,
  })
  return status
}

/* --------------------------------- setup -------------------------------- */

/**
 * Create the app-managed venv and install `python/requirements.txt`.
 * Concurrent callers share a single in-flight setup.
 */
export function setupEngine(): Promise<string> {
  if (setupInFlight) return setupInFlight
  setupInFlight = doSetup().finally(() => {
    setupInFlight = null
  })
  return setupInFlight
}

async function doSetup(): Promise<string> {
  const existing = await findReadyPython()
  if (existing) {
    await refreshEngineStatus()
    return existing
  }

  const sysPython = await detectSystemPython()
  if (!sysPython) {
    setStatus({
      ready: false,
      stage: 'error',
      detail: 'No suitable Python found. Install Python 3.10+ (e.g. `brew install python`) and relaunch.',
    })
    throw new Error('No suitable Python 3.10+ found.')
  }

  const venvDir = userVenv()
  const py = venvPython(venvDir)
  await mkdir(app.getPath('userData'), { recursive: true })

  if (!(await exists(py))) {
    setStatus({ ready: false, stage: 'creating-venv', detail: 'Creating Python environment…' })
    await runStreaming(sysPython, ['-m', 'venv', venvDir], (line) =>
      setStatus({ stage: 'creating-venv', detail: line }),
    )
  }

  setStatus({ ready: false, stage: 'installing', detail: 'Upgrading pip…' })
  await runStreaming(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], (line) =>
    setStatus({ stage: 'installing', detail: line }),
  )

  setStatus({
    ready: false,
    stage: 'installing',
    detail: 'Installing the gate engine (numpy, OpenCV, MediaPipe)…',
  })
  const req = join(workerRoot(), 'requirements.txt')
  await runStreaming(py, ['-m', 'pip', 'install', '-r', req], (line) =>
    setStatus({ stage: 'installing', detail: line }),
  )

  if (!(await pythonCan(py, REQUIRED_IMPORTS))) {
    setStatus({
      ready: false,
      stage: 'error',
      detail: 'Setup finished but the gate engine libraries are still missing.',
    })
    throw new Error('Python setup finished but required libraries are missing.')
  }

  await refreshEngineStatus()
  return py
}

/** Spawn a command, forwarding each stdout/stderr line to `onLine`. */
function runStreaming(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const forward = (buf: Buffer): void => {
      for (const line of buf.toString().split('\n')) {
        const t = line.trim()
        if (t) onLine(t)
      }
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', rej)
    child.on('close', (code) => {
      if (code === 0) res()
      else rej(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}
