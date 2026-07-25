import { useEffect, useMemo, useState } from 'react'
import { CHECK_IDS, CHECK_LABEL, toTimecode, type Take } from '@shared/types'
import {
  circledInCutOrder,
  reshootShots,
  selectsRuntime,
  spendForProject,
  spendForShot,
  takeCutDuration,
  takeWindow,
  useStore,
} from '../store'
import { media } from '../media'
import { Icon } from '../components/Icon'
import { GateBadge } from '../components/GateBadge'
import { formatUsd } from '../components/ProvenanceChips'
import { EmptyState } from '../components/EmptyState'

/**
 * Print It — two printed reports side by side.
 *
 * Left: what goes to the NLE. Right: what has to be shot again, with the exact
 * recipe and the evidence for why. A director should be able to work straight
 * off this screen without opening anything else.
 */

const DEFAULT_FPS = 24

function secs(v: number): string {
  return `${v.toFixed(1)}s`
}

// ---------------------------------------------------------------------------
// Selects
// ---------------------------------------------------------------------------

function Selects(): JSX.Element {
  const project = useStore((s) => s.project)
  const exportAs = useStore((s) => s.exportAs)
  const openShot = useStore((s) => s.openShot)

  const rows = useMemo(() => circledInCutOrder(project), [project])
  const runtime = useMemo(() => selectsRuntime(project), [project])
  const totals = useMemo(() => spendForProject(project), [project])
  const fps = project?.settings.expected?.fps ?? DEFAULT_FPS

  return (
    <section className="print-pane">
      <header className="print-head">
        <h2 className="caps print-title">Print selects</h2>
        <span className="mono section-count">{rows.length}</span>
        <span className="grow" />
        <span className="mono print-runtime" title="Total runtime of the circled selects">
          {toTimecode(runtime, fps)}
        </span>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          title="Nothing circled yet"
          hint="Circle the winning take in each shot (press C in the Village) and it lands here."
        />
      ) : (
        <div className="ptable-wrap scroll-y">
          <table className="ptable">
            <thead>
              <tr>
                <th className="caps">Shot</th>
                <th className="caps">Take</th>
                <th className="caps num">Window</th>
                <th className="caps num">Dur</th>
                <th className="caps num">Gate</th>
                <th className="caps num">Shot spend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ shot, take }) => {
                const spend = spendForShot(project, shot.id)
                const win = takeWindow(take)
                return (
                  <tr key={take.id} onClick={() => openShot(shot.id)}>
                    <td className="cell-shot">{shot.name}</td>
                    <td className="mono cell-file" title={take.mediaPath}>
                      {take.fileName}
                    </td>
                    <td className="mono num cell-dim">
                      {win.explicit ? `${win.inSec.toFixed(1)}–${win.outSec.toFixed(1)}` : 'full'}
                    </td>
                    <td className="mono num">{secs(takeCutDuration(take))}</td>
                    <td className="num">
                      <GateBadge gate={take.gate} size="sm" />
                    </td>
                    <td className="mono num">{formatUsd(spend.spend)}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="caps">Total</td>
                <td className="mono cell-dim">
                  {rows.length} select{rows.length === 1 ? '' : 's'}
                </td>
                <td />
                <td className="mono num">{secs(runtime)}</td>
                <td className="mono num cell-dim">
                  {Math.round(totals.hitRate * 100)}% hit
                </td>
                <td className="mono num">{formatUsd(totals.spend)}</td>
              </tr>
              <tr className="foot-note-row">
                <td colSpan={6} className="mono cell-dim">
                  {totals.costPerUsableSec != null
                    ? `${formatUsd(totals.costPerUsableSec)} per usable second · ${totals.usable} of ${totals.takes} takes usable`
                    : `${totals.takes} takes · no usable footage yet`}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="print-summary">
          <div className="psum-card">
            <span className="mono psum-num">{toTimecode(runtime, fps)}</span>
            <span className="caps psum-label">Total runtime</span>
          </div>
          <div className="psum-card">
            <span className="mono psum-num">
              {rows.length}/{project?.shots.length ?? 0}
            </span>
            <span className="caps psum-label">Shots circled</span>
          </div>
          <div className="psum-card">
            <span className="mono psum-num">{formatUsd(totals.spend)}</span>
            <span className="caps psum-label">Total spend</span>
          </div>
          <div className="psum-card">
            <span className="mono psum-num">{Math.round(totals.hitRate * 100)}%</span>
            <span className="caps psum-label">Hit rate</span>
          </div>
          <div className="psum-card">
            <span className="mono psum-num">
              {totals.costPerUsableSec != null ? formatUsd(totals.costPerUsableSec) : '—'}
            </span>
            <span className="caps psum-label">Per usable sec</span>
          </div>
        </div>
      )}

      <footer className="print-actions">
        <button type="button" className="btn primary" onClick={() => void exportAs('fcpxml')}>
          <Icon name="download" size={14} />
          FCPXML
        </button>
        <button type="button" className="btn ghost" onClick={() => void exportAs('edl')}>
          <Icon name="download" size={14} />
          EDL
        </button>
        <button type="button" className="btn ghost" onClick={() => void exportAs('csv')}>
          <Icon name="download" size={14} />
          CSV
        </button>
      </footer>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Reshoots
// ---------------------------------------------------------------------------

function ReshootItem({ shot, best }: { shot: { id: string; name: string; description?: string }; best: Take | null }): JSX.Element {
  const report = useStore((s) => (best ? s.reports[best.id] : undefined))
  const openShot = useStore((s) => s.openShot)
  const [promptOpen, setPromptOpen] = useState(false)
  const r = media()

  const reasons = best?.gate
    ? CHECK_IDS.map((id) => ({ id, c: best.gate?.checks[id] })).filter(
        (x) => x.c && (x.c.verdict === 'fail' || x.c.verdict === 'flag'),
      )
    : []

  const evidence = report
    ? CHECK_IDS.flatMap((id) => (report.checks[id]?.evidence ?? []).map((e) => ({ id, e }))).slice(0, 4)
    : []

  return (
    <article className="reshoot-item">
      <header className="reshoot-head" onClick={() => openShot(shot.id)}>
        <h3 className="reshoot-shot">{shot.name}</h3>
        {best?.gate && <GateBadge gate={best.gate} size="sm" />}
        <span className="grow" />
        <span className="mono reshoot-count">
          {best ? best.fileName : 'no takes'}
        </span>
      </header>

      {shot.description && <p className="reshoot-desc">{shot.description}</p>}

      {reasons.length > 0 ? (
        <ul className="reshoot-reasons">
          {reasons.map(({ id, c }) => (
            <li key={id} className={`v-${c?.verdict ?? 'flag'}`}>
              <span className={`check-dot v-${c?.verdict ?? 'flag'}`} />
              <span className="caps reshoot-check">{CHECK_LABEL[id]}</span>
              <span className="reshoot-reason">{c?.reason}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="reshoot-reason is-empty">
          {best ? 'Gate has not run on this shot yet.' : 'No footage generated for this slot yet.'}
        </p>
      )}

      {evidence.length > 0 && best && (
        <div className="reshoot-evidence">
          {evidence.map(({ id, e }) => (
            <span key={`${id}-${e.frame}`} className="reshoot-thumb" title={`${CHECK_LABEL[id]} — ${e.caption}`}>
              <img src={r.evidence(best.id, e.image)} alt="" draggable={false} />
              <span className="mono reshoot-frame">f{e.frame}</span>
            </span>
          ))}
        </div>
      )}

      {best && (
        <div className="reshoot-recipe">
          <div className="reshoot-chips">
            {best.provenance.generator && <span className="chip chip-gen">{best.provenance.generator}</span>}
            {best.provenance.model && <span className="chip chip-model mono">{best.provenance.model}</span>}
            {best.provenance.seed && (
              <span className="chip chip-seed mono">
                <span className="chip-key caps">seed</span>
                {best.provenance.seed}
              </span>
            )}
          </div>
          {best.provenance.prompt && (
            <>
              <button type="button" className="disclose caps" onClick={() => setPromptOpen((v) => !v)}>
                <Icon name={promptOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                Prompt
              </button>
              {promptOpen && <p className="mono reshoot-prompt">{best.provenance.prompt}</p>}
            </>
          )}
        </div>
      )}
    </article>
  )
}

function Reshoots(): JSX.Element {
  const project = useStore((s) => s.project)
  const exportAs = useStore((s) => s.exportAs)
  const loadReport = useStore((s) => s.loadReport)
  const reports = useStore((s) => s.reports)

  const items = useMemo(() => reshootShots(project), [project])

  // Pull the reports for the best-so-far takes so the evidence strips fill in.
  useEffect(() => {
    for (const { best } of items) {
      if (best && reports[best.id] === undefined) void loadReport(best.id)
    }
  }, [items, reports, loadReport])

  return (
    <section className="print-pane">
      <header className="print-head">
        <h2 className="caps print-title">Reshoot list</h2>
        <span className="mono section-count">{items.length}</span>
        <span className="grow" />
        <span className="mono print-runtime">
          {items.filter((i) => i.best).length} with footage
        </span>
      </header>

      {items.length === 0 ? (
        <EmptyState size="sm" title="Nothing to reshoot" hint="Every shot has a circled or passing take." />
      ) : (
        <div className="reshoot-list scroll-y">
          {items.map(({ shot, best }) => (
            <ReshootItem key={shot.id} shot={shot} best={best} />
          ))}
        </div>
      )}

      <footer className="print-actions">
        <button type="button" className="btn primary" onClick={() => void exportAs('reshoot')}>
          <Icon name="download" size={14} />
          Export reshoot list (.md)
        </button>
      </footer>
    </section>
  )
}

export function Print(): JSX.Element {
  return (
    <div className="print-cols">
      <Selects />
      <Reshoots />
    </div>
  )
}
