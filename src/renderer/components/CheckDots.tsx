import { CHECK_IDS, CHECK_LABEL, type CheckId, type CheckSummary } from '@shared/types'

/**
 * The five-dot verdict row (identity / temporal / anatomy / continuity /
 * conformance) that sits under every gate badge. Reading five dots is faster
 * than reading five words — that's the whole point.
 */

export interface CheckDotsProps {
  checks?: Partial<Record<CheckId, CheckSummary>>
  size?: number
  /** Show the initial letter under each dot (used in the wide gate panel). */
  labelled?: boolean
  onSelect?: (id: CheckId) => void
  activeId?: CheckId | null
}

export function CheckDots({
  checks,
  size = 6,
  labelled = false,
  onSelect,
  activeId,
}: CheckDotsProps): JSX.Element {
  return (
    <span className={`check-dots${labelled ? ' is-labelled' : ''}`}>
      {CHECK_IDS.map((id) => {
        const c = checks?.[id]
        const verdict = c?.verdict ?? 'skip'
        const title = c
          ? `${CHECK_LABEL[id]} — ${verdict.toUpperCase()} ${verdict === 'skip' ? '' : `(${c.score})`}`.trim()
          : `${CHECK_LABEL[id]} — not run`
        const interactive = Boolean(onSelect)
        return (
          <span
            key={id}
            className={`check-dot-wrap${activeId === id ? ' is-active' : ''}${interactive ? ' is-clickable' : ''}`}
            title={title}
            onClick={interactive ? () => onSelect?.(id) : undefined}
          >
            <span
              className={`check-dot v-${c ? verdict : 'none'}`}
              style={{ width: size, height: size }}
            />
            {labelled && <span className="check-dot-letter mono">{CHECK_LABEL[id].charAt(0)}</span>}
          </span>
        )
      })}
    </span>
  )
}
