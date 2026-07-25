import { useMemo, useState } from 'react'
import type { CharacterKit, Take, Verdict } from '@shared/types'
import { shotById, shotsInOrder, useStore } from '../store'
import { media } from '../media'
import { Icon } from '../components/Icon'
import { EmptyState } from '../components/EmptyState'
import { CircleMark } from '../components/CircleOverlay'

/**
 * Character Kits — lock a face from reference stills, then hold every take in
 * the film against it.
 *
 * THE LINEUP is the point of this room: a wall of every take-face that should
 * contain this character, sorted best → worst by distance to the locked kit.
 * Continuity stops being a matter of opinion.
 */

/**
 * Distance to the kit centroid. The engine will hand us the real cosine
 * distance in the identity check details; until then we derive a stable value
 * from the identity score so the wall is honest about ordering even if the
 * absolute numbers firm up later.
 */
function kitDistance(take: Take): number | null {
  const identity = take.gate?.checks.identity
  if (!identity || identity.verdict === 'skip') return null
  return Math.round((0.06 + ((100 - identity.score) / 100) * 0.78) * 100) / 100
}

interface LineupEntry {
  take: Take
  shotName: string
  distance: number
  verdict: Verdict
}

function useLineup(character: CharacterKit): LineupEntry[] {
  const project = useStore((s) => s.project)
  return useMemo(() => {
    if (!project) return []
    const out: LineupEntry[] = []
    for (const shot of shotsInOrder(project)) {
      if (!shot.characterIds.includes(character.id)) continue
      for (const take of project.takes) {
        if (take.shotId !== shot.id) continue
        const distance = kitDistance(take)
        if (distance == null) continue
        out.push({
          take,
          shotName: shot.name,
          distance,
          verdict: take.gate?.checks.identity?.verdict ?? 'flag',
        })
      }
    }
    return out.sort((a, b) => a.distance - b.distance || a.take.fileName.localeCompare(b.take.fileName))
  }, [project, character.id])
}

function Lineup({ character }: { character: CharacterKit }): JSX.Element {
  const entries = useLineup(character)
  const openShot = useStore((s) => s.openShot)
  const project = useStore((s) => s.project)
  const r = media()

  if (entries.length === 0) {
    return (
      <div className="lineup-empty">
        <span className="caps">No gated takes bound to {character.name} yet</span>
      </div>
    )
  }

  const best = entries[0]
  const worst = entries[entries.length - 1]
  const counts = entries.reduce(
    (acc, e) => {
      if (e.verdict === 'pass') acc.pass++
      else if (e.verdict === 'fail') acc.fail++
      else acc.flag++
      return acc
    },
    { pass: 0, flag: 0, fail: 0 },
  )
  const mean = entries.reduce((s, e) => s + e.distance, 0) / entries.length

  return (
    <section className="lineup-wrap">
      <header className="lineup-head">
        <h4 className="caps section-title">The lineup</h4>
        <span className="mono section-count">{entries.length} faces</span>
        <span className="lineup-counts">
          <span className="chip chip-verdict v-pass mono">{counts.pass} pass</span>
          {counts.flag > 0 && <span className="chip chip-verdict v-flag mono">{counts.flag} flag</span>}
          {counts.fail > 0 && <span className="chip chip-verdict v-fail mono">{counts.fail} fail</span>}
        </span>
        <span className="grow" />
        <span className="lineup-legend mono">
          mean {mean.toFixed(2)}
          <span className="lineup-legend-sep">·</span>
          best {best?.distance.toFixed(2)}
          <span className="lineup-legend-sep">→</span>
          worst {worst?.distance.toFixed(2)}
        </span>
      </header>

      <div className="lineup scroll-x">
        {entries.map(({ take, shotName, distance, verdict }) => {
          const shot = shotById(project, take.shotId)
          return (
            <button
              key={take.id}
              type="button"
              className={`lineup-item v-${verdict}${take.circled ? ' is-circled' : ''}`}
              onClick={() => shot && openShot(shot.id)}
              title={`${shotName} · ${take.fileName} — cos distance ${distance.toFixed(2)} (${verdict})`}
            >
              <span className="lineup-face">
                <img src={r.face(take.id)} alt="" draggable={false} />
                {take.circled && (
                  <span className="lineup-circled">
                    <CircleMark size={14} />
                  </span>
                )}
              </span>
              <span className="lineup-meta">
                <span className="lineup-shot">{shotName}</span>
                <span className="mono lineup-dist">{distance.toFixed(2)}</span>
              </span>
              <span className="lineup-file mono">{take.fileName}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function KitCard({ character }: { character: CharacterKit }): JSX.Element {
  const renameCharacter = useStore((s) => s.renameCharacter)
  const addKitImages = useStore((s) => s.addKitImages)
  const buildKit = useStore((s) => s.buildKit)
  const project = useStore((s) => s.project)
  const [name, setName] = useState(character.name)
  const r = media()

  const shotsWith = (project?.shots ?? []).filter((s) => s.characterIds.includes(character.id))

  return (
    <article className={`kit-card${character.locked ? ' is-locked' : ''}`}>
      <header className="kit-head">
        <input
          className="kit-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== character.name && void renameCharacter(character.id, name.trim())}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          aria-label="Character name"
        />
        <span className={`chip chip-lock${character.locked ? ' is-on' : ''}`}>
          <Icon name={character.locked ? 'lock' : 'unlock'} size={11} />
          {character.locked ? 'KIT LOCKED' : 'UNLOCKED'}
        </span>
        <span className="grow" />
        <span className="mono kit-stat">{character.images.length} refs</span>
        <span className="mono kit-stat">{shotsWith.length} shots</span>
      </header>

      <div className="ref-grid">
        {character.images.map((img) => (
          <span key={img} className="ref-still">
            <img src={r.kit(character.id, img)} alt="" draggable={false} />
            <span className="ref-name mono">{img}</span>
          </span>
        ))}
        <button
          type="button"
          className="ref-add"
          onClick={() => void addKitImages(character.id)}
          title="Add reference stills"
        >
          <Icon name="image" size={20} />
          <span className="caps">Add images</span>
        </button>
      </div>

      <div className="kit-actions">
        <button
          type="button"
          className={`btn ${character.locked ? 'ghost' : 'primary'}`}
          onClick={() => void buildKit(character.id)}
          disabled={character.images.length === 0}
        >
          <Icon name="lock" size={14} />
          {character.locked ? 'Rebuild kit' : 'Lock kit'}
        </button>
        <span className="kit-note">
          {character.locked
            ? 'Embeddings frozen — every take is scored against this centroid.'
            : 'Lock the kit to freeze embeddings and start enforcing identity.'}
        </span>
      </div>

      <Lineup character={character} />
    </article>
  )
}

export function Kits(): JSX.Element {
  const project = useStore((s) => s.project)
  const addCharacter = useStore((s) => s.addCharacter)
  const characters = project?.characters ?? []

  if (characters.length === 0) {
    return (
      <EmptyState
        title="No characters yet"
        hint="Add a character, drop in reference stills, and lock the kit. Every take in a shot they appear in gets scored against it."
        mark={<Icon name="kits" size={30} />}
      >
        <button type="button" className="btn primary" onClick={() => void addCharacter('New character')}>
          <Icon name="plus" size={14} />
          Add character
        </button>
      </EmptyState>
    )
  }

  return (
    <div className="kits scroll-y">
      {characters.map((c) => (
        <KitCard key={c.id} character={c} />
      ))}
    </div>
  )
}
