/**
 * The in-repo icon set — lucide-style, 1.5px stroke, 24px grid, currentColor.
 * No emoji, no icon fonts, no external SVG files (design.md).
 */

export type IconName =
  | 'bin'
  | 'village'
  | 'kits'
  | 'print'
  | 'gear'
  | 'plus'
  | 'minus'
  | 'close'
  | 'check'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronUp'
  | 'chevronDown'
  | 'play'
  | 'pause'
  | 'stepBack'
  | 'stepForward'
  | 'circle'
  | 'star'
  | 'copy'
  | 'folder'
  | 'film'
  | 'alert'
  | 'coin'
  | 'compare'
  | 'wipe'
  | 'refresh'
  | 'download'
  | 'image'
  | 'lock'
  | 'unlock'
  | 'bracket'
  | 'search'
  | 'link'

const PATHS: Record<IconName, JSX.Element> = {
  bin: (
    <>
      <rect x="3" y="4" width="7.5" height="6.5" rx="1" />
      <rect x="13.5" y="4" width="7.5" height="6.5" rx="1" />
      <rect x="3" y="13.5" width="7.5" height="6.5" rx="1" />
      <rect x="13.5" y="13.5" width="7.5" height="6.5" rx="1" />
    </>
  ),
  village: (
    <>
      <rect x="2.5" y="4.5" width="19" height="13" rx="1.5" />
      <path d="M10 9.2v4.1l3.6-2.05z" />
      <path d="M8.5 20.5h7" />
    </>
  ),
  kits: (
    <>
      <circle cx="12" cy="8.5" r="3.75" />
      <path d="M4.5 20.2c0-3.9 3.36-6.45 7.5-6.45s7.5 2.55 7.5 6.45" />
    </>
  ),
  print: (
    <>
      <path d="M6.5 9V3.5h11V9" />
      <rect x="3.5" y="9" width="17" height="7" rx="1.5" />
      <path d="M6.5 14.5h11v6h-11z" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.5a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.75 2.75l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47v.17a1.94 1.94 0 1 1-3.88 0v-.09a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.75-2.75l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97h-.17a1.94 1.94 0 1 1 0-3.88h.09a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.94 1.94 0 1 1 2.75-2.75l.06.06a1.6 1.6 0 0 0 1.77.32h.08a1.6 1.6 0 0 0 .97-1.47v-.17a1.94 1.94 0 1 1 3.88 0v.09a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.75 2.75l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.47.97h.17a1.94 1.94 0 1 1 0 3.88h-.09a1.6 1.6 0 0 0-1.47.97z" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M4.5 12.5l5 5 10-11" />,
  chevronLeft: <path d="M14.5 5.5L8 12l6.5 6.5" />,
  chevronRight: <path d="M9.5 5.5L16 12l-6.5 6.5" />,
  chevronUp: <path d="M5.5 15L12 8.5l6.5 6.5" />,
  chevronDown: <path d="M5.5 9l6.5 6.5L18.5 9" />,
  play: <path d="M7.5 4.8v14.4L19.5 12z" />,
  pause: (
    <>
      <rect x="7" y="5" width="3.6" height="14" rx="0.8" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="0.8" />
    </>
  ),
  stepBack: (
    <>
      <path d="M18 5.5v13L9 12z" />
      <path d="M6 5.5v13" />
    </>
  ),
  stepForward: (
    <>
      <path d="M6 5.5v13L15 12z" />
      <path d="M18 5.5v13" />
    </>
  ),
  circle: <ellipse cx="12" cy="12" rx="9" ry="7.4" />,
  star: <path d="M12 3.6l2.6 5.5 5.9.85-4.3 4.3 1.02 6.05L12 17.4l-5.22 2.9L7.8 14.25 3.5 9.95l5.9-.85z" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.6" />
      <path d="M15.5 5.5H6a1.5 1.5 0 0 0-1.5 1.5v9.5" />
    </>
  ),
  folder: <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  film: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="1.5" />
      <path d="M7 4.5v15M17 4.5v15M2.5 12h19M2.5 8.2h4.5M2.5 15.8h4.5M17 8.2h4.5M17 15.8h4.5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.2l9 15.6H3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" />
    </>
  ),
  coin: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v10M14.6 9.2c-.5-.9-1.5-1.3-2.6-1.3-1.5 0-2.7.8-2.7 2s1 1.8 2.7 2.1c1.7.3 2.8.9 2.8 2.1s-1.2 2-2.8 2c-1.2 0-2.2-.45-2.7-1.35" />
    </>
  ),
  compare: (
    <>
      <rect x="2.5" y="5.5" width="8" height="13" rx="1.2" />
      <rect x="13.5" y="5.5" width="8" height="13" rx="1.2" />
    </>
  ),
  wipe: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="1.2" />
      <path d="M12 3.5v17" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20.5 4v4.4h-4.4" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.5v11" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4 17.5v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="1.6" />
      <circle cx="8.6" cy="9.8" r="1.6" />
      <path d="M3.4 17l4.8-4.6 3.4 3.2 3.2-3 5.2 5" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="1.6" />
      <path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9" />
    </>
  ),
  unlock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="1.6" />
      <path d="M8 10.5V7.6a4 4 0 0 1 7.6-1.7" />
    </>
  ),
  bracket: (
    <>
      <path d="M7.5 4.5H4.5v15h3" />
      <path d="M16.5 4.5h3v15h-3" />
      <path d="M12 8.5v7" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.4 15.4L20.5 20.5" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.8a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
      <path d="M14 10.2a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.5-1.5" />
    </>
  ),
}

export interface IconProps {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}

export function Icon({ name, size = 18, className, strokeWidth = 1.5 }: IconProps): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

/**
 * The app mark: the hand-drawn circle gesture rendered in the brand gradient
 * (electric blue → violet → fuchsia) with a soft neon glow, matching the logo.
 */
export function LogoMark({ size = 30 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="ct-logo-grad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="0.5" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#d946ef" />
        </linearGradient>
        <filter id="ct-logo-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.9" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g filter="url(#ct-logo-glow)">
        <path
          d="M35.4 19.2c.3 7.6-6.4 13.9-15 14.2C11.7 33.7 4.6 28.1 4.3 20.6 4 13 10.7 6.7 19.3 6.4c8.6-.3 15.8 5.2 16.1 12.8"
          stroke="url(#ct-logo-grad)"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        <path
          d="M34.1 22.6c-1.1 6.7-7.7 11.4-15.4 11.1C11 33.4 4.9 28 4.9 20.9c0-7.1 6.4-12.8 14.6-13 5.6-.1 10.6 2.3 13.3 6.2"
          stroke="url(#ct-logo-grad)"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.6"
        />
      </g>
      <path d="M13.5 20.2h13" stroke="#e8ebf4" strokeWidth="1.8" strokeLinecap="round" opacity="0.85" />
    </svg>
  )
}
