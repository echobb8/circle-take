import { useMemo, useState } from 'react'
import { diffSummary, diffWords } from '@shared/diff'
import type { Take } from '@shared/types'
import { Icon } from './Icon'

/**
 * "What did I change between take 2 and take 3?"
 *
 * Word-level prompt diff between the A and B takes in compare mode, plus the
 * non-prompt recipe deltas (generator / model / seed). Removed words are struck
 * through in the fail tint, added words are lifted in the pass tint — so the
 * edit that produced the better take is readable at a glance.
 */

export interface RecipeDiffProps {
  a: Take
  b: Take
}

interface DeltaRowProps {
  label: string
  from?: string
  to?: string
  mono?: boolean
}

function DeltaRow({ label, from, to, mono = true }: DeltaRowProps): JSX.Element | null {
  if (!from && !to) return null
  const same = from === to
  return (
    <div className={`delta-row${same ? ' is-same' : ''}`}>
      <span className="delta-label caps">{label}</span>
      <span className={`delta-val${mono ? ' mono' : ''}`}>{from ?? '—'}</span>
      {same ? (
        <span className="delta-arrow is-same">=</span>
      ) : (
        <>
          <span className="delta-arrow">
            <Icon name="chevronRight" size={12} />
          </span>
          <span className={`delta-val is-to${mono ? ' mono' : ''}`}>{to ?? '—'}</span>
        </>
      )}
    </div>
  )
}

export function RecipeDiff({ a, b }: RecipeDiffProps): JSX.Element {
  const [open, setOpen] = useState(true)
  const promptA = a.provenance.prompt ?? ''
  const promptB = b.provenance.prompt ?? ''
  const segments = useMemo(() => diffWords(promptA, promptB), [promptA, promptB])
  const summary = useMemo(() => diffSummary(segments), [segments])

  const recipeChanged =
    a.provenance.model !== b.provenance.model ||
    a.provenance.seed !== b.provenance.seed ||
    a.provenance.generator !== b.provenance.generator

  return (
    <section className={`recipe-diff${open ? ' is-open' : ''}`}>
      <header className="recipe-head" onClick={() => setOpen((v) => !v)}>
        <span className="recipe-caret">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        </span>
        <h4 className="caps recipe-title">Recipe diff</h4>
        <span className="recipe-ab mono">
          <span className="ab-tag is-a">A</span>
          {a.fileName}
          <Icon name="chevronRight" size={11} />
          <span className="ab-tag is-b">B</span>
          {b.fileName}
        </span>
        <span className={`chip chip-diff${summary === 'identical prompt' ? ' is-same' : ''}`}>
          {summary}
        </span>
        {recipeChanged && <span className="chip chip-diff is-recipe">recipe changed</span>}
      </header>

      {open && (
        <div className="recipe-body">
          <div className="recipe-deltas">
            <DeltaRow label="generator" from={a.provenance.generator} to={b.provenance.generator} mono={false} />
            <DeltaRow label="model" from={a.provenance.model} to={b.provenance.model} />
            <DeltaRow label="seed" from={a.provenance.seed} to={b.provenance.seed} />
          </div>

          {promptA || promptB ? (
            <p className="prompt-diff mono">
              {segments.map((s, i) => (
                <span key={i} className={`seg seg-${s.kind}`}>
                  {s.text}
                </span>
              ))}
            </p>
          ) : (
            <p className="recipe-empty">No prompt recorded on either take.</p>
          )}

          <div className="recipe-legend caps">
            <span className="legend-item">
              <span className="legend-swatch seg-removed" /> removed from A
            </span>
            <span className="legend-item">
              <span className="legend-swatch seg-added" /> added in B
            </span>
          </div>
        </div>
      )}
    </section>
  )
}
