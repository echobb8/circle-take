/**
 * The typed IPC bridge. `window.circletake` is exactly the CircleTakeAPI
 * surface from src/shared/api.ts — nothing else from Node reaches the
 * renderer. Every method is a thin invoke; every `on*` returns an
 * unsubscribe function so React effects can clean up.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CircleTakeAPI, EngineStatus } from '../shared/api'
import type { Project } from '../shared/types'

function on<T>(channel: string, cb: (arg: T) => void): () => void {
  const listener = (_e: unknown, arg: T): void => cb(arg)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * Main-side extras the renderer needs that are not part of the core API
 * contract (drag-drop path resolution, first-run engine setup, shell helpers,
 * application-menu events).
 */
export interface CircleTakeBridge extends CircleTakeAPI {
  /** Resolve a dropped File object to its absolute path (Electron 32+). */
  pathForFile(file: File): string
  /** Kick off first-run Python engine setup; progress arrives on onEngineStatus. */
  setupEngine(): Promise<void>
  openExternal(url: string): Promise<boolean>
  revealInFinder(path: string): Promise<boolean>
  onMenuNewProject(cb: () => void): () => void
  onMenuOpenProject(cb: () => void): () => void
  onMenuIngest(cb: () => void): () => void
  onMenuAbout(cb: () => void): () => void
  appVersion(): Promise<string>
}

const api: CircleTakeBridge = {
  // ---- project lifecycle ----
  createProject: (parentDir, name) => ipcRenderer.invoke('createProject', parentDir, name),
  openProject: (ctakePath) => ipcRenderer.invoke('openProject', ctakePath),
  getProject: () => ipcRenderer.invoke('getProject'),
  getProjectPath: () => ipcRenderer.invoke('getProjectPath'),
  getRecentProjects: () => ipcRenderer.invoke('getRecentProjects'),

  // ---- dialogs ----
  chooseMediaFiles: () => ipcRenderer.invoke('chooseMediaFiles'),
  chooseImageFiles: () => ipcRenderer.invoke('chooseImageFiles'),
  chooseFolder: () => ipcRenderer.invoke('chooseFolder'),
  chooseProjectFile: () => ipcRenderer.invoke('chooseProjectFile'),
  chooseSavePath: (defaultName) => ipcRenderer.invoke('chooseSavePath', defaultName),

  // ---- shots ----
  addShot: (shot) => ipcRenderer.invoke('addShot', shot),
  updateShot: (id, patch) => ipcRenderer.invoke('updateShot', id, patch),
  deleteShot: (id) => ipcRenderer.invoke('deleteShot', id),
  reorderShots: (idsInOrder) => ipcRenderer.invoke('reorderShots', idsInOrder),

  // ---- takes ----
  ingestFiles: (paths) => ipcRenderer.invoke('ingestFiles', paths),
  assignTake: (takeId, shotId) => ipcRenderer.invoke('assignTake', takeId, shotId),
  setProvenance: (takeId, prov) => ipcRenderer.invoke('setProvenance', takeId, prov),
  circleTake: (takeId, circled) => ipcRenderer.invoke('circleTake', takeId, circled),
  setRating: (takeId, rating) => ipcRenderer.invoke('setRating', takeId, rating),
  setTakeWindow: (takeId, inSec, outSec) =>
    ipcRenderer.invoke('setTakeWindow', takeId, inSec, outSec),
  setProduction: (production) => ipcRenderer.invoke('setProduction', production),
  setModelRates: (rates) => ipcRenderer.invoke('setModelRates', rates),
  deleteTake: (takeId) => ipcRenderer.invoke('deleteTake', takeId),

  // ---- gate ----
  runGate: (takeId) => ipcRenderer.invoke('runGate', takeId),
  runGateAll: (onlyPending) => ipcRenderer.invoke('runGateAll', onlyPending),
  cancelGates: () => ipcRenderer.invoke('cancelGates'),
  getGateReport: (takeId) => ipcRenderer.invoke('getGateReport', takeId),
  getEngineStatus: () => ipcRenderer.invoke('getEngineStatus'),

  // ---- character kits ----
  addCharacter: (name) => ipcRenderer.invoke('addCharacter', name),
  renameCharacter: (id, name) => ipcRenderer.invoke('renameCharacter', id, name),
  deleteCharacter: (id) => ipcRenderer.invoke('deleteCharacter', id),
  addKitImages: (charId, imagePaths) => ipcRenderer.invoke('addKitImages', charId, imagePaths),
  removeKitImage: (charId, image) => ipcRenderer.invoke('removeKitImage', charId, image),
  buildKit: (charId) => ipcRenderer.invoke('buildKit', charId),

  // ---- watch folder ----
  setWatchFolder: (path) => ipcRenderer.invoke('setWatchFolder', path),

  // ---- exports ----
  exportFcpxml: (outPath) => ipcRenderer.invoke('exportFcpxml', outPath),
  exportEdl: (outPath) => ipcRenderer.invoke('exportEdl', outPath),
  exportReshootList: (outPath) => ipcRenderer.invoke('exportReshootList', outPath),
  exportCsv: (outPath) => ipcRenderer.invoke('exportCsv', outPath),

  // ---- events ----
  onProjectUpdated: (cb) => on<Project>('project-updated', cb),
  onGateProgress: (cb) =>
    on<{ takeId: string; stage: string; pct: number; note?: string }>('gate-progress', cb),
  onIngestProgress: (cb) => on<{ fileName: string; stage: string }>('ingest-progress', cb),
  onEngineStatus: (cb) => on<EngineStatus>('engine-status', cb),

  // ---- bridge extras ----
  pathForFile: (file) => webUtils.getPathForFile(file),
  setupEngine: () => ipcRenderer.invoke('setupEngine'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  revealInFinder: (path) => ipcRenderer.invoke('revealInFinder', path),
  onMenuNewProject: (cb) => on('menu:newProject', () => cb()),
  onMenuOpenProject: (cb) => on('menu:openProject', () => cb()),
  onMenuIngest: (cb) => on('menu:ingest', () => cb()),
  onMenuAbout: (cb) => on('menu:about', () => cb()),
  appVersion: () => ipcRenderer.invoke('appVersion'),
}

contextBridge.exposeInMainWorld('circletake', api)
