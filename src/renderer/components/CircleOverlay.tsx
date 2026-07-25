/**
 * THE brand gesture: the hand-drawn circle a director puts around the take
 * that's going in the movie.
 *
 * An imperfect double-pass ellipse — the second pass overshoots the first, the
 * way a real grease pencil does — stroked with the logo gradient
 * (blue → violet → fuchsia) and a soft neon glow. `animate` draws it on in
 * ~400ms via stroke-dashoffset; that is the moment of the app.
 *
 * `vector-effect="non-scaling-stroke"` keeps the 2.5px weight honest at any
 * poster size while `preserveAspectRatio="none"` lets the ellipse hug the frame.
 */

let uid = 0

export interface CircleOverlayProps {
  /** Draw-on animation (used when a take is circled live). */
  animate?: boolean
  /** Degrees of tilt — vary slightly per take so no two circles match. */
  rotate?: number
  className?: string
  /** Scale the whole gesture inside its box (1 = touches the edges). */
  inset?: number
}

const PASS_A =
  'M296,84 C294,126 238,160 164,162 C90,164 32,132 26,90 C20,48 82,18 160,16 C234,14 292,42 296,84'
const PASS_B =
  'M288,98 C276,138 220,164 150,164 C80,164 28,130 26,88 C24,46 84,20 158,18 C232,16 290,40 300,76'

export function CircleOverlay({
  animate = false,
  rotate = -4,
  className,
  inset = 0.6,
}: CircleOverlayProps): JSX.Element {
  // Gradient/filter ids must be unique per instance or the first one wins.
  const id = `co${++uid}`
  const scale = Math.max(0.3, Math.min(1, inset))
  const transform = `rotate(${rotate} 160 90) translate(160 90) scale(${scale}) translate(-160 -90)`

  return (
    <svg
      className={`circle-overlay${animate ? ' is-drawing' : ''}${className ? ` ${className}` : ''}`}
      viewBox="0 0 320 180"
      preserveAspectRatio="none"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="0.5" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#d946ef" />
        </linearGradient>
        <filter id={`${id}f`} x="-20%" y="-30%" width="140%" height="160%">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g transform={transform} filter={`url(#${id}f)`}>
        <path
          className="co-pass co-pass-a"
          d={PASS_A}
          pathLength={1}
          stroke={`url(#${id}g)`}
          strokeWidth="2.5"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* Second pass sits a few degrees off the first — the hand never
            retraces its own line exactly, and that gap is the whole tell. */}
        <path
          className="co-pass co-pass-b"
          d={PASS_B}
          pathLength={1}
          transform="rotate(3 160 90)"
          stroke={`url(#${id}g)`}
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.55"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  )
}

/** Small inline circle mark for list rows — same gesture, badge scale. */
export function CircleMark({ size = 15 }: { size?: number }): JSX.Element {
  const id = `cm${++uid}`
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="circle-mark">
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="0.5" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#d946ef" />
        </linearGradient>
      </defs>
      <path
        d="M21.6 11.2c.2 4.4-3.9 8.1-9.1 8.2-5.2.1-9.5-3.2-9.7-7.5C2.6 7.5 6.6 4 11.8 3.8c5.2-.2 9.6 3 9.8 7.4"
        stroke={`url(#${id}g)`}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
