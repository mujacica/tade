import { describe, expect, it, vi } from 'vitest'
import { initialState } from '../src/model.ts'
import type { PlanRun } from '../src/plan-graph.ts'
import { PLAIN } from '../src/skin.ts'
import { planPicture } from '../src/view/plan.ts'

// What drawing a plan measures, counted: every character `widthOf` is handed.
// A chain 165 boxes wide padded every row of every part — its reasons, a row
// each — out to the picture's thousands of columns, only for each to be
// measured and cut back to the pane, which was half of drawing it. Counted,
// not timed, so the figure is the same on a loaded machine.

const measured = vi.hoisted(() => ({ chars: 0 }))
vi.mock('../src/width.ts', async (original) => {
  const real = await original<typeof import('../src/width.ts')>()
  return {
    ...real,
    widthOf: (text: string) => {
      measured.chars += text.length
      return real.widthOf(text)
    },
  }
})

const run = (text: string): PlanRun => ({ text, tone: null })

describe('a plan wider than its pane', () => {
  it('measures each row at its own width, never at the widest part’s', () => {
    const wide = 3_000
    const width = 120
    // The chain as boxes: a few rows the width of the whole chain.
    const picture = Array.from({ length: 4 }, () => [run('─'.repeat(wide))])
    // Why each piece waits: a short row each, hundreds of them.
    const reasons = Array.from({ length: 400 }, (_, i) => [run(`  ╰─◌ piece-${i}  after the last`)])
    const own = [...picture, ...reasons].reduce((sum, runs) => sum + (runs[0]?.text.length ?? 0), 0)
    measured.chars = 0
    const rows = planPicture(
      { ...initialState(), planAcross: 0 },
      PLAIN,
      { hover: null, pressed: null },
      width,
      [{ rows: picture }, { label: 'WHY THIS ORDER', rows: reasons }],
    )
    expect(rows.every((row) => row.text.length === width)).toBe(true)
    // A few looks at what each row really holds. Padded to the picture's
    // width, the reasons alone were 400 × 3,000 columns, several times over.
    expect(measured.chars).toBeLessThanOrEqual(6 * own + 10 * rows.length * width)
  })
})
