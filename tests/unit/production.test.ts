import { describe, it, expect } from 'vitest'
import { normalizeProduction, productionDirection, productionReview } from '../../src/shared/production'

describe('production editions', () => {
  it('requires a source only in Scripture mode and keeps fiction distinct', () => {
    const context = { edition: 'biblical-period', era: 'Iron Age', region: 'Judah' }
    const original = productionDirection({ ...context, storyMode: 'original' })
    const scripture = productionDirection({ ...context, storyMode: 'scripture', passage: 'Ruth 2:1–7', translation: 'Selected translation' })
    expect(original).toContain('ORIGINAL PERIOD STORY')
    expect(original).not.toContain('SCRIPTURE ADAPTATION')
    expect(scripture).toContain('Ruth 2:1–7')
    expect(scripture).toContain('Selected translation')
    expect(scripture).not.toContain('ORIGINAL PERIOD STORY')
  })
  it('preserves selected production context through a JSON round trip', () => {
    const settings = normalizeProduction({ edition: 'biblical-period', storyMode: 'scripture', era: 'Roman period', region: 'Galilee', passage: 'Mark 4:35–41', translation: 'Selected translation' })
    expect(normalizeProduction(JSON.parse(JSON.stringify(settings)))).toEqual(settings)
  })
  it('keeps age and animation model continuity explicit without certifying takes', () => {
    const context = productionDirection({ edition: 'kids-3d' })
    expect(context).toContain('ages 5–8')
    expect(context).toContain('model sheets')
    expect(productionReview({ edition: 'kids-3d' }).join(' ')).toContain('manually')
    expect(productionDirection({ edition: 'general' })).toBe('')
  })
  it('accepts malformed legacy settings and bounds imported note strings', () => {
    expect(() => normalizeProduction(null)).not.toThrow()
    expect(normalizeProduction({ era: 5 }).era).toBe('')
    expect(normalizeProduction({ era: 'x'.repeat(8000) }).era.length).toBe(4000)
  })
})
