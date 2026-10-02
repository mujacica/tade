import { describe, expect, it } from 'vitest'
import {
  type AppState,
  initialState,
  markGlyph,
  withProjects,
  withTasks,
  withTerminals,
  withTranscript,
} from '../src/model.ts'
import { fromThinker, onATurn, ran, thinking } from '../src/transcript.ts'
import { draw } from '../src/view.ts'

// Whether the thing you talk to is doing anything right now, and the mark that
// says so on its own tab. The window could say what the orchestrator *is* — its
// model, how hard it thinks — and never whether it was working.

/** The same row without its colour, for reading a tab as columns. */
const plain = (row: string) =>
  row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

const NOW = 1_300

const quiet = (): AppState =>
  withTerminals(
    withTasks(withProjects(initialState(), ['checkout']), [
      { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
    ]),
    [{ id: 'checkout/terminals/1', project: 'checkout', name: 'tests' }],
  )

const working = (state: AppState): AppState =>
  withTranscript(state, thinking(state.transcript, NOW))

/** The bottom panel's row of tabs, as a person would read it. */
const tabRow = (state: AppState): string =>
  plain(
    draw(state, { width: 120, height: 30, screen: '', now: NOW }).rows.find((row) =>
      row.includes('orchestrator'),
    ) ?? '',
  )

describe('whether the orchestrator is on a turn', () => {
  it('is what the conversation says, and nothing it remembers', () => {
    expect(onATurn(quiet().transcript)).toBe(false)
    const busy = working(quiet())
    expect(onATurn(busy.transcript)).toBe(true)
    // Idle again: the answer is still on screen and the turn is over.
    expect(onATurn(fromThinker(busy.transcript, { type: 'idle' }, 2_000))).toBe(false)
  })

  it('is not something you started yourself: a tool of your own is not its turn', () => {
    const state = quiet()
    const yours = ran(state.transcript, { id: 'r1', tool: 'deps_check', input: {} }, NOW)
    expect(onATurn(yours)).toBe(false)
  })
})

describe('the mark on the orchestrator’s own tab', () => {
  it('is the agents’ own turning mark, and only while it is working', () => {
    // At rest the tab says only its name: a mark kept in reserve all day is a
    // tab that never says anything.
    expect(tabRow(quiet())).toContain('orchestrator ')
    expect(tabRow(quiet())).not.toContain(markGlyph('working', NOW))
    expect(tabRow(working(quiet()))).toContain(`orchestrator ${markGlyph('working', NOW)}`)
  })

  it('says so from a terminal’s tab too, which is when it is worth seeing', () => {
    const elsewhere = { ...working(quiet()), bottom: 'checkout/terminals/1' }
    expect(tabRow(elsewhere)).toContain(`orchestrator ${markGlyph('working', NOW)}`)
    // And the tab in front is still the terminal's: a mark is not a selection.
    expect(tabRow(elsewhere)).toContain('tests')
  })

  it('turns, so the tab shows movement rather than a frozen dot', () => {
    const at = (now: number) =>
      plain(
        draw(working(quiet()), { width: 120, height: 30, screen: '', now }).rows.find((row) =>
          row.includes('orchestrator'),
        ) ?? '',
      )
    expect(new Set([0, 100, 200, 300].map(at)).size).toBe(4)
  })
})
