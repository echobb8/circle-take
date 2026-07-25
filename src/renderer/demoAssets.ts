/**
 * Demo footage for mock mode.
 *
 * Real generated frames from the NIGHT MARKET demo film live in
 * `assets/demo/`. They are bundled through Vite's glob import so every surface
 * in a screenshot shows actual footage rather than synthesized artwork.
 *
 *   posters/night_market_<group>[_<n>].jpg   one frame per take
 *   strips/night_market_<group>_<0..7>.jpg   8 filmstrip frames per shot group
 *   kits/crew_ref_<n>.png                    character reference stills
 */

type UrlMap = Record<string, string>

function byBasename(mods: UrlMap): UrlMap {
  const out: UrlMap = {}
  for (const [path, url] of Object.entries(mods)) {
    const file = path.split('/').pop() ?? path
    out[file.replace(/\.[^.]+$/, '')] = url
  }
  return out
}

const POSTERS = byBasename(
  import.meta.glob<string>('./assets/demo/posters/*.jpg', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)

const STRIPS = byBasename(
  import.meta.glob<string>('./assets/demo/strips/*.jpg', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)

const KITS = byBasename(
  import.meta.glob<string>('./assets/demo/kits/*.{png,jpg}', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)

/** Stable ordering so the fallback picker is deterministic. */
const POSTER_KEYS = Object.keys(POSTERS).sort()

function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Any real frame, chosen deterministically — used for ad-hoc ingested takes. */
export function fallbackPoster(seed: string): string {
  const key = POSTER_KEYS[hash32(seed) % Math.max(1, POSTER_KEYS.length)]
  return (key && POSTERS[key]) ?? ''
}

/** Poster for a named frame, e.g. `night_market_stroll_2`. */
export function posterAsset(name: string, seed = name): string {
  return POSTERS[name] ?? fallbackPoster(seed)
}

/** Filmstrip frame `index` (0-7) for a shot group, e.g. `stroll`. */
export function stripAsset(group: string, index: number, seed = group): string {
  const i = ((index % 8) + 8) % 8
  return STRIPS[`night_market_${group}_${i}`] ?? fallbackPoster(`${seed}:${i}`)
}

/** A character-kit reference still by file name, e.g. `crew_ref_1.png`. */
export function kitAsset(file: string): string {
  return KITS[file.replace(/\.[^.]+$/, '')] ?? ''
}

export const KIT_FILES = Object.keys(KITS)
  .sort()
  .map((k) => `${k}.png`)
