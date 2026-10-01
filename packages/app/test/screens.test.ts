import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

// Drawing is what Tade does most — every keystroke, every frame an agent
// prints — so what a frame costs is held to a number, over every screen.
//
// A loose number, and this says plainly what it is worth. Drawing costs 0.85ms
// a screen on a quiet laptop and 7.1ms on a macOS runner: a factor of eight
// that is nothing to do with this code. Holding it against a lump of
// string-building beside it did not help — the lump came out twice dearer on
// that runner while drawing came out eight times dearer, so the ratio measured
// the difference between two kinds of slowness rather than cancelling either.
//
// So: forty, which no machine seen yet comes near, and best round of several,
// because noise only ever adds time and a starved process's quickest go is the
// only one about the code. This catches drawing changing in kind — a sync read
// that crept in, an accidental second pass over every row — and it does not
// catch it getting twenty per cent dearer. Nothing that runs on a shared
// runner can, and a test that pretends to is a test that goes red on Tuesdays.
//
// It also used not to be able to pass at all: 123 scenarios over six rounds is
// 738 draws, and 738 at the old 15ms budget is eleven seconds against a
// ten-second timeout, so the timeout bound before the `expect` ever did.

/**
 * The quickest of several goes at the same work.
 *
 * The mean of a starved process measures the starving; its best round is the
 * one where it got the machine.
 */
function fastest(rounds: number, work: () => unknown): number {
  let best = Number.POSITIVE_INFINITY
  for (let round = 0; round < rounds; round++) {
    const at = performance.now()
    work()
    best = Math.min(best, performance.now() - at)
  }
  return best
}

/** Milliseconds a screen may cost. Eight times the worst runner we have seen. */
const A_SCREEN_MS = 40

describe('what drawing costs', () => {
  it('draws any screen without going away to do it', () => {
    const everything = (): void => {
      for (const scenario of SCENARIOS) draw(scenario.state, scenario.frame)
    }
    everything()
    const each = fastest(3, everything) / SCENARIOS.length
    expect(each, `${each.toFixed(2)}ms a screen over ${SCENARIOS.length} of them`).toBeLessThan(
      A_SCREEN_MS,
    )
  })
})

// Every scenario has two goldens, and every golden belongs to a scenario.
//
// The per-scenario tests below cannot notice a file no scenario names, so a
// renamed scenario leaves its old pair behind and nothing ever says so:
// `go-to-anything` sat here for months that way. A golden with no scenario is
// a screen nobody is checking and nobody will dare delete later; a scenario
// with no golden is a screen nobody is checking at all.
describe('the goldens and the scenarios', () => {
  it('are the same set', () => {
    const named = new Set(SCENARIOS.map((scenario) => scenario.name))
    const goldens = new Set(
      readdirSync(fileURLToPath(new URL('screens/__screens__', import.meta.url))).map((file) =>
        file.replace(/\.(txt|ansi)$/, ''),
      ),
    )
    expect(
      [...goldens].filter((name) => !named.has(name)),
      'goldens with no scenario',
    ).toEqual([])
    expect(
      [...named].filter((name) => !goldens.has(name)),
      'scenarios with no golden',
    ).toEqual([])
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
