import type { CircleTakeAPI } from '@shared/api'

declare global {
  interface Window {
    /**
     * Typed preload bridge. In a plain browser (or with `?mock=1`) this is
     * installed by `src/renderer/mock.ts` instead of the preload script.
     */
    circletake: CircleTakeAPI
  }
}

export {}
