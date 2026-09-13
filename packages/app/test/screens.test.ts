import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { pressable } from '../src/hits.ts'
import { draw } from '../src/view.ts'
import { SCENARIOS } from './screens/scenarios.ts'

// The screens the window must keep looking like.
//
// Two goldens per scenario: the plain text, which is the layout, and the exact
// ANSI, which is the look. A change to either fails here with a diff, and
// `pnpm screens` draws both versions side by side for a person to judge. When
// the change is the point, `pnpm vitest run packages/app -u` accepts it.
//
// And, for every screen, the rules that no golden file can be trusted to
// notice: the geometry, and that whatever can be clicked is where it is drawn.

describe.each(SCENARIOS)('$name', (scenario) => {
  const drawn = draw(scenario.state, scenario.frame)

  it('looks the way it did', async () => {
    const plain = `${drawn.rows.map((row) => stripTerminalSequences(row)).join('\n')}\n`
    await expect(plain).toMatchFileSnapshot(`screens/__screens__/${scenario.name}.txt`)
    await expect(`${drawn.rows.join('\n')}\n`).toMatchFileSnapshot(
      `screens/__screens__/${scenario.name}.ansi`,
    )
  })

  it('fills the terminal exactly', () => {
    expect(drawn.rows.length).toBe(scenario.frame.height)
    for (const row of drawn.rows) expect(visibleWidth(row)).toBe(scenario.frame.width)
  })

  it('only offers clicks that land on the screen', () => {
    for (const hit of drawn.hits) {
      expect(hit.row).toBeGreaterThanOrEqual(0)
      expect(hit.row).toBeLessThan(drawn.rows.length)
      expect(hit.from).toBeGreaterThanOrEqual(0)
      expect(hit.to).toBeLessThan(scenario.frame.width)
      expect(hit.from).toBeLessThanOrEqual(hit.to)
    }
  })

  it('draws something wherever a click would press something', () => {
    // A button you can click but cannot see is the bug a hit map exists to
    // prevent: every pressable cell has to have ink on it somewhere.
    const ink = new Map<string, string>()
    for (const hit of drawn.hits) {
      if (!pressable(hit.target)) continue
      const key = `${hit.row} ${JSON.stringify(hit.target)}`
      const row = [...stripTerminalSequences(drawn.rows[hit.row] ?? '')]
      ink.set(key, (ink.get(key) ?? '') + row.slice(hit.from, hit.to + 1).join(''))
    }
    for (const [key, cells] of ink) expect(cells.trim(), key).not.toBe('')
  })
})
