import { describe, expect, it } from 'vitest'
import {
  focusTask,
  initialState,
  laneShown,
  ORCHESTRATOR_TAB,
  type TaskSnapshot,
  withTasks,
  withTerminals,
} from '../src/model.ts'
import {
  splitActed,
  splitPane,
  splitShown,
  splitTerminal,
  terminalSplitActed,
  terminalSplitShown,
} from '../src/split.ts'

// What a split's own buttons mean — swap, turn, close — for both of the places
// the window splits: an agent's pane, and the lower panel.
//
// State in, state out, so a button that does what the one beside it says fails
// here rather than under somebody's pointer.

describe('a split pane’s buttons', () => {
  const panes: TaskSnapshot[] = [
    {
      task: 'app/refunds',
      state: 'working',
      lane: 'app/refunds/agent',
      lanes: [
        { id: 'app/refunds/agent', kind: 'agent' },
        { id: 'app/refunds/shell', kind: 'shell' },
      ],
    },
  ]
  const base = focusTask(withTasks(initialState(), panes), 'app/refunds')
  const pane = (state = base) => state.panes[0] as NonNullable<(typeof base.panes)[0]>
  const split = splitPane(base, 'app/refunds', 'app/refunds/shell', 'beside')

  it('swaps the halves', () => {
    const next = splitActed(split, 'app/refunds', 'swap')
    expect(laneShown(next, pane(next))).toBe('app/refunds/shell')
    expect(splitShown(next, pane(next))?.lane).toBe('app/refunds/agent')
  })

  it('turns the divider', () => {
    expect(splitActed(split, 'app/refunds', 'turn').splits['app/refunds']?.direction).toBe('below')
  })

  it('closes it on anything else, which is what the close button sends', () => {
    expect(splitActed(split, 'app/refunds', 'close').splits['app/refunds']).toBeUndefined()
  })
})

describe('the lower panel’s split buttons', () => {
  const tabs = withTerminals(initialState(), [
    { id: 'app/terminals/1', project: 'app', name: 'terminal 1' },
    { id: 'app/terminals/2', project: 'app', name: 'terminal 2' },
  ])
  const split = splitTerminal({ ...tabs, bottom: 'app/terminals/1' }, 'app/terminals/2', 'beside')

  it('swaps which tab is lit, because the halves here are tabs', () => {
    const next = terminalSplitActed(split, 'swap')
    expect(next.bottom).toBe('app/terminals/2')
    expect(terminalSplitShown(next)?.lane).toBe('app/terminals/1')
    expect(next.splitFocus).toBe(!split.splitFocus)
  })

  it('turns the divider', () => {
    expect(terminalSplitActed(split, 'turn').terminalSplit?.direction).toBe('below')
  })

  it('closes it, and takes the keyboard out of the half that is going', () => {
    const closed = terminalSplitActed(split, 'close')
    expect(closed.terminalSplit).toBeNull()
    expect(closed.splitFocus).toBe(false)
  })

  it('closes it rather than swapping onto the orchestrator, which has no lane', () => {
    const talking = terminalSplitActed({ ...split, bottom: ORCHESTRATOR_TAB }, 'swap')
    expect(talking.terminalSplit).toBeNull()
  })

  it('answers a verb about a split there is not by having none', () => {
    const none = terminalSplitActed({ ...tabs, splitFocus: true }, 'swap')
    expect(none.terminalSplit).toBeNull()
    expect(none.splitFocus).toBe(false)
  })
})
