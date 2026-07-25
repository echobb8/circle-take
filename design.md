# Circle Take — Design System

The bar: **every screenshot must look like a still from a professional post-production tool** —
DaVinci Resolve / Avid density with modern typography. Nothing may look like a default HTML app.
If a view would look generic in a screenshot, redesign it.

## Tokens (CSS custom properties on :root)

```css
--bg:        #0b0e14;   /* app ground — near-black blue */
--panel:     #12161f;   /* panels / cards */
--panel-2:   #171c28;   /* raised panel / hover */
--line:      #222a3a;   /* hairline borders (1px, everywhere) */
--text:      #e8ebf4;
--text-dim:  #96a0b5;
--text-faint:#5d6678;
--accent:    #d946ef;   /* neon fuchsia (from Sam's logo) — circles, primary actions, active states */
--accent-2:  #3b82f6;   /* electric blue (logo gradient start) — secondary accent */
--accent-soft: rgba(217,70,239,.14);
/* Brand gradient (logo): blue → violet → fuchsia. Use for the circle overlay
   stroke (SVG linearGradient #3b82f6 → #8b5cf6 → #d946ef), the wipe handle,
   active-room notch, and progress fills. Single-color uses take --accent. */
--pass:      #34d399;
--flag:      #fbbf24;
--fail:      #f87171;
--skip:      #5d6678;
--mono-blue: #7dd3fc;   /* timecodes / metadata mono text */
```

Radii: 10px cards, 6px chips/buttons. Shadows: none or very subtle (0 1px 0 rgba(0,0,0,.4));
depth comes from panel tone steps, not blur. Focus ring: 1px accent.

## Type

- **Barlow** (500/600/700) — UI, headings, shot names. Tracking +0.02em on ALL-CAPS labels.
- **IBM Plex Mono** (400/500) — timecodes, seeds, scores, file names, all data values.
- Both shipped as woff2 in `src/renderer/assets/fonts/` with @font-face (root-relative
  paths; never Google Fonts imports).
- Scale: 11px labels (caps, dim), 13px body, 15px section titles, 20px room titles.

## Signature elements (the "wow" ingredients — use consistently)

1. **The neon circle**: circled takes get a hand-drawn ellipse SVG overlay (2.5px stroke,
   slight rotation, imperfect double-pass path, brand-gradient stroke blue→fuchsia with a
   soft outer glow — matching Sam's logo mark) on their poster thumb + a small circle badge
   in lists. This is the brand gesture — analog gesture, neon material.
2. **Filmstrips**: take rows render 6-8 frame thumbnails edge-to-edge with sprocket-hole
   top/bottom borders (2px dotted line pattern) — instantly reads "footage".
3. **Gate badges**: pill with score (mono) + verdict dot. Pass = green dot, flag = amber,
   fail = red, pending = pulsing outline. Overall badge shows `87` big; per-check row of
   5 tiny dots (identity/temporal/anatomy/continuity/conformance) beneath.
4. **Sparklines**: every gate check renders its per-frame series as a 120×24 sparkline
   (SVG polyline, dim stroke, threshold line dashed, breaches filled accent/fail).
5. **Evidence chips**: worst-frame thumbnails with a corner flag triangle + frame number
   in mono; clicking seeks the player there.
6. **Timecode everywhere**: player and thumbnails show `HH:MM:SS:FF` in Plex Mono.
7. **Header strip** (Bin): production totals as big mono numerals with caps labels
   (SHOTS 24 · GATED 61/68 · CIRCLED 19 · NEEDS RESHOOT 5) + a 3px segmented progress bar.
8. **Wipe compare**: vertical wipe handle = orange line with a grabber knob; A/B labels
   in corner mono chips.

## Layout

- Left rail 64px: icon nav (Bin/Village/Kits/Print), logo mark top, settings gear bottom.
  Active room = accent left-notch + icon accent.
- Room header 52px: room title, project name (dim), global actions right.
- Village: 3-pane (takes 320px / player flex / gate panel 340px), collapsible sides.
- Bin grid: `repeat(auto-fill, minmax(280px, 1fr))`, card = poster 16:9 top, meta below.
- Dense but breathing: 12/16/24 spacing steps only.

## Motion

- 150ms ease-out on hover/active; no springy easings.
- Circling animation: the ellipse draws itself in ~400ms (stroke-dashoffset) — this is THE
  moment of the app, make it satisfying. Also used in the launch video.
- Gate completion: badge counts up (mono digits) over 300ms.

## Never

- Default buttons/selects (style everything), pure black/white, blue #007bff anywhere,
  emoji as icons (inline SVG only — lucide-style 1.5px stroke set drawn in-repo),
  light theme (v1 is dark only), rounded-full avatars, gradients except a single
  radial vignette on empty states.
