/**
 * Gate runner: a serial queue that spawns the `circletake_gate` python worker
 * per take, streams its line-JSON progress to the renderer, and folds the
 * finished report into the take's denormalized GateSummary.
 *
 * Fail-soft by design. The engine is a separate deliverable and may not be
 * installed (or may not exist yet): a missing venv, a spawn error, a non-zero
 * exit or an unreadable report all land as `gate.status = 'error'` with a
 * human reason on the take, never as an unhandled rejection.
 */

import { BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CHECK_IDS,
  overallScore,
  parseWorkerLine,
  statusFromChecks,
} from '../shared/types'
import type {
  CharacterKit,
  CheckSummary,
  GateReport,
  GateSummary,
  Take,
} from '../shared/types'
import { findReadyPython, workerRoot } from './pythonEnv'
import { gateArgs, kitBuildArgs, mergeExpected } from './workerArgs'
import * as project from './project'

const ENGINE_MISSING =
  'Gate engine not available — the Python environment is not set up yet. Open Settings and run engine setup.'

const queue: string[] = []
let current: ChildProcess | null = null
let running = false
let cancelled = false

/* -------------------------------- events -------------------------------- */

function emitGateProgress(takeId: string, stage: string, pct: number, note?: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('gate-progress', { takeId, stage, pct, note })
  }
}

function setGate(takeId: string, gate: GateSummary): void {
  try {
    project.updateTake(takeId, { gate })
  } catch {
    /* take was deleted mid-run — nothing to update */
  }
}

function setGateError(takeId: string, message: string): void {
  setGate(takeId, {
    status: 'error',
    overall: 0,
    checks: {},
    engineVersion: 'unknown',
    ranAt: new Date().toISOString(),
    error: message,
  })
}

/* --------------------------------- queue -------------------------------- */

/** Enqueue one take. Resolves as soon as it is queued, not when it finishes. */
export async function runGate(takeId: string): Promise<void> {
  const take = project.findTake(takeId)
  if (!take) throw new Error(`No take with id ${takeId}`)
  enqueue(takeId)
}

/** Enqueue every take, or only those with no gate result yet. */
export async function runGateAll(onlyPending: boolean): Promise<void> {
  const p = project.requireProject()
  for (const take of p.takes) {
    if (onlyPending && take.gate && take.gate.status !== 'pending' && take.gate.status !== 'error') {
      continue
    }
    enqueue(take.id)
  }
}

function enqueue(takeId: string): void {
  if (queue.includes(takeId)) return
  cancelled = false
  queue.push(takeId)
  setGate(takeId, {
    status: 'pending',
    overall: 0,
    checks: {},
    engineVersion: 'unknown',
    ranAt: new Date().toISOString(),
  })
  void pump()
}

/** Kill the running worker and drop everything still queued. */
export function cancelGates(): void {
  cancelled = true
  const dropped = queue.splice(0, queue.length)
  for (const takeId of dropped) {
    const take = project.findTake(takeId)
    if (take?.gate?.status === 'pending') setGateError(takeId, 'Cancelled before it ran.')
  }
  const child = current
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0 && !cancelled) {
      const takeId = queue.shift()
      if (!takeId) break
      await runOne(takeId).catch((err: unknown) => {
        setGateError(takeId, (err as Error).message)
      })
    }
  } finally {
    running = false
    current = null
  }
}

/* ------------------------------ argument prep --------------------------- */

/**
 * Neighbour context = the circled takes of the shots immediately before and
 * after this one in cut order. The continuity check grades the take against
 * them, so a grade mismatch shows up at the actual cut point.
 */
function neighborMediaPaths(take: Take): string[] {
  const p = project.getProject()
  if (!p || !take.shotId) return []
  const shot = p.shots.find((s) => s.id === take.shotId)
  if (!shot) return []
  const wanted = new Set([shot.order - 1, shot.order + 1])
  const neighbourShotIds = new Set(
    p.shots.filter((s) => wanted.has(s.order)).map((s) => s.id),
  )
  return p.takes
    .filter((t) => t.circled && neighbourShotIds.has(t.shotId))
    .map((t) => t.mediaPath)
}

/**
 * v1 rule: one kit per shot. If the shot names characters and the first one
 * has a built embeddings cache, that is the identity reference.
 */
async function kitPathFor(take: Take): Promise<string | undefined> {
  const shot = take.shotId ? project.findShot(take.shotId) : null
  const charId = shot?.characterIds[0]
  if (!charId) return undefined
  const path = join(project.kitsDir(charId), 'embeddings.json')
  try {
    await readFile(path)
    return path
  } catch {
    return undefined
  }
}

/* ------------------------------- one take ------------------------------- */

async function runOne(takeId: string): Promise<void> {
  const take = project.findTake(takeId)
  if (!take) return

  const py = await findReadyPython()
  if (!py) {
    setGateError(takeId, ENGINE_MISSING)
    return
  }

  const p = project.requireProject()
  const shot = take.shotId ? project.findShot(take.shotId) : null
  const reportPath = project.gateReportPath(takeId)
  await mkdir(project.gatesDir(), { recursive: true })
  await mkdir(project.evidenceDir(takeId), { recursive: true })

  const neighbors = neighborMediaPaths(take)
  let neighborsPath: string | undefined
  if (neighbors.length > 0) {
    neighborsPath = join(tmpdir(), `ctake-neighbors-${takeId}.json`)
    await writeFile(neighborsPath, JSON.stringify({ mediaPaths: neighbors }), 'utf-8')
  }

  const args = gateArgs({
    mediaPath: take.mediaPath,
    reportPath,
    takeId,
    checks: CHECK_IDS,
    kitPath: await kitPathFor(take),
    expected: mergeExpected(p.settings.expected, shot?.expected),
    neighborsPath,
  })

  setGate(takeId, {
    status: 'running',
    overall: 0,
    checks: {},
    engineVersion: 'unknown',
    ranAt: new Date().toISOString(),
  })
  emitGateProgress(takeId, 'starting', 0)

  const outcome = await spawnWorker(py, args, takeId)
  if (neighborsPath) await rm(neighborsPath, { force: true }).catch(() => {})

  if (cancelled) {
    setGateError(takeId, 'Cancelled.')
    return
  }
  if (!outcome.ok) {
    setGateError(takeId, outcome.message)
    return
  }

  try {
    const report = await readGateReport(reportPath)
    applyReport(takeId, report)
  } catch (err) {
    setGateError(takeId, `Gate finished but its report could not be read: ${(err as Error).message}`)
  }
}

interface WorkerOutcome {
  ok: boolean
  message: string
}

function spawnWorker(py: string, args: string[], takeId: string): Promise<WorkerOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(py, args, {
        cwd: workerRoot(),
        env: { ...process.env, PYTHONPATH: workerRoot(), PYTHONUNBUFFERED: '1' },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ ok: false, message: `${ENGINE_MISSING} (${(err as Error).message})` })
      return
    }
    current = child

    let buffer = ''
    let stderr = ''
    let workerError: string | null = null

    child.stdout?.on('data', (buf: Buffer) => {
      buffer += buf.toString()
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        const msg = parseWorkerLine(line)
        if (msg?.type === 'progress') {
          emitGateProgress(takeId, msg.stage, msg.pct, msg.note)
        } else if (msg?.type === 'error') {
          workerError = msg.message
        }
        idx = buffer.indexOf('\n')
      }
    })
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString()
    })

    child.on('error', (err) => {
      current = null
      resolve({ ok: false, message: `${ENGINE_MISSING} (${err.message})` })
    })
    child.on('close', (code) => {
      current = null
      const tail = parseWorkerLine(buffer)
      if (tail?.type === 'error') workerError = tail.message
      if (workerError) {
        resolve({ ok: false, message: workerError })
      } else if (code !== 0) {
        resolve({
          ok: false,
          message: `Gate worker exited ${code}${stderr ? `: ${stderr.trim().slice(-500)}` : ''}`,
        })
      } else {
        resolve({ ok: true, message: '' })
      }
    })
  })
}

/* ------------------------------- report I/O ----------------------------- */

async function readGateReport(path: string): Promise<GateReport> {
  const raw = await readFile(path, 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null) throw new Error('report is not an object')
  return parsed as GateReport
}

/** Fold a full report into the take: GateSummary + engine-suggested window. */
function applyReport(takeId: string, report: GateReport): void {
  const checks: Partial<Record<(typeof CHECK_IDS)[number], CheckSummary>> = {}
  for (const id of CHECK_IDS) {
    const c = report.checks?.[id]
    if (!c) continue
    checks[id] = { verdict: c.verdict, score: c.score, reason: c.reason }
  }

  const gate: GateSummary = {
    status: report.status ?? statusFromChecks(checks),
    overall: typeof report.overall === 'number' ? report.overall : overallScore(checks),
    checks,
    engineVersion: report.engineVersion ?? 'unknown',
    ranAt: report.ranAt ?? new Date().toISOString(),
  }

  const patch: Partial<Omit<Take, 'id'>> = { gate }
  const take = project.findTake(takeId)
  const suggested = report.suggestedWindow
  // The engine's suggested window is a starting point, never an override:
  // only adopt it when the director has not set one by hand.
  if (
    suggested &&
    take &&
    take.inSec === undefined &&
    take.outSec === undefined &&
    Number.isFinite(suggested.inSec) &&
    Number.isFinite(suggested.outSec) &&
    suggested.outSec > suggested.inSec
  ) {
    patch.inSec = Math.max(0, suggested.inSec)
    patch.outSec = suggested.outSec
  }

  try {
    project.updateTake(takeId, patch)
  } catch {
    /* take was deleted mid-run */
  }
}

/** Read the full gate report for a take, or null when it has not been gated. */
export async function getGateReport(takeId: string): Promise<GateReport | null> {
  try {
    return await readGateReport(project.gateReportPath(takeId))
  } catch {
    return null
  }
}

/* -------------------------------- kit build ----------------------------- */

/**
 * Build (and freeze) a character kit's embeddings from its reference stills.
 * Throws with a readable message when the engine is unavailable so the UI can
 * surface it — unlike gating, this is a direct user action.
 */
export async function buildKit(charId: string): Promise<CharacterKit> {
  const char = project.findCharacter(charId)
  if (!char) throw new Error(`No character with id ${charId}`)
  if (char.images.length === 0) {
    throw new Error(`${char.name} has no reference stills yet — add images first.`)
  }

  const py = await findReadyPython()
  if (!py) throw new Error(ENGINE_MISSING)

  const dir = project.kitsDir(charId)
  await mkdir(dir, { recursive: true })
  const outPath = join(dir, 'embeddings.json')
  const images = char.images.map((rel) => join(project.requireProjectDir(), rel))

  await new Promise<void>((resolve, reject) => {
    const child = spawn(py, kitBuildArgs(outPath, images), {
      cwd: workerRoot(),
      env: { ...process.env, PYTHONPATH: workerRoot(), PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString()
    })
    child.on('error', (err) => reject(new Error(`${ENGINE_MISSING} (${err.message})`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Kit build failed (exit ${code})${stderr ? `: ${stderr.trim().slice(-500)}` : ''}`))
    })
  })

  project.setCharacterLocked(charId, true)
  const updated = project.findCharacter(charId)
  if (!updated) throw new Error(`Character ${charId} disappeared during kit build.`)
  return updated
}
