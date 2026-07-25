import { useEffect, useState } from 'react'
import {
  CHECK_IDS,
  CHECK_LABEL,
  toTimecode,
  type CheckId,
  type GateReport,
  type Take,
} from '@shared/types'
import { shotById, takeById, useStore } from '../store'
import { Icon } from '../components/Icon'
import { GateBadge } from '../components/GateBadge'
import { CheckDots } from '../components/CheckDots'
import { Sparkline } from '../components/Sparkline'
import { EvidenceChip } from '../components/EvidenceChip'

/**
 * The gate deep-dive: every series plotted full width with annotated
 * thresholds, every reason spelled out, every worst frame shown large. This is
 * where "why did it fail" gets an answer you can act on — including the exact
 * prompt to re-run.
 */

const VERDICT_COPY: Record<string, string> = {
  pass: 'Within tolerance on every sampled frame.',
  flag: 'Measurable but survivable — judge it on the evidence frames.',
  fail: 'Outside tolerance. This take should not be cut.',
  skip: 'Not applicable to this shot.',
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="btn ghost tiny"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true)
            window.setTimeout(() => setDone(false), 1400)
          },
          () => undefined,
        )
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={12} />
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function CheckSection({
  id,
  take,
  report,
}: {
  id: CheckId
  take: Take
  report: GateReport
}): JSX.Element | null {
  const full = report.checks[id]
  if (!full) return null
  const fps = take.probe?.fps ?? 24

  return (
    <section className={`report-check v-${full.verdict}`}>
      <header className="report-check-head">
        <span className={`check-dot v-${full.verdict}`} />
        <h3 className="report-check-title">{CHECK_LABEL[id]}</h3>
        <span className={`check-verdict caps v-${full.verdict}`}>{full.verdict}</span>
        {full.verdict !== 'skip' && <span className="report-check-score mono">{full.score}</span>}
        <span className="grow" />
        <span className="report-check-note">{VERDICT_COPY[full.verdict]}</span>
      </header>

      <p className="report-reason">{full.reason}</p>

      {full.series && full.series.length > 1 && (
        <div className="report-plot">
          <Sparkline
            series={full.series}
            threshold={full.threshold}
            verdict={full.verdict}
            width={980}
            height={64}
            axis
          />
        </div>
      )}

      {full.evidence && full.evidence.length > 0 && (
        <div className="evi-grid">
          {full.evidence.map((e) => (
            <EvidenceChip
              key={`${e.frame}-${e.image}`}
              takeId={take.id}
              frame={e}
              verdict={full.verdict}
              fps={fps}
              size="lg"
            />
          ))}
        </div>
      )}
    </section>
  )
}

export function Report({ takeId }: { takeId: string }): JSX.Element | null {
  const project = useStore((s) => s.project)
  const openReport = useStore((s) => s.openReport)
  const loadReport = useStore((s) => s.loadReport)
  const report = useStore((s) => s.reports[takeId])

  const take = takeById(project, takeId)
  const shot = shotById(project, take?.shotId ?? null)

  useEffect(() => {
    if (report === undefined) void loadReport(takeId)
  }, [report, loadReport, takeId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        openReport(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [openReport])

  if (!take) return null
  const fps = take.probe?.fps ?? 24

  return (
    <div className="report-overlay">
      <header className="report-head">
        <div className="report-title-wrap">
          <span className="caps report-kicker">Gate report</span>
          <h1 className="report-title">
            {shot?.name ?? 'Unassigned'}
            <span className="report-title-sep">/</span>
            <span className="mono report-file">{take.fileName}</span>
          </h1>
          {shot?.description && <p className="report-shot-desc">{shot.description}</p>}
        </div>
        <div className="report-head-right">
          <GateBadge gate={take.gate} size="lg" />
          <CheckDots checks={take.gate?.checks} size={7} labelled />
          <button type="button" className="icon-btn" onClick={() => openReport(null)} title="Close (Esc)">
            <Icon name="close" size={18} />
          </button>
        </div>
      </header>

      <div className="report-body scroll-y">
        <section className="report-prov">
          <div className="prov-grid">
            <div className="prov-cell">
              <span className="caps prov-key">Generator</span>
              <span className="prov-val">{take.provenance.generator ?? '—'}</span>
            </div>
            <div className="prov-cell">
              <span className="caps prov-key">Model</span>
              <span className="prov-val mono">{take.provenance.model ?? '—'}</span>
            </div>
            <div className="prov-cell">
              <span className="caps prov-key">Seed</span>
              <span className="prov-val mono">{take.provenance.seed ?? '—'}</span>
            </div>
            <div className="prov-cell">
              <span className="caps prov-key">Duration</span>
              <span className="prov-val mono">
                {take.probe ? toTimecode(take.probe.durationSec, fps) : '—'}
              </span>
            </div>
            <div className="prov-cell">
              <span className="caps prov-key">Format</span>
              <span className="prov-val mono">
                {take.probe ? `${take.probe.width}×${take.probe.height} · ${take.probe.fps}fps · ${take.probe.codec}` : '—'}
              </span>
            </div>
            <div className="prov-cell">
              <span className="caps prov-key">Select window</span>
              <span className="prov-val mono">
                {take.inSec != null || take.outSec != null
                  ? `${(take.inSec ?? 0).toFixed(1)}s – ${(take.outSec ?? take.probe?.durationSec ?? 0).toFixed(1)}s`
                  : 'full clip'}
              </span>
            </div>
          </div>

          {take.provenance.prompt && (
            <div className="prompt-panel">
              <header className="prompt-panel-head">
                <span className="caps">Prompt</span>
                <span className="grow" />
                <CopyButton text={take.provenance.prompt} />
              </header>
              <p className="mono prompt-body">{take.provenance.prompt}</p>
            </div>
          )}

          {report?.suggestedWindow && (
            <p className="report-suggestion">
              <Icon name="bracket" size={13} />
              <span className="caps">Suggested window</span>
              <span className="mono">
                {report.suggestedWindow.inSec.toFixed(1)}s – {report.suggestedWindow.outSec.toFixed(1)}s
              </span>
              <span className="report-suggestion-reason">{report.suggestedWindow.reason}</span>
            </p>
          )}
        </section>

        {report ? (
          <>
            {CHECK_IDS.map((id) => (
              <CheckSection key={id} id={id} take={take} report={report} />
            ))}

            <footer className="report-foot">
              <span className="caps">Engine</span>
              <span className="mono">circletake-gate {report.engineVersion}</span>
              <span className="foot-sep" />
              {Object.entries(report.modelVersions).map(([k, v]) => (
                <span key={k} className="mono foot-model">
                  {k} {v}
                </span>
              ))}
              <span className="grow" />
              <span className="caps">Ran</span>
              <span className="mono">{new Date(report.ranAt).toLocaleString()}</span>
            </footer>
          </>
        ) : (
          <p className="report-loading caps">Loading report…</p>
        )}
      </div>
    </div>
  )
}
