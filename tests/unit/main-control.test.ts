/**
 * The control-server action whitelist and its param validation, plus the pure
 * worker argv builders. These are the contract an agent (via MCP) and the
 * python engine both depend on.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CONTROL_ACTIONS,
  CONTROL_ACTION_NAMES,
  findAction,
  validateParams,
} from '../../src/main/controlActions'
import {
  expectedJson,
  gateArgs,
  kitBuildArgs,
  mergeExpected,
  WORKER_MODULE,
} from '../../src/main/workerArgs'
import { CHECK_IDS } from '../../src/shared/types'

/* ---------------------------- action whitelist -------------------------- */

describe('control action whitelist', () => {
  const REQUIRED = [
    'get_state',
    'open_project',
    'create_project',
    'add_shot',
    'update_shot',
    'ingest',
    'set_provenance',
    'assign_take',
    'run_gate',
    'run_gate_all',
    'gate_status',
    'get_gate_report',
    'circle_take',
    'set_rating',
    'set_take_window',
    'set_model_rates',
    'build_kit',
    'add_character',
    'add_kit_images',
    'export_fcpxml',
    'export_edl',
    'export_reshoot_list',
    'export_csv',
    'screenshot',
  ]

  it('exposes every documented action', () => {
    for (const name of REQUIRED) expect(CONTROL_ACTION_NAMES).toContain(name)
  })

  it('has no duplicates', () => {
    expect(new Set(CONTROL_ACTION_NAMES).size).toBe(CONTROL_ACTION_NAMES.length)
  })

  it('gives every action and param a description', () => {
    for (const action of CONTROL_ACTIONS) {
      expect(action.name, 'name').toMatch(/^[a-z][a-z0-9_]*$/)
      expect(action.description.length, action.name).toBeGreaterThan(20)
      for (const [key, spec] of Object.entries(action.params)) {
        expect(spec.description.length, `${action.name}.${key}`).toBeGreaterThan(5)
        expect(['string', 'number', 'boolean', 'string[]', 'object']).toContain(spec.type)
      }
    }
  })

  it('finds actions by name and nothing else', () => {
    expect(findAction('get_state')?.name).toBe('get_state')
    expect(findAction('rm_-rf')).toBeUndefined()
  })

  it('stays in sync with the MCP bridge tool list', () => {
    // The bridge is zero-dependency .mjs and cannot import the TS whitelist,
    // so the two lists are kept honest by this test rather than by the type
    // system. A tool with no action (or vice versa) is a dead end for agents.
    const src = readFileSync(resolve(__dirname, '../../mcp/circle-take-mcp.mjs'), 'utf-8')
    const toolNames = [...src.matchAll(/^\s{4}name: '([a-z0-9_]+)',$/gm)].map((m) => m[1])
    expect(toolNames.length).toBeGreaterThan(0)
    expect([...toolNames].sort()).toEqual([...CONTROL_ACTION_NAMES].sort())
  })
})

describe('validateParams', () => {
  const circle = findAction('circle_take')
  const window = findAction('set_take_window')
  const ingest = findAction('ingest')

  it('accepts a well-formed call', () => {
    const res = validateParams(circle!, { takeId: 'abc', circled: true })
    expect(res.ok).toBe(true)
  })

  it('rejects a missing required param and lists the valid ones', () => {
    const res = validateParams(circle!, {})
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('takeId')
      expect(res.validParams).toEqual(['takeId', 'circled'])
    }
  })

  it('rejects unknown params', () => {
    const res = validateParams(circle!, { takeId: 'a', wat: 1 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('unknown param "wat"')
  })

  it('rejects wrong types', () => {
    const res = validateParams(circle!, { takeId: 42 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('must be string')
  })

  it('allows null only on nullable params', () => {
    expect(validateParams(window!, { takeId: 'a', inSec: null }).ok).toBe(true)
    const res = validateParams(circle!, { takeId: null })
    expect(res.ok).toBe(false)
  })

  it('validates string arrays element-wise', () => {
    expect(validateParams(ingest!, { paths: ['/a', '/b'] }).ok).toBe(true)
    expect(validateParams(ingest!, { paths: [1, 2] }).ok).toBe(false)
  })

  it('rejects a non-object params payload', () => {
    const res = validateParams(circle!, 'nope')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('must be a JSON object')
  })
})

/* ------------------------------ worker argv ----------------------------- */

describe('gateArgs', () => {
  it('builds the minimal gate command line', () => {
    expect(
      gateArgs({ mediaPath: '/m/a.mp4', reportPath: '/p/gates/t1.json', takeId: 't1' }),
    ).toEqual([
      '-m',
      WORKER_MODULE,
      'gate',
      '/m/a.mp4',
      '--report',
      '/p/gates/t1.json',
      '--take-id',
      't1',
      '--checks',
      CHECK_IDS.join(','),
    ])
  })

  it('appends kit, expected and neighbors when present', () => {
    const args = gateArgs({
      mediaPath: '/m/a.mp4',
      reportPath: '/p/gates/t1.json',
      takeId: 't1',
      checks: ['identity', 'temporal'],
      kitPath: '/p/kits/c1/embeddings.json',
      expected: { fps: 24, durationSec: 4 },
      neighborsPath: '/tmp/n.json',
    })
    expect(args).toContain('--checks')
    expect(args[args.indexOf('--checks') + 1]).toBe('identity,temporal')
    expect(args[args.indexOf('--kit') + 1]).toBe('/p/kits/c1/embeddings.json')
    expect(args[args.indexOf('--expected') + 1]).toBe('{"fps":24,"durationSec":4}')
    expect(args[args.indexOf('--neighbors') + 1]).toBe('/tmp/n.json')
  })

  it('omits --expected when there is nothing to expect', () => {
    const args = gateArgs({
      mediaPath: '/m/a.mp4',
      reportPath: '/r.json',
      takeId: 't1',
      expected: {},
    })
    expect(args).not.toContain('--expected')
  })
})

describe('mergeExpected', () => {
  it('lets the shot override the project defaults', () => {
    expect(mergeExpected({ fps: 24, width: 1920 }, { fps: 30 })).toEqual({ fps: 30, width: 1920 })
  })

  it('returns undefined when both sides are empty', () => {
    expect(mergeExpected(undefined, undefined)).toBeUndefined()
    expect(mergeExpected({}, {})).toBeUndefined()
  })

  it('serializes to compact JSON', () => {
    expect(expectedJson({ fps: 24 })).toBe('{"fps":24}')
    expect(expectedJson(undefined)).toBeNull()
  })
})

describe('kitBuildArgs', () => {
  it('passes every image after --images', () => {
    expect(kitBuildArgs('/p/kits/c1/embeddings.json', ['/a.jpg', '/b.jpg'])).toEqual([
      '-m',
      WORKER_MODULE,
      'kit-build',
      '/p/kits/c1/embeddings.json',
      '--images',
      '/a.jpg',
      '/b.jpg',
    ])
  })
})
