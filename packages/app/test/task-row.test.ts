import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { initialState, withProjects, withTasks } from '../src/model.ts'
import { COLOUR } from '../src/skin.ts'
import { NO_POINTER, type Pointer } from '../src/ui.ts'
import { taskRow } from '../src/view/rows.ts'

// An agent down the side: its name, cut to the room it has, and what it cost.
//
// The name used to be cut to whatever the cost left it, so it was cut again
// each time the cost changed width — `$9.99` to `$10.00`, the first figure
// arriving, the pointer bringing the close and the menu in its place — and the
// name stuttered a column back and forth under nobody's hand.

const [pane] = withTasks(withProjects(initialState(), ['checkout']), [
  {
    task: 'checkout/a-name-long-enough-to-be-cut',
    state: 'working',
    lane: 'checkout/a-name-long-enough-to-be-cut/agent',
  },
]).panes
if (pane === undefined) throw new Error('withTasks made no pane')

const WIDTH = 29

const row = (spent: { tokens: number; usd: number } | undefined, pointer: Pointer = NO_POINTER) =>
  stripTerminalSequences(
    taskRow(WIDTH, COLOUR, pointer, { ...pane, focused: false }, spent, 0).rows[0]?.text ?? '',
  )

/** The column the name is cut at. */
const cut = (text: string) => text.indexOf('…')

describe('an agent down the side', () => {
  it('cuts its name at the same column whatever it has cost so far', () => {
    const none = row(undefined)
    expect(cut(none)).toBeGreaterThan(0)
    for (const usd of [0.35, 9.99, 10, 99.99, 100, 1234]) {
      const text = row({ tokens: 1_000, usd })
      expect(cut(text), String(usd)).toBe(cut(none))
      expect(visibleWidth(text)).toBe(WIDTH)
    }
  })

  it('keeps the same column under the pointer, where the close and the menu take the cost’s place', () => {
    const pointed = row(
      { tokens: 1_000, usd: 9.99 },
      { hover: { kind: 'task', task: pane.task }, pressed: null },
    )
    expect(pointed).toContain('×')
    expect(pointed).not.toContain('$9.99')
    expect(cut(pointed)).toBe(cut(row(undefined)))
  })

  it('keeps a token figure’s room for an agent a plan pays for, which never says money', () => {
    const columns = [999, 12_000, 120_000, 1_200_000].map((tokens) => cut(row({ tokens, usd: 0 })))
    expect(new Set(columns).size).toBe(1)
    expect(row({ tokens: 1_200_000, usd: 0 })).toContain('1.2M tok')
  })
})
