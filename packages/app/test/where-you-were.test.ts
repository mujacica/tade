import { describe, expect, it } from 'vitest'
import { standingIn, whereYouWere } from '../src/layout.ts'
import {
  type AppState,
  activeTerminal,
  focusBy,
  focusTask,
  initialState,
  selectProject,
  showPlan,
  showTerminal,
  type TaskSnapshot,
  tasksOf,
  withProjects,
  withTasks,
  withTerminals,
} from '../src/model.ts'

// A project is a place you come back to, and this is about coming back to it:
// the agent you were watching and the tab you had open below it, per project
// rather than per window.
//
// Clicking an agent, going to another project and coming back put you at the
// top of the list, which is somebody else's idea of where you were. What is
// tested here is that, and every way the memory can be wrong: the agent has
// gone, the project is empty, the finished ones are hidden, the terminal
// belongs to the project you came from. None of them may leave a blank pane.

const tasks: TaskSnapshot[] = [
  { task: 'checkout/stripe-v15', state: 'blocked', lane: 'checkout/stripe-v15/agent' },
  { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
  { task: 'search/pagination', state: 'review' },
]

const terminals = [
  { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
  { id: 'search/terminals/1', project: 'search', name: 'logs' },
]

const state = (over: Partial<AppState> = {}): AppState => ({
  ...withTasks(initialState(), tasks),
  ...over,
})

describe('coming back to a project', () => {
  it('remembers which agent you were on, project by project', () => {
    // The bug, in one line each way: out of checkout on refunds, and back to
    // checkout on refunds.
    const here = focusTask(state(), 'checkout/refunds')
    const away = selectProject(here, 'search')
    expect(away.focused).toBe('search/pagination')
    expect(selectProject(away, 'checkout').focused).toBe('checkout/refunds')
  })

  it('counts tabbing out of a project as leaving it, and the beat catches the rest', () => {
    // Tab walks into another project without going through its tab, and a
    // search jumps into one without going through either — so `withTasks`,
    // which every state passes through, is what catches up with the second.
    const tabbed = focusBy(focusTask(state(), 'checkout/refunds'), 1)
    expect(tabbed.project).toBe('search')
    expect(selectProject(tabbed, 'checkout').focused).toBe('checkout/refunds')
    const beat = withTasks(focusTask(state(), 'checkout/refunds'), tasks)
    expect(selectProject(focusTask(beat, 'search/pagination'), 'checkout').focused).toBe(
      'checkout/refunds',
    )
  })

  it('falls back to the first agent when the one you were on has gone', () => {
    // Finished and closed, stopped, or removed with its task: none of them is
    // somewhere to stand, and none of them may leave you looking at nothing.
    const away = selectProject(focusTask(state(), 'checkout/refunds'), 'search')
    const fewer = withTasks(
      away,
      tasks.filter((task) => task.task !== 'checkout/refunds'),
    )
    expect(selectProject(fewer, 'checkout').focused).toBe('checkout/stripe-v15')
  })

  it('never comes back to an empty pane, whatever you had in front of you', () => {
    // A plan and a schedule stay behind in the project they are of, so being
    // on one is not somewhere to come back to — it falls back to the first
    // agent, exactly as a project nobody has been in opens on it. Only a
    // project with no agents at all comes back to the orchestrator.
    const plan = showPlan(state())
    expect(plan.focused).toBeNull()
    const back = selectProject(selectProject(plan, 'search'), 'checkout')
    expect(back.focused).toBe('checkout/stripe-v15')
    expect(back.showingPlan).toBe(false)
    const empty = withProjects(state(), ['checkout', 'search', 'infra'])
    expect(selectProject(selectProject(empty, 'infra'), 'infra').focused).toBeNull()
  })

  it('shows the agent you left on even where the finished ones are hidden', () => {
    // Hiding is a view, and a list that leaves out what is on the screen is a
    // list that disagrees with it: `tasksOf` already keeps the focused one.
    const done: TaskSnapshot[] = tasks.map((task) =>
      task.task === 'checkout/refunds' ? { ...task, state: 'merged' as const } : task,
    )
    const hiding = { ...withTasks(focusTask(state(), 'checkout/refunds'), done), hidingDone: true }
    const back = selectProject(selectProject(hiding, 'search'), 'checkout')
    expect(back.focused).toBe('checkout/refunds')
    expect(tasksOf(back).map((pane) => pane.name)).toContain('refunds')
    // And it is hidden when it is not the one you are on, which is what makes
    // the line above say something.
    const elsewhere = { ...back, focused: 'checkout/stripe-v15' }
    expect(tasksOf(elsewhere).map((pane) => pane.name)).not.toContain('refunds')
  })

  it('takes the tab below with it, and never another project’s terminal', () => {
    // The same bug from the other side, and the worse one: the panel went on
    // showing the terminal of the project you came from, under a row of this
    // project’s tabs with none of them lit.
    const open = showTerminal(withTerminals(state(), terminals), 'checkout/terminals/1')
    expect(open.bottom).toBe('checkout/terminals/1')
    const away = selectProject(open, 'search')
    expect(away).toMatchObject({ bottom: 'orchestrator', keyboard: 'pane' })
    expect(selectProject(away, 'checkout').bottom).toBe('checkout/terminals/1')
  })

  it('opens a project you have never been in the way it always did', () => {
    expect(selectProject(state(), 'search').focused).toBe('search/pagination')
    const empty = withProjects(state(), ['checkout', 'search', 'infra'])
    expect(selectProject(empty, 'infra').focused).toBeNull()
    // And a terminal closed while you were away is the orchestrator’s tab.
    const open = showTerminal(withTerminals(state(), terminals), 'checkout/terminals/1')
    const gone = withTerminals(selectProject(open, 'search'), [])
    expect(selectProject(gone, 'checkout').bottom).toBe('orchestrator')
  })

  it('never has another project’s terminal in front, whatever the tab still says', () => {
    // Tab walks you out of a project without going past its tabs, so `bottom`
    // can be left naming a terminal that is not in the row being drawn — which
    // is the same bug again. Answered where it is read, so no way of leaving a
    // project can put one there.
    const open = showTerminal(withTerminals(state(), terminals), 'checkout/terminals/1')
    const tabbed = focusBy(focusTask(open, 'checkout/refunds'), 1)
    expect(tabbed.project).toBe('search')
    expect(tabbed.bottom).toBe('checkout/terminals/1')
    expect(activeTerminal(tabbed)).toBeNull()
    // And it is in front again in the project it belongs to, unmoved.
    expect(activeTerminal({ ...tabbed, project: 'checkout' })?.id).toBe('checkout/terminals/1')
  })

  it('reads the sidebar from its top and its left, being another list', () => {
    const scrolled = { ...focusTask(state(), 'checkout/refunds'), scroll: 4, across: 12 }
    expect(selectProject(scrolled, 'search')).toMatchObject({ scroll: 0, across: 0 })
  })
})

describe('the rule itself', () => {
  it('folds in the project you are standing in, which is kept nowhere else', () => {
    const where = { project: 'checkout', focused: 'checkout/refunds', bottom: 'orchestrator' }
    expect(whereYouWere({ ...where, spots: { search: { focused: 'search/pagination' } } })).toEqual(
      {
        search: { focused: 'search/pagination' },
        checkout: { focused: 'checkout/refunds', bottom: 'orchestrator' },
      },
    )
    // Nowhere to fold it into, and nothing lost by saying so.
    expect(whereYouWere({ ...where, project: null, spots: {} })).toEqual({})
  })

  it('never hands back a spot that is not there any more', () => {
    const here = {
      panes: [{ task: 'checkout/refunds', project: 'checkout' }],
      terminals: [{ id: 'search/terminals/1', project: 'search' }],
    }
    // Both halves name something of another project's, so both fall back.
    expect(
      standingIn({ focused: 'search/pagination', bottom: 'search/terminals/1' }, 'checkout', here),
    ).toEqual({ focused: 'checkout/refunds', bottom: null })
    // And a project with nothing in it is the orchestrator, both ways.
    expect(standingIn(undefined, 'infra', here)).toEqual({ focused: null, bottom: null })
  })
})
