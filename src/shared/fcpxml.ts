/**
 * FCPXML 1.11 export — pure builder, no Node/DOM/Electron.
 *
 * Produces a Resolve-importable timeline of the circled takes in shot order:
 * one `<format>` derived from the project (fps + frame size), one `<asset>` per
 * circled take pointing at its media with a `file://` URL, and a single
 * `<sequence>` whose `<spine>` holds one `<asset-clip>` per take laid end to
 * end. Every time value is a rational second string ("Ns/Ds") whose denominator
 * is the format's frame-duration timebase, so the timeline lands frame-exact.
 */

import type { Project, Shot, Take } from './types'

export interface FcpxmlOptions {
  /** Timeline frame rate. Defaults to project settings, then 24. */
  fps?: number
  /** Timeline width. Defaults to project settings, then 1920. */
  width?: number
  /** Timeline height. Defaults to project settings, then 1080. */
  height?: number
  /** `<project>` name. Defaults to `<project name> SELECTS`. */
  title?: string
  /** `<event>` name. Defaults to the project name. */
  eventName?: string
}

export const DEFAULT_FPS = 24
export const DEFAULT_WIDTH = 1920
export const DEFAULT_HEIGHT = 1080
/** Fallback clip length when a take has no probe and no expected duration. */
export const DEFAULT_TAKE_DURATION_SEC = 5

/** A frame duration expressed as `num/den` seconds (FCPXML rational time). */
export interface FrameDuration {
  num: number
  den: number
}

/**
 * The frame-duration table FCPXML expects, already in lowest terms. NTSC rates
 * keep their 1001/N form; integer rates are 1/N. Anything not listed falls back
 * to a reduced 1000ths fraction.
 */
const RATE_TABLE: Array<{ fps: number; fd: FrameDuration }> = [
  { fps: 23.976, fd: { num: 1001, den: 24000 } },
  { fps: 24, fd: { num: 1, den: 24 } },
  { fps: 25, fd: { num: 1, den: 25 } },
  { fps: 29.97, fd: { num: 1001, den: 30000 } },
  { fps: 30, fd: { num: 1, den: 30 } },
  { fps: 47.952, fd: { num: 1001, den: 48000 } },
  { fps: 48, fd: { num: 1, den: 48 } },
  { fps: 50, fd: { num: 1, den: 50 } },
  { fps: 59.94, fd: { num: 1001, den: 60000 } },
  { fps: 60, fd: { num: 1, den: 60 } },
]

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) {
    const t = y
    y = x % y
    x = t
  }
  return x || 1
}

/** Reduce a fraction to lowest terms. FCPXML times must be exact rationals. */
export function reduceFraction(num: number, den: number): FrameDuration {
  const g = gcd(num, den)
  return { num: num / g, den: den / g }
}

/** Frame duration for a rate, e.g. 24 -> 1/24s, 23.976 -> 1001/24000s. */
export function frameDuration(fps: number): FrameDuration {
  const rate = fps > 0 ? fps : DEFAULT_FPS
  for (const cand of RATE_TABLE) {
    if (Math.abs(rate - cand.fps) < 0.01) return cand.fd
  }
  if (Number.isInteger(rate)) return { num: 1, den: rate }
  return reduceFraction(1000, Math.max(1, Math.round(rate * 1000)))
}

/** True for the drop-frame NTSC rates (29.97 / 59.94). 23.976 is NOT DF. */
export function isDropFrame(fps: number): boolean {
  return Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01
}

/** `tcFormat` attribute value for a rate. */
export function tcFormat(fps: number): 'DF' | 'NDF' {
  return isDropFrame(fps) ? 'DF' : 'NDF'
}

/** Whole frames for a duration at a rate (never negative). */
export function framesFor(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.max(0, Math.round(seconds * (fps > 0 ? fps : DEFAULT_FPS)))
}

/**
 * Rational-second string for a whole number of frames, reduced to lowest
 * terms: 48 frames @ 24fps -> `2/1s`, 12 -> `1/2s`, 0 -> `0s`. Integer math
 * only — a float second value here is what breaks Resolve imports.
 */
export function rationalFrames(frames: number, fps: number): string {
  if (frames <= 0) return '0s'
  const fd = frameDuration(fps)
  const r = reduceFraction(frames * fd.num, fd.den)
  return `${r.num}/${r.den}s`
}

/** Rational-second string for a duration in seconds, snapped to frames. */
export function rationalSeconds(seconds: number, fps: number): string {
  return rationalFrames(framesFor(seconds, fps), fps)
}

/** Escape the five XML entities. Applied to every attribute value we emit. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Absolute filesystem path -> percent-encoded `file://` URL. */
export function fileUrl(absPath: string): string {
  const norm = absPath.replace(/\\/g, '/')
  const rooted = norm.startsWith('/') ? norm : `/${norm}`
  return `file://${rooted.split('/').map(encodeURIComponent).join('/')}`
}

/** A circled take paired with its shot (null for takes in the unassigned tray). */
export interface Select {
  take: Take
  shot: Shot | null
}

/**
 * Circled takes in cut order: shots ascending by `order`, takes in ingest
 * order within a shot. Circled takes that were never bound to a shot are
 * appended at the end so a select is never silently dropped from an export.
 */
export function circledTakesInOrder(project: Project): Select[] {
  const shots = [...project.shots].sort((a, b) => a.order - b.order)
  const out: Select[] = []
  for (const shot of shots) {
    for (const take of project.takes) {
      if (take.circled && take.shotId === shot.id) out.push({ take, shot })
    }
  }
  const known = new Set(project.shots.map((s) => s.id))
  for (const take of project.takes) {
    if (take.circled && !known.has(take.shotId)) out.push({ take, shot: null })
  }
  return out
}

/** Full media length for a take: probe, then shot/project expectation. */
export function takeDurationSec(take: Take, shot: Shot | null, project: Project): number {
  const probed = take.probe?.durationSec
  if (typeof probed === 'number' && probed > 0) return probed
  const expected = shot?.expected?.durationSec ?? project.settings.expected?.durationSec
  if (typeof expected === 'number' && expected > 0) return expected
  return DEFAULT_TAKE_DURATION_SEC
}

/** Source in/out of a take: its select window when set, else the whole clip. */
export interface TakeWindow {
  /** Source in point, seconds from the head of the media. */
  inSec: number
  /** Source out point, seconds from the head of the media. */
  outSec: number
  /** Window length in seconds (always > 0). */
  lengthSec: number
  /** Full media length in seconds. */
  fullSec: number
}

/**
 * Resolve a take's usable window. A manual/suggested window (`inSec`/`outSec`)
 * wins; anything missing, inverted or out of range falls back to the full clip
 * so an export can never produce a zero- or negative-length clip.
 */
export function takeWindow(take: Take, shot: Shot | null, project: Project): TakeWindow {
  const fullSec = takeDurationSec(take, shot, project)
  const rawIn = typeof take.inSec === 'number' && Number.isFinite(take.inSec) ? take.inSec : 0
  const rawOut =
    typeof take.outSec === 'number' && Number.isFinite(take.outSec) ? take.outSec : fullSec
  const inSec = Math.min(Math.max(0, rawIn), Math.max(0, fullSec))
  const outSec = Math.min(Math.max(inSec, rawOut), fullSec > 0 ? fullSec : rawOut)
  const lengthSec = outSec - inSec
  if (lengthSec <= 0) return { inSec: 0, outSec: fullSec, lengthSec: fullSec, fullSec }
  return { inSec, outSec, lengthSec, fullSec }
}

/** Human clip name: `<shot> — <file>` when bound, else just the file name. */
export function clipName(take: Take, shot: Shot | null): string {
  return shot ? `${shot.name} — ${take.fileName}` : take.fileName
}

function formatName(width: number, height: number, fps: number): string {
  const label = Number.isInteger(fps) ? String(fps) : fps.toFixed(2).replace('.', '')
  return `FFVideoFormat${width}x${height}p${label}`
}

/**
 * Build the FCPXML 1.11 document for the project's circled takes.
 * Always returns a well-formed document, even with zero selects.
 */
export function buildFcpxml(project: Project, opts: FcpxmlOptions = {}): string {
  const fps = opts.fps ?? project.settings.expected?.fps ?? DEFAULT_FPS
  const width = opts.width ?? project.settings.expected?.width ?? DEFAULT_WIDTH
  const height = opts.height ?? project.settings.expected?.height ?? DEFAULT_HEIGHT
  const fd = frameDuration(fps)

  const selects = circledTakesInOrder(project)
  const eventName = opts.eventName ?? project.name
  const timelineName = opts.title ?? `${project.name} SELECTS`
  const tcf = tcFormat(fps)

  const assets: string[] = []
  const clips: string[] = []
  let offsetFrames = 0

  selects.forEach((sel, i) => {
    const id = `r${i + 1}`
    const win = takeWindow(sel.take, sel.shot, project)
    // The asset spans the whole media; the clip spans only the select window.
    const assetFrames = Math.max(1, framesFor(win.fullSec, fps))
    const clipFrames = Math.max(1, framesFor(win.lengthSec, fps))
    const startFrames = framesFor(win.inSec, fps)
    const name = clipName(sel.take, sel.shot)

    assets.push(
      `    <asset id="${id}" name="${escapeXml(name)}" start="0s" ` +
        `duration="${rationalFrames(assetFrames, fps)}" ` +
        `hasVideo="1" videoSources="1" format="r0">\n` +
        `      <media-rep kind="original-media" src="${escapeXml(fileUrl(sel.take.mediaPath))}"/>\n` +
        `    </asset>`,
    )
    clips.push(
      `            <asset-clip ref="${id}" name="${escapeXml(name)}" ` +
        `offset="${rationalFrames(offsetFrames, fps)}" ` +
        `duration="${rationalFrames(clipFrames, fps)}" ` +
        `start="${rationalFrames(startFrames, fps)}" format="r0" tcFormat="${tcf}"/>`,
    )
    offsetFrames += clipFrames
  })

  const seqDuration = rationalFrames(offsetFrames, fps)

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE fcpxml>\n` +
    `<fcpxml version="1.11">\n` +
    `  <resources>\n` +
    `    <format id="r0" name="${escapeXml(formatName(width, height, fps))}" ` +
    `frameDuration="${fd.num}/${fd.den}s" width="${width}" height="${height}" ` +
    `colorSpace="1-1-1 (Rec. 709)"/>\n` +
    (assets.length ? `${assets.join('\n')}\n` : '') +
    `  </resources>\n` +
    `  <library>\n` +
    `    <event name="${escapeXml(eventName)}">\n` +
    `      <project name="${escapeXml(timelineName)}">\n` +
    `        <sequence format="r0" duration="${seqDuration}" tcStart="0s" tcFormat="${tcf}" ` +
    `audioLayout="stereo" audioRate="48k">\n` +
    `          <spine>\n` +
    (clips.length ? `${clips.join('\n')}\n` : '') +
    `          </spine>\n` +
    `        </sequence>\n` +
    `      </project>\n` +
    `    </event>\n` +
    `  </library>\n` +
    `</fcpxml>\n`
  )
}
