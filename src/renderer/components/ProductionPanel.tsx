import type { ProductionSettings } from '../../shared/production'
import { normalizeProduction, productionReview } from '../../shared/production'
import './production.css'

export function ProductionPanel({ value, onChange }: { value?: ProductionSettings; onChange: (value: ProductionSettings) => void }): JSX.Element {
  const p = normalizeProduction(value)
  const field = (key: 'era' | 'region' | 'passage' | 'translation' | 'interpretation', label: string): JSX.Element => (
    <label>{label}<input value={p[key]} onChange={(event) => onChange({ ...p, [key]: event.target.value })} /></label>
  )
  return <details className="production-editor">
    <summary>{p.edition === 'kids-3d' ? "Children’s 3D · 5–8" : p.edition === 'biblical-period' ? 'Biblical Cinema' : 'Production settings'}</summary>
    <div className="production-fields">
      <label>Production edition<select value={p.edition} onChange={(event) => onChange(normalizeProduction({ ...p, edition: event.target.value }))}>
        <option value="kids-3d">Children’s 3D animation · ages 5–8</option><option value="biblical-period">Realistic biblical period</option><option value="general">General filmmaking</option>
      </select></label>
      {p.edition === 'biblical-period' && <>
        <label>Story mode<select value={p.storyMode} onChange={(event) => onChange({ ...p, storyMode: event.target.value === 'scripture' ? 'scripture' : 'original' })}>
          <option value="original">Original period story</option><option value="scripture">Scripture adaptation</option>
        </select></label>
        {field('era', 'Historical period')}{field('region', 'Region and community')}
        {p.storyMode === 'scripture' && <>{field('passage', 'Source passage · book, chapter, verses')}{field('translation', 'Bible translation')}</>}
        {field('interpretation', 'Interpretive choices and source notes')}
      </>}
      <h3>Production review</h3><p>Review these with an editor before approving a take.</p>
      <ul>{productionReview(p).map((item) => <li key={item}>{item}</li>)}</ul>
    </div>
  </details>
}
