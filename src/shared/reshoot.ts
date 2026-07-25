/**
 * Reshoot list export — pure builder, no Node/DOM/Electron.
 *
 * "What still needs another pass, and exactly how to re-run it." A shot lands
 * on the list when it has no circled take AND either has no takes at all or its
 * best take is only flagged / failing. Each entry carries the per-check reasons
 * from the best take plus the full prompt, seed, model and generator so the
 * take can be regenerated without hunting through the UI.
 */

import { CHECK_IDS, CHECK_LABEL } from './types'
import type { CheckId, Project, Shot, Take, Verdict } from './types'

export interface ReshootReason {
  check: CheckId
  label: string
  verdict: Verdict
  score: number
  reason: string
}

export interface ReshootEntry {
  shotId: string
  shotName: string
  description?: string
  /** How many takes have been ingested for this shot. */
  takesTried: number
  bestTakeId?: string
  bestTakeFile?: string
  bestOverall?: number
  bestStatus?: string
  /** Failing/flagged checks on the best take, worst score first. */
  reasons: ReshootReason[]
  generator?: string
  model?: string
  seed?: string
  /** The FULL prompt of the best take — this is what gets re-run. */
  prompt?: string
  /** Project-relative evidence image paths (evidence/<takeId>/…). */
  evidence: string[]
}

export interface ReshootList {
  project: string
  generatedAt: string
  shotsTotal: number
  shotsNeedingReshoot: number
  entries: ReshootEntry[]
}

export interface ReshootOptions {
  /** ISO timestamp for the header. Injectable so tests stay deterministic. */
  now?: string
  /**
   * Project-relative evidence image paths per take id, harvested from the full
   * gate reports by the caller (GateSummary itself carries no evidence).
   */
  evidenceByTake?: Record<string, string[]>
}

/** Best take for a shot: highest gate score, ungated takes rank last. */
export function bestTakeForShot(project: Project, shotId: string): Take | null {
  let best: Take | null = null
  let bestScore = -1
  for (const take of project.takes) {
    if (take.shotId !== shotId) continue
    const score = take.gate ? take.gate.overall : -1
    if (score > bestScore) {
      best = take
      bestScore = score
    } else if (best === null) {
      best = take
      bestScore = score
    }
  }
  return best
}

/** True when the shot still owes the production a take. */
export function shotNeedsReshoot(project: Project, shot: Shot): boolean {
  const takes = project.takes.filter((t) => t.shotId === shot.id)
  if (takes.some((t) => t.circled)) return false
  if (takes.length === 0) return true
  const best = bestTakeForShot(project, shot.id)
  if (!best || !best.gate) return true
  return best.gate.status !== 'pass'
}

function reasonsFor(take: Take | null): ReshootReason[] {
  if (!take?.gate) return []
  const out: ReshootReason[] = []
  for (const id of CHECK_IDS) {
    const check = take.gate.checks[id]
    if (!check) continue
    if (check.verdict !== 'flag' && check.verdict !== 'fail') continue
    out.push({
      check: id,
      label: CHECK_LABEL[id],
      verdict: check.verdict,
      score: check.score,
      reason: check.reason,
    })
  }
  return out.sort((a, b) => a.score - b.score)
}

/** Build both the machine-readable list and the markdown report. */
export function buildReshootList(
  project: Project,
  opts: ReshootOptions = {},
): { md: string; json: ReshootList } {
  const generatedAt = opts.now ?? new Date().toISOString()
  const evidenceByTake = opts.evidenceByTake ?? {}
  const shots = [...project.shots].sort((a, b) => a.order - b.order)

  const entries: ReshootEntry[] = []
  for (const shot of shots) {
    if (!shotNeedsReshoot(project, shot)) continue
    const takes = project.takes.filter((t) => t.shotId === shot.id)
    const best = bestTakeForShot(project, shot.id)
    const entry: ReshootEntry = {
      shotId: shot.id,
      shotName: shot.name,
      takesTried: takes.length,
      reasons: reasonsFor(best),
      evidence: best ? (evidenceByTake[best.id] ?? []) : [],
    }
    if (shot.description) entry.description = shot.description
    if (best) {
      entry.bestTakeId = best.id
      entry.bestTakeFile = best.fileName
      if (best.gate) {
        entry.bestOverall = best.gate.overall
        entry.bestStatus = best.gate.status
      }
      if (best.provenance.generator) entry.generator = best.provenance.generator
      if (best.provenance.model) entry.model = best.provenance.model
      if (best.provenance.seed) entry.seed = best.provenance.seed
      if (best.provenance.prompt) entry.prompt = best.provenance.prompt
    }
    entries.push(entry)
  }

  const json: ReshootList = {
    project: project.name,
    generatedAt,
    shotsTotal: project.shots.length,
    shotsNeedingReshoot: entries.length,
    entries,
  }
  return { md: renderMarkdown(json), json }
}

function renderMarkdown(list: ReshootList): string {
  const out: string[] = []
  out.push(`# Reshoot list — ${list.project}`)
  out.push('')
  out.push(
    list.shotsNeedingReshoot === 0
      ? `Every shot has a circled take. Nothing to reshoot.`
      : `${list.shotsNeedingReshoot} of ${list.shotsTotal} shots still need another pass.`,
  )
  out.push('')
  out.push(`_Generated ${list.generatedAt}_`)
  out.push('')

  for (const e of list.entries) {
    out.push(`## ${e.shotName}${e.description ? ` — ${e.description}` : ''}`)
    out.push('')
    out.push(`- Takes tried: **${e.takesTried}**`)
    if (e.bestTakeFile) {
      const score = typeof e.bestOverall === 'number' ? `${e.bestOverall}` : 'not gated'
      out.push(`- Best take: \`${e.bestTakeFile}\` — gate ${score}${e.bestStatus ? ` (${e.bestStatus})` : ''}`)
    } else {
      out.push('- Best take: _none — no takes ingested yet_')
    }

    if (e.reasons.length) {
      out.push('- Why it did not make the cut:')
      for (const r of e.reasons) {
        out.push(`  - **${r.label}** (${r.verdict}, ${r.score}) — ${r.reason}`)
      }
    }

    const prov = [
      e.generator ? `Generator: ${e.generator}` : null,
      e.model ? `Model: \`${e.model}\`` : null,
      e.seed ? `Seed: \`${e.seed}\`` : null,
    ].filter((v): v is string => v !== null)
    if (prov.length) out.push(`- ${prov.join(' · ')}`)

    if (e.prompt) {
      out.push('- Prompt:')
      out.push('')
      out.push('```text')
      out.push(e.prompt)
      out.push('```')
    }

    if (e.evidence.length) {
      out.push('- Evidence:')
      for (const img of e.evidence) out.push(`  - ![evidence](${img})`)
    }
    out.push('')
  }

  return `${out.join('\n')}\n`
}
