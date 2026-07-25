/// <reference types="vite/client" />

// Static assets imported through Vite resolve to their served URL string.
// Ambient module declarations — this file intentionally has no imports so the
// wildcard `declare module` entries apply globally.
declare module '*.woff2' {
  const src: string
  export default src
}
declare module '*.png' {
  const src: string
  export default src
}
declare module '*.jpg' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
