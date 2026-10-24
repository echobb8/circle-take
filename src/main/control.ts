/**
 * Localhost HTTP control server — the second door into the app (the third is
 * the MCP bridge in mcp/, which speaks to this one).
 *
 * Every action here calls the SAME main-side function the IPC handler calls,
 * so an agent driving the app headlessly and a director clicking the UI go
 * through one brain. Discovery + auth are file-based, Blockout's pattern: on
 * ready we write ~/.config/circle-take/control.json (mode 0600) with the
 * random port and a bearer token, and delete it on quit.
 *
 *   GET  /health   -> { ok, app, appVersion }          (no auth)
 *   POST /action   -> { action, params }               (Bearer token)
 */

import { app, type BrowserWindow } from 'electron'
import http from 'http'
import crypto from 'crypto'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import {
  CONTROL_ACTION_NAMES,
  findAction,
  validateParams,
} from './controlActions'
import type { Rating } from '../shared/types'
import * as project from './project'
import * as ingest from './ingest'
import * as gate from './gate'
import * as kits from './kits'
import * as exportsApi from './exports'
import { getEngineStatus } from './pythonEnv'

const CONFIG_DIR = join(homedir(), '.config', 'circle-take-kids-3d')
const DISCOVERY_FILE = join(CONFIG_DIR, 'control.json')
const PROTOCOL_VERSION = 1
const MAX_BODY = 10 * 1024 * 1024

type Params = Record<string, unknown>
type Handler = (params: Params, win: BrowserWindow | null) => Promise<unknown>

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

/* -------------------------------- handlers ------------------------------ */

const HANDLERS: Record<string, Handler> = {
  get_state: async () => ({
    project: project.getProject(),
    projectPath: project.getProjectPath(),
    engine: getEngineStatus(),
  }),

  open_project: async (p) => project.openProject(asString(p.path)),

  create_project: async (p) => project.createProject(asString(p.parentDir), asString(p.name)),

  add_shot: async (p) =>
    project.addShot({
      name: asString(p.name),
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
      characterIds: asStringArray(p.characterIds),
    }),

  update_shot: async (p) => {
    const patch: Parameters<typeof project.updateShot>[1] = {}
    if (typeof p.name === 'string') patch.name = p.name
    if (typeof p.description === 'string') patch.description = p.description
    if (Array.isArray(p.characterIds)) patch.characterIds = asStringArray(p.characterIds)
    if (p.expected && typeof p.expected === 'object') {
      patch.expected = p.expected as Record<string, number>
    }
    return project.updateShot(asString(p.shotId), patch)
  },

  ingest: async (p) => ingest.ingestFiles(asStringArray(p.paths)),

  set_provenance: async (p) => {
    const prov: Record<string, string> = {}
    for (const key of ['generator', 'model', 'prompt', 'seed', 'notes']) {
      const v = p[key]
      if (typeof v === 'string') prov[key] = v
    }
    return project.setProvenance(asString(p.takeId), prov)
  },

  assign_take: async (p) => project.assignTake(asString(p.takeId), asString(p.shotId)),

  run_gate: async (p) => {
    await gate.runGate(asString(p.takeId))
    return { queued: asString(p.takeId) }
  },

  run_gate_all: async (p) => {
    await gate.runGateAll(p.onlyPending === true)
    return { queued: project.requireProject().takes.length }
  },

  gate_status: async () => {
    const p = project.requireProject()
    const shotById = new Map(p.shots.map((s) => [s.id, s]))
    return {
      takes: p.takes.map((t) => ({
        takeId: t.id,
        fileName: t.fileName,
        shot: shotById.get(t.shotId)?.name ?? null,
        circled: t.circled,
        rating: t.rating,
        status: t.gate?.status ?? 'pending',
        overall: t.gate?.overall ?? null,
        error: t.gate?.error ?? null,
        checks: t.gate?.checks ?? {},
        window:
          t.inSec === undefined && t.outSec === undefined
            ? null
            : { inSec: t.inSec ?? 0, outSec: t.outSec ?? null },
      })),
    }
  },

  get_gate_report: async (p) => {
    const report = await gate.getGateReport(asString(p.takeId))
    if (!report) throw new Error(`No gate report for take ${asString(p.takeId)} — run the gate first.`)
    return report
  },

  circle_take: async (p) => project.circleTake(asString(p.takeId), p.circled !== false),

  set_rating: async (p) => {
    const n = Math.round(Number(p.rating))
    if (![0, 1, 2, 3].includes(n)) throw new Error('rating must be 0, 1, 2 or 3.')
    return project.setRating(asString(p.takeId), n as Rating)
  },

  set_take_window: async (p) => {
    const val = (v: unknown): number | null => (typeof v === 'number' ? v : null)
    return project.setTakeWindow(asString(p.takeId), val(p.inSec), val(p.outSec))
  },

  set_model_rates: async (p) => {
    const raw = (p.rates ?? {}) as Record<string, unknown>
    const rates: Record<string, number> = {}
    for (const [key, value] of Object.entries(raw)) {
      const n = Number(value)
      if (!Number.isFinite(n)) throw new Error(`rate for "${key}" must be a number.`)
      rates[key] = n
    }
    return project.setModelRates(rates)
  },

  build_kit: async (p) => gate.buildKit(asString(p.charId)),

  add_character: async (p) => project.addCharacter(asString(p.name)),

  add_kit_images: async (p) => kits.addKitImages(asString(p.charId), asStringArray(p.imagePaths)),

  export_fcpxml: async (p) => ({ path: await exportsApi.exportFcpxml(asString(p.outPath)) }),
  export_edl: async (p) => ({ path: await exportsApi.exportEdl(asString(p.outPath)) }),
  export_reshoot_list: async (p) => ({
    path: await exportsApi.exportReshootList(asString(p.outPath)),
  }),
  export_csv: async (p) => ({ path: await exportsApi.exportCsv(asString(p.outPath)) }),

  screenshot: async (_p, win) => {
    if (!win) throw new Error('Circle Take window is not open.')
    const image = await win.webContents.capturePage()
    return { imageBase64: image.toPNG().toString('base64') }
  },
}

/** Compile-time-ish guarantee that the whitelist and the handler map agree. */
export function missingHandlers(): string[] {
  return CONTROL_ACTION_NAMES.filter((name) => !(name in HANDLERS))
}

/* --------------------------------- server ------------------------------- */

export async function startControlServer(getWindow: () => BrowserWindow | null): Promise<void> {
  const missing = missingHandlers()
  if (missing.length) {
    console.error(`[circle-take] control actions without handlers: ${missing.join(', ')}`)
  }
  const token = crypto.randomUUID()
  const appVersion = app.getVersion()

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET' && req.url === '/health') {
      send(200, { ok: true, app: 'circle-take', appVersion, protocolVersion: PROTOCOL_VERSION })
      return
    }

    if (req.method !== 'POST' || req.url !== '/action') {
      send(404, { ok: false, error: 'not found — use POST /action or GET /health' })
      return
    }

    if (req.headers['authorization'] !== `Bearer ${token}`) {
      send(401, { ok: false, error: 'unauthorized' })
      return
    }

    let body = ''
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      body += chunk
      if (body.length > MAX_BODY) {
        aborted = true
        send(413, { ok: false, error: 'request body too large' })
        req.destroy()
      }
    })
    req.on('end', () => {
      if (aborted) return
      let parsed: { action?: unknown; params?: unknown }
      try {
        parsed = JSON.parse(body || '{}') as { action?: unknown; params?: unknown }
      } catch {
        send(400, { ok: false, error: 'invalid JSON body' })
        return
      }
      if (typeof parsed.action !== 'string') {
        send(400, { ok: false, error: 'missing "action"', validActions: CONTROL_ACTION_NAMES })
        return
      }
      const spec = findAction(parsed.action)
      const handler = HANDLERS[parsed.action]
      if (!spec || !handler) {
        send(400, {
          ok: false,
          error: `unknown action "${parsed.action}"`,
          validActions: CONTROL_ACTION_NAMES,
        })
        return
      }
      const check = validateParams(spec, parsed.params)
      if (!check.ok) {
        send(400, { ok: false, error: check.error, validParams: check.validParams })
        return
      }
      handler(check.params, getWindow()).then(
        (data) => send(200, { ok: true, data }),
        (err: unknown) => send(200, { ok: false, error: (err as Error).message }),
      )
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(
    DISCOVERY_FILE,
    JSON.stringify({
      port,
      token,
      app: 'circle-take',
      protocolVersion: PROTOCOL_VERSION,
      appVersion,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  )

  app.on('will-quit', () => {
    void rm(DISCOVERY_FILE, { force: true }).catch(() => {})
    server.close()
  })

  console.log(`[circle-take] control server on 127.0.0.1:${port}`)
}
