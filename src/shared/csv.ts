/**
 * Take-inventory CSV export — pure builder, no Node/DOM/Electron.
 *
 * Every take in the project, in shot order, with provenance, probe, select
 * window, gate scores per check, cost from the project rate table, circled flag
 * and director rating. RFC 4180 quoting with CRLF line endings so it opens
 * cleanly in Excel/Numbers/Sheets.
 */

import { CHECK_IDS, CHECK_LABEL, takeCost } from './types'
import type { Project, Shot, Take } from './types'

const EOL = '\r\n'

export const CSV_COLUMNS = [
  'Shot',
  'Shot Order',
  'File',
  'Media Path',
  'Generator',
  'Model',
  'Seed',
  'Duration (s)',
  'In (s)',
  'Out (s)',
  'Window (s)',
  'FPS',
  'Resolution',
  'Gate Status',
  'Overall',
  ...CHECK_IDS.map((id) => CHECK_LABEL[id]),
  'Cost',
  'Circled',
  'Rating',
] as const

/** RFC 4180: quote when the value holds a comma, quote, CR or LF. */
export function csvEscape(value: string): string {
  if (!/[",\r\n]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

/** Join one row of already-stringified cells. */
export function csvRow(cells: readonly string[]): string {
  return cells.map(csvEscape).join(',')
}

const sec = (v: number): string => v.toFixed(3)

function takeRow(take: Take, shot: Shot | null, rates?: Record<string, number>): string[] {
  const probe = take.probe
  const gate = take.gate
  const checks = CHECK_IDS.map((id) => {
    const c = gate?.checks[id]
    return c ? String(c.score) : ''
  })
  const hasIn = typeof take.inSec === 'number'
  const hasOut = typeof take.outSec === 'number'
  const full = probe?.durationSec ?? 0
  const winIn = hasIn ? (take.inSec as number) : 0
  const winOut = hasOut ? (take.outSec as number) : full
  const cost = takeCost(take, rates)

  return [
    shot ? shot.name : 'UNASSIGNED',
    shot ? String(shot.order) : '',
    take.fileName,
    take.mediaPath,
    take.provenance.generator ?? '',
    take.provenance.model ?? '',
    take.provenance.seed ?? '',
    probe ? sec(probe.durationSec) : '',
    hasIn ? sec(winIn) : '',
    hasOut ? sec(winOut) : '',
    hasIn || hasOut ? sec(Math.max(0, winOut - winIn)) : '',
    probe ? String(probe.fps) : '',
    probe ? `${probe.width}x${probe.height}` : '',
    gate ? gate.status : '',
    gate ? String(gate.overall) : '',
    ...checks,
    cost === null ? '' : cost.toFixed(2),
    take.circled ? 'yes' : 'no',
    String(take.rating),
  ]
}

/** Build the full take-inventory CSV for the project. */
export function buildCsv(project: Project): string {
  const shotById = new Map(project.shots.map((s) => [s.id, s]))
  const orderOf = (take: Take): number => shotById.get(take.shotId)?.order ?? Number.MAX_SAFE_INTEGER
  const rates = project.settings.modelRates

  const takes = [...project.takes].sort((a, b) => {
    const d = orderOf(a) - orderOf(b)
    if (d !== 0) return d
    return a.fileName.localeCompare(b.fileName)
  })

  const lines = [csvRow(CSV_COLUMNS)]
  for (const take of takes) {
    lines.push(csvRow(takeRow(take, shotById.get(take.shotId) ?? null, rates)))
  }
  return `${lines.join(EOL)}${EOL}`
}
