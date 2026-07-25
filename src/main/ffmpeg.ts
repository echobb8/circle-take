/**
 * ffmpeg / ffprobe helpers for the main process.
 *
 * GUI apps launched from Finder don't inherit the login shell's PATH, so the
 * binaries are probed at the usual Homebrew locations first and only then left
 * to PATH resolution. Everything that builds an argv is a pure exported
 * function so it can be unit-tested without spawning anything.
 */

import { spawn } from 'child_process'
import { access, mkdir } from 'fs/promises'
import { constants } from 'fs'
import { join } from 'path'
import type { ProbeInfo } from '../shared/types'

/** Poster frame is taken at this fraction of the take's duration. */
export const POSTER_AT_FRACTION = 0.25
export const POSTER_WIDTH = 640
/** Filmstrip frames per take (strip_0 … strip_7). */
export const STRIP_COUNT = 8
export const STRIP_WIDTH = 240

/* ------------------------------ pure argv ------------------------------- */

/** `ffprobe` argv for a full JSON probe of one file. */
export function probeArgs(mediaPath: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    mediaPath,
  ]
}

/**
 * `ffmpeg` argv for a single JPEG frame grab. `-ss` before `-i` keeps the seek
 * fast (keyframe-accurate is fine for thumbnails); `scale=W:-2` preserves the
 * aspect ratio with an even height, which every JPEG encoder wants.
 */
export function frameGrabArgs(
  mediaPath: string,
  outPath: string,
  atSec: number,
  width: number,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    formatSeconds(atSec),
    '-i',
    mediaPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:-2`,
    '-q:v',
    '3',
    outPath,
  ]
}

/** Seconds -> a stable, locale-free `-ss` value. */
export function formatSeconds(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? sec : 0
  return s.toFixed(3)
}

/**
 * Evenly spaced filmstrip timestamps: each frame sits at the centre of its
 * 1/count slice, so no frame lands on the very first or very last (often
 * black) frame of the take.
 */
export function stripTimestamps(durationSec: number, count = STRIP_COUNT): number[] {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push((dur * (i + 0.5)) / count)
  return out
}

/** Poster timestamp for a take. */
export function posterTimestamp(durationSec: number): number {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  return dur * POSTER_AT_FRACTION
}

/**
 * Parse an ffprobe rate fraction such as `24000/1001` or `25/1`.
 * Returns 0 when the value is missing or degenerate (`0/0`).
 */
export function parseFraction(value: string | undefined): number {
  if (!value) return 0
  const parts = value.split('/')
  const num = Number(parts[0])
  const den = parts.length > 1 ? Number(parts[1]) : 1
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0
  const fps = num / den
  return Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : 0
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  duration?: string
}
interface FfprobeJson {
  streams?: FfprobeStream[]
  format?: { duration?: string }
}

/** Turn raw ffprobe JSON into a {@link ProbeInfo}. Pure — unit-tested. */
export function parseProbeJson(raw: unknown): ProbeInfo {
  const json = (raw ?? {}) as FfprobeJson
  const streams = json.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const fps = parseFraction(video?.r_frame_rate) || parseFraction(video?.avg_frame_rate)
  const duration = Number(json.format?.duration ?? video?.duration ?? 0)
  return {
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
    fps,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    codec: video?.codec_name ?? 'unknown',
  }
}

/* ------------------------------ resolution ------------------------------ */

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await access(p, constants.X_OK)
      return p
    } catch {
      /* keep looking */
    }
  }
  return null
}

async function resolveTool(bin: 'ffmpeg' | 'ffprobe'): Promise<string> {
  const found = await firstExisting([
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `/usr/bin/${bin}`,
  ])
  // Bare name so PATH resolution still gets a chance.
  return found ?? bin
}

export async function ffmpegPath(): Promise<string> {
  return resolveTool('ffmpeg')
}
export async function ffprobePath(): Promise<string> {
  return resolveTool('ffprobe')
}

/* -------------------------------- running ------------------------------- */

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString()
    })
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString()
    })
    child.on('error', (e) =>
      reject(new Error(`${bin} could not be launched: ${(e as Error).message}`)),
    )
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`${bin} exited ${code}${err ? `\n${err.slice(-2000)}` : ''}`))
    })
  })
}

/** Probe a media file into a {@link ProbeInfo}. Throws on ffprobe failure. */
export async function probeMedia(mediaPath: string): Promise<ProbeInfo> {
  const bin = await ffprobePath()
  const stdout = await run(bin, probeArgs(mediaPath))
  try {
    return parseProbeJson(JSON.parse(stdout))
  } catch (e) {
    throw new Error(`ffprobe returned invalid JSON: ${(e as Error).message}`)
  }
}

export interface ThumbResult {
  poster: string
  strips: string[]
}

/**
 * Write `poster.jpg` (640w, at 25% of the duration) plus `strip_0..strip_7.jpg`
 * (240w, evenly spaced) into `outDir`. Individual frame failures are tolerated:
 * a take whose tail is corrupt still gets the frames that did decode.
 */
export async function extractThumbs(
  mediaPath: string,
  outDir: string,
  durationSec: number,
): Promise<ThumbResult> {
  const bin = await ffmpegPath()
  await mkdir(outDir, { recursive: true })

  const poster = join(outDir, 'poster.jpg')
  await run(bin, frameGrabArgs(mediaPath, poster, posterTimestamp(durationSec), POSTER_WIDTH))

  const strips: string[] = []
  const stamps = stripTimestamps(durationSec, STRIP_COUNT)
  for (let i = 0; i < stamps.length; i++) {
    const at = stamps[i] ?? 0
    const out = join(outDir, `strip_${i}.jpg`)
    try {
      await run(bin, frameGrabArgs(mediaPath, out, at, STRIP_WIDTH))
      strips.push(out)
    } catch {
      /* a single unreadable frame must not sink the whole filmstrip */
    }
  }
  return { poster, strips }
}
