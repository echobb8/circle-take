/**
 * Renderer state (zustand).
 *
 * MAIN owns the canonical Project — this store holds a *mirror*. Every mutation
 * is an IPC call through `window.circletake`; main persists and pushes
 * `project-updated`, which refreshes the mirror. Nothing here writes to
 * `state.project` except the `project-updated` handler and the optimistic
 * results returned by the mutator calls themselves.
 *
 * The selectors at the bottom are PURE (Project in, plain data out) and are the
 * unit-tested surface — they never touch React, zustand or the DOM.
 */

import { create } from 'zustand'
import type { CircleTakeAPI, EngineStatus, RecentProject } from '@shared/api'
import {
  shotSpend,
  takeCost,
  type CharacterKit,
  type GateReport,
  type GateStatus,
  type Project,
  type Rating,
  type Shot,
  type ShotSpend,
  type Take,
} from '@shared/types'

// ---------------------------------------------------------------------------
// Pure selectors
// ---------------------------------------------------------------------------

/**
 * Ranking of gate status for "best first" ordering. Lower sorts earlier.
 * A graded pass beats a flag beats a fail; ungated takes sink to the bottom.
 */
export const GATE_STATUS_RANK: Record<GateStatus, number> = {
  pass: 0,
  flag: 1,
  fail: 2,
  error: 3,
  running: 4,
  pending: 5,
}

export const UNGATED_RANK = 6

export function gateRank(take: Take): number {
  const st = take.gate?.status
  return st ? GATE_STATUS_RANK[st] : UNGATED_RANK
}

export function overallOf(take: Take): number {
  return take.gate?.overall ?? -1
}

/**
 * Takes bound to a shot, best first.
 * Order: circled → gate status → overall score desc → director rating desc →
 * fileName (stable tiebreak, so the list never jitters between renders).
 */
export function takesForShot(project: Project | null, shotId: string): Take[] {
  if (!project) return []
  return project.takes
    .filter((t) => t.shotId === shotId)
    .slice()
    .sort((a, b) => {
      if (a.circled !== b.circled) return a.circled ? -1 : 1
      const r = gateRank(a) - gateRank(b)
      if (r !== 0) return r
      const o = overallOf(b) - overallOf(a)
      if (o !== 0) return o
      const rt = b.rating - a.rating
      if (rt !== 0) return rt
      return a.fileName.localeCompare(b.fileName)
    })
}

/** Takes that arrived without a shot binding (the Bin's Unassigned tray). */
export function unassignedTakes(project: Project | null): Take[] {
  if (!project) return []
  return project.takes.filter((t) => t.shotId === '')
}

/** The take that would represent this shot in the Bin / in an export. */
export function bestTake(project: Project | null, shotId: string): Take | null {
  return takesForShot(project, shotId)[0] ?? null
}

/** A gate run that produced a verdict (as opposed to pending/running/error). */
export function isGraded(take: Take): boolean {
  const st = take.gate?.status
  return st === 'pass' || st === 'flag' || st === 'fail'
}

/**
 * A shot needs a reshoot when it has neither a circled take nor a passing take
 * — i.e. nothing in it is good enough to cut. Shots with no takes at all
 * qualify too: there is still nothing usable for that slot.
 */
export function shotNeedsReshoot(project: Project | null, shotId: string): boolean {
  if (!project) return false
  const takes = project.takes.filter((t) => t.shotId === shotId)
  if (takes.some((t) => t.circled)) return false
  if (takes.some((t) => t.gate?.status === 'pass')) return false
  return true
}

export interface ShotStats {
  shots: number
  takes: number
  gated: number
  circled: number
  needsReshoot: number
  /** Total ledger spend across every take, from settings.modelRates. */
  spend: number
}

/** Production totals for the Bin header strip. */
export function shotStats(project: Project | null): ShotStats {
  if (!project) return { shots: 0, takes: 0, gated: 0, circled: 0, needsReshoot: 0, spend: 0 }
  const rates = project.settings.modelRates
  return {
    shots: project.shots.length,
    takes: project.takes.length,
    gated: project.takes.filter(isGraded).length,
    circled: project.takes.filter((t) => t.circled).length,
    needsReshoot: project.shots.filter((s) => shotNeedsReshoot(project, s.id)).length,
    spend: project.takes.reduce((sum, t) => sum + (takeCost(t, rates) ?? 0), 0),
  }
}

/** Cost ledger for one shot (spend / hit-rate / cost per usable second). */
export function spendForShot(project: Project | null, shotId: string): ShotSpend {
  if (!project) return { spend: 0, takes: 0, usable: 0, hitRate: 0, costPerUsableSec: null }
  return shotSpend(
    project.takes.filter((t) => t.shotId === shotId),
    project.settings.modelRates,
  )
}

/** Whole-project ledger — used by the Print room totals row. */
export function spendForProject(project: Project | null): ShotSpend {
  if (!project) return { spend: 0, takes: 0, usable: 0, hitRate: 0, costPerUsableSec: null }
  return shotSpend(project.takes, project.settings.modelRates)
}

/**
 * Distinct `provenance.model` values across a shot's takes. More than one means
 * the shot was generated by different model versions — the takes are no longer
 * reproducible from a single recipe, which is worth a warning chip.
 */
export function shotModels(project: Project | null, shotId: string): string[] {
  if (!project) return []
  const seen = new Set<string>()
  for (const t of project.takes) {
    if (t.shotId !== shotId) continue
    const m = t.provenance.model?.trim()
    if (m) seen.add(m)
  }
  return [...seen].sort()
}

export function hasModelMix(project: Project | null, shotId: string): boolean {
  return shotModels(project, shotId).length > 1
}

/** Effective select window of a take, falling back to the whole clip. */
export function takeWindow(take: Take): { inSec: number; outSec: number; explicit: boolean } {
  const dur = take.probe?.durationSec ?? 0
  const explicit = take.inSec != null || take.outSec != null
  return {
    inSec: Math.max(0, take.inSec ?? 0),
    outSec: take.outSec ?? dur,
    explicit,
  }
}

/** Duration a take contributes to the cut, honouring its select window. */
export function takeCutDuration(take: Take): number {
  const w = takeWindow(take)
  return Math.max(0, w.outSec - w.inSec)
}

/** Shots in cut order (project.shots is authoritative but may be unsorted). */
export function shotsInOrder(project: Project | null): Shot[] {
  if (!project) return []
  return project.shots.slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

export function shotById(project: Project | null, shotId: string | null): Shot | null {
  if (!project || !shotId) return null
  return project.shots.find((s) => s.id === shotId) ?? null
}

export function takeById(project: Project | null, takeId: string | null): Take | null {
  if (!project || !takeId) return null
  return project.takes.find((t) => t.id === takeId) ?? null
}

export function characterById(project: Project | null, id: string): CharacterKit | null {
  if (!project) return null
  return project.characters.find((c) => c.id === id) ?? null
}

/** Circled takes in cut order — the Print room's select list. */
export function circledInCutOrder(project: Project | null): { shot: Shot; take: Take }[] {
  if (!project) return []
  const out: { shot: Shot; take: Take }[] = []
  for (const shot of shotsInOrder(project)) {
    for (const take of takesForShot(project, shot.id)) {
      if (take.circled) out.push({ shot, take })
    }
  }
  return out
}

/** Shots that still need work, with the best take we have so far. */
export function reshootShots(project: Project | null): { shot: Shot; best: Take | null }[] {
  if (!project) return []
  return shotsInOrder(project)
    .filter((s) => shotNeedsReshoot(project, s.id))
    .map((shot) => ({ shot, best: bestTake(project, shot.id) }))
}

/** Total runtime of the circled selects, in seconds (select windows honoured). */
export function selectsRuntime(project: Project | null): number {
  return circledInCutOrder(project).reduce((sum, { take }) => sum + takeCutDuration(take), 0)
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

export type Room = 'bin' | 'village' | 'kits' | 'print'

export interface GateProgress {
  stage: string
  pct: number
}

export const IDLE_ENGINE: EngineStatus = { ready: false, stage: 'idle' }

export interface UIState {
  // ---- project mirror ----
  project: Project | null
  projectPath: string | null
  recents: RecentProject[]
  loading: boolean

  // ---- navigation ----
  room: Room
  selectedShotId: string | null
  selectedTakeId: string | null

  // ---- compare ----
  compareTakeId: string | null
  /** null = side-by-side; 0..1 = wipe handle position. */
  wipe: number | null
  /** Scrub-lock B to A's playhead. */
  syncPlayheads: boolean
  playhead: number
  playing: boolean

  // ---- engine ----
  engineStatus: EngineStatus
  gateProgress: Record<string, GateProgress>

  // ---- gate reports (lazy cache, shared by Village panel + Report overlay) ----
  reports: Record<string, GateReport | null>

  // ---- overlays ----
  reportTakeId: string | null
  ratesOpen: boolean
  toast: string | null

  // ---- actions ----
  init(): Promise<void>
  setRoom(room: Room): void
  openShot(shotId: string): void
  selectShot(shotId: string | null): void
  selectTake(takeId: string | null): void
  setCompare(takeId: string | null): void
  setWipe(v: number | null): void
  toggleWipeMode(): void
  setSyncPlayheads(v: boolean): void
  setPlayhead(t: number): void
  setPlaying(v: boolean): void
  openReport(takeId: string | null): void
  setRatesOpen(open: boolean): void
  notify(message: string | null): void
  loadReport(takeId: string): Promise<void>

  createProject(): Promise<void>
  openProject(path?: string): Promise<void>
  addShot(shot: Omit<Shot, 'id' | 'order'>): Promise<void>
  updateShot(id: string, patch: Partial<Omit<Shot, 'id'>>): Promise<void>
  ingestPaths(paths: string[]): Promise<void>
  chooseAndIngest(): Promise<void>
  assignTake(takeId: string, shotId: string): Promise<void>
  circleTake(takeId: string, circled: boolean): Promise<void>
  toggleCircle(takeId: string): Promise<void>
  setRating(takeId: string, rating: Rating): Promise<void>
  setTakeWindow(takeId: string, inSec: number | null, outSec: number | null): Promise<void>
  applySuggestedWindow(takeId: string): Promise<void>
  setModelRates(rates: Record<string, number>): Promise<void>
  runGate(takeId: string): Promise<void>
  runGateAll(onlyPending: boolean): Promise<void>
  addCharacter(name: string): Promise<void>
  renameCharacter(id: string, name: string): Promise<void>
  addKitImages(charId: string): Promise<void>
  buildKit(charId: string): Promise<void>
  exportAs(kind: 'fcpxml' | 'edl' | 'csv' | 'reshoot'): Promise<void>
}

/** The preload bridge, or null when it has not been installed (SSR / tests). */
function api(): CircleTakeAPI | null {
  if (typeof window === 'undefined') return null
  return (window as { circletake?: CircleTakeAPI }).circletake ?? null
}

const EXPORT_DEFAULTS: Record<'fcpxml' | 'edl' | 'csv' | 'reshoot', string> = {
  fcpxml: 'selects.fcpxml',
  edl: 'selects.edl',
  csv: 'takes.csv',
  reshoot: 'reshoots.md',
}

export const useStore = create<UIState>((set, get) => ({
  project: null,
  projectPath: null,
  recents: [],
  loading: true,

  room: 'bin',
  selectedShotId: null,
  selectedTakeId: null,

  compareTakeId: null,
  wipe: null,
  syncPlayheads: true,
  playhead: 0,
  playing: false,

  engineStatus: IDLE_ENGINE,
  gateProgress: {},

  reports: {},

  reportTakeId: null,
  ratesOpen: false,
  toast: null,

  async init() {
    const a = api()
    if (!a) {
      set({ loading: false })
      return
    }
    a.onProjectUpdated((project) => {
      set((s) => {
        // Keep the selection valid across mutations from any door (UI/HTTP/MCP).
        const takeStillThere = project.takes.some((t) => t.id === s.selectedTakeId)
        const shotStillThere = project.shots.some((sh) => sh.id === s.selectedShotId)
        return {
          project,
          selectedTakeId: takeStillThere ? s.selectedTakeId : null,
          selectedShotId: shotStillThere ? s.selectedShotId : null,
          compareTakeId: project.takes.some((t) => t.id === s.compareTakeId)
            ? s.compareTakeId
            : null,
        }
      })
    })
    a.onGateProgress((e) => {
      set((s) => ({ gateProgress: { ...s.gateProgress, [e.takeId]: { stage: e.stage, pct: e.pct } } }))
    })
    a.onEngineStatus((engineStatus) => set({ engineStatus }))

    const [project, projectPath, recents, engineStatus] = await Promise.all([
      a.getProject(),
      a.getProjectPath(),
      a.getRecentProjects(),
      a.getEngineStatus(),
    ])
    const firstShot = shotsInOrder(project)[0] ?? null
    set({
      project,
      projectPath,
      recents,
      engineStatus,
      loading: false,
      selectedShotId: firstShot ? firstShot.id : null,
    })
  },

  setRoom: (room) => set({ room }),

  openShot(shotId) {
    const project = get().project
    const first = takesForShot(project, shotId)[0] ?? null
    set({
      room: 'village',
      selectedShotId: shotId,
      selectedTakeId: first ? first.id : null,
      compareTakeId: null,
      playhead: 0,
      playing: false,
    })
  },

  selectShot(shotId) {
    const project = get().project
    const first = shotId ? (takesForShot(project, shotId)[0] ?? null) : null
    set({
      selectedShotId: shotId,
      selectedTakeId: first ? first.id : null,
      compareTakeId: null,
      playhead: 0,
    })
  },

  selectTake: (takeId) => set({ selectedTakeId: takeId, playhead: 0 }),
  setCompare: (takeId) =>
    set((s) => ({ compareTakeId: s.compareTakeId === takeId ? null : takeId })),
  setWipe: (wipe) => set({ wipe }),
  toggleWipeMode: () => set((s) => ({ wipe: s.wipe === null ? 0.5 : null })),
  setSyncPlayheads: (syncPlayheads) => set({ syncPlayheads }),
  setPlayhead: (playhead) => set({ playhead }),
  setPlaying: (playing) => set({ playing }),
  openReport: (reportTakeId) => set({ reportTakeId }),
  setRatesOpen: (ratesOpen) => set({ ratesOpen }),
  notify: (toast) => set({ toast }),

  async loadReport(takeId) {
    const a = api()
    if (!a) return
    const report = await a.getGateReport(takeId)
    set((s) => ({ reports: { ...s.reports, [takeId]: report } }))
  },

  async createProject() {
    const a = api()
    if (!a) return
    const parent = await a.chooseFolder()
    if (!parent) return
    const project = await a.createProject(parent, 'Untitled Film')
    const path = await a.getProjectPath()
    set({ project, projectPath: path, room: 'bin' })
  },

  async openProject(path) {
    const a = api()
    if (!a) return
    const target = path ?? (await a.chooseProjectFile())
    if (!target) return
    const project = await a.openProject(target)
    const first = shotsInOrder(project)[0] ?? null
    set({
      project,
      projectPath: target,
      room: 'bin',
      selectedShotId: first ? first.id : null,
      selectedTakeId: null,
      compareTakeId: null,
    })
  },

  async addShot(shot) {
    const a = api()
    if (!a) return
    set({ project: await a.addShot(shot) })
  },

  async updateShot(id, patch) {
    const a = api()
    if (!a) return
    set({ project: await a.updateShot(id, patch) })
  },

  async ingestPaths(paths) {
    const a = api()
    if (!a || paths.length === 0) return
    const res = await a.ingestFiles(paths)
    const skipped = res.skipped.length ? ` · ${res.skipped.length} skipped` : ''
    set({ toast: `Ingested ${res.added} file${res.added === 1 ? '' : 's'}${skipped}` })
  },

  async chooseAndIngest() {
    const a = api()
    if (!a) return
    const files = await a.chooseMediaFiles()
    await get().ingestPaths(files)
  },

  async assignTake(takeId, shotId) {
    const a = api()
    if (!a) return
    set({ project: await a.assignTake(takeId, shotId) })
  },

  async circleTake(takeId, circled) {
    const a = api()
    if (!a) return
    set({ project: await a.circleTake(takeId, circled) })
  },

  async toggleCircle(takeId) {
    const take = takeById(get().project, takeId)
    if (!take) return
    await get().circleTake(takeId, !take.circled)
  },

  async setRating(takeId, rating) {
    const a = api()
    if (!a) return
    set({ project: await a.setRating(takeId, rating) })
  },

  async setTakeWindow(takeId, inSec, outSec) {
    const a = api()
    if (!a) return
    set({ project: await a.setTakeWindow(takeId, inSec, outSec) })
  },

  async applySuggestedWindow(takeId) {
    const cached = get().reports[takeId]
    let report = cached
    if (report === undefined) {
      await get().loadReport(takeId)
      report = get().reports[takeId] ?? null
    }
    const w = report?.suggestedWindow
    if (!w) return
    await get().setTakeWindow(takeId, w.inSec, w.outSec)
    set({ toast: `Select window applied — ${w.inSec.toFixed(1)}s → ${w.outSec.toFixed(1)}s` })
  },

  async setModelRates(rates) {
    const a = api()
    if (!a) return
    set({ project: await a.setModelRates(rates), ratesOpen: false, toast: 'Rate card updated' })
  },

  async runGate(takeId) {
    const a = api()
    if (!a) return
    set((s) => ({ gateProgress: { ...s.gateProgress, [takeId]: { stage: 'queued', pct: 0 } } }))
    await a.runGate(takeId)
    // The report changed underneath us — drop the cache entry so it refetches.
    set((s) => {
      const next = { ...s.reports }
      delete next[takeId]
      return { reports: next }
    })
  },

  async runGateAll(onlyPending) {
    const a = api()
    if (!a) return
    await a.runGateAll(onlyPending)
  },

  async addCharacter(name) {
    const a = api()
    if (!a) return
    set({ project: await a.addCharacter(name) })
  },

  async renameCharacter(id, name) {
    const a = api()
    if (!a) return
    set({ project: await a.renameCharacter(id, name) })
  },

  async addKitImages(charId) {
    const a = api()
    if (!a) return
    const files = await a.chooseImageFiles()
    if (files.length === 0) return
    set({ project: await a.addKitImages(charId, files) })
  },

  async buildKit(charId) {
    const a = api()
    if (!a) return
    const kit = await a.buildKit(charId)
    set({ toast: `Kit locked — ${kit.name} (${kit.images.length} refs)` })
  },

  async exportAs(kind) {
    const a = api()
    if (!a) return
    const out = await a.chooseSavePath(EXPORT_DEFAULTS[kind])
    if (!out) return
    const written =
      kind === 'fcpxml'
        ? await a.exportFcpxml(out)
        : kind === 'edl'
          ? await a.exportEdl(out)
          : kind === 'csv'
            ? await a.exportCsv(out)
            : await a.exportReshootList(out)
    set({ toast: `Wrote ${written}` })
  },
}))
