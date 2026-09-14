import { sliceByColumn, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
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

// Drawing is what Wilco does most — every keystroke, every frame an agent
// prints — so what a frame costs is held to a number, over every screen.
describe('what drawing costs', () => {
  it('draws any screen in a few milliseconds', () => {
    for (const scenario of SCENARIOS) draw(scenario.state, scenario.frame)
    const rounds = 5
    const started = performance.now()
    for (let round = 0; round < rounds; round++) {
      for (const scenario of SCENARIOS) draw(scenario.state, scenario.frame)
    }
    const each = (performance.now() - started) / (rounds * SCENARIOS.length)
    expect(each).toBeLessThan(15)
  })
})

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
    // Ink is a character, or a painted background: a field's empty end is
    // still a field you can click.
    const background = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*48;5;`)
    const ink = new Map<string, boolean>()
    for (const hit of drawn.hits) {
      if (!pressable(hit.target)) continue
      const key = `${hit.row} ${JSON.stringify(hit.target)}`
      const cells = sliceByColumn(drawn.rows[hit.row] ?? '', hit.from, hit.to - hit.from + 1)
      const visible = stripTerminalSequences(cells).trim() !== '' || background.test(cells)
      ink.set(key, (ink.get(key) ?? false) || visible)
    }
    for (const [key, visible] of ink) expect(visible, key).toBe(true)
  })
})
