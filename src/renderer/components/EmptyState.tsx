import type { ReactNode } from 'react'

/**
 * The one place gradients are allowed (design.md): a single radial vignette
 * behind the circle motif.
 */

export interface EmptyStateProps {
  title: string
  hint?: string
  children?: ReactNode
  mark?: ReactNode
  size?: 'sm' | 'lg'
}

export function EmptyState({ title, hint, children, mark, size = 'lg' }: EmptyStateProps): JSX.Element {
  return (
    <div className={`empty-state size-${size}`}>
      <div className="empty-vignette" aria-hidden="true" />
      {mark && <div className="empty-mark">{mark}</div>}
      <h3 className="empty-title">{title}</h3>
      {hint && <p className="empty-hint">{hint}</p>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  )
}
