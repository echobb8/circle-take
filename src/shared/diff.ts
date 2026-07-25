/**
 * Word-level prompt diff (pure, LCS-based). Powers the Shot Recipe diff view:
 * comparing take A vs take B highlights exactly what changed in the prompt
 * between generations — the "what did I change between take 7 and 8" answer.
 */

export interface DiffSegment {
  kind: 'same' | 'added' | 'removed'
  text: string
}

function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0)
}

/** Diff a → b. 'removed' = in a only, 'added' = in b only. */
export function diffWords(a: string, b: string): DiffSegment[] {
  const at = tokenize(a)
  const bt = tokenize(b)
  const n = at.length
  const m = bt.length
  // LCS table (prompts are ≤ ~2k words; O(n*m) is fine)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        at[i] === bt[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: DiffSegment[] = []
  const push = (kind: DiffSegment['kind'], text: string) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (at[i] === bt[j]) {
      push('same', at[i]!)
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push('removed', at[i]!)
      i++
    } else {
      push('added', bt[j]!)
      j++
    }
  }
  while (i < n) push('removed', at[i++]!)
  while (j < m) push('added', bt[j++]!)
  return out
}

/** Quick summary for chips: "+3 words, −1 word" or "identical". */
export function diffSummary(segs: DiffSegment[]): string {
  const count = (k: DiffSegment['kind']) =>
    segs
      .filter((s) => s.kind === k)
      .reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0)
  const add = count('added')
  const rem = count('removed')
  if (add === 0 && rem === 0) return 'identical prompt'
  const parts: string[] = []
  if (add) parts.push(`+${add} word${add === 1 ? '' : 's'}`)
  if (rem) parts.push(`−${rem} word${rem === 1 ? '' : 's'}`)
  return parts.join(', ')
}
