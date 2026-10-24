// Production editions. Pure data and prompt helpers; no platform APIs.
export type ProductionEdition = 'general' | 'kids-3d' | 'biblical-period'
export type StoryMode = 'original' | 'scripture'
export interface ProductionSettings {
  edition: ProductionEdition
  storyMode: StoryMode
  era: string
  region: string
  passage: string
  translation: string
  interpretation: string
}
export const DEFAULT_EDITION: ProductionEdition = 'kids-3d'
export const EDITION_LABEL = String(DEFAULT_EDITION) === 'kids-3d' ? "Children's 3D · ages 5–8" : 'Biblical Cinema'
export function defaultProduction(): ProductionSettings {
  return { edition: DEFAULT_EDITION, storyMode: 'original', era: '', region: '', passage: '', translation: '', interpretation: '' }
}
export function normalizeProduction(value: unknown): ProductionSettings {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const str = (key: string): string => typeof v[key] === 'string' ? (v[key] as string).slice(0, 4000) : ''
  return {
    edition: v.edition === 'general' || v.edition === 'kids-3d' || v.edition === 'biblical-period' ? v.edition : DEFAULT_EDITION,
    storyMode: v.storyMode === 'scripture' ? 'scripture' : 'original',
    era: str('era'), region: str('region'), passage: str('passage'), translation: str('translation'), interpretation: str('interpretation')
  }
}
export function productionDirection(value?: unknown): string {
  const p = normalizeProduction(value)
  if (p.edition === 'general') return ''
  if (p.edition === 'kids-3d') return [
    "CHILDREN'S 3D ANIMATION — audience ages 5–8.",
    'Original stylized 3D animated world: rounded readable silhouettes, appealing expressive faces, tactile materials, soft global illumination, clear staging and consistent character proportions, fur/hair, costume and palette. Keep reference model sheets authoritative across all views.',
    'Use simple concrete language, one clear emotional idea per beat, gentle humor, cooperative problem solving and a reassuring resolution. Show feelings through action; leave time for reactions and comprehension.',
    'Age-appropriate conflict: no graphic injury, frightening horror imagery, sexual content, dangerous imitable behavior or humiliating stereotypes. Review story context and sound with an adult editor; a prompt does not certify suitability.',
    'Camera and animation: motivated smooth movement, clear screen direction, deliberate poses and stable facial topology. Avoid sudden flashes, aggressive camera shake, uncanny realistic faces and hyperactive cutting.',
    'Audio: intelligible warm dialogue, gentle effects, supportive music and no startling volume jumps. Do not imitate an identifiable performer without permission.'
  ].join('\n')
  return [
    'BIBLICAL CINEMA — realistic live-action visual language, natural anatomy, weathered practical materials and motivated daylight, firelight or oil-lamp light.',
    `Period: ${p.era || 'UNSET — choose a specific historical period before look development'}. Region: ${p.region || 'UNSET — choose a specific geography and community'}.`,
    'Research clothing, fibers, dyes, tools, architecture, agriculture, scripts, weapons, food and social customs for this exact era and region. Do not blend Bronze Age, Iron Age, Persian, Hellenistic and Roman material cultures. Keep a source ledger; label disputed reconstructions.',
    'Cast people plausibly for the selected place and community without stereotypes. Avoid modern fasteners, electricity, plastics, modern roads, modern typography, medieval armor, later religious buildings and generic fantasy costumes.',
    p.storyMode === 'scripture'
      ? `SCRIPTURE ADAPTATION. Passage: ${p.passage || 'UNSET — select book, chapter and verses'}. Translation: ${p.translation || 'UNSET — specify the text used'}. Preserve the passage meaning and sequence. Separate direct quotation, paraphrase, historical inference and invented dialogue. Do not present invented events or words as Scripture. Record translation permissions when quoting.`
      : 'ORIGINAL PERIOD STORY. Characters, dialogue and plot may be invented. Clearly identify the story as historical fiction set in biblical times. Do not attribute invented dialogue to Scripture or imply the story is a biblical account.',
    `Interpretive choices: ${p.interpretation || 'Record theological, cultural and disputed historical choices for human review; do not silently resolve them.'}`,
    'Film grammar: grounded restrained performance, believable weight and contact, coherent geography, stable faces/hands/wardrobe and natural skin detail. Use violence only when the story and intended audience call for it; review intensity explicitly.'
  ].join('\n')
}
export function productionReview(value?: unknown): string[] {
  const p = normalizeProduction(value)
  if (p.edition === 'general') return []
  return p.edition === 'kids-3d' ? [
    'Adult editor: story and emotional intensity suit ages 5–8; resolution is reassuring.',
    'Animation: character model, scale, costume, face and material continuity match approved sheets.',
    'Readability: action, eye lines and screen direction are clear; reactions have time to read.',
    'Sound and picture: no startling peaks or flashes; dialogue remains intelligible.',
    'Identity/anatomy computer-vision checks trained on live-action faces may skip or mis-score stylized characters; compare approved turnarounds manually.'
  ] : [
    'Historical editor: era and geography are selected; material-culture sources and uncertainties are recorded.',
    p.storyMode === 'scripture' ? 'Scripture editor: passage and translation are set; quotation, paraphrase, inference and invented material are distinguished.' : 'Story editor: identify this as original historical fiction, not a scriptural account.',
    'Continuity: wardrobe, architecture, script, tools, lighting and geography fit the same era and region.',
    'Performance and sound: believable movement, pronunciation reviewed and modern background sounds removed.',
    'Human review remains required: automated artifact scores do not establish historical or theological accuracy.'
  ]
}
