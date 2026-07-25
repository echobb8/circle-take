#!/usr/bin/env node
/**
 * Circle Take MCP server — zero-dependency Node >=18 stdio bridge.
 *
 * Speaks the MCP stdio transport: newline-delimited JSON-RPC 2.0 on
 * stdin/stdout (NOT Content-Length framed). Each tools/call is forwarded to
 * the running app's HTTP control server, discovered via
 * ~/.config/circle-take/control.json (random localhost port + bearer token).
 *
 * Uses only node built-ins + global fetch — run directly with `node`.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DISCOVERY_FILE = join(homedir(), '.config', 'circle-take', 'control.json')
const PROTOCOL_VERSION = '2024-11-05'

/* --------------------------------- tools -------------------------------- */

// Each tool name maps to a control action of the SAME name; the tool's input
// object is passed through verbatim as that action's params. Keep this list in
// sync with src/main/controlActions.ts.
const TOOLS = [
  {
    name: 'get_state',
    description:
      'Call FIRST. Returns the open Circle Take project — shots (in cut order, with expected format and character kits), takes (file, provenance, probe, gate summary, select window, circled, rating), character kits, project settings — plus the project folder path and the gate engine status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'open_project',
    description: 'Open an existing .ctake project folder.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the .ctake folder.' } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'create_project',
    description: 'Create a new <name>.ctake project inside a parent folder and open it.',
    inputSchema: {
      type: 'object',
      properties: {
        parentDir: { type: 'string', description: 'Absolute path to the containing folder.' },
        name: { type: 'string', description: 'Project name (becomes <name>.ctake).' }
      },
      required: ['parentDir', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'add_shot',
    description:
      'Add a shot to the bin. Shots are the spine of the project: cut order comes from the order shots are added, and continuity checks compare a take against the circled takes of its neighbours.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Shot name, e.g. "12A".' },
        description: { type: 'string', description: 'One-line description of the shot.' },
        characterIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Character kit ids appearing in this shot — drives the identity check.'
        }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'update_shot',
    description: 'Patch an existing shot. Only the fields you pass are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        shotId: { type: 'string', description: 'Shot id from get_state.' },
        name: { type: 'string', description: 'New shot name.' },
        description: { type: 'string', description: 'New description.' },
        characterIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement character kit id list.'
        },
        expected: {
          type: 'object',
          description: 'Expected format for the conformance check: { durationSec, fps, width, height }.'
        }
      },
      required: ['shotId'],
      additionalProperties: false
    }
  },
  {
    name: 'ingest',
    description:
      'Ingest media files or folders (folders are walked recursively). Files are referenced in place — nothing is copied. Sidecar <name>.json / <name>.txt provenance is parsed automatically, and filenames like "12A_take3.mp4" bind to the matching shot.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file or folder paths.'
        }
      },
      required: ['paths'],
      additionalProperties: false
    }
  },
  {
    name: 'set_provenance',
    description:
      'Set or correct a take’s generator / model / prompt / seed. This is what the reshoot list prints, so it is worth getting right.',
    inputSchema: {
      type: 'object',
      properties: {
        takeId: { type: 'string', description: 'Take id from get_state.' },
        generator: { type: 'string', description: 'Generator app, e.g. "Runway", "Kling", "ComfyUI".' },
        model: { type: 'string', description: 'Model name, e.g. "gen-4".' },
        prompt: { type: 'string', description: 'The full generation prompt.' },
        seed: { type: 'string', description: 'The seed used.' },
        notes: { type: 'string', description: 'Free-form notes.' }
      },
      required: ['takeId'],
      additionalProperties: false
    }
  },
  {
    name: 'assign_take',
    description: 'Bind a take to a shot, or pass shotId "" to move it back to the unassigned tray.',
    inputSchema: {
      type: 'object',
      properties: {
        takeId: { type: 'string', description: 'Take id from get_state.' },
        shotId: { type: 'string', description: 'Shot id, or "" to unassign.' }
      },
      required: ['takeId', 'shotId'],
      additionalProperties: false
    }
  },
  {
    name: 'run_gate',
    description:
      'Queue the QC gate for one take (identity / temporal / anatomy / continuity / conformance). Returns as soon as it is queued — poll gate_status for the verdict.',
    inputSchema: {
      type: 'object',
      properties: { takeId: { type: 'string', description: 'Take id from get_state.' } },
      required: ['takeId'],
      additionalProperties: false
    }
  },
  {
    name: 'run_gate_all',
    description: 'Queue the gate for every take, or only the ones with no result yet.',
    inputSchema: {
      type: 'object',
      properties: {
        onlyPending: {
          type: 'boolean',
          description: 'true = skip takes that already have a gate result.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'gate_status',
    description:
      'Compact gate summary for every take: status, overall 0-100, per-check verdicts and reasons, select window, circled, rating. The fastest way to see what still needs work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_gate_report',
    description:
      'Full gate report for one take: per-check per-frame series, thresholds used, worst-frame evidence images, engine and model versions.',
    inputSchema: {
      type: 'object',
      properties: { takeId: { type: 'string', description: 'Take id from get_state.' } },
      required: ['takeId'],
      additionalProperties: false
    }
  },
  {
    name: 'circle_take',
    description:
      'Circle (select) or un-circle a take. Circled takes are what the FCPXML / EDL exports contain — this is the decision the whole app exists for.',
    inputSchema: {
      type: 'object',
      properties: {
        takeId: { type: 'string', description: 'Take id from get_state.' },
        circled: { type: 'boolean', description: 'true to circle (default), false to un-circle.' }
      },
      required: ['takeId'],
      additionalProperties: false
    }
  },
  {
    name: 'set_rating',
    description: 'Set the director rating on a take (0-3 stars). Orthogonal to the gate score.',
    inputSchema: {
      type: 'object',
      properties: {
        takeId: { type: 'string', description: 'Take id from get_state.' },
        rating: { type: 'number', description: '0, 1, 2 or 3.' }
      },
      required: ['takeId', 'rating'],
      additionalProperties: false
    }
  },
  {
    name: 'set_take_window',
    description:
      'Set the select window (the usable slice) of a take in seconds, or pass null to clear it. Exports use this window as the source in/out, so trimming off a morphing tail happens here.',
    inputSchema: {
      type: 'object',
      properties: {
        takeId: { type: 'string', description: 'Take id from get_state.' },
        inSec: { type: ['number', 'null'], description: 'Window start in seconds, or null to clear.' },
        outSec: { type: ['number', 'null'], description: 'Window end in seconds, or null to clear.' }
      },
      required: ['takeId'],
      additionalProperties: false
    }
  },
  {
    name: 'set_model_rates',
    description:
      'Set the cost ledger: dollars per generation keyed by model name, with "*" as the fallback rate. Drives per-shot spend, hit-rate and cost-per-usable-second.',
    inputSchema: {
      type: 'object',
      properties: {
        rates: {
          type: 'object',
          description: 'Model name -> dollars per generation, e.g. { "gen-4": 0.5, "*": 0.25 }.'
        }
      },
      required: ['rates'],
      additionalProperties: false
    }
  },
  {
    name: 'add_character',
    description: 'Create a character kit. Add reference stills next, then build_kit.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Character name.' } },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'add_kit_images',
    description:
      'Copy reference stills into a character kit. The images are copied into the project so the kit survives the sources moving.',
    inputSchema: {
      type: 'object',
      properties: {
        charId: { type: 'string', description: 'Character id from get_state.' },
        imagePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to image files (jpg, png, webp, bmp, tif).'
        }
      },
      required: ['charId', 'imagePaths'],
      additionalProperties: false
    }
  },
  {
    name: 'build_kit',
    description:
      'Compute and freeze the face embeddings for a character kit. Required before the identity check can score takes against that character.',
    inputSchema: {
      type: 'object',
      properties: { charId: { type: 'string', description: 'Character id from get_state.' } },
      required: ['charId'],
      additionalProperties: false
    }
  },
  {
    name: 'export_fcpxml',
    description:
      'Write the circled takes to an FCPXML 1.11 timeline (imports into DaVinci Resolve and Final Cut).',
    inputSchema: {
      type: 'object',
      properties: { outPath: { type: 'string', description: 'Absolute output path (.fcpxml).' } },
      required: ['outPath'],
      additionalProperties: false
    }
  },
  {
    name: 'export_edl',
    description: 'Write the circled takes to a CMX3600 EDL.',
    inputSchema: {
      type: 'object',
      properties: { outPath: { type: 'string', description: 'Absolute output path (.edl).' } },
      required: ['outPath'],
      additionalProperties: false
    }
  },
  {
    name: 'export_reshoot_list',
    description:
      'Write the reshoot list: every shot with no circled take, with the gate reasons, the exact prompt/seed/model to re-run, and evidence frames. Writes <name>.md plus a <name>.json sibling.',
    inputSchema: {
      type: 'object',
      properties: { outPath: { type: 'string', description: 'Absolute output path (.md).' } },
      required: ['outPath'],
      additionalProperties: false
    }
  },
  {
    name: 'export_csv',
    description:
      'Write the full take inventory: shot, file, provenance, duration, select window, gate scores per check, cost, circled, rating.',
    inputSchema: {
      type: 'object',
      properties: { outPath: { type: 'string', description: 'Absolute output path (.csv).' } },
      required: ['outPath'],
      additionalProperties: false
    }
  },
  {
    name: 'screenshot',
    description:
      'Capture the Circle Take window as a PNG image. Use it to see the current room (Bin, Village, Kits, Print) after making changes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name))

/* ------------------------------ control call ---------------------------- */

const NOT_RUNNING = "Circle Take isn't running — launch the app first."

async function callControl(action, params) {
  let config
  try {
    config = JSON.parse(await readFile(DISCOVERY_FILE, 'utf-8'))
  } catch {
    return { error: NOT_RUNNING }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`
      },
      body: JSON.stringify({ action, params: params ?? {} })
    })
    return { response: await res.json() }
  } catch {
    return { error: NOT_RUNNING }
  }
}

/* ---------------------------- JSON-RPC plumbing ------------------------- */

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handleToolCall(id, params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  if (!TOOL_NAMES.has(name)) {
    reply(id, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true })
    return
  }
  const { response, error } = await callControl(name, args)
  if (error) {
    reply(id, { content: [{ type: 'text', text: error }], isError: true })
    return
  }
  // Image special-case: an ok screenshot returns base64 PNG data.
  if (response && response.ok && response.data && typeof response.data.imageBase64 === 'string') {
    reply(id, {
      content: [{ type: 'image', data: response.data.imageBase64, mimeType: 'image/png' }]
    })
    return
  }
  reply(id, {
    content: [{ type: 'text', text: JSON.stringify(response) }],
    isError: response && response.ok === false
  })
}

async function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'circle-take', version: '1.0.0' }
      })
      return
    case 'notifications/initialized':
      return // notification, no reply
    case 'tools/list':
      reply(id, { tools: TOOLS })
      return
    case 'tools/call':
      await handleToolCall(id, params)
      return
    case 'ping':
      reply(id, {})
      return
    default:
      // Notifications (no id) are ignored; requests get method-not-found.
      if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`)
      return
  }
}

/* ------------------------------- stdin loop ----------------------------- */

let buffer = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue // ignore non-JSON lines
    }
    void handle(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
