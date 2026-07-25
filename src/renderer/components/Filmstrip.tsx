import { media, STRIP_COUNT } from '../media'

/**
 * A take rendered as film: N frame thumbnails butted edge-to-edge between
 * sprocket-hole borders. Reads as "footage" before you've read a single word.
 */

export interface FilmstripProps {
  takeId: string
  count?: number
  /** Highlight one frame index (e.g. the one nearest the playhead). */
  activeIndex?: number
  onPick?: (index: number, fraction: number) => void
  className?: string
}

export function Filmstrip({
  takeId,
  count = STRIP_COUNT,
  activeIndex,
  onPick,
  className,
}: FilmstripProps): JSX.Element {
  const r = media()
  return (
    <div className={`filmstrip${className ? ` ${className}` : ''}`}>
      <span className="sprockets sprockets-top" aria-hidden="true" />
      <div className="filmstrip-frames">
        {Array.from({ length: count }, (_, i) => (
          <button
            key={i}
            type="button"
            className={`strip-frame${activeIndex === i ? ' is-active' : ''}`}
            onClick={onPick ? () => onPick(i, count > 1 ? i / (count - 1) : 0) : undefined}
            tabIndex={-1}
            aria-label={`Frame ${i + 1}`}
          >
            <img src={r.strip(takeId, i)} alt="" draggable={false} />
          </button>
        ))}
      </div>
      <span className="sprockets sprockets-bottom" aria-hidden="true" />
    </div>
  )
}
