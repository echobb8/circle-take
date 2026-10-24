import { defaultProduction, normalizeProduction } from '../shared/production'
/**
 * The canonical Project store. MAIN owns it; the renderer only ever holds a
 * mirror that is refreshed by the `project-updated` broadcast this module
 * emits after every mutation.
 *
 * On disk a project is a `<name>.ctake/` folder:
 *   project.json           single source of truth (schema v1)
 *   gates/<takeId>.json    full gate reports
 *   kits/<charId>/         reference stills + embeddings.json
 *   thumbs/<takeId>/       poster.jpg + strip_0..7.jpg
 *   evidence/<takeId>/     worst-frame JPEGs from the gate
 *
 * Saves are debounced 500 ms and written atomically (tmp file + rename) so a
 * crash mid-write can never truncate project.json.
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join, basename } from 'path'
import {
  PROJECT_SCHEMA_VERSION,
  PROJECT_EXT,
  newId,
} from '../shared/types'
import type {
  CharacterKit,
  Project,
  Provenance,
  Rating,
  Shot,
  Take,
} from '../shared/types'
import type { RecentProject } from '../shared/api'

const SAVE_DEBOUNCE_MS = 500
const MAX_RECENTS = 8

let current: Project | null = null
let currentDir: string | null = null
let saveTimer: NodeJS.Timeout | null = null

/* ------------------------------- accessors ------------------------------ */

export function getProject(): Project | null {
  return current
}

export function getProjectPath(): string | null {
  return currentDir
}

/** The open project, or a readable error for IPC/control callers. */
export function requireProject(): Project {
  if (!current) throw new Error('No project is open — open or create a .ctake project first.')
  return current
}

export function requireProjectDir(): string {
  if (!currentDir) throw new Error('No project is open — open or create a .ctake project first.')
  return currentDir
}

export const gatesDir = (): string => join(requireProjectDir(), 'gates')
export const kitsDir = (charId?: string): string =>
  charId ? join(requireProjectDir(), 'kits', charId) : join(requireProjectDir(), 'kits')
export const thumbsDir = (takeId?: string): string =>
  takeId ? join(requireProjectDir(), 'thumbs', takeId) : join(requireProjectDir(), 'thumbs')
export const evidenceDir = (takeId?: string): string =>
  takeId ? join(requireProjectDir(), 'evidence', takeId) : join(requireProjectDir(), 'evidence')
export const gateReportPath = (takeId: string): string => join(gatesDir(), `${takeId}.json`)

export function findTake(takeId: string): Take | null {
  return current?.takes.find((t) => t.id === takeId) ?? null
}

export function findShot(shotId: string): Shot | null {
  return current?.shots.find((s) => s.id === shotId) ?? null
}

export function findCharacter(charId: string): CharacterKit | null {
  return current?.characters.find((c) => c.id === charId) ?? null
}

/* ------------------------------ persistence ----------------------------- */

/** Push the full project to every open window. */
export function broadcastProject(): void {
  if (!current) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('project-updated', current)
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void saveNow().catch((err: unknown) => {
      console.error('[circle-take] project save failed:', (err as Error).message)
    })
  }, SAVE_DEBOUNCE_MS)
}

/** Flush any pending save immediately (called on quit). */
export async function saveNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!current || !currentDir) return
  const target = join(currentDir, 'project.json')
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(current, null, 2), 'utf-8')
  await rename(tmp, target)
}

/**
 * Apply a mutation to the open project, then persist + broadcast.
 * Every exported mutator funnels through here — that is the whole contract.
 */
export function mutate(fn: (project: Project) => void): Project {
  const project = requireProject()
  fn(project)
  scheduleSave()
  broadcastProject()
  return project
}

/* ------------------------------ open / create --------------------------- */

function emptyProject(name: string): Project {
  return {
    schema: PROJECT_SCHEMA_VERSION,
    name,
    production: defaultProduction(),
    createdAt: new Date().toISOString(),
    settings: { copyMediaIntoProject: false },
    shots: [],
    takes: [],
    characters: [],
  }
}

async function ensureSubdirs(dir: string): Promise<void> {
  for (const sub of ['gates', 'kits', 'thumbs', 'evidence']) {
    await mkdir(join(dir, sub), { recursive: true })
  }
}

/** Create `<parentDir>/<name>.ctake/` with its subdirs and open it. */
export async function createProject(parentDir: string, name: string): Promise<Project> {
  const clean = name.trim().replace(/[/\\:]/g, '-')
  if (!clean) throw new Error('Project name cannot be empty.')
  const dir = parentDir.endsWith(PROJECT_EXT) ? parentDir : join(parentDir, `${clean}${PROJECT_EXT}`)
  await mkdir(dir, { recursive: true })
  await ensureSubdirs(dir)

  current = emptyProject(clean)
  currentDir = dir
  await saveNow()
  await addRecent(dir, clean)
  broadcastProject()
  return current
}

/** Coerce unknown JSON into a Project, or throw a readable schema error. */
export function validateProject(raw: unknown): Project {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('project.json is not a JSON object.')
  }
  const p = raw as Partial<Project>
  if (p.schema !== PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported project schema ${String(p.schema)} — this build reads schema ${PROJECT_SCHEMA_VERSION}.`,
    )
  }
  if (typeof p.name !== 'string') throw new Error('project.json is missing a "name".')
  if (!Array.isArray(p.shots)) throw new Error('project.json is missing a "shots" array.')
  if (!Array.isArray(p.takes)) throw new Error('project.json is missing a "takes" array.')

  const settings = (p.settings ?? {}) as Project['settings']
  return {
    schema: PROJECT_SCHEMA_VERSION,
    name: p.name,
    production: normalizeProduction(p.production),
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    settings: { ...settings, copyMediaIntoProject: settings.copyMediaIntoProject === true },
    shots: p.shots,
    takes: p.takes,
    characters: Array.isArray(p.characters) ? p.characters : [],
  }
}

/** Open an existing `.ctake` folder (or its project.json). */
export async function openProject(ctakePath: string): Promise<Project> {
  const dir = ctakePath.endsWith('project.json')
    ? ctakePath.slice(0, -'/project.json'.length)
    : ctakePath
  const raw = await readFile(join(dir, 'project.json'), 'utf-8').catch(() => {
    throw new Error(`No project.json found in ${dir}`)
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`project.json is not valid JSON: ${(e as Error).message}`)
  }
  const project = validateProject(parsed)
  await ensureSubdirs(dir)

  current = project
  currentDir = dir
  normalizeShotOrder(project)
  await addRecent(dir, project.name)
  broadcastProject()
  return project
}

/* -------------------------------- recents ------------------------------- */

function recentsFile(): string {
  return join(app.getPath('userData'), 'recents.json')
}

export async function getRecentProjects(): Promise<RecentProject[]> {
  try {
    const raw = await readFile(recentsFile(), 'utf-8')
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return []
    return list.filter(
      (r): r is RecentProject =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as RecentProject).path === 'string' &&
        typeof (r as RecentProject).name === 'string',
    )
  } catch {
    return []
  }
}

async function addRecent(path: string, name: string): Promise<void> {
  const list = await getRecentProjects()
  const next: RecentProject[] = [
    { path, name: name || basename(path, PROJECT_EXT), openedAt: new Date().toISOString() },
    ...list.filter((r) => r.path !== path),
  ].slice(0, MAX_RECENTS)
  await mkdir(app.getPath('userData'), { recursive: true }).catch(() => {})
  await writeFile(recentsFile(), JSON.stringify(next, null, 2), 'utf-8').catch(() => {})
}

/* --------------------------------- shots -------------------------------- */

/** Re-number `order` densely from 0, preserving the current relative order. */
function normalizeShotOrder(project: Project): void {
  project.shots.sort((a, b) => a.order - b.order)
  project.shots.forEach((shot, i) => {
    shot.order = i
  })
}

export function addShot(input: Omit<Shot, 'id' | 'order'>): Project {
  return mutate((p) => {
    p.shots.push({
      ...input,
      characterIds: Array.isArray(input.characterIds) ? [...input.characterIds] : [],
      id: newId(),
      order: p.shots.length,
    })
    normalizeShotOrder(p)
  })
}

export function updateShot(id: string, patch: Partial<Omit<Shot, 'id'>>): Project {
  return mutate((p) => {
    const shot = p.shots.find((s) => s.id === id)
    if (!shot) throw new Error(`No shot with id ${id}`)
    Object.assign(shot, patch, { id: shot.id })
    normalizeShotOrder(p)
  })
}

export function deleteShot(id: string): Project {
  return mutate((p) => {
    p.shots = p.shots.filter((s) => s.id !== id)
    for (const take of p.takes) {
      if (take.shotId === id) take.shotId = ''
    }
    normalizeShotOrder(p)
  })
}

/** Reorder by explicit id list; ids left out keep their relative tail order. */
export function reorderShots(idsInOrder: string[]): Project {
  return mutate((p) => {
    const rank = new Map(idsInOrder.map((id, i) => [id, i]))
    p.shots.sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER
      if (ra !== rb) return ra - rb
      return a.order - b.order
    })
    p.shots.forEach((shot, i) => {
      shot.order = i
    })
  })
}

/* --------------------------------- takes -------------------------------- */

export interface NewTakeInput {
  shotId: string
  mediaPath: string
  fileName: string
  provenance: Provenance
}

/** Append a take. Returns the created take (already persisted + broadcast). */
export function addTake(input: NewTakeInput): Take {
  const take: Take = {
    id: newId(),
    shotId: input.shotId,
    mediaPath: input.mediaPath,
    fileName: input.fileName,
    ingestedAt: new Date().toISOString(),
    provenance: input.provenance,
    circled: false,
    rating: 0,
  }
  mutate((p) => {
    p.takes.push(take)
  })
  return take
}

/** Patch a take in place (used by ingest probe/thumb and the gate runner). */
export function updateTake(takeId: string, patch: Partial<Omit<Take, 'id'>>): Project {
  return mutate((p) => {
    const take = p.takes.find((t) => t.id === takeId)
    if (!take) throw new Error(`No take with id ${takeId}`)
    Object.assign(take, patch, { id: take.id })
  })
}

export function assignTake(takeId: string, shotId: string): Project {
  return mutate((p) => {
    const take = p.takes.find((t) => t.id === takeId)
    if (!take) throw new Error(`No take with id ${takeId}`)
    if (shotId && !p.shots.some((s) => s.id === shotId)) {
      throw new Error(`No shot with id ${shotId}`)
    }
    take.shotId = shotId
  })
}

export function setProvenance(takeId: string, prov: Partial<Provenance>): Project {
  return mutate((p) => {
    const take = p.takes.find((t) => t.id === takeId)
    if (!take) throw new Error(`No take with id ${takeId}`)
    take.provenance = { ...take.provenance, ...prov }
  })
}

export function circleTake(takeId: string, circled: boolean): Project {
  return mutate((p) => {
    const take = p.takes.find((t) => t.id === takeId)
    if (!take) throw new Error(`No take with id ${takeId}`)
    take.circled = circled
  })
}

export function setRating(takeId: string, rating: Rating): Project {
  return mutate((p) => {
    const take = p.takes.find((t) => t.id === takeId)
    if (!take) throw new Error(`No take with id ${takeId}`)
    take.rating = rating
  })
}

/**
 * Set (or clear, with null) the take's select window. Values are clamped to
 * the probed media length and an inverted window is rejected rather than
 * silently swapped — the caller made a mistake worth surfacing.
 */
export function setTakeWindow(
  takeId: string,
  inSec: number | null,
  outSec: number | null,
): Project {
  return mutate((p) => {
    const take = p.takes.find((t) => t.id === takeId)
    if (!take) throw new Error(`No take with id ${takeId}`)
    const full = take.probe?.durationSec
    const clamp = (v: number): number => {
      const min = Math.max(0, v)
      return typeof full === 'number' && full > 0 ? Math.min(min, full) : min
    }
    const nextIn = inSec === null ? undefined : clamp(inSec)
    const nextOut = outSec === null ? undefined : clamp(outSec)
    if (nextIn !== undefined && nextOut !== undefined && nextOut <= nextIn) {
      throw new Error('Select window is empty — outSec must be greater than inSec.')
    }
    if (nextIn === undefined) delete take.inSec
    else take.inSec = nextIn
    if (nextOut === undefined) delete take.outSec
    else take.outSec = nextOut
  })
}

export function setModelRates(rates: Record<string, number>): Project {
  return mutate((p) => {
    const clean: Record<string, number> = {}
    for (const [key, value] of Object.entries(rates)) {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`Rate for "${key}" must be a non-negative number.`)
      }
      clean[key] = n
    }
    p.settings.modelRates = clean
  })
}

/** Remove a take and its generated artefacts (thumbs, evidence, gate report). */
export async function deleteTake(takeId: string): Promise<Project> {
  const dir = requireProjectDir()
  const project = mutate((p) => {
    p.takes = p.takes.filter((t) => t.id !== takeId)
  })
  await Promise.all([
    rm(join(dir, 'thumbs', takeId), { recursive: true, force: true }),
    rm(join(dir, 'evidence', takeId), { recursive: true, force: true }),
    rm(join(dir, 'gates', `${takeId}.json`), { force: true }),
  ]).catch(() => {})
  return project
}

/* ------------------------------- characters ----------------------------- */

export function addCharacter(name: string): Project {
  return mutate((p) => {
    p.characters.push({ id: newId(), name, images: [], locked: false })
  })
}

export function renameCharacter(id: string, name: string): Project {
  return mutate((p) => {
    const char = p.characters.find((c) => c.id === id)
    if (!char) throw new Error(`No character with id ${id}`)
    char.name = name
  })
}

export function deleteCharacter(id: string): Project {
  return mutate((p) => {
    p.characters = p.characters.filter((c) => c.id !== id)
    for (const shot of p.shots) {
      shot.characterIds = shot.characterIds.filter((c) => c !== id)
    }
  })
}

/** Record already-copied kit images (project-relative `kits/<id>/<file>`). */
export function registerKitImages(charId: string, relPaths: string[]): Project {
  return mutate((p) => {
    const char = p.characters.find((c) => c.id === charId)
    if (!char) throw new Error(`No character with id ${charId}`)
    for (const rel of relPaths) {
      if (!char.images.includes(rel)) char.images.push(rel)
    }
    // New reference material invalidates a frozen kit.
    char.locked = false
  })
}

export function removeKitImage(charId: string, image: string): Project {
  return mutate((p) => {
    const char = p.characters.find((c) => c.id === charId)
    if (!char) throw new Error(`No character with id ${charId}`)
    char.images = char.images.filter((i) => i !== image && !i.endsWith(`/${image}`))
    char.locked = false
  })
}

export function setCharacterLocked(charId: string, locked: boolean): Project {
  return mutate((p) => {
    const char = p.characters.find((c) => c.id === charId)
    if (!char) throw new Error(`No character with id ${charId}`)
    char.locked = locked
  })
}

/* ------------------------------ watch folder ---------------------------- */

export function setWatchFolder(path: string | null): Project {
  return mutate((p) => {
    if (path) p.settings.watchFolder = path
    else delete p.settings.watchFolder
  })
}

/** Persist production settings through the same main-owned transaction as other edits. */
export function setProduction(value: unknown): Project {
  return mutate((p) => { p.production = normalizeProduction(value) })
}
