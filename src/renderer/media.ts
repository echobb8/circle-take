/**
 * Media URL indirection.
 *
 * Real app: everything resolves through the `ctake://` protocol (see
 * `@shared/api`). Mock mode swaps in a resolver that returns generated
 * data-URI artwork so every view is fully populated in a plain browser.
 *
 * Views must never build `ctake://` URLs themselves — always go through here.
 */

import { evidenceUrl, kitImageUrl, mediaUrl, thumbUrl } from '@shared/api'

export interface MediaResolver {
  /** True when artwork is synthesized (no real video element should be mounted). */
  synthetic: boolean
  poster(takeId: string): string
  strip(takeId: string, index: number): string
  video(takeId: string): string
  evidence(takeId: string, file: string): string
  kit(charId: string, file: string): string
  /**
   * Face tile for the Kits lineup wall. There is no dedicated face thumbnail
   * in the project format yet, so this returns the take's poster and the CSS
   * reframes it to a portrait crop biased toward the upper third.
   */
  face(takeId: string): string
}

const realResolver: MediaResolver = {
  synthetic: false,
  poster: (takeId) => thumbUrl(takeId, 'poster.jpg'),
  strip: (takeId, index) => thumbUrl(takeId, `strip_${index}.jpg`),
  video: (takeId) => mediaUrl(takeId),
  evidence: (takeId, file) => evidenceUrl(takeId, file),
  kit: (charId, file) => kitImageUrl(charId, file),
  face: (takeId) => thumbUrl(takeId, 'poster.jpg'),
}

let active: MediaResolver = realResolver

export function setMediaResolver(next: MediaResolver): void {
  active = next
}

export function media(): MediaResolver {
  return active
}

/** Number of filmstrip frames a take row renders. */
export const STRIP_COUNT = 8
