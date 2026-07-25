/**
 * The typed IPC surface exposed to the renderer as `window.circletake`.
 * PURE types module. Main implements it (src/main/index.ts registers handlers),
 * preload bridges it, renderer consumes it. Control-server actions reuse the
 * same main-side mutators — one brain, three doors (UI, HTTP, MCP).
 *
 * Ownership: MAIN owns the canonical Project. Every mutation goes through IPC;
 * main persists to project.json (debounced) and pushes `project-updated` with
 * the full Project after every change. The renderer store is a mirror.
 */

import type {
  CharacterKit,
  GateReport,
  Project,
  Provenance,
  Rating,
  Shot,
} from './types'

export interface IngestResult {
  added: number
  skipped: string[] // fileName + reason
}

export interface RecentProject {
  path: string
  name: string
  openedAt: string
}

export interface EngineStatus {
  ready: boolean
  stage: 'idle' | 'creating-venv' | 'installing' | 'downloading-models' | 'ready' | 'error'
  detail?: string
  engineVersion?: string
  anatomyAvailable?: boolean
}

export interface CircleTakeAPI {
  // ---- project lifecycle ----
  createProject(parentDir: string, name: string): Promise<Project>
  openProject(ctakePath: string): Promise<Project>
  getProject(): Promise<Project | null>
  getProjectPath(): Promise<string | null>
  getRecentProjects(): Promise<RecentProject[]>

  // ---- dialogs (main-side native) ----
  chooseMediaFiles(): Promise<string[]>
  chooseImageFiles(): Promise<string[]>
  chooseFolder(): Promise<string | null>
  chooseProjectFile(): Promise<string | null>
  chooseSavePath(defaultName: string): Promise<string | null>

  // ---- shots ----
  addShot(shot: Omit<Shot, 'id' | 'order'>): Promise<Project>
  updateShot(id: string, patch: Partial<Omit<Shot, 'id'>>): Promise<Project>
  deleteShot(id: string): Promise<Project>
  reorderShots(idsInOrder: string[]): Promise<Project>

  // ---- takes ----
  ingestFiles(paths: string[]): Promise<IngestResult>
  assignTake(takeId: string, shotId: string): Promise<Project>
  setProvenance(takeId: string, prov: Partial<Provenance>): Promise<Project>
  circleTake(takeId: string, circled: boolean): Promise<Project>
  setRating(takeId: string, rating: Rating): Promise<Project>
  setTakeWindow(takeId: string, inSec: number | null, outSec: number | null): Promise<Project>
  setModelRates(rates: Record<string, number>): Promise<Project>
  deleteTake(takeId: string): Promise<Project>

  // ---- gate ----
  runGate(takeId: string): Promise<void> // progress via events; result lands in project mirror
  runGateAll(onlyPending: boolean): Promise<void>
  cancelGates(): Promise<void>
  getGateReport(takeId: string): Promise<GateReport | null>
  getEngineStatus(): Promise<EngineStatus>

  // ---- character kits ----
  addCharacter(name: string): Promise<Project>
  renameCharacter(id: string, name: string): Promise<Project>
  deleteCharacter(id: string): Promise<Project>
  addKitImages(charId: string, imagePaths: string[]): Promise<Project>
  removeKitImage(charId: string, image: string): Promise<Project>
  buildKit(charId: string): Promise<CharacterKit> // computes + freezes embeddings, sets locked

  // ---- watch folder ----
  setWatchFolder(path: string | null): Promise<Project>

  // ---- exports ----
  exportFcpxml(outPath: string): Promise<string>
  exportEdl(outPath: string): Promise<string>
  exportReshootList(outPath: string): Promise<string> // writes .md + .json sibling
  exportCsv(outPath: string): Promise<string>

  // ---- events ----
  onProjectUpdated(cb: (project: Project) => void): () => void
  onGateProgress(
    cb: (e: { takeId: string; stage: string; pct: number; note?: string }) => void,
  ): () => void
  onIngestProgress(cb: (e: { fileName: string; stage: string }) => void): () => void
  onEngineStatus(cb: (s: EngineStatus) => void): () => void
}

/**
 * ctake:// protocol URL builders (renderer-side helpers; main resolves).
 *   ctake://media/<takeId>          — the take's video file
 *   ctake://thumb/<takeId>/<name>   — poster.jpg | strip_0.jpg …
 *   ctake://evidence/<takeId>/<file>
 *   ctake://kit/<charId>/<file>
 */
export const mediaUrl = (takeId: string) => `ctake://media/${takeId}`
export const thumbUrl = (takeId: string, name: string) => `ctake://thumb/${takeId}/${name}`
export const evidenceUrl = (takeId: string, file: string) =>
  `ctake://evidence/${takeId}/${encodeURIComponent(file)}`
export const kitImageUrl = (charId: string, file: string) =>
  `ctake://kit/${charId}/${encodeURIComponent(file)}`
