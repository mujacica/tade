import { describeWork } from '@tade/core'
import { markOf } from '../model.ts'
import type { Wiring } from './context.ts'

// What the orchestrator's `status` answers: one agent's work, or the shape of
// everything. A fold over what the window last looked at and nothing else, so
// it is a free function rather than a method — out of `orchestrator.ts`, which
// is the conversation as the window drives it, and at its size.

/** What is going on, in `scope` (a task, a project) or everywhere. */
export function describeLive(wire: Pick<Wiring, 'live' | 'now'>, scope: string | null): string {
  const live = wire.live
  const tasks = live?.tasks ?? []
  // Asked about one agent, answer with what it has been doing. Asked about
  // everything, answer with the shape of it: an account of nine tasks at
  // once is unusable, spoken or read.
  if (live && scope && tasks.some((task) => task.task === scope)) {
    return describeWork(live.workOn(scope), wire.now())
  }
  const wanted = scope
    ? tasks.filter((t) => t.task === scope || t.task.startsWith(`${scope}/`))
    : tasks
  if (wanted.length === 0) return scope ? `nothing going on in ${scope}.` : 'nothing going on.'
  // Waiting on you is a decision to make: an agent idle at its prompt is not one.
  const blocked = wanted.filter((t) => markOf(t) === 'needs-you').length
  const working = wanted.filter((t) => markOf(t) === 'working').length
  const parts = [`${wanted.length} task${wanted.length === 1 ? '' : 's'}`]
  if (working > 0) parts.push(`${working} working`)
  parts.push(blocked > 0 ? `${blocked} waiting on you` : 'nothing blocked')
  return `${parts.join(', ')}.`
}
