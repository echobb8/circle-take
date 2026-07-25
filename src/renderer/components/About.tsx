import { useEffect, useState } from 'react'
import logoUrl from '../assets/logo.png'

/**
 * House-style About window: logo, version, Sam's credit with clickable sites,
 * Apache-2.0 + NOTICE line. Opened from the app menu (About Circle Take) or
 * by clicking the rail logo mark.
 */

const SITES = [
  { label: 'wassermanproductions.com', url: 'https://wassermanproductions.com' },
  { label: 'wasserman.ai', url: 'https://wasserman.ai' },
]

function openSite(url: string): void {
  const bridge = window.circletake as { openExternal?: (u: string) => Promise<boolean> } | undefined
  if (bridge?.openExternal) void bridge.openExternal(url)
  else window.open(url, '_blank', 'noopener') // mock / plain-browser fallback
}

export function About({ onClose }: { onClose: () => void }): JSX.Element {
  const [version, setVersion] = useState('')

  useEffect(() => {
    const bridge = window.circletake as { appVersion?: () => Promise<string> } | undefined
    if (bridge?.appVersion) {
      void bridge.appVersion().then(setVersion).catch(() => setVersion(''))
    } else {
      setVersion('1.0.0')
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="about-backdrop" onClick={onClose} role="presentation">
      <div
        className="about-card"
        role="dialog"
        aria-label="About Circle Take"
        onClick={(e) => e.stopPropagation()}
      >
        <img className="about-logo" src={logoUrl} alt="Circle Take" draggable={false} />
        <div className="about-version mono">
          {version ? `Version ${version}` : ' '}
        </div>
        <p className="about-blurb">
          The dailies room for AI filmmaking — every take, gated, compared, circled.
        </p>
        <div className="about-credit">
          Created by <strong>Sam Wasserman</strong>
        </div>
        <div className="about-links">
          {SITES.map((s) => (
            <button
              key={s.url}
              type="button"
              className="about-link"
              onClick={() => openSite(s.url)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="about-license caps">
          Free &amp; open source · Apache-2.0 license · see NOTICE
        </div>
        <button type="button" className="btn ghost about-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
