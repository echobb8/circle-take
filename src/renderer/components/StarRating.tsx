import type { Rating } from '@shared/types'
import { Icon } from './Icon'

/**
 * Director stars, 0-3 — orthogonal to the gate. The gate says "is this
 * broken"; the stars say "do I like it". Clicking the active star clears it.
 */

export interface StarRatingProps {
  value: Rating
  onChange?: (value: Rating) => void
  size?: number
  className?: string
}

const LEVELS: Rating[] = [1, 2, 3]

export function StarRating({ value, onChange, size = 13, className }: StarRatingProps): JSX.Element {
  return (
    <span
      className={`stars${onChange ? ' is-interactive' : ''}${className ? ` ${className}` : ''}`}
      title={`${value} of 3`}
    >
      {LEVELS.map((level) => (
        <button
          key={level}
          type="button"
          className={`star${value >= level ? ' is-on' : ''}`}
          tabIndex={-1}
          disabled={!onChange}
          onClick={(e) => {
            e.stopPropagation()
            onChange?.(value === level ? 0 : level)
          }}
          aria-label={`Rate ${level}`}
        >
          <Icon name="star" size={size} strokeWidth={1.4} />
        </button>
      ))}
    </span>
  )
}
