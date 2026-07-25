import { toTimecode, type EvidenceFrame, type Verdict } from '@shared/types'
import { media } from '../media'

/**
 * A worst-frame extraction: thumbnail, a corner flag triangle in the verdict
 * colour, and the frame number in mono. Clicking seeks the player to that
 * moment — the gate's claim is always one click from being checked by eye.
 */

export interface EvidenceChipProps {
  takeId: string
  frame: EvidenceFrame
  verdict: Verdict
  fps: number
  size?: 'sm' | 'lg'
  onSeek?: (t: number) => void
}

export function EvidenceChip({
  takeId,
  frame,
  verdict,
  fps,
  size = 'sm',
  onSeek,
}: EvidenceChipProps): JSX.Element {
  const r = media()
  return (
    <button
      type="button"
      className={`evidence-chip v-${verdict} size-${size}`}
      onClick={onSeek ? () => onSeek(frame.t) : undefined}
      title={`${frame.caption} — frame ${frame.frame} (${toTimecode(frame.t, fps)})`}
    >
      <span className="evidence-thumb">
        <img src={r.evidence(takeId, frame.image)} alt="" draggable={false} />
        <span className="evidence-flag" aria-hidden="true" />
      </span>
      <span className="evidence-meta">
        <span className="mono evidence-frame">f{frame.frame}</span>
        {size === 'lg' && <span className="mono evidence-tc">{toTimecode(frame.t, fps)}</span>}
      </span>
      {size === 'lg' && <span className="evidence-caption">{frame.caption}</span>}
    </button>
  )
}
