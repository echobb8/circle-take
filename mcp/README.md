# Circle Take MCP bridge

`circle-take-mcp.mjs` is a zero-dependency stdio MCP server. It exposes the running
Circle Take app's control actions as MCP tools, so an agent can drive the whole
dailies loop — create a project, ingest takes, run the gate, circle the winners,
export FCPXML — without touching the UI.

## Connect

Circle Take must be **running**. On startup the app opens a localhost-only control
server on a random port and writes its port + bearer token to
`~/.config/circle-take/control.json` (mode `0600`); the bridge reads that file. If the
app isn't running, every tool returns `Circle Take isn't running — launch the app first.`

```bash
claude mcp add circle-take -- node /absolute/path/to/circle-take/mcp/circle-take-mcp.mjs
```

Any MCP client works — the equivalent JSON config is:

```json
{
  "mcpServers": {
    "circle-take": {
      "command": "node",
      "args": ["/absolute/path/to/circle-take/mcp/circle-take-mcp.mjs"]
    }
  }
}
```

Requires Node 18+ (uses global `fetch`). No `npm install` — there are no dependencies.

## Tools

| Tool | What it does |
| --- | --- |
| `get_state` | **Call first.** Project (shots, takes, kits, settings), project path, engine status. |
| `open_project` / `create_project` | Open or create a `.ctake` project. |
| `add_shot` / `update_shot` | Build and edit the shot list — the spine of the cut. |
| `ingest` | Ingest files/folders. Sidecar provenance and filename→shot binding are automatic. |
| `set_provenance` | Fix a take's generator / model / prompt / seed. |
| `assign_take` | Bind a take to a shot (or unassign it). |
| `run_gate` / `run_gate_all` | Queue the QC gate. Returns immediately. |
| `gate_status` | Compact per-take verdicts — poll this after queueing. |
| `get_gate_report` | Full report for one take: series, thresholds, evidence frames. |
| `circle_take` | Circle (select) a take. This is the decision that gets exported. |
| `set_rating` | Director stars, 0–3. |
| `set_take_window` | Trim the usable slice of a take; exports use it as source in/out. |
| `set_model_rates` | Cost ledger: $ per generation by model, `"*"` as fallback. |
| `add_character` / `add_kit_images` / `build_kit` | Lock a character's identity from reference stills. |
| `export_fcpxml` / `export_edl` / `export_csv` | Print the selects for the NLE. |
| `export_reshoot_list` | Every shot without a circled take, with reasons + exact prompt/seed. |
| `screenshot` | PNG of the app window. |

## A typical loop

1. `get_state` — see what exists.
2. `add_shot` for each shot in the sequence.
3. `ingest` the folder of generations.
4. `run_gate_all` with `onlyPending: true`, then poll `gate_status`.
5. `get_gate_report` on anything flagged to read the actual reasons.
6. `circle_take` the winners; `set_take_window` to trim a morphing tail.
7. `export_fcpxml` for the NLE and `export_reshoot_list` for what still needs another pass.

## Talking to the control server directly

The bridge is a thin shim over plain HTTP, so curl works too:

```bash
CFG=~/.config/circle-take/control.json
PORT=$(node -p "require('$CFG').port")
TOKEN=$(node -p "require('$CFG').token")

curl -s "http://127.0.0.1:$PORT/health"            # no auth
curl -s "http://127.0.0.1:$PORT/action" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"get_state"}'
```

`GET /health` needs no auth and returns `{ ok, app, appVersion, protocolVersion }`.
`POST /action` takes `{ action, params }`, answers `401` for a bad token, and returns
`{ error, validParams }` when the params don't match the action's schema.
