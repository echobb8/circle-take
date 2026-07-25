import type { SeriesPoint, Verdict } from '@shared/types'

/**
 * Per-frame gate series as a sparkline: dim polyline for the measured metric,
 * a dashed threshold line, and every breaching span redrawn in the fail colour
 * with a filled area beneath it. Metrics guide, eyes decide — but the shape of
 * the failure should be legible at 120×24.
 */

export interface SparklineProps {
  series: SeriesPoint[]
  threshold?: number
  width?: number
  height?: number
  verdict?: Verdict
  /** Large mode: axis ticks, time labels, annotated threshold (Report view). */
  axis?: boolean
  /** Current playhead in seconds — drawn as a vertical indicator. */
  playhead?: number
  onScrub?: (t: number) => void
}

interface Scaled {
  x: number
  y: number
  t: number
  v: number
  breach: boolean
}

export function Sparkline({
  series,
  threshold,
  width = 120,
  height = 24,
  verdict = 'pass',
  axis = false,
  playhead,
  onScrub,
}: SparklineProps): JSX.Element | null {
  if (series.length < 2) return null

  const padY = axis ? 8 : 2.5
  const padL = axis ? 30 : 0
  const padB = axis ? 14 : 0
  const plotW = width - padL
  const plotH = height - padY * 2 - padB

  const tMin = series[0]?.t ?? 0
  const tMax = series[series.length - 1]?.t ?? 1
  const tSpan = Math.max(0.0001, tMax - tMin)
  const vMax = Math.max(threshold ?? 0, ...series.map((p) => p.v)) * 1.12 || 1
  const vMin = 0

  const sx = (t: number) => padL + ((t - tMin) / tSpan) * plotW
  const sy = (v: number) => padY + plotH - ((v - vMin) / (vMax - vMin)) * plotH

  const pts: Scaled[] = series.map((p) => ({
    x: sx(p.t),
    y: sy(p.v),
    t: p.t,
    v: p.v,
    breach: threshold != null && p.v > threshold,
  }))

  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')

  // Contiguous breach runs, drawn hot on top of the dim base line.
  const runs: Scaled[][] = []
  let current: Scaled[] = []
  for (const p of pts) {
    if (p.breach) current.push(p)
    else if (current.length) {
      runs.push(current)
      current = []
    }
  }
  if (current.length) runs.push(current)

  const breachColor = verdict === 'fail' ? 'var(--fail)' : 'var(--flag)'
  const baseY = padY + plotH

  const handleScrub = onScrub
    ? (e: React.MouseEvent<SVGSVGElement>) => {
        const box = e.currentTarget.getBoundingClientRect()
        const f = (e.clientX - box.left - padL * (box.width / width)) / (plotW * (box.width / width))
        onScrub(tMin + Math.max(0, Math.min(1, f)) * tSpan)
      }
    : undefined

  return (
    <svg
      className={`sparkline${axis ? ' is-large' : ''}${onScrub ? ' is-scrubbable' : ''}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      onClick={handleScrub}
      aria-hidden="true"
    >
      {axis && (
        <>
          <line x1={padL} y1={baseY} x2={width} y2={baseY} stroke="var(--line)" strokeWidth="1" />
          <line x1={padL} y1={padY} x2={padL} y2={baseY} stroke="var(--line)" strokeWidth="1" />
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line
                x1={padL + f * plotW}
                y1={baseY}
                x2={padL + f * plotW}
                y2={baseY + 3}
                stroke="var(--line)"
                strokeWidth="1"
              />
              <text
                x={padL + f * plotW}
                y={baseY + 12}
                textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}
                className="spark-tick"
              >
                {(tMin + f * tSpan).toFixed(1)}s
              </text>
            </g>
          ))}
          <text x={padL - 6} y={padY + 4} textAnchor="end" className="spark-tick">
            {vMax.toFixed(2)}
          </text>
          <text x={padL - 6} y={baseY} textAnchor="end" className="spark-tick">
            0
          </text>
        </>
      )}

      {threshold != null && (
        <>
          <line
            x1={padL}
            y1={sy(threshold)}
            x2={width}
            y2={sy(threshold)}
            stroke="var(--text-faint)"
            strokeWidth="1"
            strokeDasharray="3 3"
            opacity={axis ? 0.9 : 0.65}
          />
          {axis && (
            <text x={padL + 6} y={sy(threshold) - 5} textAnchor="start" className="spark-thr">
              threshold {threshold}
            </text>
          )}
        </>
      )}

      <path d={line} stroke="var(--text-dim)" strokeWidth={axis ? 1.5 : 1.3} fill="none" opacity="0.9" />

      {runs.map((run, i) => {
        const first = run[0]
        const last = run[run.length - 1]
        if (!first || !last) return null
        const seg = run.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
        const area = `${seg} L${last.x.toFixed(2)},${baseY} L${first.x.toFixed(2)},${baseY} Z`
        return (
          <g key={i}>
            <path d={area} fill={breachColor} opacity="0.16" />
            <path d={seg} stroke={breachColor} strokeWidth={axis ? 2 : 1.6} fill="none" />
          </g>
        )
      })}

      {playhead != null && playhead >= tMin && playhead <= tMax && (
        <line
          x1={sx(playhead)}
          y1={padY}
          x2={sx(playhead)}
          y2={baseY}
          stroke="var(--accent)"
          strokeWidth="1"
          opacity="0.9"
        />
      )}
    </svg>
  )
}
