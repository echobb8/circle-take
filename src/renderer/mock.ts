/**
 * Mock mode — a complete in-memory `CircleTakeAPI` over the NIGHT MARKET demo
 * film, using the real generated frames in `assets/demo/`.
 *
 * Installed when there is no preload bridge (a plain browser) or when the URL
 * carries `?mock=1`, so every room can be developed, screenshotted and demoed
 * without Electron, the python engine or a media drive. The gate data is
 * synthesized but shaped like the real thing: per-frame series with breach
 * spans, worst-frame evidence, suggested select windows and reasons.
 *
 * Nothing here runs in the packaged app.
 */

import type { CircleTakeAPI, EngineStatus, IngestResult, RecentProject } from '@shared/api'
import {
  CHECK_IDS,
  overallScore,
  shotHintFromFileName,
  statusFromChecks,
  type CharacterKit,
  type CheckId,
  type CheckReport,
  type CheckSummary,
  type EvidenceFrame,
  type GateReport,
  type GateSummary,
  type Project,
  type Provenance,
  type Rating,
  type SeriesPoint,
  type Shot,
  type Take,
} from '@shared/types'
import { setMediaResolver, type MediaResolver } from './media'
import { fallbackPoster, kitAsset, posterAsset, stripAsset } from './demoAssets'

// ---------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------

function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function rng(seed: string): () => number {
  let a = hash32(seed) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Series shapes — the sparkline data that makes the gate panel look measured
// ---------------------------------------------------------------------------

type SeriesShape = 'stable' | 'rising' | 'spike' | 'step' | 'noisy'

function makeSeries(
  seed: string,
  shape: SeriesShape,
  durationSec: number,
  base: number,
  threshold: number,
): SeriesPoint[] {
  const rnd = rng(seed)
  const count = 48
  const pts: SeriesPoint[] = []
  const spikeAt = 0.42 + rnd() * 0.36
  const stepAt = 0.38 + rnd() * 0.3
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1)
    const t = f * durationSec
    let v = base + (rnd() - 0.5) * base * 0.34
    switch (shape) {
      case 'rising':
        v += Math.pow(Math.max(0, f - 0.28) / 0.72, 1.7) * (threshold * 1.32 - base)
        break
      case 'spike': {
        const d = Math.abs(f - spikeAt)
        if (d < 0.055) v += (threshold * 1.5 - base) * (1 - d / 0.055)
        const d2 = Math.abs(f - (spikeAt + 0.19))
        if (d2 < 0.03) v += (threshold * 0.9 - base) * (1 - d2 / 0.03)
        break
      }
      case 'step':
        if (f > stepAt) v += threshold * 0.72 - base * 0.4
        break
      case 'noisy':
        v += Math.sin(f * 21) * base * 0.4 + (rnd() - 0.5) * base * 0.5
        break
      case 'stable':
      default:
        v += Math.sin(f * 6.1) * base * 0.12
        break
    }
    pts.push({ t: Math.round(t * 100) / 100, v: Math.max(0, Math.round(v * 1000) / 1000) })
  }
  return pts
}

function evidenceFrames(
  check: CheckId,
  fps: number,
  series: SeriesPoint[],
  threshold: number,
  captions: string[],
): EvidenceFrame[] {
  return series
    .filter((p) => p.v > threshold)
    .sort((a, b) => b.v - a.v)
    .slice(0, captions.length)
    .sort((a, b) => a.t - b.t)
    .map((p, i) => ({
      frame: Math.round(p.t * fps),
      t: p.t,
      image: `${check}_${Math.round(p.t * fps)}.jpg`,
      caption: captions[i] ?? captions[captions.length - 1] ?? 'Worst frame',
    }))
}

// ---------------------------------------------------------------------------
// NIGHT MARKET — the demo film
// ---------------------------------------------------------------------------

const CHARACTERS: CharacterKit[] = [
  { id: 'ch_crew', name: 'The Crew', images: ['crew_ref_1.png', 'crew_ref_2.png'], locked: true },
  {
    id: 'ch_leader',
    name: 'The Leader',
    images: ['leader_ref_1.jpg', 'leader_ref_2.jpg', 'leader_ref_3.jpg', 'leader_ref_4.jpg'],
    locked: true,
  },
]

interface ShotSeed {
  id: string
  name: string
  /** Filename group in assets/demo — also the filmstrip group. */
  group: string
  description: string
  characterIds: string[]
  durationSec: number
  /** Fallback strip group when this shot has no strips of its own. */
  stripGroup?: string
}

const SHOT_SEEDS: ShotSeed[] = [
  {
    id: 'sh_12',
    name: '12',
    group: 'stroll',
    description: 'Stroll — the crew walks the market lane, rain, neon',
    characterIds: ['ch_crew'],
    durationSec: 7,
  },
  {
    id: 'sh_14',
    name: '14',
    group: 'walk',
    description: 'Walk — steadicam follow through the stalls',
    characterIds: ['ch_crew'],
    durationSec: 8,
  },
  {
    id: 'sh_18',
    name: '18',
    group: 'squad',
    description: 'Squad — the crew lines up, low angle',
    characterIds: ['ch_crew'],
    durationSec: 5,
  },
  {
    id: 'sh_22',
    name: '22',
    group: 'portrait',
    description: 'Portrait — leader close-up, rain-slick neon',
    characterIds: ['ch_leader'],
    durationSec: 6,
  },
  {
    id: 'sh_24',
    name: '24',
    group: 'tension',
    description: 'Tension — standoff at the food stall',
    characterIds: ['ch_crew'],
    durationSec: 6,
  },
  {
    id: 'sh_26',
    name: '26',
    group: 'crew',
    description: 'Crew — the group establishes',
    characterIds: ['ch_crew'],
    durationSec: 5,
  },
  {
    id: 'sh_30',
    name: '30',
    group: 'search',
    description: 'Search — scanning the crowd',
    characterIds: ['ch_crew'],
    durationSec: 6,
  },
  {
    id: 'sh_34',
    name: '34',
    group: 'observer',
    description: 'Observer — the watcher in the shadows',
    characterIds: ['ch_leader'],
    durationSec: 5,
  },
  {
    id: 'sh_36',
    name: '36',
    group: 'alarm',
    description: 'Alarm — the break',
    characterIds: [],
    durationSec: 4,
    stripGroup: 'tension',
  },
]

const GENERATORS: Record<string, { generator: string; model: string }> = {
  dreamina: { generator: 'Dreamina', model: 'dreamina-video-3.0' },
  krea: { generator: 'Krea', model: 'krea-video-1.5' },
}

/** $ per generation, keyed by provenance.model. '*' is the fallback rate. */
const DEFAULT_RATES: Record<string, number> = {
  'dreamina-video-3.0': 0.9,
  'krea-video-1.5': 0.55,
  '*': 0.5,
}

/**
 * Prompt variants per shot. Successive takes walk down this list, so comparing
 * take N with take N+1 shows a small readable word delta — exactly the "what
 * did I change between take 2 and 3" question the recipe diff answers.
 */
const PROMPTS: Record<string, string[]> = {
  sh_12: [
    'anamorphic night exterior, four young people in leather jackets walk shoulder to shoulder down a Bangkok night-market lane, rain-slick asphalt, red paper lanterns and Thai neon signage, charcoal grill smoke drifting through frame, 35mm, shallow depth of field, practical neon keylight, handheld follow',
    'anamorphic night exterior, four young people in leather jackets walk shoulder to shoulder down a Bangkok night-market lane, rain-slick asphalt, red paper lanterns and Thai neon signage, charcoal grill smoke drifting through frame, 35mm, shallow depth of field, practical neon keylight, smooth gimbal follow, no flicker',
    'anamorphic night exterior, four young people in leather jackets walk shoulder to shoulder down a Bangkok night-market lane, rain-slick asphalt, red paper lanterns and Thai neon signage, charcoal grill smoke drifting through frame, 35mm, shallow depth of field, practical neon keylight, smooth gimbal follow, consistent facial identity, no flicker',
    'anamorphic night exterior, four young people in denim jackets walk down a Bangkok night-market lane, dry asphalt, red paper lanterns and Thai neon signage, heavy grill smoke, 50mm, deep focus, practical neon keylight, smooth gimbal follow, consistent facial identity',
  ],
  sh_14: [
    'steadicam follow behind the crew threading between food stalls in a Thai night market, wet ground reflecting neon, steam and grill fire either side, 35mm, continuous forward motion, shallow focus, cinematic',
    'steadicam follow behind the crew threading between food stalls in a Thai night market, wet ground reflecting neon, steam and grill fire either side, 35mm, continuous forward motion at walking pace, shallow focus, cinematic, no morphing, stable geometry',
    'steadicam follow beside the crew threading between food stalls in a Thai night market, wet ground reflecting neon, steam and grill fire either side, 50mm, continuous lateral motion, shallow focus, cinematic, no morphing',
  ],
  sh_18: [
    'low-angle hero shot, the crew lined up across the market lane, Thai neon signage burning behind them, rain in the air, 24mm wide, slight upward tilt, high contrast',
    'low-angle hero shot, the crew lined up across the market lane, Thai neon signage burning behind them, rain in the air, 24mm wide, slight upward tilt, high contrast, correct hand anatomy, five fingers',
  ],
  sh_22: [
    'close-up of the crew leader in a flat cap, rain-slick skin, neon bokeh behind, 85mm, very shallow focus, moody underexposure, night market ambience',
    'close-up of the crew leader in a flat cap, rain-slick skin, neon bokeh behind, 85mm, very shallow focus, moody underexposure, night market ambience, locked-off camera, consistent facial identity',
  ],
  sh_24: [
    'standoff at a food stall, two figures facing off across the grill, flames between them, night-market crowd blurred behind, 50mm, tense stillness',
    'standoff at a food stall, two figures facing off across the grill, flames between them, night-market crowd blurred behind, 50mm, tense stillness, consistent facial identity, matched exposure to previous shot',
  ],
  sh_26: [
    'group establishing shot, the crew stationary in the market lane, neon signage overhead, wet ground, wide 28mm, balanced exposure, cinematic night grade',
  ],
  sh_30: [
    'the leader scanning the night-market crowd, slow pan across faces and stall lights, 50mm, handheld, shallow focus, neon practicals',
  ],
  sh_34: [
    'a watcher in the shadows across the lane, partially obscured by hanging lanterns, long lens 135mm, compressed background, night market neon falling off behind',
  ],
  sh_36: [
    'the break — sudden movement through the night-market crowd, whip pan, motion blur, neon streaks, handheld, 35mm',
  ],
}

type VerdictSpec = Partial<Record<CheckId, 'pass' | 'flag' | 'fail' | 'skip'>>

interface TakeSeed {
  shotId: string
  /** Poster file suffix: '' for the base frame, '_1', '_2'… for the rest. */
  suffix: string
  n: number
  gen: 'dreamina' | 'krea'
  circled?: boolean
  rating?: Rating
  applyWindow?: boolean
  verdicts: VerdictSpec
}

const P = 'pass' as const
const F = 'flag' as const
const X = 'fail' as const
const S = 'skip' as const

const TAKE_SEEDS: TakeSeed[] = [
  // 12 · Stroll — four takes, one clean winner
  { shotId: 'sh_12', suffix: '', n: 1, gen: 'dreamina', verdicts: { identity: F, temporal: P, anatomy: P, continuity: P, conformance: P } },
  { shotId: 'sh_12', suffix: '_1', n: 2, gen: 'dreamina', verdicts: { identity: P, temporal: F, anatomy: P, continuity: P, conformance: P } },
  { shotId: 'sh_12', suffix: '_2', n: 3, gen: 'krea', circled: true, rating: 3, applyWindow: true, verdicts: { identity: P, temporal: P, anatomy: P, continuity: P, conformance: P } },
  { shotId: 'sh_12', suffix: '_3', n: 4, gen: 'dreamina', rating: 1, verdicts: { identity: F, temporal: F, anatomy: F, continuity: F, conformance: P } },

  // 14 · Walk — the morph take, then the keeper
  { shotId: 'sh_14', suffix: '', n: 1, gen: 'dreamina', verdicts: { identity: P, temporal: X, anatomy: P, continuity: P, conformance: P } },
  { shotId: 'sh_14', suffix: '_1', n: 2, gen: 'dreamina', circled: true, rating: 2, applyWindow: true, verdicts: { identity: P, temporal: P, anatomy: P, continuity: F, conformance: P } },
  { shotId: 'sh_14', suffix: '_2', n: 3, gen: 'krea', verdicts: { identity: F, temporal: F, anatomy: P, continuity: P, conformance: P } },

  // 18 · Squad — hands are the problem, nothing usable yet
  { shotId: 'sh_18', suffix: '', n: 1, gen: 'krea', verdicts: { identity: F, temporal: P, anatomy: X, continuity: P, conformance: P } },
  { shotId: 'sh_18', suffix: '_1', n: 2, gen: 'krea', rating: 1, applyWindow: true, verdicts: { identity: F, temporal: F, anatomy: F, continuity: P, conformance: F } },

  // 22 · Portrait — identity is rock solid on the close-up
  { shotId: 'sh_22', suffix: '', n: 1, gen: 'dreamina', circled: true, rating: 3, applyWindow: true, verdicts: { identity: P, temporal: P, anatomy: S, continuity: P, conformance: P } },
  { shotId: 'sh_22', suffix: '_1', n: 2, gen: 'dreamina', rating: 2, verdicts: { identity: P, temporal: F, anatomy: S, continuity: F, conformance: P } },

  // 24 · Tension — a wrong-face event, then a near miss
  { shotId: 'sh_24', suffix: '', n: 1, gen: 'krea', verdicts: { identity: X, temporal: P, anatomy: P, continuity: P, conformance: P } },
  { shotId: 'sh_24', suffix: '_1', n: 2, gen: 'krea', rating: 1, verdicts: { identity: F, temporal: P, anatomy: P, continuity: F, conformance: P } },

  // 26 · Crew — one take, printed
  { shotId: 'sh_26', suffix: '', n: 1, gen: 'dreamina', circled: true, rating: 2, verdicts: { identity: P, temporal: P, anatomy: P, continuity: P, conformance: P } },

  // 30 · Search — still open
  { shotId: 'sh_30', suffix: '', n: 1, gen: 'krea', verdicts: { identity: F, temporal: F, anatomy: S, continuity: P, conformance: P } },

  // 34 · Observer — printed
  { shotId: 'sh_34', suffix: '', n: 1, gen: 'dreamina', circled: true, rating: 2, applyWindow: true, verdicts: { identity: P, temporal: P, anatomy: S, continuity: P, conformance: P } },

  // 36 · Alarm — no characters bound, so identity is skipped; the whip pan morphs
  { shotId: 'sh_36', suffix: '', n: 1, gen: 'krea', verdicts: { identity: S, temporal: X, anatomy: S, continuity: F, conformance: P } },
]

/** Takes that landed in the watch folder without a recognisable shot name. */
const UNASSIGNED_SEEDS: { file: string; gen: 'dreamina' | 'krea'; poster: string }[] = [
  { file: 'market_lane_altlight_v4.mp4', gen: 'krea', poster: 'night_market_search' },
  { file: 'crew_establish_retake_final.mp4', gen: 'dreamina', poster: 'night_market_crew' },
]

// ---------------------------------------------------------------------------
// Check authoring — scores, reasons, series, evidence
// ---------------------------------------------------------------------------

const THRESHOLDS: Record<CheckId, number> = {
  identity: 0.55,
  temporal: 0.3,
  anatomy: 0.42,
  continuity: 0.35,
  conformance: 1,
}

const SERIES_BASE: Record<CheckId, number> = {
  identity: 0.26,
  temporal: 0.12,
  anatomy: 0.18,
  continuity: 0.14,
  conformance: 0,
}

const SCORE_BANDS: Record<'pass' | 'flag' | 'fail' | 'skip', [number, number]> = {
  pass: [86, 97],
  flag: [58, 78],
  fail: [17, 42],
  skip: [0, 0],
}

function shapeFor(verdict: 'pass' | 'flag' | 'fail' | 'skip', check: CheckId): SeriesShape {
  if (verdict === 'pass') return check === 'temporal' ? 'noisy' : 'stable'
  if (verdict === 'flag') return check === 'identity' ? 'rising' : 'step'
  return check === 'temporal' ? 'spike' : 'rising'
}

function reasonFor(
  check: CheckId,
  verdict: 'pass' | 'flag' | 'fail' | 'skip',
  ctx: { charName: string; series: SeriesPoint[]; durationSec: number; fps: number; rnd: () => number },
): string {
  const { charName, series, durationSec, rnd } = ctx
  const first = series[0]?.v ?? 0
  const last = series[series.length - 1]?.v ?? 0
  const peak = series.reduce((m, p) => Math.max(m, p.v), 0)
  const mean = series.length ? series.reduce((s, p) => s + p.v, 0) / series.length : 0
  const peakT = (series.find((p) => p.v === peak)?.t ?? durationSec * 0.5).toFixed(1)
  const f2 = (v: number) => v.toFixed(2)

  switch (check) {
    case 'identity':
      if (verdict === 'skip') return 'No character bound to this shot — identity not evaluated.'
      if (verdict === 'pass')
        return `${charName} holds to the locked kit: mean cos distance ${f2(mean)}, peak ${f2(peak)}, no face-lost windows across ${Math.round(durationSec * 2.5)} sampled frames.`
      if (verdict === 'flag')
        return `identity drift rises after ${(durationSec * 0.34).toFixed(1)}s (cos dist ${f2(first)} → ${f2(last)}) — faces soften toward the end of the take.`
      return `wrong-face event at ${peakT}s: cos distance ${f2(peak)} against the kit centroid, ${Math.round(6 + rnd() * 9)} consecutive samples above the 0.55 cap.`
    case 'temporal':
      if (verdict === 'pass')
        return `Stable motion: warp residual mean ${f2(mean)}, flicker MAD in smooth regions under 1.4/255, no jump events.`
      if (verdict === 'flag')
        return `neon flicker beating against frame rate from ${(durationSec * 0.4).toFixed(1)}s — luma MAD ${f2(mean)} in the smooth signage regions vs 0.30 tolerance, visible on a large screen.`
      return `morph discontinuity at ${peakT}s — content delta ${f2(peak)} against a rolling baseline of ${f2(mean)}, i.e. a cut where no cut exists.`
    case 'anatomy':
      if (verdict === 'skip') return 'No hands resolved in frame — anatomy check skipped.'
      if (verdict === 'pass')
        return `Hand landmarks stable: five fingers held on ${Math.round(94 + rnd() * 5)}% of detected frames, jitter within the motion baseline.`
      if (verdict === 'flag')
        return `finger-count anomaly on ${Math.round(4 + rnd() * 6)} frames around ${peakT}s (six landmarks resolved on one hand) — brief, may survive a cut.`
      return `sustained anatomy break from ${peakT}s: landmark confidence collapses and finger count oscillates 4↔6 for ${(durationSec * 0.2).toFixed(1)}s.`
    case 'continuity':
      if (verdict === 'pass')
        return `Matches the circled neighbours: ΔL* ${f2(mean * 12)}, a/b means within 1.8, histogram distance ${f2(mean)}.`
      if (verdict === 'flag')
        return `exposure sits ${(0.6 + rnd() * 0.6).toFixed(1)} stop hotter than the circled neighbour — ΔL* ${f2(peak * 14)} will read as a grade mismatch at the cut.`
      return `palette drift against the circled neighbour: histogram distance ${f2(peak)}, warm cast (+${Math.round(4 + rnd() * 4)} on b*) that no single-node grade will match.`
    case 'conformance':
    default:
      if (verdict === 'pass')
        return `${durationSec.toFixed(1)}s @ ${ctx.fps}fps, 1920×1080 — inside expected format on every axis.`
      if (verdict === 'flag')
        return `runs ${(durationSec * 0.18).toFixed(1)}s short of the expected ${(durationSec * 1.18).toFixed(1)}s — usable but the cut will need a hold.`
      return `frozen tail: the last ${(durationSec * 0.12).toFixed(1)}s are duplicate frames, and delivery is 1600×900 against the 1920×1080 floor.`
  }
}

const EVIDENCE_CAPTIONS: Record<CheckId, string[]> = {
  identity: ['Highest cos distance to kit', 'Face geometry drifts off-kit', 'Recovered, still above cap'],
  temporal: ['Warp residual peak — morph', 'Signage flicker beat', 'Flow discontinuity'],
  anatomy: ['Six landmarks on one hand', 'Confidence collapse', 'Finger count oscillation'],
  continuity: ['Exposure step vs neighbour', 'Warm cast in the highlights', 'Palette departure'],
  conformance: ['Frozen frame in tail', 'Resolution floor breach'],
}

/**
 * Cleanest continuous span: slide a window over the normalised artifact energy
 * of every series and keep the quietest one. Mirrors what the engine will do
 * for real; here it only has to be plausible and deterministic.
 */
function suggestWindow(
  checks: Partial<Record<CheckId, CheckReport>>,
  durationSec: number,
): { inSec: number; outSec: number; reason: string } | undefined {
  const scored = CHECK_IDS.map((id) => ({ id, c: checks[id] })).filter(
    (x): x is { id: CheckId; c: CheckReport } => !!x.c?.series?.length,
  )
  if (scored.length === 0 || durationSec < 2) return undefined

  const N = 48
  const energy = new Array<number>(N).fill(0)
  for (const { c } of scored) {
    const series = c.series ?? []
    const thr = c.threshold ?? 1
    for (let i = 0; i < N; i++) {
      const p = series[Math.min(series.length - 1, Math.round((i / (N - 1)) * (series.length - 1)))]
      energy[i] = (energy[i] ?? 0) + (p ? p.v / thr : 0)
    }
  }
  const span = Math.max(4, Math.round(N * 0.55))
  let bestStart = 0
  let bestSum = Infinity
  for (let s = 0; s + span <= N; s++) {
    let sum = 0
    for (let i = s; i < s + span; i++) sum += energy[i] ?? 0
    if (sum < bestSum) {
      bestSum = sum
      bestStart = s
    }
  }
  const inSec = Math.round((bestStart / (N - 1)) * durationSec * 10) / 10
  const outSec = Math.round((Math.min(N - 1, bestStart + span) / (N - 1)) * durationSec * 10) / 10
  if (outSec - inSec < 1) return undefined
  const names = scored.map((s) => s.id).slice(0, 2).join(' + ')
  return {
    inSec,
    outSec,
    reason: `cleanest continuous span (${names} stable across the whole window)`,
  }
}

interface BuiltGate {
  summary: GateSummary
  report: GateReport
}

function buildGate(
  takeId: string,
  mediaPath: string,
  verdicts: VerdictSpec,
  durationSec: number,
  fps: number,
  charName: string,
): BuiltGate {
  const rnd = rng(`gate:${takeId}`)
  const summary: Partial<Record<CheckId, CheckSummary>> = {}
  const full: Partial<Record<CheckId, CheckReport>> = {}

  for (const check of CHECK_IDS) {
    const verdict = verdicts[check]
    if (!verdict) continue
    const band = SCORE_BANDS[verdict]
    const score = verdict === 'skip' ? 0 : Math.round(band[0] + rnd() * (band[1] - band[0]))
    const threshold = THRESHOLDS[check]
    const base = SERIES_BASE[check]
    const hasSeries = verdict !== 'skip' && check !== 'conformance'
    const series = hasSeries
      ? makeSeries(`${takeId}:${check}`, shapeFor(verdict, check), durationSec, base, threshold)
      : undefined
    const reason = reasonFor(check, verdict, { charName, series: series ?? [], durationSec, fps, rnd })
    const entry: CheckSummary = { verdict, score, reason }
    summary[check] = entry

    const evidence =
      series && (verdict === 'flag' || verdict === 'fail')
        ? evidenceFrames(
            check,
            fps,
            series,
            threshold,
            EVIDENCE_CAPTIONS[check].slice(0, verdict === 'fail' ? 3 : 2),
          )
        : undefined

    full[check] = {
      ...entry,
      ...(series ? { series, threshold } : {}),
      ...(evidence && evidence.length ? { evidence } : {}),
      details: { sampledFrames: Math.round(durationSec * 2.5), threshold },
    }
  }

  const overall = overallScore(summary)
  const status = statusFromChecks(summary)
  const ranAt = new Date(Date.UTC(2026, 6, 22, 9, 0, 0) + (hash32(takeId) % 60000000)).toISOString()
  const suggested = suggestWindow(full, durationSec)

  return {
    summary: { status, overall, checks: summary, engineVersion: '1.0.0', ranAt },
    report: {
      takeId,
      mediaPath,
      engineVersion: '1.0.0',
      modelVersions: { yunet: '2023mar', sface: '2021dec', mediapipe: '0.10.14', opencv: '4.10.0' },
      ranAt,
      overall,
      status,
      checks: full,
      ...(suggested ? { suggestedWindow: suggested } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Project assembly
// ---------------------------------------------------------------------------

const MEDIA_ROOT = '/Volumes/DAILIES/NightMarket/renders'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** takeId → the demo frame it was generated from. Drives the media resolver. */
interface ArtBinding {
  poster: string
  stripGroup: string
}

interface Built {
  project: Project
  reports: Map<string, GateReport>
  art: Map<string, ArtBinding>
}

function buildDemoProject(): Built {
  const shots: Shot[] = SHOT_SEEDS.map((s, i) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    order: i,
    characterIds: s.characterIds,
    expected: { durationSec: s.durationSec, fps: 24, width: 1920, height: 1080 },
    refs: { blockoutShot: `BLK-${s.name}`, scriptbreakScene: `SC ${s.name}` },
  }))
  const seedById = new Map(SHOT_SEEDS.map((s) => [s.id, s]))
  const shotById = new Map(shots.map((s) => [s.id, s]))
  const takes: Take[] = []
  const reports = new Map<string, GateReport>()
  const art = new Map<string, ArtBinding>()

  TAKE_SEEDS.forEach((seed, i) => {
    const shot = shotById.get(seed.shotId)
    const shotSeed = seedById.get(seed.shotId)
    if (!shot || !shotSeed) return

    const rnd = rng(`take:${seed.shotId}:${seed.n}`)
    const gen = GENERATORS[seed.gen]
    if (!gen) return

    const prompts = PROMPTS[seed.shotId] ?? []
    const prompt = prompts[(seed.n - 1) % Math.max(1, prompts.length)] ?? prompts[0] ?? ''
    const id = `tk_${shotSeed.group}_${pad2(seed.n)}`
    const durationSec = Math.round((shotSeed.durationSec + (rnd() - 0.4) * 1.4) * 10) / 10
    const fps = 24
    const fileName = `${shot.name}_t${pad2(seed.n)}_${seed.gen}.mp4`
    const mediaPath = `${MEDIA_ROOT}/${shot.name}/${fileName}`
    const charName = CHARACTERS.find((c) => c.id === shot.characterIds[0])?.name ?? 'the subject'

    const { summary, report } = buildGate(id, mediaPath, seed.verdicts, durationSec, fps, charName)
    reports.set(id, report)
    art.set(id, {
      poster: `night_market_${shotSeed.group}${seed.suffix}`,
      stripGroup: shotSeed.stripGroup ?? shotSeed.group,
    })

    const provenance: Provenance = {
      generator: gen.generator,
      model: gen.model,
      prompt,
      seed: String(2600000000 + Math.floor(rnd() * 99999999)),
      sourceSidecar: `${fileName.replace(/\.mp4$/, '')}.json`,
      ...(seed.circled ? { notes: 'Director pick — printed.' } : {}),
    }

    takes.push({
      id,
      shotId: shot.id,
      mediaPath,
      fileName,
      ingestedAt: new Date(Date.UTC(2026, 6, 21, 14, 0, 0) + i * 1_140_000).toISOString(),
      provenance,
      probe: { durationSec, fps, width: 1920, height: 1080, codec: 'h264' },
      gate: summary,
      circled: seed.circled ?? false,
      rating: seed.rating ?? 0,
      ...(seed.applyWindow && report.suggestedWindow
        ? { inSec: report.suggestedWindow.inSec, outSec: report.suggestedWindow.outSec }
        : {}),
    })
  })

  UNASSIGNED_SEEDS.forEach((u, i) => {
    const rnd = rng(`unassigned:${u.file}`)
    const gen = GENERATORS[u.gen]
    if (!gen) return
    const id = `tk_inbox_${pad2(i + 1)}`
    const durationSec = Math.round((4 + rnd() * 4) * 10) / 10
    art.set(id, { poster: u.poster, stripGroup: u.poster.replace('night_market_', '') })
    takes.push({
      id,
      shotId: '',
      mediaPath: `${MEDIA_ROOT}/inbox/${u.file}`,
      fileName: u.file,
      ingestedAt: new Date(Date.UTC(2026, 6, 23, 8, 30, 0) + i * 420_000).toISOString(),
      provenance: {
        generator: gen.generator,
        model: gen.model,
        prompt: 'night market lane, rain-slick neon, handheld, crew walking through grill smoke',
        seed: String(2600000000 + Math.floor(rnd() * 99999999)),
      },
      probe: { durationSec, fps: 24, width: 1920, height: 1080, codec: 'h264' },
      circled: false,
      rating: 0,
    })
  })

  return {
    project: {
      schema: 1,
      name: 'NIGHT MARKET',
      createdAt: '2026-07-21T13:40:00.000Z',
      settings: {
        copyMediaIntoProject: false,
        watchFolder: `${MEDIA_ROOT}/inbox`,
        expected: { durationSec: 6, fps: 24, width: 1920, height: 1080 },
        modelRates: DEFAULT_RATES,
      },
      shots,
      takes,
      characters: CHARACTERS.map((c) => ({ ...c, images: [...c.images] })),
    },
    reports,
    art,
  }
}

// ---------------------------------------------------------------------------
// The mock API
// ---------------------------------------------------------------------------

const RECENTS: RecentProject[] = [
  { path: '/Users/director/Films/NightMarket.ctake', name: 'NIGHT MARKET', openedAt: '2026-07-24T09:12:00.000Z' },
  { path: '/Users/director/Films/HalfLight.ctake', name: 'HALF LIGHT', openedAt: '2026-07-19T18:44:00.000Z' },
  { path: '/Users/director/Films/TheQuietCar.ctake', name: 'THE QUIET CAR', openedAt: '2026-07-11T21:05:00.000Z' },
]

const GATE_STAGES = [
  'probing media',
  'extracting frames',
  'identity · embedding faces',
  'temporal · optical flow',
  'anatomy · landmarks',
  'continuity · Lab stats',
  'writing report',
]

function makeMockApi(built: Built, startEmpty: boolean): CircleTakeAPI {
  let project = built.project
  /** `?empty=1` boots with no project open so the Welcome room is reachable. */
  let unopened = startEmpty
  const reports = built.reports
  const art = built.art
  const projectListeners = new Set<(p: Project) => void>()
  const gateListeners = new Set<(e: { takeId: string; stage: string; pct: number; note?: string }) => void>()
  const ingestListeners = new Set<(e: { fileName: string; stage: string }) => void>()
  const engineListeners = new Set<(s: EngineStatus) => void>()

  const engine: EngineStatus = {
    ready: true,
    stage: 'ready',
    engineVersion: '1.0.0',
    anatomyAvailable: true,
    detail: 'Local engine ready · YuNet 2023mar · SFace 2021dec',
  }

  const push = (): Project => {
    project = {
      ...project,
      shots: [...project.shots],
      takes: [...project.takes],
      characters: [...project.characters],
    }
    for (const cb of projectListeners) cb(project)
    return project
  }

  const patchTake = (takeId: string, patch: Partial<Take>): Project => {
    project = { ...project, takes: project.takes.map((t) => (t.id === takeId ? { ...t, ...patch } : t)) }
    for (const cb of projectListeners) cb(project)
    return project
  }

  const nextId = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 8)}`

  const simulateGate = async (takeId: string): Promise<void> => {
    const take = project.takes.find((t) => t.id === takeId)
    if (!take) return
    patchTake(takeId, {
      gate: {
        status: 'running',
        overall: 0,
        checks: {},
        engineVersion: '1.0.0',
        ranAt: new Date().toISOString(),
      },
    })
    for (let i = 0; i < GATE_STAGES.length; i++) {
      await new Promise((r) => setTimeout(r, 260))
      for (const cb of gateListeners) {
        cb({
          takeId,
          stage: GATE_STAGES[i] ?? 'working',
          pct: Math.round(((i + 1) / GATE_STAGES.length) * 100),
        })
      }
    }
    const shot = project.shots.find((s) => s.id === take.shotId)
    const roll = rng(`rerun:${takeId}:${Date.now()}`)()
    const verdicts: VerdictSpec = {
      identity: shot?.characterIds.length ? (roll > 0.35 ? P : F) : S,
      temporal: roll > 0.6 ? P : F,
      anatomy: roll > 0.75 ? F : P,
      continuity: roll > 0.5 ? P : F,
      conformance: P,
    }
    const charName = CHARACTERS.find((c) => c.id === shot?.characterIds[0])?.name ?? 'the subject'
    const { summary, report } = buildGate(
      takeId,
      take.mediaPath,
      verdicts,
      take.probe?.durationSec ?? 6,
      take.probe?.fps ?? 24,
      charName,
    )
    reports.set(takeId, report)
    patchTake(takeId, { gate: summary })
  }

  const api: CircleTakeAPI = {
    async setProduction(production) { project.production = production; return push() },
    async createProject(_parentDir, name) {
      unopened = false
      project = {
        schema: 1,
        name,
        createdAt: new Date().toISOString(),
        settings: { copyMediaIntoProject: false },
        shots: [],
        takes: [],
        characters: [],
      }
      return push()
    },
    async openProject() {
      unopened = false
      return push()
    },
    async getProject() {
      return unopened ? null : project
    },
    async getProjectPath() {
      return unopened ? null : '/Users/director/Films/NightMarket.ctake'
    },
    async getRecentProjects() {
      return RECENTS
    },

    async chooseMediaFiles() {
      return [`${MEDIA_ROOT}/inbox/22_t03_dreamina.mp4`, `${MEDIA_ROOT}/inbox/30_t02_krea.mp4`]
    },
    async chooseImageFiles() {
      return ['/Users/director/Refs/crew_ref_3.png']
    },
    async chooseFolder() {
      return '/Users/director/Films'
    },
    async chooseProjectFile() {
      return '/Users/director/Films/NightMarket.ctake'
    },
    async chooseSavePath(defaultName) {
      return `/Users/director/Desktop/${defaultName}`
    },

    async addShot(shot) {
      const order = project.shots.reduce((m, s) => Math.max(m, s.order + 1), 0)
      project = { ...project, shots: [...project.shots, { ...shot, id: nextId('sh'), order }] }
      return push()
    },
    async updateShot(id, patch) {
      project = { ...project, shots: project.shots.map((s) => (s.id === id ? { ...s, ...patch } : s)) }
      return push()
    },
    async deleteShot(id) {
      project = {
        ...project,
        shots: project.shots.filter((s) => s.id !== id),
        takes: project.takes.map((t) => (t.shotId === id ? { ...t, shotId: '' } : t)),
      }
      return push()
    },
    async reorderShots(idsInOrder) {
      project = {
        ...project,
        shots: project.shots.map((s) => {
          const idx = idsInOrder.indexOf(s.id)
          return idx === -1 ? s : { ...s, order: idx }
        }),
      }
      return push()
    },

    async ingestFiles(paths) {
      const added: Take[] = []
      const skipped: string[] = []
      for (const p of paths) {
        const fileName = p.split('/').pop() ?? p
        if (!/\.(mp4|mov|webm|mkv|m4v)$/i.test(fileName)) {
          skipped.push(`${fileName} — not a media file`)
          continue
        }
        for (const cb of ingestListeners) cb({ fileName, stage: 'probed' })
        const hint = shotHintFromFileName(fileName)
        const shot = hint ? project.shots.find((s) => s.name.toUpperCase() === hint) : undefined
        const rnd = rng(`ingest:${fileName}`)
        const gen = rnd() > 0.5 ? GENERATORS.dreamina : GENERATORS.krea
        if (!gen) continue
        const id = nextId('tk')
        const group = shot ? (SHOT_SEEDS.find((s) => s.id === shot.id)?.group ?? 'stroll') : 'stroll'
        art.set(id, { poster: `__fallback__${id}`, stripGroup: group })
        added.push({
          id,
          shotId: shot?.id ?? '',
          mediaPath: p,
          fileName,
          ingestedAt: new Date().toISOString(),
          provenance: {
            generator: gen.generator,
            model: gen.model,
            prompt: shot ? (PROMPTS[shot.id]?.[0] ?? '') : '',
            seed: String(2600000000 + Math.floor(rnd() * 99999999)),
          },
          probe: {
            durationSec: Math.round((4 + rnd() * 4) * 10) / 10,
            fps: 24,
            width: 1920,
            height: 1080,
            codec: 'h264',
          },
          circled: false,
          rating: 0,
        })
      }
      project = { ...project, takes: [...project.takes, ...added] }
      push()
      for (const t of added) void simulateGate(t.id)
      return { added: added.length, skipped } satisfies IngestResult
    },
    async assignTake(takeId, shotId) {
      return patchTake(takeId, { shotId })
    },
    async setProvenance(takeId, prov) {
      const take = project.takes.find((t) => t.id === takeId)
      return patchTake(takeId, { provenance: { ...take?.provenance, ...prov } })
    },
    async circleTake(takeId, circled) {
      return patchTake(takeId, { circled })
    },
    async setRating(takeId, rating) {
      return patchTake(takeId, { rating })
    },
    async setTakeWindow(takeId, inSec, outSec) {
      const take = project.takes.find((t) => t.id === takeId)
      if (!take) return project
      const next: Take = { ...take }
      if (inSec == null) delete next.inSec
      else next.inSec = Math.round(inSec * 100) / 100
      if (outSec == null) delete next.outSec
      else next.outSec = Math.round(outSec * 100) / 100
      project = { ...project, takes: project.takes.map((t) => (t.id === takeId ? next : t)) }
      return push()
    },
    async setModelRates(rates) {
      project = { ...project, settings: { ...project.settings, modelRates: { ...rates } } }
      return push()
    },
    async deleteTake(takeId) {
      project = { ...project, takes: project.takes.filter((t) => t.id !== takeId) }
      return push()
    },

    async runGate(takeId) {
      await simulateGate(takeId)
    },
    async runGateAll(onlyPending) {
      for (const t of project.takes.filter((x) => (onlyPending ? !x.gate : true))) {
        await simulateGate(t.id)
      }
    },
    async cancelGates() {
      /* nothing queued in mock */
    },
    async getGateReport(takeId) {
      return reports.get(takeId) ?? null
    },
    async getEngineStatus() {
      return engine
    },

    async addCharacter(name) {
      project = {
        ...project,
        characters: [...project.characters, { id: nextId('ch'), name, images: [], locked: false }],
      }
      return push()
    },
    async renameCharacter(id, name) {
      project = {
        ...project,
        characters: project.characters.map((c) => (c.id === id ? { ...c, name } : c)),
      }
      return push()
    },
    async deleteCharacter(id) {
      project = { ...project, characters: project.characters.filter((c) => c.id !== id) }
      return push()
    },
    async addKitImages(charId, imagePaths) {
      project = {
        ...project,
        characters: project.characters.map((c) =>
          c.id === charId
            ? { ...c, images: [...c.images, ...imagePaths.map((p) => p.split('/').pop() ?? p)] }
            : c,
        ),
      }
      return push()
    },
    async removeKitImage(charId, image) {
      project = {
        ...project,
        characters: project.characters.map((c) =>
          c.id === charId ? { ...c, images: c.images.filter((i) => i !== image) } : c,
        ),
      }
      return push()
    },
    async buildKit(charId) {
      project = {
        ...project,
        characters: project.characters.map((c) => (c.id === charId ? { ...c, locked: true } : c)),
      }
      push()
      return project.characters.find((c) => c.id === charId) ?? { id: charId, name: '', images: [], locked: true }
    },

    async setWatchFolder(path) {
      project = { ...project, settings: { ...project.settings, watchFolder: path ?? undefined } }
      return push()
    },

    async exportFcpxml(outPath) {
      return outPath
    },
    async exportEdl(outPath) {
      return outPath
    },
    async exportReshootList(outPath) {
      return outPath
    },
    async exportCsv(outPath) {
      return outPath
    },

    onProjectUpdated(cb) {
      projectListeners.add(cb)
      return () => projectListeners.delete(cb)
    },
    onGateProgress(cb) {
      gateListeners.add(cb)
      return () => gateListeners.delete(cb)
    },
    onIngestProgress(cb) {
      ingestListeners.add(cb)
      return () => ingestListeners.delete(cb)
    },
    onEngineStatus(cb) {
      engineListeners.add(cb)
      return () => engineListeners.delete(cb)
    },
  }

  // Every visible surface resolves to a real demo frame.
  const resolver: MediaResolver = {
    synthetic: true,
    poster: (takeId) => {
      const binding = art.get(takeId)
      return binding ? posterAsset(binding.poster, takeId) : fallbackPoster(takeId)
    },
    strip: (takeId, index) => {
      const binding = art.get(takeId)
      return binding ? stripAsset(binding.stripGroup, index, takeId) : fallbackPoster(`${takeId}:${index}`)
    },
    video: (takeId) => `mock://media/${takeId}`,
    // Evidence frames are extracted from the take itself — reuse its strip
    // frames so the worst-frame thumbnails are real footage too.
    evidence: (takeId, file) => {
      const binding = art.get(takeId)
      const i = hash32(file) % 8
      return binding ? stripAsset(binding.stripGroup, i, takeId) : fallbackPoster(file)
    },
    kit: (_charId, file) => kitAsset(file),
    face: (takeId) => {
      const binding = art.get(takeId)
      return binding ? posterAsset(binding.poster, takeId) : fallbackPoster(takeId)
    },
  }
  setMediaResolver(resolver)

  return api
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export function isMockMode(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as { circletake?: CircleTakeAPI }
  if (!w.circletake) return true
  return new URLSearchParams(window.location.search).has('mock')
}

/**
 * Install the mock bridge when there is no preload API, or when `?mock=1`
 * forces it. Safe to call more than once.
 */
export function installMockIfNeeded(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as { circletake?: CircleTakeAPI }
  const forced = new URLSearchParams(window.location.search).has('mock')
  if (w.circletake && !forced) return false
  const params = new URLSearchParams(window.location.search)
  w.circletake = makeMockApi(buildDemoProject(), params.has('empty'))
  return true
}
