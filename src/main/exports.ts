/**
 * Export writers. The document building lives in the pure src/shared builders;
 * this module only resolves the open project, gathers anything that has to
 * come off disk (evidence frames live in the full gate reports), and writes
 * the files. Every writer returns the path it wrote.
 */

import { writeFile } from 'fs/promises'
import { buildFcpxml } from '../shared/fcpxml'
import { buildEdl } from '../shared/edl'
import { buildReshootList } from '../shared/reshoot'
import { buildCsv } from '../shared/csv'
import { getGateReport } from './gate'
import * as project from './project'

function withExt(path: string, ext: string): string {
  return path.toLowerCase().endsWith(ext) ? path : `${path}${ext}`
}

export async function exportFcpxml(outPath: string): Promise<string> {
  const p = project.requireProject()
  const target = withExt(outPath, '.fcpxml')
  await writeFile(target, buildFcpxml(p), 'utf-8')
  return target
}

export async function exportEdl(outPath: string): Promise<string> {
  const p = project.requireProject()
  const target = withExt(outPath, '.edl')
  await writeFile(target, buildEdl(p), 'utf-8')
  return target
}

export async function exportCsv(outPath: string): Promise<string> {
  const p = project.requireProject()
  const target = withExt(outPath, '.csv')
  await writeFile(target, buildCsv(p), 'utf-8')
  return target
}

/**
 * Writes `<name>.md` plus a `<name>.json` sibling. Evidence images are pulled
 * out of the full gate reports (the denormalized GateSummary carries none) so
 * the markdown can link the worst frames of each failing take.
 */
export async function exportReshootList(outPath: string): Promise<string> {
  const p = project.requireProject()
  const mdPath = withExt(outPath, '.md')
  const jsonPath = `${mdPath.slice(0, -'.md'.length)}.json`

  const evidenceByTake: Record<string, string[]> = {}
  for (const take of p.takes) {
    if (take.circled) continue
    const report = await getGateReport(take.id)
    if (!report) continue
    const images: string[] = []
    for (const check of Object.values(report.checks ?? {})) {
      for (const frame of check?.evidence ?? []) {
        if (frame.image && !images.includes(frame.image)) images.push(frame.image)
      }
    }
    if (images.length) evidenceByTake[take.id] = images
  }

  const { md, json } = buildReshootList(p, { evidenceByTake })
  await writeFile(mdPath, md, 'utf-8')
  await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf-8')
  return mdPath
}
