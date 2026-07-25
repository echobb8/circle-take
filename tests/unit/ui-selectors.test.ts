import { describe, expect, it } from 'vitest'
import type { GateStatus, Project, Rating, Shot, Take } from '@shared/types'
import {
  bestTake,
  circledInCutOrder,
  gateRank,
  hasModelMix,
  isGraded,
  reshootShots,
  selectsRuntime,
  shotModels,
  shotNeedsReshoot,
  shotStats,
  shotsInOrder,
  spendForProject,
  spendForShot,
  takeCutDuration,
  takeWindow,
  takesForShot,
  unassignedTakes,
  UNGATED_RANK,
} from '@renderer/store'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function shot(id: string, name: string, order: number, characterIds: string[] = []): Shot {
  return { id, name, order, characterIds }
}

interface TakeOpts {
  status?: GateStatus
  overall?: number
  circled?: boolean
  rating?: Rating
  fileName?: string
  model?: string
  durationSec?: number
  inSec?: number
  outSec?: number
}

function take(id: string, shotId: string, opts: TakeOpts = {}): Take {
  const {
    status,
    overall = 0,
    circled = false,
    rating = 0,
    fileName = `${id}.mp4`,
    model,
    durationSec = 5,
    inSec,
    outSec,
  } = opts
  return {
    id,
    shotId,
    mediaPath: `/media/${fileName}`,
    fileName,
    ingestedAt: '2026-07-21T00:00:00.000Z',
    provenance: model ? { model } : {},
    probe: { durationSec, fps: 24, width: 1920, height: 1080, codec: 'h264' },
    ...(status
      ? {
          gate: {
            status,
            overall,
            checks: {},
            engineVersion: '1.0.0',
            ranAt: '2026-07-22T00:00:00.000Z',
          },
        }
      : {}),
    circled,
    rating,
    ...(inSec != null ? { inSec } : {}),
    ...(outSec != null ? { outSec } : {}),
  }
}

function project(shots: Shot[], takes: Take[], rates?: Record<string, number>): Project {
  return {
    schema: 1,
    name: 'FIXTURE',
    createdAt: '2026-07-20T00:00:00.000Z',
    settings: { copyMediaIntoProject: false, ...(rates ? { modelRates: rates } : {}) },
    shots,
    takes,
    characters: [],
  }
}

// ---------------------------------------------------------------------------

describe('gateRank', () => {
  it('orders pass before flag before fail', () => {
    expect(gateRank(take('a', 's', { status: 'pass' }))).toBeLessThan(
      gateRank(take('b', 's', { status: 'flag' })),
    )
    expect(gateRank(take('b', 's', { status: 'flag' }))).toBeLessThan(
      gateRank(take('c', 's', { status: 'fail' })),
    )
  })

  it('sinks ungated takes below every graded one', () => {
    expect(gateRank(take('u', 's'))).toBe(UNGATED_RANK)
    expect(gateRank(take('e', 's', { status: 'error' }))).toBeLessThan(UNGATED_RANK)
  })
})

describe('takesForShot', () => {
  it('returns only takes bound to the shot', () => {
    const p = project(
      [shot('s1', '12', 0), shot('s2', '14', 1)],
      [take('t1', 's1'), take('t2', 's2'), take('t3', 's1')],
    )
    expect(takesForShot(p, 's1').map((t) => t.id).sort()).toEqual(['t1', 't3'])
  })

  it('puts the circled take first even when another take scores higher', () => {
    const p = project(
      [shot('s1', '12', 0)],
      [
        take('hi', 's1', { status: 'pass', overall: 96 }),
        take('circled', 's1', { status: 'flag', overall: 61, circled: true }),
      ],
    )
    expect(takesForShot(p, 's1')[0]?.id).toBe('circled')
  })

  it('orders by gate status, then overall, then rating', () => {
    const p = project(
      [shot('s1', '12', 0)],
      [
        take('fail', 's1', { status: 'fail', overall: 40 }),
        take('ungated', 's1'),
        take('pass-low', 's1', { status: 'pass', overall: 87 }),
        take('flag', 's1', { status: 'flag', overall: 70 }),
        take('pass-high', 's1', { status: 'pass', overall: 94 }),
      ],
    )
    expect(takesForShot(p, 's1').map((t) => t.id)).toEqual([
      'pass-high',
      'pass-low',
      'flag',
      'fail',
      'ungated',
    ])
  })

  it('breaks ties on rating, then filename, so ordering is stable', () => {
    const p = project(
      [shot('s1', '12', 0)],
      [
        take('b', 's1', { status: 'pass', overall: 90, rating: 1, fileName: 'b.mp4' }),
        take('a', 's1', { status: 'pass', overall: 90, rating: 1, fileName: 'a.mp4' }),
        take('c', 's1', { status: 'pass', overall: 90, rating: 3, fileName: 'c.mp4' }),
      ],
    )
    expect(takesForShot(p, 's1').map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })

  it('is empty for a null project', () => {
    expect(takesForShot(null, 's1')).toEqual([])
  })
})

describe('bestTake', () => {
  it('is the head of takesForShot', () => {
    const p = project(
      [shot('s1', '12', 0)],
      [take('lo', 's1', { status: 'flag', overall: 60 }), take('hi', 's1', { status: 'pass', overall: 91 })],
    )
    expect(bestTake(p, 's1')?.id).toBe('hi')
  })

  it('is null when the shot has no takes', () => {
    expect(bestTake(project([shot('s1', '12', 0)], []), 's1')).toBeNull()
  })
})

describe('unassignedTakes', () => {
  it('collects takes with an empty shotId', () => {
    const p = project([shot('s1', '12', 0)], [take('bound', 's1'), take('loose', '')])
    expect(unassignedTakes(p).map((t) => t.id)).toEqual(['loose'])
  })
})

describe('shotNeedsReshoot', () => {
  it('is false when a take is circled', () => {
    const p = project([shot('s1', '12', 0)], [take('t', 's1', { status: 'fail', circled: true })])
    expect(shotNeedsReshoot(p, 's1')).toBe(false)
  })

  it('is false when any take passes the gate', () => {
    const p = project([shot('s1', '12', 0)], [take('t', 's1', { status: 'pass', overall: 90 })])
    expect(shotNeedsReshoot(p, 's1')).toBe(false)
  })

  it('is true when every take only flags or fails', () => {
    const p = project(
      [shot('s1', '12', 0)],
      [take('a', 's1', { status: 'flag' }), take('b', 's1', { status: 'fail' })],
    )
    expect(shotNeedsReshoot(p, 's1')).toBe(true)
  })

  it('is true for a shot with no takes at all', () => {
    expect(shotNeedsReshoot(project([shot('s1', '12', 0)], []), 's1')).toBe(true)
  })

  it('is false for a null project', () => {
    expect(shotNeedsReshoot(null, 's1')).toBe(false)
  })
})

describe('isGraded', () => {
  it('accepts only settled verdicts', () => {
    expect(isGraded(take('a', 's', { status: 'pass' }))).toBe(true)
    expect(isGraded(take('b', 's', { status: 'flag' }))).toBe(true)
    expect(isGraded(take('c', 's', { status: 'fail' }))).toBe(true)
    expect(isGraded(take('d', 's', { status: 'running' }))).toBe(false)
    expect(isGraded(take('e', 's', { status: 'error' }))).toBe(false)
    expect(isGraded(take('f', 's'))).toBe(false)
  })
})

describe('shotStats', () => {
  it('counts shots, takes, graded, circled and reshoots', () => {
    const p = project(
      [shot('s1', '12', 0), shot('s2', '14', 1), shot('s3', '18', 2)],
      [
        take('a', 's1', { status: 'pass', overall: 90 }),
        take('b', 's1', { status: 'flag', overall: 70, circled: true }),
        take('c', 's2', { status: 'fail', overall: 30 }),
        take('d', 's2', { status: 'running' }),
        take('e', ''),
      ],
    )
    expect(shotStats(p)).toEqual({
      shots: 3,
      takes: 5,
      gated: 3,
      circled: 1,
      // s2 has only a fail + a running take; s3 has none.
      needsReshoot: 2,
      spend: 0,
    })
  })

  it('is all zeros for a null project', () => {
    expect(shotStats(null)).toEqual({
      shots: 0,
      takes: 0,
      gated: 0,
      circled: 0,
      needsReshoot: 0,
      spend: 0,
    })
  })

  it('sums spend from the rate card, falling back to "*"', () => {
    const p = project(
      [shot('s1', '12', 0)],
      [
        take('a', 's1', { model: 'veo-3.1-cine' }),
        take('b', 's1', { model: 'kling-2.5-master' }),
        take('c', 's1', { model: 'unpriced-model' }),
      ],
      { 'veo-3.1-cine': 1.2, 'kling-2.5-master': 0.65, '*': 0.5 },
    )
    expect(shotStats(p).spend).toBeCloseTo(2.35, 5)
  })
})

describe('shotsInOrder', () => {
  it('sorts by the cut order field, not array position', () => {
    const p = project([shot('c', '31A', 2), shot('a', '12', 0), shot('b', '14', 1)], [])
    expect(shotsInOrder(p).map((s) => s.name)).toEqual(['12', '14', '31A'])
  })
})

describe('model mix', () => {
  it('lists distinct models for a shot', () => {
    const p = project(
      [shot('s1', '12', 0)],
      [
        take('a', 's1', { model: 'veo-3.1-cine' }),
        take('b', 's1', { model: 'kling-2.5-master' }),
        take('c', 's1', { model: 'veo-3.1-cine' }),
      ],
    )
    expect(shotModels(p, 's1')).toEqual(['kling-2.5-master', 'veo-3.1-cine'])
    expect(hasModelMix(p, 's1')).toBe(true)
  })

  it('is not a mix when every take shares a model', () => {
    const p = project(
      [shot('s1', '12', 0)],
      [take('a', 's1', { model: 'veo-3.1-cine' }), take('b', 's1', { model: 'veo-3.1-cine' })],
    )
    expect(hasModelMix(p, 's1')).toBe(false)
  })

  it('ignores takes with no model recorded', () => {
    const p = project([shot('s1', '12', 0)], [take('a', 's1', { model: 'veo-3.1-cine' }), take('b', 's1')])
    expect(shotModels(p, 's1')).toEqual(['veo-3.1-cine'])
  })
})

describe('select windows', () => {
  it('falls back to the whole clip when no window is set', () => {
    const t = take('a', 's1', { durationSec: 7 })
    expect(takeWindow(t)).toEqual({ inSec: 0, outSec: 7, explicit: false })
    expect(takeCutDuration(t)).toBe(7)
  })

  it('honours an explicit window', () => {
    const t = take('a', 's1', { durationSec: 7, inSec: 1.5, outSec: 4.5 })
    expect(takeWindow(t)).toEqual({ inSec: 1.5, outSec: 4.5, explicit: true })
    expect(takeCutDuration(t)).toBe(3)
  })

  it('treats a lone in-point as explicit and runs to the end', () => {
    const t = take('a', 's1', { durationSec: 6, inSec: 2 })
    expect(takeWindow(t)).toEqual({ inSec: 2, outSec: 6, explicit: true })
  })
})

describe('circledInCutOrder / selectsRuntime', () => {
  it('walks shots in cut order and honours select windows', () => {
    const p = project(
      [shot('s2', '14', 1), shot('s1', '12', 0)],
      [
        take('later', 's2', { circled: true, durationSec: 5 }),
        take('earlier', 's1', { circled: true, durationSec: 6, inSec: 1, outSec: 3 }),
        take('nope', 's1', { durationSec: 9 }),
      ],
    )
    expect(circledInCutOrder(p).map((r) => r.take.id)).toEqual(['earlier', 'later'])
    expect(selectsRuntime(p)).toBe(7) // 2s windowed + 5s full
  })
})

describe('reshootShots', () => {
  it('lists failing shots in cut order with the best take so far', () => {
    const p = project(
      [shot('s1', '12', 0), shot('s2', '14', 1)],
      [
        take('ok', 's1', { status: 'pass', overall: 90 }),
        take('bad', 's2', { status: 'fail', overall: 30 }),
        take('less-bad', 's2', { status: 'flag', overall: 66 }),
      ],
    )
    const out = reshootShots(p)
    expect(out.map((r) => r.shot.name)).toEqual(['14'])
    expect(out[0]?.best?.id).toBe('less-bad')
  })

  it('reports a null best take for a shot with no footage', () => {
    const p = project([shot('s1', '12', 0)], [])
    expect(reshootShots(p)[0]?.best).toBeNull()
  })
})

describe('cost ledger', () => {
  const rates = { 'veo-3.1-cine': 1.2, 'kling-2.5-master': 0.65 }

  it('computes spend, hit-rate and cost per usable second for a shot', () => {
    const p = project(
      [shot('s1', '12', 0)],
      [
        take('a', 's1', { model: 'veo-3.1-cine', status: 'fail' }),
        take('b', 's1', { model: 'veo-3.1-cine', status: 'fail' }),
        take('c', 's1', { model: 'kling-2.5-master', status: 'pass', durationSec: 4 }),
      ],
      rates,
    )
    const s = spendForShot(p, 's1')
    expect(s.spend).toBeCloseTo(3.05, 5)
    expect(s.takes).toBe(3)
    expect(s.usable).toBe(1)
    expect(s.hitRate).toBeCloseTo(1 / 3, 5)
    expect(s.costPerUsableSec).toBeCloseTo(3.05 / 4, 5)
  })

  it('reports a null cost-per-second when nothing is usable', () => {
    const p = project([shot('s1', '12', 0)], [take('a', 's1', { model: 'veo-3.1-cine', status: 'fail' })], rates)
    expect(spendForShot(p, 's1').costPerUsableSec).toBeNull()
  })

  it('rolls up the whole project', () => {
    const p = project(
      [shot('s1', '12', 0), shot('s2', '14', 1)],
      [
        take('a', 's1', { model: 'veo-3.1-cine', status: 'pass', durationSec: 5 }),
        take('b', 's2', { model: 'kling-2.5-master', status: 'fail' }),
      ],
      rates,
    )
    expect(spendForProject(p).spend).toBeCloseTo(1.85, 5)
    expect(spendForProject(p).usable).toBe(1)
  })

  it('is empty for a null project', () => {
    expect(spendForProject(null)).toEqual({
      spend: 0,
      takes: 0,
      usable: 0,
      hitRate: 0,
      costPerUsableSec: null,
    })
  })
})
