import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CHECK_IDS,
  CHECK_LABEL,
  takeCost,
  toTimecode,
  type CheckId,
  type GateReport,
  type Shot,
  type Take,
} from '@shared/types'
import {
  shotById,
  shotModels,
  shotsInOrder,
  takeById,
  takeWindow,
  takesForShot,
  useStore,
} from '../store'
import { media } from '../media'
import { Icon } from '../components/Icon'
import { GateBadge } from '../components/GateBadge'
import { CheckDots } from '../components/CheckDots'
import { Sparkline } from '../components/Sparkline'
import { Filmstrip } from '../components/Filmstrip'
import { CircleMark, CircleOverlay } from '../components/CircleOverlay'
import { EvidenceChip } from '../components/EvidenceChip'
import { StarRating } from '../components/StarRating'
import { ModelMixChip, ProvenanceChips } from '../components/ProvenanceChips'
import { RecipeDiff } from '../components/RecipeDiff'
import { EmptyState } from '../components/EmptyState'

const DEFAULT_FPS = 24

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function fractionFromEvent(e: { clientX: number }, el: HTMLElement): number {
  const box = el.getBoundingClientRect()
  return clamp((e.clientX - box.left) / Math.max(1, box.width), 0, 1)
}

// ---------------------------------------------------------------------------
// Video surface — a real <video>, or the synthetic frame with a grain shimmer
// ---------------------------------------------------------------------------

interface SurfaceProps {
  take: Take
  time: number
  playing: boolean
  primary: boolean
  onTime?: (t: number) => void
  showCircle?: boolean
  circleAnimKey?: number
}

function VideoSurface({
  take,
  time,
  playing,
  primary,
  onTime,
  showCircle,
  circleAnimKey,
}: SurfaceProps): JSX.Element {
  const r = media()
  const ref = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (playing) void el.play().catch(() => undefined)
    else el.pause()
  }, [playing])

  // Scrub-lock: keep this element on the shared playhead.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (Math.abs(el.currentTime - time) > 0.12) el.currentTime = time
  }, [time])

  // The overlays live inside `.surface-frame`, which shrink-wraps the 16:9
  // image — so the circle sits on the picture, never on the letterbox.
  if (r.synthetic) {
    return (
      <div className="surface is-synthetic">
        <div className="surface-frame">
          <img className="surface-img" src={r.poster(take.id)} alt="" draggable={false} />
          <span className={`grain${playing ? ' is-live' : ''}`} aria-hidden="true" />
          <span className="surface-scanline" aria-hidden="true" />
          {showCircle && <CircleOverlay key={circleAnimKey} animate={circleAnimKey != null} inset={0.58} />}
        </div>
      </div>
    )
  }

  return (
    <div className="surface">
      <div className="surface-frame">
        <video
          ref={ref}
          className="surface-video"
          src={r.video(take.id)}
          poster={r.poster(take.id)}
          preload="auto"
          playsInline
          muted={!primary}
          onTimeUpdate={primary && onTime ? (e) => onTime(e.currentTarget.currentTime) : undefined}
        />
        {showCircle && <CircleOverlay key={circleAnimKey} animate={circleAnimKey != null} inset={0.58} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface TransportProps {
  take: Take
  duration: number
  fps: number
  time: number
  playing: boolean
  rate: number
  report: GateReport | null | undefined
  onSeek: (t: number) => void
  onTogglePlay: () => void
  onStep: (frames: number) => void
}

function Transport({
  take,
  duration,
  fps,
  time,
  playing,
  rate,
  report,
  onSeek,
  onTogglePlay,
  onStep,
}: TransportProps): JSX.Element {
  const setTakeWindow = useStore((s) => s.setTakeWindow)
  const applySuggestedWindow = useStore((s) => s.applySuggestedWindow)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<'playhead' | 'in' | 'out' | null>(null)

  const win = takeWindow(take)
  const suggested = report?.suggestedWindow
  const showSuggestion = !win.explicit && !!suggested

  const ticks = useMemo(() => {
    if (!report) return [] as { t: number; verdict: string; label: string }[]
    const out: { t: number; verdict: string; label: string }[] = []
    for (const id of CHECK_IDS) {
      const c = report.checks[id]
      for (const e of c?.evidence ?? []) {
        out.push({ t: e.t, verdict: c?.verdict ?? 'flag', label: `${CHECK_LABEL[id]} — ${e.caption}` })
      }
    }
    return out
  }, [report])

  const commit = useCallback(
    (kind: 'in' | 'out', t: number) => {
      const inSec = kind === 'in' ? t : win.inSec
      const outSec = kind === 'out' ? t : win.outSec
      void setTakeWindow(take.id, Math.min(inSec, outSec - 0.1), Math.max(outSec, inSec + 0.1))
    },
    [setTakeWindow, take.id, win.inSec, win.outSec],
  )

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const el = trackRef.current
      if (!el) return
      const t = fractionFromEvent(e, el) * duration
      if (drag === 'playhead') onSeek(t)
      else commit(drag, t)
    }
    const up = () => setDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag, duration, onSeek, commit])

  const pct = (t: number) => `${clamp(t / Math.max(0.001, duration), 0, 1) * 100}%`

  return (
    <div className="transport">
      <div className="transport-controls">
        <button type="button" className="tbtn" onClick={() => onStep(-1)} title="Frame back (,)">
          <Icon name="stepBack" size={15} />
        </button>
        <button
          type="button"
          className="tbtn is-play"
          onClick={onTogglePlay}
          title={playing ? 'Pause (space / K)' : 'Play (space / L)'}
        >
          <Icon name={playing ? 'pause' : 'play'} size={17} />
        </button>
        <button type="button" className="tbtn" onClick={() => onStep(1)} title="Frame forward (.)">
          <Icon name="stepForward" size={15} />
        </button>

        <span className={`rate-pill mono${rate !== 1 ? ' is-shuttling' : ''}`} title="J / K / L shuttle">
          {rate === 1 ? '1×' : `${rate > 0 ? '' : '−'}${Math.abs(rate)}×`}
        </span>

        <span className="tc-big mono">{toTimecode(time, fps)}</span>
        <span className="tc-dur mono">/ {toTimecode(duration, fps)}</span>

        <span className="grow" />

        <button
          type="button"
          className="tbtn is-text"
          onClick={() => void setTakeWindow(take.id, time, Math.max(win.outSec, time + 0.1))}
          title="Set select IN at playhead (I)"
        >
          <span className="mono">IN</span>
        </button>
        <button
          type="button"
          className="tbtn is-text"
          onClick={() => void setTakeWindow(take.id, Math.min(win.inSec, time - 0.1), time)}
          title="Set select OUT at playhead (O)"
        >
          <span className="mono">OUT</span>
        </button>
        {win.explicit && (
          <>
            <span className="window-readout mono" title="Select window">
              {win.inSec.toFixed(1)}–{win.outSec.toFixed(1)}s
            </span>
            <button
              type="button"
              className="tbtn is-text"
              onClick={() => void setTakeWindow(take.id, null, null)}
              title="Clear select window"
            >
              <Icon name="close" size={13} />
            </button>
          </>
        )}
      </div>

      <div
        className="scrub"
        ref={trackRef}
        onPointerDown={(e) => {
          const el = trackRef.current
          if (!el) return
          onSeek(fractionFromEvent(e, el) * duration)
          setDrag('playhead')
        }}
      >
        <div className="scrub-track">
          <div className="scrub-buffered" style={{ width: '100%' }} />
          <div className="scrub-played" style={{ width: pct(time) }} />

          {win.explicit && (
            <div
              className="scrub-window"
              style={{ left: pct(win.inSec), width: `${((win.outSec - win.inSec) / Math.max(0.001, duration)) * 100}%` }}
            >
              <span
                className="win-handle win-in"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  setDrag('in')
                }}
                title={`Select in — ${win.inSec.toFixed(2)}s`}
              />
              <span
                className="win-handle win-out"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  setDrag('out')
                }}
                title={`Select out — ${win.outSec.toFixed(2)}s`}
              />
            </div>
          )}

          {showSuggestion && suggested && (
            <div
              className="scrub-window is-suggested"
              style={{
                left: pct(suggested.inSec),
                width: `${((suggested.outSec - suggested.inSec) / Math.max(0.001, duration)) * 100}%`,
              }}
              title={suggested.reason}
            />
          )}

          {ticks.map((tick, i) => (
            <button
              key={i}
              type="button"
              className={`scrub-tick v-${tick.verdict}`}
              style={{ left: pct(tick.t) }}
              title={tick.label}
              onPointerDown={(e) => {
                e.stopPropagation()
                onSeek(tick.t)
              }}
            />
          ))}

          <span className="scrub-head" style={{ left: pct(time) }} aria-hidden="true" />
        </div>
      </div>

      {showSuggestion && suggested && (
        <button
          type="button"
          className="suggest-chip"
          onClick={() => void applySuggestedWindow(take.id)}
          title={suggested.reason}
        >
          <Icon name="bracket" size={13} />
          <span className="caps">Gate suggests</span>
          <span className="mono">
            {suggested.inSec.toFixed(1)}–{suggested.outSec.toFixed(1)}s
          </span>
          <span className="suggest-apply caps">Apply</span>
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stage — single / side-by-side / wipe
// ---------------------------------------------------------------------------

interface StageProps {
  a: Take
  b: Take | null
  wipe: number | null
  time: number
  playing: boolean
  onTime: (t: number) => void
  onWipe: (v: number) => void
  circleAnimKey?: number
}

function Stage({ a, b, wipe, time, playing, onTime, onWipe, circleAnimKey }: StageProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => {
      const el = stageRef.current
      if (el) onWipe(fractionFromEvent(e, el))
    }
    const up = () => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, onWipe])

  if (!b) {
    return (
      <div className="stage">
        <VideoSurface
          take={a}
          time={time}
          playing={playing}
          primary
          onTime={onTime}
          showCircle={a.circled}
          circleAnimKey={circleAnimKey}
        />
      </div>
    )
  }

  if (wipe === null) {
    return (
      <div className="stage is-split">
        <div className="split-half">
          <span className="ab-chip is-a mono">A</span>
          <VideoSurface take={a} time={time} playing={playing} primary onTime={onTime} showCircle={a.circled} />
          <span className="split-file mono">{a.fileName}</span>
        </div>
        <div className="split-half">
          <span className="ab-chip is-b mono">B</span>
          <VideoSurface take={b} time={time} playing={playing} primary={false} showCircle={b.circled} />
          <span className="split-file mono">{b.fileName}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="stage is-wipe" ref={stageRef}>
      <div className="wipe-layer">
        <VideoSurface take={a} time={time} playing={playing} primary onTime={onTime} showCircle={a.circled} />
      </div>
      <div className="wipe-layer is-b" style={{ clipPath: `inset(0 0 0 ${wipe * 100}%)` }}>
        <VideoSurface take={b} time={time} playing={playing} primary={false} showCircle={b.circled} />
      </div>
      <span className="ab-chip is-a mono">A · {a.fileName}</span>
      <span className="ab-chip is-b mono">B · {b.fileName}</span>
      <div
        className={`wipe-handle${dragging ? ' is-dragging' : ''}`}
        style={{ left: `${wipe * 100}%` }}
        onPointerDown={() => setDragging(true)}
        role="separator"
        aria-label="Wipe position"
      >
        <span className="wipe-line" />
        <span className="wipe-knob">
          <Icon name="chevronLeft" size={11} />
          <Icon name="chevronRight" size={11} />
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Take rows (left pane)
// ---------------------------------------------------------------------------

function TakeRow({
  take,
  index,
  selected,
  isB,
}: {
  take: Take
  index: number
  selected: boolean
  isB: boolean
}): JSX.Element {
  const project = useStore((s) => s.project)
  const selectTake = useStore((s) => s.selectTake)
  const setCompare = useStore((s) => s.setCompare)
  const setRating = useStore((s) => s.setRating)
  const progress = useStore((s) => s.gateProgress[take.id])

  const fps = take.probe?.fps ?? DEFAULT_FPS
  const dur = take.probe?.durationSec ?? 0
  const win = takeWindow(take)
  const cost = takeCost(take, project?.settings.modelRates)

  return (
    <article
      className={`take-row${selected ? ' is-selected' : ''}${isB ? ' is-b' : ''}${take.circled ? ' is-circled' : ''}`}
      onClick={() => selectTake(take.id)}
    >
      <div className="take-row-strip">
        <Filmstrip takeId={take.id} />
        {take.circled && (
          <span className="take-circle-mark">
            <CircleMark size={17} />
          </span>
        )}
        <span className="take-index mono">T{String(index + 1).padStart(2, '0')}</span>
        <span className="take-dur mono">{toTimecode(dur, fps)}</span>
        {win.explicit && (
          <span className="take-window mono" title="Select window set">
            <Icon name="bracket" size={10} />
            {win.inSec.toFixed(1)}–{win.outSec.toFixed(1)}
          </span>
        )}
      </div>

      <div className="take-row-body">
        <div className="take-row-line">
          <GateBadge gate={take.gate} size="sm" progressPct={progress?.pct} />
          <CheckDots checks={take.gate?.checks} size={5} />
          <span className="grow" />
          <StarRating value={take.rating} onChange={(r) => void setRating(take.id, r)} size={12} />
        </div>

        <div className="take-row-line">
          <span className="mono take-file" title={take.mediaPath}>
            {take.fileName}
          </span>
        </div>

        <div className="take-row-line">
          <ProvenanceChips provenance={take.provenance} cost={cost} compact />
          <span className="grow" />
          <button
            type="button"
            className={`btn tiny${isB ? ' is-on' : ' ghost'}`}
            onClick={(e) => {
              e.stopPropagation()
              setCompare(take.id)
            }}
            title="Compare against the selected take"
          >
            {isB ? 'B ✓' : 'Set as B'}
          </button>
        </div>

        {progress && take.gate?.status === 'running' && (
          <div className="take-progress">
            <span className="take-progress-fill" style={{ width: `${progress.pct}%` }} />
            <span className="take-progress-label caps">{progress.stage}</span>
          </div>
        )}
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Gate panel (right pane)
// ---------------------------------------------------------------------------

function CheckRow({
  id,
  take,
  report,
  time,
  onSeek,
}: {
  id: CheckId
  take: Take
  report: GateReport | null | undefined
  time: number
  onSeek: (t: number) => void
}): JSX.Element | null {
  const summary = take.gate?.checks[id]
  const full = report?.checks[id]
  if (!summary) return null
  const fps = take.probe?.fps ?? DEFAULT_FPS
  const skipped = summary.verdict === 'skip'

  return (
    <section className={`check-row v-${summary.verdict}`}>
      <header className="check-head">
        <span className={`check-dot v-${summary.verdict}`} />
        <h4 className="check-label caps">{CHECK_LABEL[id]}</h4>
        <span className="grow" />
        <span className={`check-verdict caps v-${summary.verdict}`}>{summary.verdict}</span>
        {!skipped && <span className="check-score mono">{summary.score}</span>}
      </header>

      {full?.series && full.series.length > 1 && (
        <Sparkline
          series={full.series}
          threshold={full.threshold}
          verdict={summary.verdict}
          width={296}
          height={30}
          playhead={time}
          onScrub={onSeek}
        />
      )}

      <p className="check-reason">{summary.reason}</p>

      {full?.evidence && full.evidence.length > 0 && (
        <div className="evidence-strip">
          {full.evidence.map((e) => (
            <EvidenceChip
              key={`${e.frame}-${e.image}`}
              takeId={take.id}
              frame={e}
              verdict={summary.verdict}
              fps={fps}
              onSeek={onSeek}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function GatePanel({
  take,
  report,
  time,
  onSeek,
}: {
  take: Take
  report: GateReport | null | undefined
  time: number
  onSeek: (t: number) => void
}): JSX.Element {
  const runGate = useStore((s) => s.runGate)
  const openReport = useStore((s) => s.openReport)
  const progress = useStore((s) => s.gateProgress[take.id])
  const running = take.gate?.status === 'running'
  const gated = !!take.gate && !running

  return (
    <aside className="pane gate-panel">
      <header className="pane-head">
        <h2 className="caps section-title">Gate</h2>
        <span className="grow" />
        {take.gate?.ranAt && !running && (
          <span className="mono pane-meta" title={take.gate.ranAt}>
            {new Date(take.gate.ranAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
      </header>

      <div className="gate-overall">
        <GateBadge gate={take.gate} size="lg" countUp progressPct={progress?.pct} />
        <CheckDots checks={take.gate?.checks} size={7} labelled />
        {running && progress && <span className="gate-stage caps">{progress.stage}</span>}
      </div>

      <div className="gate-actions">
        <button
          type="button"
          className={`btn ${gated ? 'ghost' : 'primary'} wide`}
          disabled={running}
          onClick={() => void runGate(take.id)}
        >
          <Icon name={gated ? 'refresh' : 'check'} size={14} />
          {running ? `Gating… ${progress?.pct ?? 0}%` : gated ? 'Re-run gate' : 'Run gate'}
        </button>
        <button
          type="button"
          className="btn ghost wide"
          disabled={!gated}
          onClick={() => openReport(take.id)}
        >
          <Icon name="print" size={14} />
          Open full report
        </button>
      </div>

      <div className="gate-checks scroll-y">
        {take.gate ? (
          CHECK_IDS.map((id) => (
            <CheckRow key={id} id={id} take={take} report={report} time={time} onSeek={onSeek} />
          ))
        ) : (
          <EmptyState
            size="sm"
            title="Not gated yet"
            hint="Run the gate to measure identity, temporal integrity, anatomy, continuity and conformance."
          />
        )}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Village
// ---------------------------------------------------------------------------

export function Village(): JSX.Element {
  const project = useStore((s) => s.project)
  const selectedShotId = useStore((s) => s.selectedShotId)
  const selectedTakeId = useStore((s) => s.selectedTakeId)
  const compareTakeId = useStore((s) => s.compareTakeId)
  const wipe = useStore((s) => s.wipe)
  const setWipe = useStore((s) => s.setWipe)
  const toggleWipeMode = useStore((s) => s.toggleWipeMode)
  const selectShot = useStore((s) => s.selectShot)
  const selectTake = useStore((s) => s.selectTake)
  const toggleCircle = useStore((s) => s.toggleCircle)
  const setRating = useStore((s) => s.setRating)
  const setTakeWindow = useStore((s) => s.setTakeWindow)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const loadReport = useStore((s) => s.loadReport)
  const reports = useStore((s) => s.reports)

  const shots = useMemo(() => shotsInOrder(project), [project])
  const shot: Shot | null = shotById(project, selectedShotId)
  const takes = useMemo(() => takesForShot(project, shot?.id ?? ''), [project, shot])
  const take = takeById(project, selectedTakeId) ?? takes[0] ?? null
  // Comparing a take with itself is meaningless — treat it as no compare.
  const compareTake = compareTakeId === take?.id ? null : takeById(project, compareTakeId)
  const report = take ? reports[take.id] : undefined

  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [circleAnimKey, setCircleAnimKey] = useState<number | undefined>(undefined)

  const duration = take?.probe?.durationSec ?? 0
  const fps = take?.probe?.fps ?? DEFAULT_FPS
  const synthetic = media().synthetic

  useEffect(() => {
    if (take && reports[take.id] === undefined) void loadReport(take.id)
  }, [take, reports, loadReport])

  useEffect(() => {
    setTime(0)
    setPlaying(false)
    setRate(1)
  }, [take?.id])

  // Synthetic playback clock (mock mode has no real media to drive timeupdate).
  useEffect(() => {
    if (!synthetic || !playing || duration <= 0) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setTime((t) => {
        const next = t + dt * rate
        if (next >= duration) return 0
        if (next < 0) return duration
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [synthetic, playing, rate, duration])

  const seek = useCallback(
    (t: number) => {
      const clamped = clamp(t, 0, Math.max(0, duration))
      setTime(clamped)
      setPlayhead(clamped)
    },
    [duration, setPlayhead],
  )

  const step = useCallback(
    (frames: number) => {
      setPlaying(false)
      seek(time + frames / fps)
    },
    [seek, time, fps],
  )

  const circleCurrent = useCallback(() => {
    if (!take) return
    if (!take.circled) setCircleAnimKey(Date.now())
    void toggleCircle(take.id)
  }, [take, toggleCircle])

  // Keyboard: the whole review loop without leaving the keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const shotIdx = shots.findIndex((s) => s.id === shot?.id)
      const takeIdx = takes.findIndex((t) => t.id === take?.id)

      switch (e.key) {
        case ' ':
          e.preventDefault()
          setRate(1)
          setPlaying((p) => !p)
          return
        case 'j':
        case 'J':
          e.preventDefault()
          setPlaying(true)
          setRate((r) => (r > 0 ? -1 : Math.max(-8, r * 2)))
          return
        case 'k':
        case 'K':
          e.preventDefault()
          setPlaying(false)
          setRate(1)
          return
        case 'l':
        case 'L':
          e.preventDefault()
          setPlaying(true)
          setRate((r) => (r < 0 ? 1 : Math.min(8, r * 2)))
          return
        case ',':
        case 'ArrowLeft':
          e.preventDefault()
          step(-1)
          return
        case '.':
        case 'ArrowRight':
          e.preventDefault()
          step(1)
          return
        case 'ArrowUp':
          e.preventDefault()
          if (takeIdx > 0) selectTake(takes[takeIdx - 1]?.id ?? null)
          return
        case 'ArrowDown':
          e.preventDefault()
          if (takeIdx >= 0 && takeIdx < takes.length - 1) selectTake(takes[takeIdx + 1]?.id ?? null)
          return
        case '[':
          e.preventDefault()
          if (shotIdx > 0) selectShot(shots[shotIdx - 1]?.id ?? null)
          return
        case ']':
          e.preventDefault()
          if (shotIdx >= 0 && shotIdx < shots.length - 1) selectShot(shots[shotIdx + 1]?.id ?? null)
          return
        case 'c':
        case 'C':
          e.preventDefault()
          circleCurrent()
          return
        case 'i':
        case 'I':
          if (take) void setTakeWindow(take.id, time, Math.max(takeWindow(take).outSec, time + 0.1))
          return
        case 'o':
        case 'O':
          if (take) void setTakeWindow(take.id, Math.min(takeWindow(take).inSec, time - 0.1), time)
          return
        case 'w':
        case 'W':
          if (compareTakeId) toggleWipeMode()
          return
        case '0':
        case '1':
        case '2':
        case '3':
          if (take) void setRating(take.id, Number(e.key) as 0 | 1 | 2 | 3)
          return
        default:
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    shots,
    takes,
    shot,
    take,
    time,
    compareTakeId,
    selectShot,
    selectTake,
    step,
    circleCurrent,
    setRating,
    setTakeWindow,
    toggleWipeMode,
  ])

  if (!shot) {
    return (
      <EmptyState
        title="No shot selected"
        hint="Pick a shot in the Bin, or add one to start binding takes."
        mark={<Icon name="village" size={30} />}
      />
    )
  }

  const shotIdx = shots.findIndex((s) => s.id === shot.id)
  const models = shotModels(project, shot.id)

  return (
    <div className="village">
      {/* ---------------- LEFT: takes ---------------- */}
      <aside className="pane take-pane">
        <header className="shot-switcher">
          <button
            type="button"
            className="icon-btn"
            disabled={shotIdx <= 0}
            onClick={() => selectShot(shots[shotIdx - 1]?.id ?? null)}
            title="Previous shot ([)"
          >
            <Icon name="chevronLeft" size={15} />
          </button>
          <div className="select-wrap">
            <select
              className="select"
              value={shot.id}
              onChange={(e) => selectShot(e.target.value)}
              aria-label="Shot"
            >
              {shots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.description ?? 'untitled'}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={14} className="select-caret" />
          </div>
          <button
            type="button"
            className="icon-btn"
            disabled={shotIdx >= shots.length - 1}
            onClick={() => selectShot(shots[shotIdx + 1]?.id ?? null)}
            title="Next shot (])"
          >
            <Icon name="chevronRight" size={15} />
          </button>
        </header>

        <div className="shot-brief">
          <h2 className="shot-brief-name">{shot.name}</h2>
          {shot.description && <p className="shot-brief-desc">{shot.description}</p>}
          <div className="shot-brief-row">
            <span className="mono section-count">{takes.length} takes</span>
            {models.length > 1 && <ModelMixChip models={models} />}
          </div>
        </div>

        <div className="take-list scroll-y">
          {takes.length === 0 ? (
            <EmptyState size="sm" title="No takes bound" hint="Drop media on this shot in the Bin." />
          ) : (
            takes.map((t, i) => (
              <TakeRow
                key={t.id}
                take={t}
                index={i}
                selected={t.id === take?.id}
                isB={t.id === compareTakeId}
              />
            ))
          )}
        </div>
      </aside>

      {/* ---------------- CENTER: player ---------------- */}
      <section className="player-pane">
        {take ? (
          <>
            <Stage
              a={take}
              b={compareTake}
              wipe={wipe}
              time={time}
              playing={playing}
              onTime={(t) => setTime(t)}
              onWipe={setWipe}
              circleAnimKey={circleAnimKey}
            />

            <Transport
              take={take}
              duration={duration}
              fps={fps}
              time={time}
              playing={playing}
              rate={rate}
              report={report}
              onSeek={seek}
              onTogglePlay={() => {
                setRate(1)
                setPlaying((p) => !p)
              }}
              onStep={step}
            />

            <div className="player-foot">
              <button
                type="button"
                className={`btn circle-btn${take.circled ? ' is-on' : ''}`}
                onClick={circleCurrent}
                title="Circle this take (C)"
              >
                <CircleMark size={15} />
                {take.circled ? 'Circled' : 'Circle take'}
              </button>
              <StarRating value={take.rating} onChange={(r) => void setRating(take.id, r)} size={14} />
              <span className="grow" />
              <ProvenanceChips
                provenance={take.provenance}
                cost={takeCost(take, project?.settings.modelRates)}
                modelWarn={models.length > 1}
              />
              {compareTake && (
                <button type="button" className="btn ghost tiny" onClick={toggleWipeMode}>
                  <Icon name={wipe === null ? 'wipe' : 'compare'} size={13} />
                  {wipe === null ? 'Wipe' : 'Split'}
                </button>
              )}
            </div>

            {compareTake && <RecipeDiff a={take} b={compareTake} />}

            {!compareTake && take.provenance.prompt && (
              <details className="prompt-block">
                <summary className="caps">Prompt</summary>
                <p className="mono prompt-text">{take.provenance.prompt}</p>
              </details>
            )}
          </>
        ) : (
          <EmptyState
            title="No take selected"
            hint="Bind takes to this shot in the Bin, or drop media anywhere."
            mark={<Icon name="film" size={30} />}
          />
        )}
      </section>

      {/* ---------------- RIGHT: gate ---------------- */}
      {take ? (
        <GatePanel take={take} report={report} time={time} onSeek={seek} />
      ) : (
        <aside className="pane gate-panel" />
      )}
    </div>
  )
}
