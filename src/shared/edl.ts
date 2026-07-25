/**
 * CMX3600 EDL export — pure builder, no Node/DOM/Electron.
 *
 * One video event per circled take, in shot order. Source timecode is
 * 00:00:00:00-based at the head of the media file, so a take's select window
 * (`inSec`/`outSec`) becomes its source in/out; takes with no window use the
 * whole clip. Record timecode accumulates across events. All arithmetic is done
 * in whole frames so the record TC never drifts.
 */

import type { Project } from './types'
import { circledTakesInOrder, framesFor, isDropFrame, takeWindow, DEFAULT_FPS } from './fcpxml'

export interface EdlOptions {
  /** TITLE: line. Defaults to the project name (uppercased). */
  title?: string
  /** Timecode rate. Defaults to project settings, then 24. */
  fps?: number
  /** Reel/tape id, max 8 chars. Defaults to `AX` (file-based source). */
  reel?: string
  /** Record start timecode in frames. Defaults to 0 (00:00:00:00). */
  recordStartFrames?: number
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * Whole frames -> `HH:MM:SS:FF` (non-drop) or `HH:MM:SS;FF` (drop frame).
 * Hours wrap at 24.
 *
 * Drop-frame is a *labelling* scheme, not dropped pictures: at 29.97 two frame
 * numbers are skipped at the top of every minute except every tenth minute, so
 * the clock tracks wall time. 23.976 is never drop-frame.
 */
export function framesToTimecode(frames: number, fps: number): string {
  const rate = fps > 0 ? fps : DEFAULT_FPS
  const nominal = Math.max(1, Math.round(rate))
  let count = Math.max(0, Math.round(frames))
  const drop = isDropFrame(rate)

  if (drop) {
    const dropPerMinute = Math.round(nominal * 0.0666666) // 2 @ 30, 4 @ 60
    const framesPer10Min = Math.round(nominal * 600) - dropPerMinute * 9
    const framesPerMin = nominal * 60 - dropPerMinute
    const tenMinBlocks = Math.floor(count / framesPer10Min)
    const remainder = count % framesPer10Min
    count += dropPerMinute * 9 * tenMinBlocks
    if (remainder > dropPerMinute) {
      count += dropPerMinute * Math.floor((remainder - dropPerMinute) / framesPerMin)
    }
  }

  const ff = count % nominal
  const totalSec = Math.floor(count / nominal)
  const ss = totalSec % 60
  const mm = Math.floor(totalSec / 60) % 60
  const hh = Math.floor(totalSec / 3600) % 24
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${drop ? ';' : ':'}${pad2(ff)}`
}

/**
 * Format one CMX3600 event line.
 * Columns: `NNN  RRRRRRRR CCCCC C        SRCIN SRCOUT RECIN RECOUT`
 */
export function edlEventLine(
  eventNumber: number,
  reel: string,
  srcIn: string,
  srcOut: string,
  recIn: string,
  recOut: string,
): string {
  const num = String(eventNumber).padStart(3, '0')
  const tape = reel.slice(0, 8).padEnd(8, ' ')
  const channel = 'V'.padEnd(6, ' ')
  const transition = 'C'.padEnd(9, ' ')
  return `${num}  ${tape} ${channel}${transition}${srcIn} ${srcOut} ${recIn} ${recOut}`
}

/** Sanitize a project name into an EDL TITLE value. */
export function edlTitle(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 70) || 'UNTITLED'
  )
}

/** Build the full CMX3600 EDL text for the project's circled takes. */
export function buildEdl(project: Project, opts: EdlOptions = {}): string {
  const fps = opts.fps ?? project.settings.expected?.fps ?? DEFAULT_FPS
  const reel = opts.reel ?? 'AX'
  const lines: string[] = [
    `TITLE: ${edlTitle(opts.title ?? project.name)}`,
    isDropFrame(fps) ? 'FCM: DROP FRAME' : 'FCM: NON-DROP FRAME',
    '',
  ]

  let record = Math.max(0, Math.round(opts.recordStartFrames ?? 0))
  let event = 1

  for (const sel of circledTakesInOrder(project)) {
    const win = takeWindow(sel.take, sel.shot, project)
    const srcIn = framesFor(win.inSec, fps)
    const frames = Math.max(1, framesFor(win.lengthSec, fps))
    lines.push(
      edlEventLine(
        event,
        reel,
        framesToTimecode(srcIn, fps),
        framesToTimecode(srcIn + frames, fps),
        framesToTimecode(record, fps),
        framesToTimecode(record + frames, fps),
      ),
    )
    lines.push(`* FROM CLIP NAME: ${sel.take.fileName}`)
    if (sel.shot) lines.push(`* SHOT: ${sel.shot.name}`)
    lines.push('')
    record += frames
    event += 1
  }

  return `${lines.join('\n')}\n`
}
