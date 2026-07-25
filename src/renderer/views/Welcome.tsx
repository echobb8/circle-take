import { useStore } from '../store'
import { Icon } from '../components/Icon'
import logoUrl from '../assets/logo.png'

/**
 * No project open. The circle motif at full size over a radial vignette — the
 * one place design.md allows a gradient.
 */

function relativeDay(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function Welcome(): JSX.Element {
  const recents = useStore((s) => s.recents)
  const createProject = useStore((s) => s.createProject)
  const openProject = useStore((s) => s.openProject)

  return (
    <div className="welcome">
      <div className="welcome-vignette" aria-hidden="true" />

      <div className="welcome-inner">
        <img className="welcome-logo" src={logoUrl} alt="Circle Take" draggable={false} />
        <p className="welcome-blurb">
          Blockout plans the shot. The generators shoot it.
          <br />
          Circle Take decides what&rsquo;s in the movie.
        </p>

        <div className="welcome-actions">
          <button type="button" className="btn primary lg" onClick={() => void createProject()}>
            <Icon name="plus" size={15} />
            Create project
          </button>
          <button type="button" className="btn ghost lg" onClick={() => void openProject()}>
            <Icon name="folder" size={15} />
            Open project
          </button>
        </div>

        {recents.length > 0 && (
          <section className="recents">
            <h2 className="caps recents-title">Recent</h2>
            <ul className="recents-list">
              {recents.map((r) => (
                <li key={r.path}>
                  <button type="button" className="recent-row" onClick={() => void openProject(r.path)}>
                    <span className="recent-name">{r.name}</span>
                    <span className="mono recent-path">{r.path}</span>
                    <span className="mono recent-when">{relativeDay(r.openedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="welcome-hint">
          <Icon name="film" size={13} />
          Drop takes anywhere in this window to ingest them
        </p>
      </div>
    </div>
  )
}
