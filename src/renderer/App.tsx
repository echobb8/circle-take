import { useEffect, useState } from 'react'
import { useStore, type Room } from './store'
import { Icon, LogoMark, type IconName } from './components/Icon'
import { Bin } from './views/Bin'
import { Village } from './views/Village'
import { Kits } from './views/Kits'
import { Print } from './views/Print'
import { Report } from './views/Report'
import { Welcome } from './views/Welcome'
import { RatesModal } from './views/RatesModal'
import { About } from './components/About'

const ROOMS: { id: Room; label: string; icon: IconName; hint: string }[] = [
  { id: 'bin', label: 'Bin', icon: 'bin', hint: 'The Bin — shot grid' },
  { id: 'village', label: 'Village', icon: 'village', hint: 'The Village — review room' },
  { id: 'kits', label: 'Kits', icon: 'kits', hint: 'Character Kits' },
  { id: 'print', label: 'Print', icon: 'print', hint: 'Print It — exports' },
]

const ROOM_TITLE: Record<Room, string> = {
  bin: 'The Bin',
  village: 'The Village',
  kits: 'Character Kits',
  print: 'Print It',
}

const ROOM_SUB: Record<Room, string> = {
  bin: 'Shot-by-shot production grid',
  village: 'Review, compare, circle',
  kits: 'Lock identity, enforce continuity',
  print: 'Selects out, reshoots listed',
}

/**
 * Best-effort path extraction from a dropped file. Electron 32+ removed
 * File.path — the preload bridge exposes webUtils.getPathForFile as
 * pathForFile. In a plain browser (mock mode) we fall back to the name,
 * which the mock ingest is happy with.
 */
function pathOf(file: File): string {
  const bridge = window.circletake as { pathForFile?: (f: File) => string } | undefined
  if (bridge?.pathForFile) {
    try {
      const p = bridge.pathForFile(file)
      if (p) return p
    } catch {
      // fall through to name
    }
  }
  return (file as File & { path?: string }).path ?? file.name
}

function EngineDot(): JSX.Element {
  const engine = useStore((s) => s.engineStatus)
  const cls = engine.stage === 'error' ? 'is-error' : engine.ready ? 'is-ready' : 'is-busy'
  const detail = engine.detail ?? (engine.ready ? 'Gate engine ready' : `Engine: ${engine.stage}`)
  return (
    <span className={`engine-dot ${cls}`} title={detail}>
      <span className="engine-dot-core" />
    </span>
  )
}

function Toast(): JSX.Element | null {
  const toast = useStore((s) => s.toast)
  const notify = useStore((s) => s.notify)
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => notify(null), 3200)
    return () => window.clearTimeout(t)
  }, [toast, notify])
  if (!toast) return null
  return (
    <div className="toast" role="status">
      <Icon name="check" size={14} />
      <span>{toast}</span>
    </div>
  )
}

function HeaderActions({ room }: { room: Room }): JSX.Element | null {
  const chooseAndIngest = useStore((s) => s.chooseAndIngest)
  const runGateAll = useStore((s) => s.runGateAll)
  const addCharacter = useStore((s) => s.addCharacter)
  const compareTakeId = useStore((s) => s.compareTakeId)
  const wipe = useStore((s) => s.wipe)
  const toggleWipeMode = useStore((s) => s.toggleWipeMode)
  const setCompare = useStore((s) => s.setCompare)

  switch (room) {
    case 'bin':
      return (
        <>
          <button type="button" className="btn ghost" onClick={() => void runGateAll(true)}>
            <Icon name="refresh" size={14} />
            Gate ungated
          </button>
          <button type="button" className="btn primary" onClick={() => void chooseAndIngest()}>
            <Icon name="plus" size={14} />
            Add media
          </button>
        </>
      )
    case 'village':
      return compareTakeId ? (
        <>
          <button type="button" className="btn ghost" onClick={toggleWipeMode}>
            <Icon name={wipe === null ? 'wipe' : 'compare'} size={14} />
            {wipe === null ? 'Wipe' : 'Side by side'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setCompare(compareTakeId)}>
            <Icon name="close" size={14} />
            Exit compare
          </button>
        </>
      ) : null
    case 'kits':
      return (
        <button type="button" className="btn primary" onClick={() => void addCharacter('New character')}>
          <Icon name="plus" size={14} />
          Add character
        </button>
      )
    case 'print':
      return null
    default:
      return null
  }
}

export function App(): JSX.Element {
  const loading = useStore((s) => s.loading)
  const project = useStore((s) => s.project)
  const room = useStore((s) => s.room)
  const setRoom = useStore((s) => s.setRoom)
  const init = useStore((s) => s.init)
  const ingestPaths = useStore((s) => s.ingestPaths)
  const reportTakeId = useStore((s) => s.reportTakeId)
  const ratesOpen = useStore((s) => s.ratesOpen)
  const [aboutOpen, setAboutOpen] = useState(false)

  // App menu → About
  useEffect(() => {
    const bridge = window.circletake as { onMenuAbout?: (cb: () => void) => () => void } | undefined
    return bridge?.onMenuAbout?.(() => setAboutOpen(true))
  }, [])

  useEffect(() => {
    void init()
  }, [init])

  // Drop media anywhere in the window.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      // Internal take drags (Bin tray → shot card) carry no files; leave them alone.
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      document.body.classList.add('is-dropping')
    }
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) document.body.classList.remove('is-dropping')
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      document.body.classList.remove('is-dropping')
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length) void ingestPaths(files.map(pathOf))
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [ingestPaths])

  // Cmd/Ctrl + 1..4 switches rooms from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const idx = ['1', '2', '3', '4'].indexOf(e.key)
      if (idx === -1) return
      const target = ROOMS[idx]
      if (!target) return
      e.preventDefault()
      setRoom(target.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setRoom])

  if (loading) {
    return (
      <div className="boot">
        <LogoMark size={44} />
      </div>
    )
  }

  if (!project)
    return (
      <>
        <Welcome />
        {aboutOpen && <About onClose={() => setAboutOpen(false)} />}
      </>
    )

  return (
    <div className="app">
      <nav className="rail" aria-label="Rooms">
        <button
          type="button"
          className="rail-logo"
          title="About Circle Take"
          aria-label="About Circle Take"
          onClick={() => setAboutOpen(true)}
        >
          <LogoMark size={30} />
        </button>
        <div className="rail-nav">
          {ROOMS.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`rail-btn${room === r.id ? ' is-active' : ''}`}
              onClick={() => setRoom(r.id)}
              title={r.hint}
              aria-label={r.label}
              aria-current={room === r.id}
            >
              <span className="rail-notch" aria-hidden="true" />
              <Icon name={r.icon} size={20} />
              <span className="rail-label caps">{r.label}</span>
            </button>
          ))}
        </div>
        <div className="rail-foot">
          <EngineDot />
          <button type="button" className="rail-btn is-small" title="Settings" aria-label="Settings">
            <Icon name="gear" size={18} />
          </button>
        </div>
      </nav>

      <main className="room">
        <header className="room-header">
          <div className="room-title-wrap">
            <h1 className="room-title">{ROOM_TITLE[room]}</h1>
            <span className="room-sub">{ROOM_SUB[room]}</span>
          </div>
          <div className="room-project">
            <span className="project-name">{project.name}</span>
            <span className="project-dot" aria-hidden="true" />
            <span className="mono project-meta">{project.takes.length} takes</span>
          </div>
          <div className="room-actions">
            <HeaderActions room={room} />
          </div>
        </header>

        <div className="room-body">
          {room === 'bin' && <Bin />}
          {room === 'village' && <Village />}
          {room === 'kits' && <Kits />}
          {room === 'print' && <Print />}
        </div>
      </main>

      {reportTakeId && <Report takeId={reportTakeId} />}
      {ratesOpen && <RatesModal />}
      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}
      <Toast />
      <div className="drop-veil" aria-hidden="true">
        <div className="drop-veil-inner">
          <Icon name="film" size={28} />
          <span className="caps">Drop takes to ingest</span>
        </div>
      </div>
    </div>
  )
}
