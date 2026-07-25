import { useEffect, useRef, useState } from 'react'
import type { GateStatus, GateSummary } from '@shared/types'

/**
 * The gate verdict pill: mono score + verdict dot.
 * `pending` / `running` render as a pulsing outline with no number.
 * `countUp` animates the digits over 300ms when a fresh result lands.
 */

export type BadgeSize = 'sm' | 'md' | 'lg'

export interface GateBadgeProps {
  gate?: GateSummary
  size?: BadgeSize
  countUp?: boolean
  /** Progress 0-100 while a gate is running (drives the sweep fill). */
  progressPct?: number
}

export const STATUS_LABEL: Record<GateStatus, string> = {
  pending: 'NOT GATED',
  running: 'GATING',
  pass: 'PASS',
  flag: 'FLAG',
  fail: 'FAIL',
  error: 'ERROR',
}

function useCountUp(target: number, enabled: boolean): number {
  const [value, setValue] = useState(enabled ? 0 : target)
  const raf = useRef(0)
  useEffect(() => {
    if (!enabled) {
      setValue(target)
      return
    }
    const start = performance.now()
    const from = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 300)
      // ease-out
      const e = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(from + (target - from) * e))
      if (t < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [target, enabled])
  return value
}

export function GateBadge({
  gate,
  size = 'md',
  countUp = false,
  progressPct,
}: GateBadgeProps): JSX.Element {
  const status: GateStatus = gate?.status ?? 'pending'
  const settled = status === 'pass' || status === 'flag' || status === 'fail'
  const score = useCountUp(gate?.overall ?? 0, countUp && settled)

  if (status === 'running') {
    return (
      <span className={`gate-badge is-running size-${size}`} title="Gate running">
        <span className="gate-badge-sweep" style={{ width: `${progressPct ?? 12}%` }} />
        <span className="gate-dot" />
        <span className="gate-badge-label caps">GATING</span>
      </span>
    )
  }

  if (!settled) {
    return (
      <span className={`gate-badge is-${status} size-${size}`} title={STATUS_LABEL[status]}>
        <span className="gate-dot" />
        <span className="gate-badge-label caps">{status === 'error' ? 'ERROR' : 'UNGATED'}</span>
      </span>
    )
  }

  return (
    <span
      className={`gate-badge is-${status} size-${size}`}
      title={`${STATUS_LABEL[status]} · overall ${gate?.overall ?? 0}/100`}
    >
      <span className="gate-dot" />
      <span className="gate-score mono">{score}</span>
      {size !== 'sm' && <span className="gate-badge-label caps">{STATUS_LABEL[status]}</span>}
    </span>
  )
}
