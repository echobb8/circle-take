/**
 * Ingest pipeline: files/folders in -> Takes bound to shots -> probe -> thumbs.
 *
 * Takes are created synchronously so the Bin fills instantly; probing and
 * thumbnail extraction run behind a small worker pool and patch each take as
 * results land. Per-take stage changes are pushed on `ingest-progress`.
 *
 * Media is referenced in place — the project folder only ever gains generated
 * artefacts (thumbs/, evidence/), never a copy of the footage.
 */

import { BrowserWindow } from 'electron'
import { readdir, readFile, stat } from 'fs/promises'
import { watch, type FSWatcher } from 'fs'
import { basename, dirname, extname, join, resolve } from 'path'
import {
  MEDIA_EXTENSIONS,
  provenanceFromSidecar,
  shotHintFromFileName,
  type IngestStage,
  type Provenance,
} from '../shared/types'
import type { IngestResult } from '../shared/api'
import { extractThumbs, probeMedia } from './ffmpeg'
import * as project from './project'

/** How long the watch folder stays quiet before a batch is ingested. */
const WATCH_DEBOUNCE_MS = 2000
/** Probe+thumbnail concurrency. Two keeps a fanless laptop responsive. */
const PROCESS_CONCURRENCY = 2

const pending: string[] = []
let workers = 0

let watcher: FSWatcher | null = null
let watchTimer: NodeJS.Timeout | null = null
let watchedDir: string | null = null

/* -------------------------------- events -------------------------------- */

function emitProgress(fileName: string, stage: IngestStage | 'error'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ingest-progress', { fileName, stage })
  }
}

/* ------------------------------- discovery ------------------------------ */

export function isMediaFile(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return (MEDIA_EXTENSIONS as readonly string[]).includes(ext)
}

/** Expand folders (recursively) into a flat file list; files pass through. */
async function expandPaths(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const path of paths) {
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
      const children = entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => join(path, e.name))
      out.push(...(await expandPaths(children)))
    } else if (info.isFile()) {
      out.push(resolve(path))
    }
  }
  return out
}

/* ------------------------------- provenance ----------------------------- */

/**
 * Read `<base>.json` (mapped through provenanceFromSidecar) or `<base>.txt`
 * (whole file becomes the prompt) sitting next to the media file.
 */
export async function readSidecar(mediaPath: string): Promise<Provenance> {
  const dir = dirname(mediaPath)
  const base = basename(mediaPath, extname(mediaPath))

  const jsonPath = join(dir, `${base}.json`)
  try {
    const raw = await readFile(jsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const prov = provenanceFromSidecar(parsed as Record<string, unknown>)
      return { ...stripUndefined(prov), sourceSidecar: jsonPath }
    }
  } catch {
    /* no json sidecar, or unreadable — try the txt form */
  }

  const txtPath = join(dir, `${base}.txt`)
  try {
    const text = await readFile(txtPath, 'utf-8')
    if (text.trim()) return { prompt: text.trim(), sourceSidecar: txtPath }
  } catch {
    /* no sidecar at all */
  }
  return {}
}

function stripUndefined(prov: Provenance): Provenance {
  const out: Provenance = {}
  for (const [key, value] of Object.entries(prov)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}

/* --------------------------------- ingest ------------------------------- */

/** Case-insensitive filename-hint -> shot id, or '' for the unassigned tray. */
function bindShot(fileName: string): string {
  const hint = shotHintFromFileName(fileName)
  if (!hint) return ''
  const shots = project.getProject()?.shots ?? []
  const match = shots.find((s) => s.name.trim().toUpperCase() === hint)
  return match ? match.id : ''
}

/**
 * Ingest a batch of file/folder paths. Non-media files and paths already in
 * the project are skipped with a reason rather than failing the whole batch.
 */
export async function ingestFiles(paths: string[]): Promise<IngestResult> {
  project.requireProject()
  const files = await expandPaths(paths)
  const skipped: string[] = []
  let added = 0

  for (const file of files) {
    const fileName = basename(file)
    if (!isMediaFile(file)) {
      skipped.push(`${fileName} — not a supported media file`)
      continue
    }
    const known = project.getProject()?.takes ?? []
    if (known.some((t) => t.mediaPath === file)) {
      skipped.push(`${fileName} — already ingested`)
      continue
    }

    const provenance = await readSidecar(file)
    const take = project.addTake({
      shotId: bindShot(fileName),
      mediaPath: file,
      fileName,
      provenance,
    })
    added++
    emitProgress(fileName, 'ingested')
    enqueue(take.id)
  }

  return { added, skipped }
}

/* ---------------------------- probe + thumbs ---------------------------- */

function enqueue(takeId: string): void {
  pending.push(takeId)
  pump()
}

function pump(): void {
  while (workers < PROCESS_CONCURRENCY && pending.length > 0) {
    const takeId = pending.shift()
    if (!takeId) return
    workers++
    void processTake(takeId).finally(() => {
      workers--
      pump()
    })
  }
}

async function processTake(takeId: string): Promise<void> {
  const take = project.findTake(takeId)
  if (!take) return
  try {
    const probe = await probeMedia(take.mediaPath)
    project.updateTake(takeId, { probe })
    emitProgress(take.fileName, 'probed')

    await extractThumbs(take.mediaPath, project.thumbsDir(takeId), probe.durationSec)
    emitProgress(take.fileName, 'thumbed')
  } catch (err) {
    console.error(`[circle-take] ingest failed for ${take.fileName}:`, (err as Error).message)
    emitProgress(take.fileName, 'error')
  }
}

/* ------------------------------ watch folder ---------------------------- */

/**
 * Point the watcher at a folder (or null to stop). New media files that appear
 * are auto-ingested after a 2 s quiet period — generators write files in
 * bursts, and fs.watch fires several times per file.
 */
export function applyWatchFolder(path: string | null): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
  if (watchTimer) {
    clearTimeout(watchTimer)
    watchTimer = null
  }
  watchedDir = path
  if (!path) return

  try {
    watcher = watch(path, { persistent: false }, () => {
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        watchTimer = null
        void sweepWatchFolder()
      }, WATCH_DEBOUNCE_MS)
    })
    watcher.on('error', (err) => {
      console.error('[circle-take] watch folder error:', err.message)
    })
  } catch (err) {
    console.error('[circle-take] could not watch folder:', (err as Error).message)
  }
  // Pick up anything already sitting in the folder.
  void sweepWatchFolder()
}

async function sweepWatchFolder(): Promise<void> {
  const dir = watchedDir
  if (!dir || !project.getProject()) return
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const files = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => join(dir, e.name))
      .filter(isMediaFile)
    if (files.length) await ingestFiles(files)
  } catch (err) {
    console.error('[circle-take] watch sweep failed:', (err as Error).message)
  }
}

/** Stop watching (called on quit / project close). */
export function stopWatching(): void {
  applyWatchFolder(null)
}
