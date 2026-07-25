/**
 * The four pure export builders: FCPXML, EDL, reshoot list, CSV.
 * These are the app's output contract with the NLE — the rational time math
 * and the escaping get asserted precisely.
 */

import { describe, it, expect } from 'vitest'
import {
  buildFcpxml,
  circledTakesInOrder,
  escapeXml,
  fileUrl,
  frameDuration,
  framesFor,
  isDropFrame,
  rationalFrames,
  reduceFraction,
  takeWindow,
} from '../../src/shared/fcpxml'
import { buildEdl, edlEventLine, edlTitle, framesToTimecode } from '../../src/shared/edl'
import { buildReshootList, bestTakeForShot, shotNeedsReshoot } from '../../src/shared/reshoot'
import { buildCsv, csvEscape, csvRow } from '../../src/shared/csv'
import { PROJECT_SCHEMA_VERSION } from '../../src/shared/types'
import type { GateSummary, Project, Shot, Take } from '../../src/shared/types'

/* ------------------------------- fixtures ------------------------------- */

function shot(id: string, name: string, order: number, extra: Partial<Shot> = {}): Shot {
  return { id, name, order, characterIds: [], ...extra }
}

function take(id: string, shotId: string, extra: Partial<Take> = {}): Take {
  return {
    id,
    shotId,
    mediaPath: `/media/${id}.mp4`,
    fileName: `${id}.mp4`,
    ingestedAt: '2026-07-24T00:00:00.000Z',
    provenance: {},
    circled: false,
    rating: 0,
    ...extra,
  }
}

function gate(status: GateSummary['status'], overall: number, checks: GateSummary['checks'] = {}): GateSummary {
  return { status, overall, checks, engineVersion: '1.0.0', ranAt: '2026-07-24T00:00:00.000Z' }
}

function project(extra: Partial<Project> = {}): Project {
  return {
    schema: PROJECT_SCHEMA_VERSION,
    name: 'Nightfall',
    createdAt: '2026-07-24T00:00:00.000Z',
    settings: { copyMediaIntoProject: false },
    shots: [],
    takes: [],
    characters: [],
    ...extra,
  }
}

/* -------------------------------- FCPXML -------------------------------- */

describe('rational time math', () => {
  it('reduces fractions to lowest terms', () => {
    expect(reduceFraction(48, 24)).toEqual({ num: 2, den: 1 })
    expect(reduceFraction(12, 24)).toEqual({ num: 1, den: 2 })
    expect(reduceFraction(24024, 24000)).toEqual({ num: 1001, den: 1000 })
  })

  it('uses the FCPXML frame-duration table', () => {
    expect(frameDuration(24)).toEqual({ num: 1, den: 24 })
    expect(frameDuration(25)).toEqual({ num: 1, den: 25 })
    expect(frameDuration(30)).toEqual({ num: 1, den: 30 })
    expect(frameDuration(60)).toEqual({ num: 1, den: 60 })
    expect(frameDuration(23.976)).toEqual({ num: 1001, den: 24000 })
    expect(frameDuration(29.97)).toEqual({ num: 1001, den: 30000 })
  })

  it('writes reduced rational seconds, never floats', () => {
    expect(rationalFrames(48, 24)).toBe('2/1s')
    expect(rationalFrames(12, 24)).toBe('1/2s')
    expect(rationalFrames(0, 24)).toBe('0s')
    // 24 frames at 23.976 is exactly 1.001 seconds.
    expect(rationalFrames(24, 23.976)).toBe('1001/1000s')
    expect(rationalFrames(30, 29.97)).toBe('1001/1000s')
  })

  it('flags only 29.97/59.94 as drop frame — 23.976 is NDF', () => {
    expect(isDropFrame(29.97)).toBe(true)
    expect(isDropFrame(59.94)).toBe(true)
    expect(isDropFrame(23.976)).toBe(false)
    expect(isDropFrame(24)).toBe(false)
  })

  it('rounds seconds to whole frames', () => {
    expect(framesFor(2, 24)).toBe(48)
    expect(framesFor(0, 24)).toBe(0)
    expect(framesFor(-3, 24)).toBe(0)
  })
})

describe('fileUrl', () => {
  it('percent-encodes spaces and specials', () => {
    expect(fileUrl('/Volumes/My Drive/shot 002.mov')).toBe(
      'file:///Volumes/My%20Drive/shot%20002.mov',
    )
    expect(fileUrl('/media/a&b#1.mp4')).toBe('file:///media/a%26b%231.mp4')
  })
})

describe('escapeXml', () => {
  it('escapes all five entities', () => {
    expect(escapeXml(`R&D <"go">'`)).toBe('R&amp;D &lt;&quot;go&quot;&gt;&apos;')
  })
})

describe('circledTakesInOrder', () => {
  it('follows shot order and appends unassigned circled takes last', () => {
    const p = project({
      shots: [shot('s2', '12B', 1), shot('s1', '12A', 0)],
      takes: [
        take('t3', '', { circled: true }),
        take('t2', 's2', { circled: true }),
        take('t1', 's1', { circled: true }),
        take('t0', 's1'),
      ],
    })
    expect(circledTakesInOrder(p).map((s) => s.take.id)).toEqual(['t1', 't2', 't3'])
  })
})

describe('takeWindow', () => {
  const p = project({ shots: [shot('s1', '12A', 0)] })
  const s = p.shots[0] ?? null

  it('uses the whole clip when no window is set', () => {
    const w = takeWindow(take('t1', 's1', { probe: probe(10) }), s, p)
    expect(w).toMatchObject({ inSec: 0, outSec: 10, lengthSec: 10, fullSec: 10 })
  })

  it('honours a manual window', () => {
    const w = takeWindow(take('t1', 's1', { probe: probe(10), inSec: 2, outSec: 6 }), s, p)
    expect(w).toMatchObject({ inSec: 2, outSec: 6, lengthSec: 4 })
  })

  it('falls back to the full clip for an inverted or empty window', () => {
    const w = takeWindow(take('t1', 's1', { probe: probe(10), inSec: 8, outSec: 3 }), s, p)
    expect(w).toMatchObject({ inSec: 0, outSec: 10 })
  })

  it('clamps a window that runs past the end of the media', () => {
    const w = takeWindow(take('t1', 's1', { probe: probe(10), inSec: 1, outSec: 99 }), s, p)
    expect(w.outSec).toBe(10)
  })
})

function probe(durationSec: number, fps = 24): Take['probe'] {
  return { durationSec, fps, width: 1920, height: 1080, codec: 'h264' }
}

describe('buildFcpxml', () => {
  const p = project({
    name: 'Night & Day',
    settings: { copyMediaIntoProject: false, expected: { fps: 24, width: 1920, height: 1080 } },
    shots: [shot('s1', '12A', 0), shot('s2', '12B', 1)],
    takes: [
      take('t1', 's1', { circled: true, probe: probe(2), mediaPath: '/media/shot 002.mov' }),
      take('t2', 's2', { circled: true, probe: probe(4), inSec: 1, outSec: 3 }),
      take('t3', 's2'),
    ],
  })
  const xml = buildFcpxml(p)

  it('is a well-formed FCPXML 1.11 document with the DOCTYPE', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n')).toBe(true)
    expect(xml).toContain('<fcpxml version="1.11">')
    expect(xml.trimEnd().endsWith('</fcpxml>')).toBe(true)
  })

  it('nests resources then library > event > project > sequence > spine', () => {
    const order = [
      '<resources>',
      '<format id="r0"',
      '<library>',
      '<event name=',
      '<project name=',
      '<sequence',
      '<spine>',
    ]
    let cursor = -1
    for (const token of order) {
      const at = xml.indexOf(token)
      expect(at, token).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('gives every asset a media-rep child and a format', () => {
    const assets = xml.match(/<asset /g) ?? []
    const reps = xml.match(/<media-rep kind="original-media"/g) ?? []
    expect(assets).toHaveLength(2) // only the circled takes
    expect(reps).toHaveLength(2)
    expect(xml).toContain('<asset id="r1"')
    expect(xml).toMatch(/<asset id="r1"[^>]*format="r0"/)
  })

  it('uses 1/24s frame duration and Rec.709 on the format', () => {
    expect(xml).toContain('frameDuration="1/24s"')
    expect(xml).toContain('colorSpace="1-1-1 (Rec. 709)"')
    expect(xml).toContain('width="1920" height="1080"')
  })

  it('lays clips end to end with reduced rational offsets', () => {
    // t1: 2s = 48 frames -> offset 0s, duration 2/1s
    expect(xml).toContain('offset="0s" duration="2/1s" start="0s"')
    // t2: window 1s..3s -> offset 2/1s, duration 2/1s, start 1/1s
    expect(xml).toContain('offset="2/1s" duration="2/1s" start="1/1s"')
    expect(xml).toContain('<sequence format="r0" duration="4/1s"')
  })

  it('escapes XML in names and percent-encodes the media URL', () => {
    expect(xml).toContain('Night &amp; Day')
    expect(xml).toContain('src="file:///media/shot%20002.mov"')
    expect(xml).not.toContain('Night & Day')
  })

  it('marks NDF at 24fps and DF at 29.97', () => {
    expect(xml).toContain('tcFormat="NDF"')
    const df = buildFcpxml(p, { fps: 29.97 })
    expect(df).toContain('tcFormat="DF"')
    expect(df).toContain('frameDuration="1001/30000s"')
  })

  it('still produces a valid document with no circled takes', () => {
    const empty = buildFcpxml(project())
    expect(empty).toContain('<spine>')
    expect(empty).toContain('duration="0s"')
    expect(empty).not.toContain('<asset ')
  })
})

/* ---------------------------------- EDL --------------------------------- */

describe('framesToTimecode', () => {
  it('converts non-drop frame counts', () => {
    expect(framesToTimecode(0, 24)).toBe('00:00:00:00')
    expect(framesToTimecode(24, 24)).toBe('00:00:01:00')
    expect(framesToTimecode(24 * 60, 24)).toBe('00:01:00:00')
    expect(framesToTimecode(24 * 3600 + 24 * 61 + 5, 24)).toBe('01:01:01:05')
  })

  it('uses a semicolon and skips frame numbers for drop frame', () => {
    expect(framesToTimecode(0, 29.97)).toBe('00:00:00;00')
    // Frame 1799 is the last of the first minute; 1800 skips ;00 and ;01.
    expect(framesToTimecode(1799, 29.97)).toBe('00:00:59;29')
    expect(framesToTimecode(1800, 29.97)).toBe('00:01:00;02')
    // The tenth minute is NOT dropped — the clock resyncs there.
    expect(framesToTimecode(17982, 29.97)).toBe('00:10:00;00')
  })

  it('wraps hours at 24', () => {
    expect(framesToTimecode(24 * 3600 * 24, 24)).toBe('00:00:00:00')
  })
})

describe('edlEventLine', () => {
  it('lays out CMX3600 columns', () => {
    const line = edlEventLine(1, 'AX', '00:00:00:00', '00:00:02:00', '00:00:00:00', '00:00:02:00')
    expect(line).toBe(
      '001  AX       V     C        00:00:00:00 00:00:02:00 00:00:00:00 00:00:02:00',
    )
  })

  it('truncates reel names to 8 characters', () => {
    const line = edlEventLine(12, 'VERYLONGREELNAME', '0', '0', '0', '0')
    expect(line.startsWith('012  VERYLONG ')).toBe(true)
  })
})

describe('edlTitle', () => {
  it('uppercases and strips newlines', () => {
    expect(edlTitle('Night\nFall')).toBe('NIGHT FALL')
    expect(edlTitle('   ')).toBe('UNTITLED')
  })
})

describe('buildEdl', () => {
  const p = project({
    settings: { copyMediaIntoProject: false, expected: { fps: 24 } },
    shots: [shot('s1', '12A', 0), shot('s2', '12B', 1)],
    takes: [
      take('t1', 's1', { circled: true, probe: probe(2) }),
      take('t2', 's2', { circled: true, probe: probe(4), inSec: 1, outSec: 3 }),
    ],
  })
  const edl = buildEdl(p)

  it('writes the header', () => {
    expect(edl.startsWith('TITLE: NIGHTFALL\nFCM: NON-DROP FRAME\n')).toBe(true)
  })

  it('accumulates record timecode across events', () => {
    expect(edl).toContain('001  AX       V     C        00:00:00:00 00:00:02:00 00:00:00:00 00:00:02:00')
    // Second event uses the take's window as source in/out (1s..3s).
    expect(edl).toContain('002  AX       V     C        00:00:01:00 00:00:03:00 00:00:02:00 00:00:04:00')
  })

  it('comments the source clip name', () => {
    expect(edl).toContain('* FROM CLIP NAME: t1.mp4')
    expect(edl).toContain('* SHOT: 12B')
  })

  it('switches to DROP FRAME at 29.97', () => {
    const df = buildEdl(p, { fps: 29.97 })
    expect(df).toContain('FCM: DROP FRAME')
    expect(df).toContain('00:00:00;00')
  })
})

/* ------------------------------ reshoot list ---------------------------- */

describe('reshoot list', () => {
  const failing = take('t1', 's1', {
    probe: probe(4),
    provenance: { generator: 'Runway', model: 'gen-4', seed: '12345', prompt: 'a bridge at dusk' },
    gate: gate('fail', 31, {
      identity: { verdict: 'fail', score: 22, reason: 'mean distance 0.62 over 0.45 threshold' },
      temporal: { verdict: 'flag', score: 61, reason: 'flicker in low-texture regions' },
      anatomy: { verdict: 'pass', score: 95, reason: 'no anomalies' },
    }),
  })
  const p = project({
    shots: [
      shot('s1', '12A', 0, { description: 'Wide on the bridge' }),
      shot('s2', '12B', 1),
      shot('s3', '12C', 2),
    ],
    takes: [failing, take('t2', 's3', { circled: true, gate: gate('pass', 91) })],
  })

  it('picks the highest-scoring take as best', () => {
    const p2 = project({
      shots: [shot('s1', '12A', 0)],
      takes: [
        take('a', 's1', { gate: gate('fail', 30) }),
        take('b', 's1', { gate: gate('flag', 70) }),
        take('c', 's1'),
      ],
    })
    expect(bestTakeForShot(p2, 's1')?.id).toBe('b')
  })

  it('lists shots with no circled take, and skips satisfied shots', () => {
    expect(shotNeedsReshoot(p, p.shots[0] as Shot)).toBe(true)
    expect(shotNeedsReshoot(p, p.shots[1] as Shot)).toBe(true) // no takes at all
    expect(shotNeedsReshoot(p, p.shots[2] as Shot)).toBe(false)
  })

  it('builds json with reasons, provenance and the full prompt', () => {
    const { json } = buildReshootList(p, {
      now: '2026-07-24T12:00:00.000Z',
      evidenceByTake: { t1: ['evidence/t1/f88.jpg'] },
    })
    expect(json.shotsNeedingReshoot).toBe(2)
    expect(json.entries).toHaveLength(2)
    const first = json.entries[0]
    expect(first?.shotName).toBe('12A')
    expect(first?.takesTried).toBe(1)
    expect(first?.prompt).toBe('a bridge at dusk')
    expect(first?.seed).toBe('12345')
    expect(first?.evidence).toEqual(['evidence/t1/f88.jpg'])
    // Only flagged/failed checks, worst first; the passing one is left out.
    expect(first?.reasons.map((r) => r.check)).toEqual(['identity', 'temporal'])
  })

  it('renders markdown with the prompt in a fenced block', () => {
    const { md } = buildReshootList(p, { now: '2026-07-24T12:00:00.000Z' })
    expect(md).toContain('# Reshoot list — Nightfall')
    expect(md).toContain('## 12A — Wide on the bridge')
    expect(md).toContain('**Identity** (fail, 22)')
    expect(md).toContain('```text\na bridge at dusk\n```')
    expect(md).toContain('- Best take: _none — no takes ingested yet_')
  })

  it('says so when nothing needs a reshoot', () => {
    const clean = project({
      shots: [shot('s1', '12A', 0)],
      takes: [take('t1', 's1', { circled: true })],
    })
    const { md, json } = buildReshootList(clean, { now: 'x' })
    expect(json.entries).toHaveLength(0)
    expect(md).toContain('Every shot has a circled take.')
  })
})

/* ---------------------------------- CSV --------------------------------- */

describe('csvEscape', () => {
  it('leaves plain values alone', () => {
    expect(csvEscape('12A')).toBe('12A')
  })

  it('quotes commas, quotes and newlines, doubling inner quotes', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
    expect(csvEscape('carriage\rreturn')).toBe('"carriage\rreturn"')
  })

  it('escapes every cell of a row', () => {
    expect(csvRow(['a', 'b,c'])).toBe('a,"b,c"')
  })
})

describe('buildCsv', () => {
  const p = project({
    settings: { copyMediaIntoProject: false, modelRates: { 'gen-4': 0.5, '*': 0.25 } },
    shots: [shot('s1', '12A', 0)],
    takes: [
      take('t1', 's1', {
        probe: probe(4),
        inSec: 1,
        outSec: 3,
        circled: true,
        rating: 3,
        provenance: { generator: 'Runway, Inc', model: 'gen-4', prompt: 'x', seed: '9' },
        gate: gate('flag', 72, {
          identity: { verdict: 'pass', score: 90, reason: 'ok' },
          temporal: { verdict: 'flag', score: 61, reason: 'flicker' },
        }),
      }),
      take('t2', 'missing-shot', { provenance: { model: 'other' } }),
    ],
  })
  const csv = buildCsv(p)
  const lines = csv.split('\r\n')

  it('uses CRLF and a header row', () => {
    expect(csv).toContain('\r\n')
    expect(lines[0]).toContain('Shot,Shot Order,File')
    expect(lines[0]).toContain('Identity,Temporal,Anatomy,Continuity,Conformance')
    expect(lines[0]).toContain('Cost,Circled,Rating')
  })

  it('quotes a generator name containing a comma', () => {
    expect(lines[1]).toContain('"Runway, Inc"')
  })

  it('writes window, per-check scores, cost and rating', () => {
    const row = lines[1] ?? ''
    expect(row).toContain('4.000,1.000,3.000,2.000') // duration, in, out, window
    expect(row).toContain('flag,72,90,61,,,')
    expect(row).toContain('0.50,yes,3')
  })

  it('labels takes with no shot as UNASSIGNED and falls back to the "*" rate', () => {
    const row = lines[2] ?? ''
    expect(row.startsWith('UNASSIGNED,,t2.mp4')).toBe(true)
    expect(row.endsWith('0.25,no,0')).toBe(true)
  })
})
