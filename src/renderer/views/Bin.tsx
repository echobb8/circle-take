import { useMemo, useState } from 'react'
import type { Shot, Take } from '@shared/types'
import { takeCost, toTimecode } from '@shared/types'
import {
  bestTake,
  hasModelMix,
  shotModels,
  shotNeedsReshoot,
  shotStats,
  shotsInOrder,
  spendForShot,
  takesForShot,
  unassignedTakes,
  useStore,
} from '../store'
import { media } from '../media'
import { Icon } from '../components/Icon'
import { GateBadge } from '../components/GateBadge'
import { CheckDots } from '../components/CheckDots'
import { CircleOverlay } from '../components/CircleOverlay'
import { ModelMixChip, formatUsd } from '../components/ProvenanceChips'
import { EmptyState } from '../components/EmptyState'

const DRAG_TYPE = 'application/x-ctake-take'

// ---------------------------------------------------------------------------
// Production header strip
// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'accent' | 'pass' | 'fail' | 'plain'
  onClick?: () => void
}): JSX.Element {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      className={`prod-stat tone-${tone ?? 'plain'}${onClick ? ' is-clickable' : ''}`}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
    >
      <span className="prod-num mono">{value}</span>
      <span className="prod-label caps">{label}</span>
      {sub && <span className="prod-sub mono">{sub}</span>}
    </Tag>
  )
}

function ProgressBar({ shots, project }: { shots: Shot[]; project: ReturnType<typeof useStore.getState>['project'] }): JSX.Element {
  return (
    <div className="prod-bar" title="One segment per shot, in cut order">
      {shots.map((s) => {
        const takes = takesForShot(project, s.id)
        const circled = takes.some((t) => t.circled)
        const passing = takes.some((t) => t.gate?.status === 'pass')
        const flagged = takes.some((t) => t.gate?.status === 'flag')
        const state = circled ? 'circled' : passing ? 'pass' : flagged ? 'flag' : takes.length ? 'fail' : 'empty'
        return <span key={s.id} className={`seg seg-${state}`} title={`${s.name} — ${state}`} />
      })}
    </div>
  )
}

function HeaderStrip(): JSX.Element {
  const project = useStore((s) => s.project)
  const setRatesOpen = useStore((s) => s.setRatesOpen)
  const stats = useMemo(() => shotStats(project), [project])
  const shots = useMemo(() => shotsInOrder(project), [project])

  return (
    <section className="prod-strip">
      <div className="prod-stats">
        <Stat label="Shots" value={String(stats.shots)} />
        <Stat label="Takes" value={String(stats.takes)} />
        <Stat label="Gated" value={`${stats.gated}`} sub={`/ ${stats.takes}`} />
        <Stat label="Circled" value={String(stats.circled)} tone="accent" />
        <Stat
          label="Needs reshoot"
          value={String(stats.needsReshoot)}
          tone={stats.needsReshoot > 0 ? 'fail' : 'plain'}
        />
        <Stat
          label="Spend"
          value={formatUsd(stats.spend)}
          sub="rate card"
          onClick={() => setRatesOpen(true)}
        />
      </div>
      <ProgressBar shots={shots} project={project} />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Shot card
// ---------------------------------------------------------------------------

function ShotCard({ shot }: { shot: Shot }): JSX.Element {
  const project = useStore((s) => s.project)
  const openShot = useStore((s) => s.openShot)
  const assignTake = useStore((s) => s.assignTake)
  const [over, setOver] = useState(false)

  const takes = takesForShot(project, shot.id)
  const best = bestTake(project, shot.id)
  const circled = takes.find((t) => t.circled) ?? null
  const needsReshoot = shotNeedsReshoot(project, shot.id)
  const spend = spendForShot(project, shot.id)
  const models = shotModels(project, shot.id)
  const chars = shot.characterIds
    .map((id) => project?.characters.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => !!c)

  const poster = best ? media().poster(best.id) : null

  return (
    <article
      className={`shot-card${over ? ' is-drop-target' : ''}${needsReshoot ? ' is-reshoot' : ''}`}
      onClick={() => openShot(shot.id)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const takeId = e.dataTransfer.getData(DRAG_TYPE)
        setOver(false)
        if (!takeId) return
        e.preventDefault()
        e.stopPropagation()
        void assignTake(takeId, shot.id)
      }}
    >
      <div className="poster">
        {poster ? (
          <img className="poster-img" src={poster} alt="" draggable={false} />
        ) : (
          <div className="poster-blank">
            <Icon name="film" size={22} />
            <span className="caps">Awaiting footage</span>
          </div>
        )}
        <span className="poster-scrim" aria-hidden="true" />

        {circled && <CircleOverlay rotate={((shot.order * 7) % 9) - 4} inset={0.6} />}

        <span className="poster-tl">
          {best?.gate && <GateBadge gate={best.gate} size="lg" />}
        </span>

        <span className="poster-tr">
          {takes.length > 0 && (
            <span className="chip chip-count mono">
              {takes.length} TAKE{takes.length === 1 ? '' : 'S'}
            </span>
          )}
        </span>

        <span className="poster-bl">
          {best?.gate && <CheckDots checks={best.gate.checks} size={6} />}
        </span>

        <span className="poster-br mono">
          {best?.probe ? toTimecode(best.probe.durationSec, best.probe.fps) : ''}
        </span>

        {needsReshoot && takes.length > 0 && (
          <span className="corner-tag caps">Needs reshoot</span>
        )}
        {takes.length === 0 && <span className="corner-tag is-empty caps">No takes</span>}
      </div>

      <div className="shot-meta">
        <div className="shot-row">
          <h3 className="shot-name">{shot.name}</h3>
          <span className="grow" />
          {models.length > 1 && <ModelMixChip models={models} />}
        </div>
        {shot.description && <p className="shot-desc">{shot.description}</p>}
        <div className="shot-row shot-footer">
          {chars.map((c) => (
            <span key={c.id} className="chip chip-char" title={c.locked ? 'Kit locked' : 'Kit not locked'}>
              {c.locked && <Icon name="lock" size={10} />}
              {c.name}
            </span>
          ))}
          <span className="grow" />
          {spend.takes > 0 && (
            <span
              className="chip chip-spend mono"
              title={`${formatUsd(spend.spend)} spent · ${spend.takes} takes · ${Math.round(spend.hitRate * 100)}% usable`}
            >
              {formatUsd(spend.spend)}
              <span className="chip-sep">·</span>
              {spend.takes}
              <span className="chip-sep">·</span>
              {Math.round(spend.hitRate * 100)}%
            </span>
          )}
        </div>
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Add-shot ghost card
// ---------------------------------------------------------------------------

function AddShotCard(): JSX.Element {
  const project = useStore((s) => s.project)
  const addShot = useStore((s) => s.addShot)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [duration, setDuration] = useState('')
  const [characterIds, setCharacterIds] = useState<string[]>([])

  const reset = () => {
    setOpen(false)
    setName('')
    setDescription('')
    setDuration('')
    setCharacterIds([])
  }

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const durationSec = Number(duration)
    void addShot({
      name: trimmed,
      description: description.trim() || undefined,
      characterIds,
      expected: Number.isFinite(durationSec) && durationSec > 0 ? { durationSec } : undefined,
    })
    reset()
  }

  if (!open) {
    return (
      <button type="button" className="ghost-card" onClick={() => setOpen(true)}>
        <Icon name="plus" size={22} />
        <span className="caps">Add shot</span>
      </button>
    )
  }

  return (
    <form
      className="shot-card is-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <h3 className="caps form-title">New shot</h3>
      <label className="field-row">
        <span className="caps field-label">Name</span>
        <input
          className="field mono"
          autoFocus
          value={name}
          placeholder="12A"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field-row">
        <span className="caps field-label">Description</span>
        <input
          className="field"
          value={description}
          placeholder="Maya exits the diner, rain"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="field-row">
        <span className="caps field-label">Duration</span>
        <input
          className="field mono"
          value={duration}
          placeholder="6"
          inputMode="decimal"
          onChange={(e) => setDuration(e.target.value)}
        />
      </label>
      <div className="field-row">
        <span className="caps field-label">Characters</span>
        <div className="char-picker">
          {(project?.characters ?? []).map((c) => {
            const on = characterIds.includes(c.id)
            return (
              <button
                key={c.id}
                type="button"
                className={`chip chip-char is-toggle${on ? ' is-on' : ''}`}
                onClick={() =>
                  setCharacterIds((prev) => (on ? prev.filter((x) => x !== c.id) : [...prev, c.id]))
                }
              >
                {c.name}
              </button>
            )
          })}
          {(project?.characters.length ?? 0) === 0 && (
            <span className="field-hint">No characters yet — add them in Kits.</span>
          )}
        </div>
      </div>
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={reset}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!name.trim()}>
          Add shot
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Unassigned tray
// ---------------------------------------------------------------------------

function TrayCard({ take }: { take: Take }): JSX.Element {
  const project = useStore((s) => s.project)
  const cost = takeCost(take, project?.settings.modelRates)
  return (
    <article
      className="tray-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, take.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      title="Drag onto a shot to bind it"
    >
      <div className="tray-thumb">
        <img src={media().poster(take.id)} alt="" draggable={false} />
        <span className="poster-scrim" aria-hidden="true" />
        <span className="tray-grip" aria-hidden="true">
          <Icon name="link" size={13} />
        </span>
      </div>
      <div className="tray-meta">
        <span className="mono tray-file" title={take.mediaPath}>
          {take.fileName}
        </span>
        <span className="tray-sub">
          <span className="chip chip-gen">{take.provenance.generator ?? 'unknown'}</span>
          {take.probe && (
            <span className="mono tray-dur">{toTimecode(take.probe.durationSec, take.probe.fps)}</span>
          )}
          {cost != null && <span className="mono tray-cost">{formatUsd(cost)}</span>}
        </span>
      </div>
    </article>
  )
}

function UnassignedTray(): JSX.Element | null {
  const project = useStore((s) => s.project)
  const takes = unassignedTakes(project)
  if (takes.length === 0) return null
  return (
    <section className="tray">
      <header className="tray-head">
        <h2 className="caps section-title">Unassigned</h2>
        <span className="mono section-count">{takes.length}</span>
        <span className="tray-hint">Drag a take onto a shot card to bind it</span>
      </header>
      <div className="tray-grid">
        {takes.map((t) => (
          <TrayCard key={t.id} take={t} />
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

export function Bin(): JSX.Element {
  const project = useStore((s) => s.project)
  const chooseAndIngest = useStore((s) => s.chooseAndIngest)
  const shots = useMemo(() => shotsInOrder(project), [project])
  const mixCount = useMemo(
    () => shots.filter((s) => hasModelMix(project, s.id)).length,
    [shots, project],
  )

  return (
    <div className="bin scroll-y">
      <HeaderStrip />

      {mixCount > 0 && (
        <p className="bin-note">
          <Icon name="alert" size={13} />
          {mixCount} shot{mixCount === 1 ? '' : 's'} mix model versions — those takes are no longer
          reproducible from a single recipe.
        </p>
      )}

      <UnassignedTray />

      {shots.length === 0 ? (
        <EmptyState
          title="No shots yet"
          hint="Add the shots you're covering, then drop takes on them. Filenames like 12A_take3.mp4 bind themselves."
          mark={<Icon name="bin" size={30} />}
        >
          <button type="button" className="btn primary" onClick={() => void chooseAndIngest()}>
            <Icon name="plus" size={14} />
            Add media
          </button>
        </EmptyState>
      ) : (
        <section className="shot-grid">
          {shots.map((s) => (
            <ShotCard key={s.id} shot={s} />
          ))}
          <AddShotCard />
        </section>
      )}
    </div>
  )
}
