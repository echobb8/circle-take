/**
 * Pure argv builders for the `circletake_gate` python worker.
 *
 * Kept free of Electron/fs so the exact command line the app will run can be
 * asserted in unit tests. The contract is SPEC.md §"Gate engine":
 *
 *   python -m circletake_gate gate <media> --report <out.json>
 *          [--checks a,b,c] [--kit <embeddings.json>] [--expected <json>]
 *          [--neighbors <json>]
 *   python -m circletake_gate kit-build <out.json> --images a.jpg b.jpg …
 */

import { CHECK_IDS, type CheckId, type ExpectedFormat } from '../shared/types'

export const WORKER_MODULE = 'circletake_gate'

export interface GateArgsOptions {
  mediaPath: string
  reportPath: string
  /** Take id — the engine stamps it into the report and evidence paths. */
  takeId: string
  /** Which checks to run. Defaults to all five. */
  checks?: CheckId[]
  /** Absolute path to `kits/<charId>/embeddings.json`, when the shot has one. */
  kitPath?: string
  /** Merged shot-over-project expected format; omitted when empty. */
  expected?: ExpectedFormat
  /** Absolute path to the temp JSON file listing neighbouring media paths. */
  neighborsPath?: string
}

/** `--expected` is passed as an inline JSON object (it is a handful of keys). */
export function expectedJson(expected: ExpectedFormat | undefined): string | null {
  if (!expected) return null
  const keys = Object.keys(expected).filter(
    (k) => expected[k as keyof ExpectedFormat] !== undefined,
  )
  if (keys.length === 0) return null
  return JSON.stringify(expected)
}

/** Merge a shot's expected format over the project-wide defaults. */
export function mergeExpected(
  projectDefaults: ExpectedFormat | undefined,
  shotExpected: ExpectedFormat | undefined,
): ExpectedFormat | undefined {
  if (!projectDefaults && !shotExpected) return undefined
  const merged: ExpectedFormat = { ...(projectDefaults ?? {}), ...(shotExpected ?? {}) }
  return expectedJson(merged) ? merged : undefined
}

/** Full argv (after the python executable) for a gate run. */
export function gateArgs(opts: GateArgsOptions): string[] {
  const checks = opts.checks && opts.checks.length ? opts.checks : CHECK_IDS
  const args = [
    '-m',
    WORKER_MODULE,
    'gate',
    opts.mediaPath,
    '--report',
    opts.reportPath,
    '--take-id',
    opts.takeId,
    '--checks',
    checks.join(','),
  ]
  if (opts.kitPath) args.push('--kit', opts.kitPath)
  const expected = expectedJson(opts.expected)
  if (expected) args.push('--expected', expected)
  if (opts.neighborsPath) args.push('--neighbors', opts.neighborsPath)
  return args
}

/** Full argv for building a character kit's embeddings cache. */
export function kitBuildArgs(outJsonPath: string, imagePaths: string[]): string[] {
  return ['-m', WORKER_MODULE, 'kit-build', outJsonPath, '--images', ...imagePaths]
}

/** Full argv for the worker's own probe subcommand (engine self-test). */
export function workerVersionArgs(): string[] {
  return ['-m', WORKER_MODULE, '--version']
}
