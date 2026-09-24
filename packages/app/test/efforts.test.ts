import { describe, expect, it } from 'vitest'
import type { AppState } from '../src/model.ts'
import { groupedTasks, initialState, tasksOf, withProjects, withTasks } from '../src/model.ts'
import { inProject } from '../src/view/text.ts'
import { renderApp } from '../src/view.ts'

/** The same row without its colour, for comparing positions against columns. */
const plain = (row: string) =>
  row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

const frame = (over: Partial<{ width: number; height: number; screen: string }> = {}) => ({
  width: 80,
  height: 24,
  screen: '',
  ...over,
})

// What the side looks like when a project holds two unrelated streams.
//
// Search performance and billing emails in one repository are one flat list of
// agents interleaved, which says nothing about which is which. Two efforts is
// what says they are separate; this is what draws that. One effort or none is
// the common case, and looks exactly as it always did.

describe('the agents down the side, when a project has more than one effort', () => {
  const inEfforts = (...efforts: (string | undefined)[]): AppState =>
    withTasks(
      initialState(),
      efforts.map((effort, at) => ({
        task: `checkout/task-${at}`,
        state: 'working' as const,
        ...(effort ? { effort } : {}),
      })),
    )

  it('is one flat list with no effort at all, exactly as it always was', () => {
    const groups = groupedTasks(inEfforts(undefined, undefined))
    expect(groups).toHaveLength(1)
    expect(groups[0]?.effort).toBeNull()
    expect(groups[0]?.tasks.map((one) => one.task)).toEqual(['checkout/task-0', 'checkout/task-1'])
  })

  it('is one flat list with only one effort, because there is nothing to tell apart', () => {
    const groups = groupedTasks(inEfforts('search-perf', 'search-perf', undefined))
    expect(groups).toHaveLength(1)
    expect(groups[0]?.effort).toBeNull()
  })

  it('groups by effort once there are two, with what is in none last and unheaded', () => {
    const groups = groupedTasks(
      inEfforts('search-perf', 'billing-emails', undefined, 'search-perf'),
    )
    expect(groups.map((group) => group.effort)).toEqual(['search-perf', 'billing-emails', null])
    expect(groups[0]?.tasks.map((one) => one.task)).toEqual(['checkout/task-0', 'checkout/task-3'])
    expect(groups[2]?.tasks.map((one) => one.task)).toEqual(['checkout/task-2'])
  })

  it('leaves nothing out: every agent is in exactly one group', () => {
    const groups = groupedTasks(inEfforts('a', 'b', undefined))
    expect(groups.flatMap((group) => group.tasks).map((one) => one.task)).toEqual(
      tasksOf(inEfforts('a', 'b', undefined)).map((one) => one.task),
    )
  })
})

describe('a wait that crosses repositories, as the person reads it', () => {
  it('keeps the other project’s prefix, and loses only this one’s', () => {
    // In a `sentry-cli` pane, `after oauth-scopes` names a task that pane
    // could plausibly have and does not. Tidying every prefix away is the one
    // change here that would read better and be wrong.
    expect(inProject('sentry-cli', 'after sentry/oauth-scopes')).toBe('after sentry/oauth-scopes')
    expect(inProject('sentry-cli', 'after sentry-cli/bump')).toBe('after bump')
  })
})

describe('the agents down the side, with two efforts in one project', () => {
  const inEfforts = (...efforts: (string | undefined)[]): AppState =>
    withTasks(
      withProjects(initialState(), ['checkout']),
      efforts.map((effort, at) => ({
        task: `checkout/task-${at}`,
        state: 'working' as const,
        ...(effort ? { effort } : {}),
      })),
    )

  it('draws a header per effort, and none at all over what is in none', () => {
    const rows = renderApp(inEfforts('search-perf', 'billing-emails', undefined), frame()).map(
      plain,
    )
    // Only down the side: the row also spans the pane, whose header says the
    // focused task's name too.
    const side = rows.map((row) => row.slice(0, 26))
    const at = (text: string) => side.findIndex((row) => row.includes(text))
    // Each header above its own agents, in the order the efforts came.
    expect(at('SEARCH-PERF')).toBeGreaterThan(-1)
    expect(at('task-0')).toBeGreaterThan(at('SEARCH-PERF'))
    expect(at('BILLING-EMAILS')).toBeGreaterThan(at('task-0'))
    expect(at('task-1')).toBeGreaterThan(at('BILLING-EMAILS'))
    // What is in no effort gets no heading of its own: one saying "no effort"
    // is noise in the common case where nothing has one.
    expect(side.join('\n')).not.toMatch(/NO EFFORT|OTHER|UNGROUPED/)
    // And the heading still counts every agent, grouped or not.
    expect(rows.find((row) => row.includes('AGENTS'))).toContain('(3)')
  })

  it('draws nothing extra with one effort or none, which is what it always looked like', () => {
    const one = renderApp(inEfforts('search-perf', 'search-perf'), frame()).map(plain).join('\n')
    expect(one).not.toContain('SEARCH-PERF')
    const none = renderApp(inEfforts(undefined, undefined), frame()).map(plain).join('\n')
    expect(none).toContain('task-0')
  })
})
