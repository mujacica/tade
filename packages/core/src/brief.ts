import type { TaskState } from './model.ts'

// The morning brief: everything that matters, in one paragraph, before the
// kettle boils.
//
// The hard part is not gathering it, it is leaving things out. A brief that
// recites nine tasks is one nobody listens to twice, so it speaks about what
// is stopped and counts what is moving.
//
// Pure: facts in, sentences out, `now` and the hour passed.

export interface BriefTask {
  task: string
  state: TaskState
  /** What it is waiting on, when it is blocked. */
  waiting: string | null
  /** Why it is in that state, from the state machine. */
  reason: string
}

export interface BriefOptions {
  /** Local hour, 0–23, so machines agree on what "morning" means. */
  localHour: number
  /** At most one, and only when there is room for it. */
  proposal?: string | null
}

export interface Brief {
  greeting: string
  /** One clause per thing worth saying. */
  clauses: string[]
  /** The whole thing, as it would be said out loud. */
  spoken: string
}

/** States that stop work, in the order they should be mentioned. */
const STOPPED: TaskState[] = ['blocked', 'failed', 'review']

export function composeBrief(tasks: readonly BriefTask[], opts: BriefOptions): Brief {
  const greeting = greet(opts.localHour)
  const clauses: string[] = []

  for (const state of STOPPED) {
    for (const task of tasks.filter((t) => t.state === state)) {
      clauses.push(describe(task))
    }
  }

  // What is moving is a count, not a list: it needs no decision from you.
  const working = tasks.filter((t) => t.state === 'working').length
  if (working > 0) clauses.push(`${working} still working`)

  if (clauses.length === 0) {
    // Nothing is moving, but "nothing running" while three tasks sit waiting
    // to be started is true and useless.
    const idle = [
      count(tasks, 'queued', 'waiting to start'),
      count(tasks, 'parked', 'parked'),
    ].filter((part) => part !== '')
    clauses.push(idle.length > 0 ? `nothing running, ${idle.join(' and ')}` : 'nothing running')
  }

  // One proposal, and only when the brief is short enough to hear it out.
  if (opts.proposal && clauses.length <= 4) clauses.push(opts.proposal)

  return { greeting, clauses, spoken: `${greeting}. ${sentence(clauses)}.` }
}

function describe(task: BriefTask): string {
  const name = short(task.task)
  switch (task.state) {
    case 'blocked':
      return task.waiting ? `${name} is blocked on ${task.waiting}` : `${name} is blocked`
    case 'failed':
      return `${name} failed — ${task.reason}`
    case 'review':
      return `${name} is done and wants your eyes`
    default:
      return `${name} is ${task.state}`
  }
}

function count(tasks: readonly BriefTask[], state: TaskState, label: string): string {
  const n = tasks.filter((task) => task.state === state).length
  return n > 0 ? `${n} ${label}` : ''
}

function greet(hour: number): string {
  if (hour < 12) return 'Morning'
  if (hour < 18) return 'Afternoon'
  return 'Evening'
}

/** Clauses joined the way a person would say them. */
function sentence(clauses: readonly string[]): string {
  if (clauses.length === 1) return clauses[0] ?? ''
  return `${clauses.slice(0, -1).join(', ')} and ${clauses.at(-1)}`
}

function short(task: string): string {
  return task.split('/').at(-1) ?? task
}
