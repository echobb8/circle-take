/**
 * The control server's action whitelist — declared here as pure data so it can
 * be unit-tested, and so control.ts and the MCP bridge share one definition of
 * what an agent is allowed to ask the app to do.
 *
 * PURE module: no Electron, no fs, no network. control.ts binds each name to
 * the same main-side function the IPC handler calls.
 */

export type ParamType = 'string' | 'number' | 'boolean' | 'string[]' | 'object'

export interface ParamSpec {
  type: ParamType
  required?: boolean
  description: string
  /** Allow explicit null (used by nullable clear-this-value params). */
  nullable?: boolean
}

export interface ControlActionSpec {
  name: string
  description: string
  params: Record<string, ParamSpec>
}

const str = (description: string, required = false): ParamSpec => ({
  type: 'string',
  required,
  description,
})
const num = (description: string, required = false): ParamSpec => ({
  type: 'number',
  required,
  description,
})

export const CONTROL_ACTIONS: ControlActionSpec[] = [
  {
    name: 'get_state',
    description:
      'Call FIRST. Returns the open project (shots, takes, characters, settings), its folder path, and the gate engine status.',
    params: {},
  },
  {
    name: 'open_project',
    description: 'Open an existing .ctake project folder.',
    params: { path: str('Absolute path to the .ctake folder.', true) },
  },
  {
    name: 'create_project',
    description: 'Create a new <name>.ctake project inside a parent folder and open it.',
    params: {
      parentDir: str('Absolute path to the folder that will contain the project.', true),
      name: str('Project name (becomes <name>.ctake).', true),
    },
  },
  {
    name: 'add_shot',
    description: 'Add a shot to the bin. Order is appended at the end of the cut.',
    params: {
      name: str('Shot name, e.g. "12A".', true),
      description: str('One-line description of the shot.'),
      characterIds: {
        type: 'string[]',
        description: 'Character kit ids that appear in this shot (drives identity checks).',
      },
    },
  },
  {
    name: 'update_shot',
    description: 'Patch an existing shot. Only the fields you pass are changed.',
    params: {
      shotId: str('Shot id from get_state.', true),
      name: str('New shot name.'),
      description: str('New description.'),
      characterIds: { type: 'string[]', description: 'Replacement character kit id list.' },
      expected: {
        type: 'object',
        description: 'Expected format overrides: { durationSec, fps, width, height }.',
      },
    },
  },
  {
    name: 'ingest',
    description:
      'Ingest media files or folders into the project. Files are referenced in place; sidecar .json/.txt provenance is picked up automatically.',
    params: {
      paths: {
        type: 'string[]',
        required: true,
        description: 'Absolute file or folder paths.',
      },
    },
  },
  {
    name: 'set_provenance',
    description: 'Set or correct a take’s generator/model/prompt/seed metadata.',
    params: {
      takeId: str('Take id from get_state.', true),
      generator: str('Generator app, e.g. "Runway", "Kling", "ComfyUI".'),
      model: str('Model name, e.g. "gen-4".'),
      prompt: str('The full generation prompt.'),
      seed: str('The seed used.'),
      notes: str('Free-form notes.'),
    },
  },
  {
    name: 'assign_take',
    description: 'Bind a take to a shot, or pass an empty shotId to move it to the unassigned tray.',
    params: {
      takeId: str('Take id from get_state.', true),
      shotId: str('Shot id, or "" to unassign.', true),
    },
  },
  {
    name: 'run_gate',
    description: 'Queue the QC gate for one take. Returns immediately; poll gate_status for results.',
    params: { takeId: str('Take id from get_state.', true) },
  },
  {
    name: 'run_gate_all',
    description: 'Queue the QC gate for every take, or only the ones with no result yet.',
    params: {
      onlyPending: { type: 'boolean', description: 'true = skip takes that already have a gate result.' },
    },
  },
  {
    name: 'gate_status',
    description:
      'Compact gate summary for every take: status, overall score, per-check verdicts. The fastest way to see what still needs work.',
    params: {},
  },
  {
    name: 'get_gate_report',
    description:
      'Full gate report for one take: per-check series, thresholds, evidence frames, model versions.',
    params: { takeId: str('Take id from get_state.', true) },
  },
  {
    name: 'circle_take',
    description: 'Circle (select) or un-circle a take. Circled takes are what gets exported.',
    params: {
      takeId: str('Take id from get_state.', true),
      circled: { type: 'boolean', description: 'true to circle, false to un-circle. Defaults to true.' },
    },
  },
  {
    name: 'set_rating',
    description: 'Set the director rating on a take (0-3 stars), orthogonal to the gate score.',
    params: {
      takeId: str('Take id from get_state.', true),
      rating: num('0, 1, 2 or 3.', true),
    },
  },
  {
    name: 'set_take_window',
    description:
      'Set the select window (usable slice) of a take in seconds, or clear it by passing null. Exports use this window as the source in/out.',
    params: {
      takeId: str('Take id from get_state.', true),
      inSec: { type: 'number', nullable: true, description: 'Window start in seconds, or null to clear.' },
      outSec: { type: 'number', nullable: true, description: 'Window end in seconds, or null to clear.' },
    },
  },
  {
    name: 'set_model_rates',
    description:
      'Set the cost ledger: $ per generation keyed by model name, with "*" as the fallback rate. Drives per-shot spend and hit-rate.',
    params: {
      rates: {
        type: 'object',
        required: true,
        description: 'Object of model name -> dollars per generation, e.g. { "gen-4": 0.5, "*": 0.25 }.',
      },
    },
  },
  {
    name: 'build_kit',
    description:
      'Compute and freeze face embeddings for a character kit from its reference stills. Required before identity checks can score against that character.',
    params: { charId: str('Character id from get_state.', true) },
  },
  {
    name: 'add_character',
    description: 'Create a character kit.',
    params: { name: str('Character name.', true) },
  },
  {
    name: 'add_kit_images',
    description: 'Copy reference stills into a character kit. Unlocks the kit so it can be rebuilt.',
    params: {
      charId: str('Character id from get_state.', true),
      imagePaths: { type: 'string[]', required: true, description: 'Absolute paths to image files.' },
    },
  },
  {
    name: 'export_fcpxml',
    description: 'Write the circled takes to an FCPXML 1.11 timeline (Resolve-compatible).',
    params: { outPath: str('Absolute output path (.fcpxml).', true) },
  },
  {
    name: 'export_edl',
    description: 'Write the circled takes to a CMX3600 EDL.',
    params: { outPath: str('Absolute output path (.edl).', true) },
  },
  {
    name: 'export_reshoot_list',
    description:
      'Write the reshoot list (.md plus a .json sibling): every shot without a circled take, with reasons, prompt, seed and evidence.',
    params: { outPath: str('Absolute output path (.md).', true) },
  },
  {
    name: 'export_csv',
    description: 'Write the full take inventory with gate scores, window and cost to CSV.',
    params: { outPath: str('Absolute output path (.csv).', true) },
  },
  {
    name: 'screenshot',
    description: 'Capture the app window as a PNG (base64). Use it to see what the room looks like.',
    params: {},
  },
]

export const CONTROL_ACTION_NAMES: string[] = CONTROL_ACTIONS.map((a) => a.name)

export function findAction(name: string): ControlActionSpec | undefined {
  return CONTROL_ACTIONS.find((a) => a.name === name)
}

export type ValidationResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: string; validParams: string[] }

function typeOf(value: unknown): ParamType | 'null' | 'unknown' {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.every((v) => typeof v === 'string') ? 'string[]' : 'unknown'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'object') return 'object'
  return 'unknown'
}

/**
 * Validate an action's params: required keys present, types right, no unknown
 * keys. On failure the caller gets the list of valid params so an agent can
 * self-correct without reading the source.
 */
export function validateParams(spec: ControlActionSpec, raw: unknown): ValidationResult {
  const validParams = Object.keys(spec.params)
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { ok: false, error: '"params" must be a JSON object', validParams }
  }
  const params = (raw ?? {}) as Record<string, unknown>

  for (const key of Object.keys(params)) {
    if (!(key in spec.params)) {
      return { ok: false, error: `unknown param "${key}" for ${spec.name}`, validParams }
    }
  }
  for (const [key, ps] of Object.entries(spec.params)) {
    const value = params[key]
    if (value === undefined) {
      if (ps.required) {
        return { ok: false, error: `missing required param "${key}" for ${spec.name}`, validParams }
      }
      continue
    }
    const actual = typeOf(value)
    if (actual === 'null') {
      if (!ps.nullable) {
        return { ok: false, error: `param "${key}" may not be null`, validParams }
      }
      continue
    }
    if (actual !== ps.type) {
      return {
        ok: false,
        error: `param "${key}" must be ${ps.type}, got ${actual}`,
        validParams,
      }
    }
  }
  return { ok: true, params }
}
