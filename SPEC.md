# Circle Take — Specification v1

> **One line:** Blockout plans the shot. The generators shoot it. **Circle Take decides what's in the movie.**

Circle Take is a local-first desktop app for AI filmmakers: a dailies room, take manager, and
self-judging QC gate for AI-generated footage. Drop in every take from any generator; Circle Take
binds them to shots, measures them (identity drift, temporal integrity, anatomy, continuity,
conformance), lets you compare and **circle** the winners, and prints selects to FCPXML/EDL plus a
reshoot list for everything that failed — with the exact prompt/seed and *why*.

Part of Wasserman's Filmmaker Suite. Desktop app first; every capability also exposed via a
localhost control server + zero-dep MCP bridge so an agent can run the whole loop headlessly.

## Product pillars

1. **The Bin** — shot-by-shot production grid. Every shot shows take count, best gate score,
   circled status. One glance answers "which shots still need work."
2. **The Gate** — measurable, local, self-judging QC per take, with *reasons* and worst-frame
   evidence, never just a number.
3. **Character Kits** — lock a character's identity from reference stills; every take is scored
   against the kit. Continuity becomes enforceable.
4. **The Village** — pro review room: scrub-locked A/B compare, wipe, J-K-L, filmstrips,
   one-key circling.
5. **Print It** — circled takes → FCPXML/EDL for the NLE (and Unofficial DaVinci MCP);
   failed shots → reshoot list with prompts/seeds/reasons.

## Research-driven v1 additions

The market has one cloud competitor (Lotix: shots/takes/selects, cloud, Seedance-locked).
Circle Take's wedge — the intersection NOBODY ships: **local-first + model-agnostic ingest +
automated artifact QC + cost ledger + real NLE handoff.** Therefore v1 also includes:

- **Select windows** (`take.inSec/outSec`): creators keep 2-3s of a 20s generation — the
  reviewable unit is a range, not a file. The gate suggests the cleanest continuous window
  (`GateReport.suggestedWindow`); exports honor the window.
- **Prompt diff** (`src/shared/diff.ts`): word-level LCS diff between two takes' prompts in
  compare mode — "what changed between take 7 and 8." No tool ships this.
- **Cost ledger** (`settings.modelRates`, `takeCost`/`shotSpend` helpers): $ per shot, hit
  rate, cost-per-usable-second. Documented gap — producers build spreadsheets today.
- **Model-mix warning**: chip when one shot's takes span different models/versions
  (reproducibility expires when the model silently updates — "seed drift").
- Copy vocabulary: "take" paired with "generation" at least once; hierarchy Shot → Take →
  circled select matches the community's Scene→Shot→Generation→Select mental model.

## Non-negotiables (house rules)

- 100% local. No cloud APIs, no accounts, no API keys. Model weights runtime-downloaded
  (sha256-pinned) into the app cache, never committed.
- Apache-2.0 + NOTICE (credit Sam Wasserman), CITATION.cff.
- venv + caches live OUTSIDE iCloud-synced paths (`~/Library/Application Support/CircleTake/…`).
  Dev venv = repo-local `.venv` (repo lives in `~/Projects`, non-synced).
- Renderer never touches fs/spawn — preload IPC only. Media via `ctake://` protocol.
- `src/shared/` stays pure (no DOM/Electron/Node APIs) and unit-tested.
- Deterministic where feasible; gate reports carry engine + model versions.

## Data model (project = `.ctake` folder)

```
MyFilm.ctake/
  project.json          # single source of truth (schema v1)
  gates/<takeId>.json   # gate reports (verdicts + per-frame series + evidence frames)
  kits/<charId>/        # reference stills (copied in) + embeddings.json cache
  thumbs/<takeId>/      # poster.jpg + filmstrip_N.jpg (generated)
  evidence/<takeId>/    # worst-frame JPEGs extracted by the gate
```

`project.json` (all ids are short ulids):

```ts
interface Project {
  schema: 1
  name: string
  createdAt: string           // ISO
  settings: ProjectSettings   // fps/aspect/duration defaults, watchFolder?, gate thresholds overrides
  shots: Shot[]               // ordered = cut order (continuity neighbors derive from this)
  takes: Take[]
  characters: CharacterKit[]
}
interface Shot {
  id: string; name: string;   // "12A" style
  description?: string
  order: number
  expected?: { durationSec?: number; fps?: number; width?: number; height?: number }
  characterIds: string[]      // who appears — drives identity checks
  refs?: { scriptbreakScene?: string; blockoutShot?: string; boardFrame?: string }
}
interface Take {
  id: string; shotId: string
  mediaPath: string           // absolute; project stores no media by default (reference-in-place)
  fileName: string; ingestedAt: string
  provenance: { generator?: string; model?: string; prompt?: string; seed?: string;
                sourceSidecar?: string; notes?: string }
  probe?: { durationSec: number; fps: number; width: number; height: number; codec: string }
  gate?: GateSummary          // denormalized from gates/<id>.json for fast grid render
  circled: boolean
  rating: 0|1|2|3             // director stars, orthogonal to gate
}
interface GateSummary {
  status: 'pending'|'running'|'pass'|'flag'|'fail'|'error'
  overall: number             // 0-100
  checks: Record<CheckId, { verdict: 'pass'|'flag'|'fail'|'skip'; score: number; reason: string }>
  engineVersion: string; ranAt: string
}
type CheckId = 'identity'|'temporal'|'anatomy'|'continuity'|'conformance'
interface CharacterKit {
  id: string; name: string
  images: string[]            // repo-relative paths under kits/<id>/
  locked: boolean             // locked kit = embeddings frozen
}
```

Full gate report (`gates/<takeId>.json`) adds per-check `series` (sampled per-frame values w/
timestamps), `evidence` (frame indices + extracted JPEG paths + short captions), thresholds used,
and model/version info. The UI renders series as sparklines and evidence as heatmap chips.

## Gate engine (python/circletake_gate)

Worker CLI, line-JSON stdout protocol identical in spirit to Stem Studio
(`{"type":"progress"|"done"|"error", ...}`). Commands (subcommand style):

- `probe <media>` → duration/fps/size/codec (ffprobe JSON passthrough + parsing)
- `thumbs <media> --out <dir> --count N` → poster + filmstrip
- `gate <media> --report <out.json> [--kit <embeddings.json>] [--expected <json>]
   [--neighbors <json>] [--checks identity,temporal,anatomy,continuity,conformance]`
- `kit-build <out.json> --images a.jpg b.jpg ...` → face embeddings for a character kit
- `evidence <media> --frames 12,88 --out <dir>` → JPEG extraction

### Checks (doctrine: measure through what the viewer sees; relative-to-self thresholds
### plus absolute caps; every verdict carries a reason; metrics guide, eyes decide)

1. **identity** — YuNet face detect + SFace embeddings (OpenCV zoo models, runtime-downloaded,
   sha256-pinned). Sample ~2-4 fps. Per-face cosine distance to kit centroid (per character
   in `shot.characterIds`). Flags: mean distance above threshold (wrong person / drift),
   rising trend within the take (morphing), high variance (identity instability),
   face-lost windows. Skip (not fail) when shot has no characters or no faces expected.
2. **temporal** — three sub-metrics, all pure OpenCV/numpy:
   a. *flicker*: luma MAD between consecutive frames measured in low-texture regions
      (smooth-region doctrine from the DaVinci color rounds — whole-frame means hide it);
   b. *warp error*: DIS optical flow, warp prev→next, SSIM residual on the covered region
      (AI shimmer / boiling);
   c. *jump/morph discontinuity*: content-delta spikes vs the clip's own rolling baseline
      (a cut where no cut should be = morph event).
3. **anatomy** — MediaPipe Hands (optional dep; degrade to `skip` with reason if unavailable):
   finger-count anomalies, landmark jitter vs motion baseline, confidence collapse windows.
4. **continuity** — Lab-space stats (L mean/std, a/b means, contrast) + histogram distance vs
   the *circled takes of neighboring shots* (cut order from `shots[].order`). Flags exposure
   jumps and palette drift that will read as a grade mismatch at the cut point.
5. **conformance** — duration vs expected (±tolerance), fps, aspect, resolution floor,
   corrupt/short file, black/frozen-frame head/tails.

Scoring: each check → 0-100 + verdict; overall = weighted min-emphasis blend (a hard fail
caps overall ≤ 40; all-pass ≥ 85). Thresholds live in one python module with named constants +
project-level overrides; every threshold documented.

### Engine environment

- Deps: numpy, opencv-python (YuNet/SFace built in), mediapipe (optional extra), no torch.
- Model files: YuNet + SFace ONNX from the official OpenCV zoo URLs, sha256-pinned,
  downloaded on first gate run into the app cache dir; offline-friendly error if absent.
- Device: CPU is fine (models are tiny); everything must run on a fanless laptop.

## Desktop app (Electron + React + zustand, electron-vite)

Process split mirrors Stem Studio. Main owns: project open/save, ingest pipeline
(probe → thumbs → gate queue with concurrency 1-2), python env management
(repo `.venv` dev / userData venv packaged), `ctake://` media+thumbs protocol, control server.

### Views ("rooms"), left rail navigation

1. **Bin** — the default room. Responsive shot-card grid: poster thumb, shot name +
   description, take count chip, best-gate badge, circled indicator, per-check mini-icons.
   Production header strip: total shots / gated / circled / needs-reshoot + a thin
   progress bar. Click shot → Village.
2. **Village** — review room. Left: take list (filmstrip rows w/ gate badges + provenance
   chips). Center: player (custom transport, J-K-L, frame step, timecode). Right: gate
   panel for current take (check verdicts, sparklines, evidence chips → click seeks player).
   Compare mode: pick A + B → scrub-locked side-by-side or wipe slider. `C` circles.
3. **Kits** — character gallery; per character: reference stills grid, lock button,
   live "lineup" strip showing every take-face scored against the kit (best→worst).
4. **Report** — full-take gate deep-dive: all series plotted, evidence frames large,
   thresholds annotated. (Reached from Village gate panel.)
5. **Print** — export room: circled-takes summary table → FCPXML 1.11 / CMX3600 EDL /
   CSV; reshoot list preview (every non-passing shot with prompt/seed/reasons) → MD/JSON.
   Everything writes via save dialogs.

### Ingest

- Drag-drop files/folders anywhere; Watch Folder per project (chokidar-free: fs.watch + poll).
- Shot binding: filename patterns (`12A_*`, `shot-12A*`, `s12a*`) → auto-bind; else
  "Unassigned" tray in Bin with drag-to-shot assignment.
- Sidecar provenance: `<name>.json` / `<name>.txt` next to media auto-parsed (common keys:
  prompt, seed, model, generator); Runway/Kling/ComfyUI-style JSON keys mapped best-effort.
- Ingest pipeline states per take: `ingested → probed → thumbed → gated`.

### Design language (see design.md)

Dark professional: charcoal `#0b0e14` ground, panel `#131826`, hairline borders `#1f2637`,
text `#e6e9f2`/`#8a93a8`, accent **grease-pencil orange `#f97316`** (circles, badges, CTAs),
pass `#34d399`, flag `#fbbf24`, fail `#f87171`. Barlow (display/UI) + IBM Plex Mono
(timecodes, seeds, scores). The circle motif everywhere: circled takes get a hand-drawn
orange ellipse overlay on their poster. Density = pro NLE, not consumer app.

## Control server + MCP

Blockout pattern: localhost HTTP server, random port + bearer token written to
`~/.config/circle-take/control.json`; renderer registers a whitelisted action handler.
Actions (v1): `get_state`, `open_project`, `create_project`, `add_shot`, `ingest`,
`set_provenance`, `run_gate`, `get_gate_report`, `circle_take`, `set_rating`,
`build_kit`, `export_fcpxml`, `export_edl`, `export_reshoot_list`, `screenshot`.
`mcp/circle-take-mcp.mjs`: zero-dep stdio bridge exposing the same tools.

## Exports

- **FCPXML 1.11** (Resolve-compatible): one sequence, circled takes in shot order,
  clip per take w/ source in/out = full take (trim later in NLE), format from project fps.
- **EDL CMX3600**: same order, record TC computed, source file names in comments.
- **Reshoot list**: `reshoots.md` + `.json` — per failing shot: shot name, why (gate reasons),
  best-so-far take, exact prompt/seed/model to re-run, evidence thumbnails (md links).
- **CSV**: full take inventory w/ scores.

## Testing gate (definition of done)

`npm run typecheck && npm run lint && npm test` green; python `pytest` (or test_worker.py style)
green including synthetic-defect eval: generated fixtures with *injected* defects
(luma flicker sine, mid-clip crossfade morph, duplicated/frozen frames, exposure step) must be
flagged, clean fixture must pass. Playwright e2e: launch app → create project → ingest fixture →
gate runs → circle → export FCPXML (file exists + parses).

## Launch-video capture hooks (build-time)

- `scripts/screenshots.mjs` — Playwright Electron, stages a demo project, captures the
  6 README shots at 1600×1000@2x.
- `capture/record-ux.mjs` — CDP screencast rig (house pattern) for later video takes.
- Demo project must use constructed/synthetic footage only (no private files).

## Post-v1 parking lot

Auto-circle mode (agent circles best passing take), Resolve round-trip via Unofficial DaVinci
MCP, VBench-style subject-consistency (DINO) as optional heavy check, LUFS/audio QC on takes
with sound, per-take cost tracking, style-drift check vs a look reference, Windows installer.
