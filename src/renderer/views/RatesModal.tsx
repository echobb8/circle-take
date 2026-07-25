import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { Modal } from '../components/Modal'
import { Icon } from '../components/Icon'
import { formatUsd } from '../components/ProvenanceChips'

/**
 * The rate card: $ per generation keyed by model id, with '*' as the fallback.
 * Every model that actually appears in the project is pre-seeded so the
 * director never has to type a model string from memory.
 */

interface Row {
  key: string
  value: string
}

export function RatesModal(): JSX.Element {
  const project = useStore((s) => s.project)
  const setRatesOpen = useStore((s) => s.setRatesOpen)
  const setModelRates = useStore((s) => s.setModelRates)

  const seeded = useMemo<Row[]>(() => {
    const rates = project?.settings.modelRates ?? {}
    const keys = new Set<string>(Object.keys(rates))
    for (const t of project?.takes ?? []) {
      const m = t.provenance.model?.trim()
      if (m) keys.add(m)
    }
    keys.add('*')
    return [...keys]
      .sort((a, b) => (a === '*' ? 1 : b === '*' ? -1 : a.localeCompare(b)))
      .map((key) => ({ key, value: rates[key] != null ? String(rates[key]) : '' }))
  }, [project])

  const [rows, setRows] = useState<Row[]>(seeded)

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of project?.takes ?? []) {
      const m = t.provenance.model?.trim()
      if (m) map.set(m, (map.get(m) ?? 0) + 1)
    }
    return map
  }, [project])

  const total = rows.reduce((sum, r) => {
    const v = Number(r.value)
    if (!Number.isFinite(v) || r.key === '*') return sum
    return sum + v * (counts.get(r.key) ?? 0)
  }, 0)

  const save = () => {
    const out: Record<string, number> = {}
    for (const r of rows) {
      const v = Number(r.value)
      if (r.value.trim() !== '' && Number.isFinite(v) && v >= 0) out[r.key] = v
    }
    void setModelRates(out)
  }

  const update = (i: number, value: string) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, value } : r)))

  return (
    <Modal
      title="Rate card"
      subtitle="Cost per generation, by model. Drives spend, hit-rate and cost-per-usable-second."
      width={560}
      onClose={() => setRatesOpen(false)}
      footer={
        <>
          <span className="rates-total mono">
            Ledger total <strong>{formatUsd(total)}</strong>
          </span>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={() => setRatesOpen(false)}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={save}>
            <Icon name="check" size={14} />
            Save rates
          </button>
        </>
      }
    >
      <table className="rates-table">
        <thead>
          <tr>
            <th className="caps">Model</th>
            <th className="caps num">Takes</th>
            <th className="caps num">$ / generation</th>
            <th className="caps num">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const n = counts.get(r.key) ?? 0
            const v = Number(r.value)
            const sub = Number.isFinite(v) && r.key !== '*' ? v * n : null
            return (
              <tr key={r.key} className={r.key === '*' ? 'is-fallback' : undefined}>
                <td className="mono">
                  {r.key === '*' ? <span className="fallback-key">any other model</span> : r.key}
                </td>
                <td className="mono num">{r.key === '*' ? '—' : n}</td>
                <td className="num">
                  <span className="rate-input">
                    <span className="rate-prefix mono">$</span>
                    <input
                      className="field mono"
                      inputMode="decimal"
                      value={r.value}
                      placeholder="0.00"
                      onChange={(e) => update(i, e.target.value)}
                    />
                  </span>
                </td>
                <td className="mono num">{sub != null ? formatUsd(sub) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="rates-note">
        Rates are stored in the project, never sent anywhere. Takes whose model has no rate fall back
        to the <span className="mono">any other model</span> row.
      </p>
    </Modal>
  )
}
