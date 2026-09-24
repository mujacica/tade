import { describe, expect, it } from 'vitest'
import type { AppState } from '../src/model.ts'
import { groupedTasks, initialState, tasksOf, withTasks } from '../src/model.ts'
import { inProject } from '../src/view/text.ts'

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
