import type { ProductionSettings } from './production'
/**
 * Circle Take — shared contracts.
 * PURE module: no DOM, no Electron, no Node APIs. Imported by main, preload,
 * renderer, and tests. All cross-process shapes live here.
 */

export const PROJECT_SCHEMA_VERSION = 1 as const
export const PROJECT_EXT = '.ctake'
export const GATE_ENGINE_MIN_VERSION = '1.0.0'

// ---------------------------------------------------------------------------
// Core model
// ---------------------------------------------------------------------------

export type CheckId = 'identity' | 'temporal' | 'anatomy' | 'continuity' | 'conformance'
export const CHECK_IDS: CheckId[] = ['identity', 'temporal', 'anatomy', 'continuity', 'conformance']

export const CHECK_LABEL: Record<CheckId, string> = {
  identity: 'Identity',
  temporal: 'Temporal',
  anatomy: 'Anatomy',
  continuity: 'Continuity',
  conformance: 'Conformance',
}

export type Verdict = 'pass' | 'flag' | 'fail' | 'skip'
export type GateStatus = 'pending' | 'running' | 'pass' | 'flag' | 'fail' | 'error'

export interface ExpectedFormat {
  durationSec?: number
  fps?: number
  width?: number
  height?: number
}

export interface Shot {
  id: string
  name: string
  description?: string
  order: number
  expected?: ExpectedFormat
  characterIds: string[]
  refs?: { scriptbreakScene?: string; blockoutShot?: string; boardFrame?: string }
}

export interface Provenance {
  generator?: string
  model?: string
  prompt?: string
  seed?: string
  sourceSidecar?: string
  notes?: string
}

export interface ProbeInfo {
  durationSec: number
  fps: number
  width: number
  height: number
  codec: string
}

export interface CheckSummary {
  verdict: Verdict
  score: number // 0-100
  reason: string
}

export interface GateSummary {
  status: GateStatus
  overall: number // 0-100
  checks: Partial<Record<CheckId, CheckSummary>>
  engineVersion: string
  ranAt: string
  error?: string
}

export type Rating = 0 | 1 | 2 | 3

export interface Take {
  id: string
  shotId: string // '' = unassigned tray
  mediaPath: string
  fileName: string
  ingestedAt: string
  provenance: Provenance
  probe?: ProbeInfo
  gate?: GateSummary
  circled: boolean
  rating: Rating
  /** Select window (seconds) — the usable slice of the generation. Gate may
   *  suggest one (GateReport.suggestedWindow); the director can adjust.
   *  Exports use this window when present, else the full clip. */
  inSec?: number
  outSec?: number
}

export interface CharacterKit {
  id: string
  name: string
  images: string[] // project-relative paths under kits/<id>/
  locked: boolean
}

export interface ProjectSettings {
  watchFolder?: string
  expected?: ExpectedFormat // project-wide defaults, shot.expected overrides
  copyMediaIntoProject: boolean
  /** Cost ledger: $ per generation keyed by provenance.model (case-insensitive
   *  exact match; '*' = fallback rate). Enables per-shot spend + hit-rate. */
  modelRates?: Record<string, number>
}

export interface Project {
  production?: ProductionSettings
  schema: typeof PROJECT_SCHEMA_VERSION
  name: string
  createdAt: string
  settings: ProjectSettings
  shots: Shot[]
  takes: Take[]
  characters: CharacterKit[]
}

// ---------------------------------------------------------------------------
// Full gate report (gates/<takeId>.json) — written by the python engine
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  t: number // seconds
  v: number
}

export interface EvidenceFrame {
  frame: number
  t: number
  image: string // project-relative path under evidence/<takeId>/
  caption: string
}

export interface CheckReport extends CheckSummary {
  series?: SeriesPoint[]
  threshold?: number // series-space threshold used (for sparkline annotation)
  evidence?: EvidenceFrame[]
  details?: Record<string, unknown>
}

export interface GateReport {
  takeId: string
  mediaPath: string
  engineVersion: string
  modelVersions: Record<string, string>
  ranAt: string
  overall: number
  status: Exclude<GateStatus, 'pending' | 'running'>
  checks: Partial<Record<CheckId, CheckReport>>
  /** Cleanest continuous window of the clip (least artifact energy across
   *  temporal+identity series) — the engine's suggested select range. */
  suggestedWindow?: { inSec: number; outSec: number; reason: string }
}

// ---------------------------------------------------------------------------
// Worker line-JSON protocol (python stdout)
// ---------------------------------------------------------------------------

export type WorkerMessage =
  | { type: 'progress'; stage: string; pct: number; note?: string }
  | { type: 'done'; result?: unknown }
  | { type: 'error'; message: string }

/** Parse one stdout line; returns null for noise (non-JSON or unknown shape). */
export function parseWorkerLine(line: string): WorkerMessage | null {
  const s = line.trim()
  if (!s.startsWith('{')) return null
  try {
    const m = JSON.parse(s) as { type?: unknown }
    if (m.type === 'progress' || m.type === 'done' || m.type === 'error') {
      return m as WorkerMessage
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export const MEDIA_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'] as const

export type IngestStage = 'ingested' | 'probed' | 'thumbed' | 'gated'

/**
 * Extract a shot-name hint from a take filename.
 * Recognized: "12A_take3.mp4", "shot-12A v2.mov", "s12a_006.mp4", "SH010_t4.mp4".
 * Returns the normalized shot name (uppercased, no prefix) or null.
 */
export function shotHintFromFileName(fileName: string): string | null {
  const base = fileName.replace(/\.[^.]+$/, '')
  const m =
    /^(?:shot[-_ ]?|sh(?=\d)|s(?=\d))?(\d{1,4}[a-zA-Z]?)(?:[-_ .]|$)/.exec(base.trim())
  const hit = m?.[1]
  if (!hit) return null
  return hit.toUpperCase()
}

/** Map common sidecar JSON keys from generators to Provenance. Best-effort. */
export function provenanceFromSidecar(json: Record<string, unknown>): Provenance {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = json[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
      if (typeof v === 'number') return String(v)
    }
    return undefined
  }
  return {
    prompt: pick('prompt', 'text_prompt', 'positive_prompt', 'input_prompt', 'description'),
    seed: pick('seed', 'noise_seed', 'random_seed'),
    model: pick('model', 'model_name', 'model_id', 'checkpoint'),
    generator: pick('generator', 'app', 'source', 'provider', 'platform'),
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const OVERALL_FAIL_CAP = 40
export const PASS_FLOOR = 85

/**
 * Blend check scores into an overall 0-100 with min-emphasis:
 * a hard fail caps the overall at OVERALL_FAIL_CAP. Skips are excluded.
 */
export function overallScore(checks: Partial<Record<CheckId, CheckSummary>>): number {
  const active = CHECK_IDS.map((id) => checks[id]).filter(
    (c): c is CheckSummary => !!c && c.verdict !== 'skip',
  )
  if (active.length === 0) return 0
  const mean = active.reduce((s, c) => s + c.score, 0) / active.length
  const min = Math.min(...active.map((c) => c.score))
  let overall = Math.round(0.6 * mean + 0.4 * min)
  if (active.some((c) => c.verdict === 'fail')) overall = Math.min(overall, OVERALL_FAIL_CAP)
  return overall
}

export function statusFromChecks(
  checks: Partial<Record<CheckId, CheckSummary>>,
): Exclude<GateStatus, 'pending' | 'running' | 'error'> {
  const active = CHECK_IDS.map((id) => checks[id]).filter(
    (c): c is CheckSummary => !!c && c.verdict !== 'skip',
  )
  if (active.some((c) => c.verdict === 'fail')) return 'fail'
  if (active.some((c) => c.verdict === 'flag')) return 'flag'
  return 'pass'
}

// ---------------------------------------------------------------------------
// Cost ledger (pure helpers)
// ---------------------------------------------------------------------------

/** $ cost of one take from the project rate table (model match, else '*'). */
export function takeCost(take: Take, rates?: Record<string, number>): number | null {
  if (!rates) return null
  const model = (take.provenance.model ?? '').toLowerCase()
  for (const [k, v] of Object.entries(rates)) {
    if (k !== '*' && k.toLowerCase() === model) return v
  }
  return rates['*'] ?? null
}

export interface ShotSpend {
  spend: number
  takes: number
  usable: number // takes passing or circled
  hitRate: number // usable / takes
  costPerUsableSec: number | null
}

export function shotSpend(
  takes: Take[],
  rates?: Record<string, number>,
): ShotSpend {
  let spend = 0
  let usable = 0
  let usableSec = 0
  for (const t of takes) {
    spend += takeCost(t, rates) ?? 0
    const ok = t.circled || t.gate?.status === 'pass'
    if (ok) {
      usable++
      const dur = t.probe?.durationSec ?? 0
      const w = t.outSec != null && t.inSec != null ? t.outSec - t.inSec : dur
      usableSec += Math.max(0, w)
    }
  }
  return {
    spend,
    takes: takes.length,
    usable,
    hitRate: takes.length ? usable / takes.length : 0,
    costPerUsableSec: usableSec > 0 ? spend / usableSec : null,
  }
}

// ---------------------------------------------------------------------------
// Timecode
// ---------------------------------------------------------------------------

export function toTimecode(seconds: number, fps: number): string {
  const fpsR = Math.max(1, Math.round(fps))
  const totalFrames = Math.round(seconds * fpsR)
  const ff = totalFrames % fpsR
  const totalSec = Math.floor(totalFrames / fpsR)
  const ss = totalSec % 60
  const mm = Math.floor(totalSec / 60) % 60
  const hh = Math.floor(totalSec / 3600)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** Short sortable id: ms timestamp base32 + random tail. Injectable RNG for tests. */
export function newId(now: () => number = Date.now, rand: () => number = Math.random): string {
  let t = now()
  let ts = ''
  for (let i = 0; i < 9; i++) {
    ts = ID_ALPHABET[t % 32] + ts
    t = Math.floor(t / 32)
  }
  let tail = ''
  for (let i = 0; i < 5; i++) tail += ID_ALPHABET[Math.floor(rand() * 32)]
  return ts + tail
}
