import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  type AppState,
  focusTask,
  initialState,
  type TaskSnapshot,
  withProjects,
  withTasks,
} from '../src/model.ts'
import { WORDMARK } from '../src/skin.ts'
import { renderApp } from '../src/view.ts'

// A project with nothing in it: where the window stays when you close the
// last agent, and what it draws there.
//
// One file because it is one subject from both ends — the rule that keeps you
// in the project and the screen that makes being there worth something — and
// they were the two halves of one bug: falling through to another project's
// agent was never noticed as *wrong* while the screen you fell through from
// said only `Nothing is running in checkout.`

const plain = (row: string) => stripTerminalSequences(row)

const tasks: TaskSnapshot[] = [
  { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
  { task: 'search/pagination', state: 'review' },
]

const state = (): AppState => withTasks(withProjects(initialState(), ['checkout', 'search']), tasks)

const frame = (over: { width?: number; height?: number } = {}) => ({
  width: 80,
  height: 24,
  screen: '',
  ...over,
})

describe('where you are when the last agent closes', () => {
  it('stays in the project, and never falls through to the next one', () => {
    const here = withTasks(focusTask(state(), 'search/pagination'), [tasks[0] as TaskSnapshot])
    expect(here.project).toBe('search')
    expect(here.focused).toBe(null)
    // The agent next door is still there, and is not what you are looking at.
    expect(plain(renderApp(here, frame({ width: 120, height: 34 })).join('\n'))).not.toContain(
      'refunds',
    )
  })
})

describe('what an empty project draws', () => {
  const empty = (over: Partial<AppState> = {}): AppState => ({
    ...withProjects(initialState(), ['checkout']),
    ...over,
  })

  it('draws the wordmark and one line to type on, and no second one at the foot', () => {
    const text = plain(renderApp(empty(), frame({ width: 120, height: 34 })).join('\n'))
    // The block letters, and the invitation that says what typing here does.
    expect(text).toContain('████████')
    expect(text).toContain('Ask Tade for an agent, or anything')
    // One line and one editor: the foot's own placeholder is nowhere on it.
    expect(text).not.toContain('Ask Tade anything')
    expect(text).toContain('+ New agent')
    expect(text).toContain('in checkout')
  })

  it('keeps the line at the foot the moment there is an agent to look at', () => {
    const text = plain(renderApp(state(), frame({ width: 120, height: 34 })).join('\n'))
    expect(text).toContain('Ask Tade anything')
    expect(text).not.toContain('Ask Tade for an agent, or anything')
  })

  it('gives the wordmark up in steps rather than clipping it, and never the line', () => {
    for (const size of [
      { width: 200, height: 60 },
      { width: 120, height: 34 },
      { width: 90, height: 24 },
      { width: 72, height: 18 },
      { width: 64, height: 12 },
      { width: 40, height: 10 },
    ]) {
      const rows = renderApp(empty(), frame(size))
      const text = plain(rows.join('\n'))
      expect(rows.length).toBe(size.height)
      for (const row of rows) expect(visibleWidth(row)).toBe(size.width)
      // The one thing this screen is for survives every size — in as many of
      // its own words as the columns allow, which is the row's own rule.
      // Half a letter of a wordmark is what stepping down exists to avoid, so
      // the block letters are only ever every row of them or none.
      expect(text).toContain('Ask Tade')
      const letters = WORDMARK.filter((line) => text.includes(line.trimEnd())).length
      expect([0, WORDMARK.length]).toContain(letters)
    }
  })

  it('is the same screen whether agents were closed here or never started', () => {
    // An empty project is one state and not two: nothing in the window can
    // tell the two apart, and a screen that remembered would have to decide
    // when to stop saying it.
    const never = renderApp(empty(), frame({ width: 120, height: 34 }))
    const closed = renderApp(
      withTasks(
        focusTask(withTasks(withProjects(initialState(), ['checkout']), tasks), 'checkout/refunds'),
        [],
      ),
      frame({ width: 120, height: 34 }),
    )
    expect(plain(closed.join('\n'))).toBe(plain(never.join('\n')))
  })
})
