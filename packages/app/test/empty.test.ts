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
//
// What this screen is *not* is the orchestrator's line. It was drawn here for
// a while, and moving somebody's prompt to wherever the window happens to be
// empty is a prompt they have to look for, so it went back: the line is the
// orchestrator's and it is in the orchestrator's pane on every screen there
// is. The last two tests here are what holds that.

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

  it('draws the wordmark and the two things there are to press', () => {
    const text = plain(renderApp(empty(), frame({ width: 120, height: 34 })).join('\n'))
    // The block letters, the tagline under them, and what to do next.
    expect(text).toContain('████████')
    expect(text).toContain('said, and done.')
    expect(text).toContain('+ New agent')
    expect(text).toContain('Open project')
    expect(text).toContain('in checkout')
  })

  it('gives the wordmark up in steps rather than clipping it, and never the buttons', () => {
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
      // The one thing on this screen that does anything survives every size:
      // it is the only way off it for somebody using the mouse. Half a letter
      // of a wordmark is what stepping down exists to avoid, so the block
      // letters are only ever every row of them or none.
      expect(text).toContain('+ New agent')
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

  it("draws no line of its own: there is one, and it is the orchestrator's", () => {
    const rows = plain(renderApp(empty(), frame({ width: 120, height: 34 })).join('\n')).split('\n')
    const said = rows.filter((row) => row.includes('Ask Tade')).length
    expect(said).toBe(1)
    // Below the pane, in the panel the orchestrator's conversation is in —
    // never under the wordmark, which is where it used to be moved to.
    const line = rows.findIndex((row) => row.includes('Ask Tade'))
    const logo = rows.findIndex((row) => row.includes('████████'))
    expect(logo).toBeGreaterThan(-1)
    expect(line).toBeGreaterThan(logo)
    expect(rows.findIndex((row) => row.includes('orchestrator'))).toBeLessThan(line)
  })

  it('leaves the line in the row it is in on every other screen', () => {
    // The whole of what was asked for, as one number: emptying a project must
    // not move the prompt. A window with agents in it and a window with none
    // draw the line you type on in the same row.
    const size = frame({ width: 120, height: 34 })
    const rowOf = (drawn: string[]) =>
      drawn.map(plain).findIndex((row) => row.includes('Ask Tade anything'))
    expect(rowOf(renderApp(empty(), size))).toBe(rowOf(renderApp(state(), size)))
    expect(rowOf(renderApp(empty(), size))).toBeGreaterThan(-1)
  })
})
