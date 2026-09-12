import type { WorkHistory } from './history.ts'
import type { TaskState } from './model.ts'

// Which agent did you mean.
//
// Deterministic and explainable: every answer carries the reason it was
// chosen, so the app can show its working and you can correct it. When the
// evidence doesn't single one out it ASKS rather than guessing, because acting
// on the wrong agent is far worse than one more question.

/** Words that mean "the one we were just talking about". */
const PRONOUNS = new Set([
  'it',
  'that',
  'this',
  'that one',
  'this one',
  'them',
  'the same',
  'the same one',
])

export interface KnownTask {
  id: string
  project: string
  state: TaskState
}

export interface ResolveContext {
  tasks: KnownTask[]
  history: WorkHistory
  /** What the app has selected, i.e. what you are looking at. */
  focused?: string | null
  /** The last task a command was aimed at. */
  lastAddressed?: string | null
  now: number
}

export interface ResolveOptions {
  /** Narrows the field for verbs that only make sense in one state. */
  prefer?: 'waiting' | 'running'
}

export type Target =
  | { kind: 'resolved'; task: string; why: string }
  | { kind: 'ask'; question: string; candidates: string[] }
  | { kind: 'none'; why: string }

/** How recently something must have moved to count as "what we were doing". */
const RECENT_MS = 30 * 60_000

export function resolveTarget(
  spoken: string | null,
  context: ResolveContext,
  options: ResolveOptions = {},
): Target {
  const { tasks } = context
  if (tasks.length === 0) return { kind: 'none', why: 'there are no tasks' }

  const said = (spoken ?? '').trim().toLowerCase()

  // 1. A name you actually said wins over any amount of inference.
  if (said && !PRONOUNS.has(said)) {
    const named = byName(said, tasks)
    if (named.length === 1) return resolved(named[0]!.id, `you said ${short(named[0]!.id)}`)
    if (named.length > 1)
      return ask(
        `Which ${said}?`,
        named.map((t) => t.id),
      )

    const inProject = tasks.filter((t) => t.project === said.replace(/\s+/g, ''))
    if (inProject.length === 1) {
      return resolved(inProject[0]!.id, `the only task in ${said}`)
    }
    if (inProject.length > 1) {
      const narrowed = narrow(inProject, options)
      if (narrowed.length === 1) {
        return resolved(narrowed[0]!.id, `the only one in ${said} ${describePreference(options)}`)
      }
      return ask(
        `Which one in ${said}?`,
        inProject.map((t) => t.id),
      )
    }
    return { kind: 'none', why: `nothing here is called ${spoken}` }
  }

  // 2. Nothing named, or a pronoun: work out what you meant from context.
  const field = narrow(tasks, options)
  if (field.length === 1) {
    return resolved(field[0]!.id, `the only one ${describePreference(options)}`.trim())
  }

  if (context.focused && field.some((t) => t.id === context.focused)) {
    return resolved(context.focused, 'it is what you are looking at')
  }
  if (context.lastAddressed && field.some((t) => t.id === context.lastAddressed)) {
    return resolved(context.lastAddressed, 'it is what you last spoke to')
  }

  const recent = context.history.tasks.filter(
    (activity) =>
      context.now - activity.lastEventAt <= RECENT_MS &&
      field.some((task) => task.id === activity.task),
  )
  if (recent.length === 1) {
    return resolved(recent[0]!.task, 'it is the only one that has moved recently')
  }

  const candidates = (recent.length > 1 ? recent.map((r) => r.task) : field.map((t) => t.id)).slice(
    0,
    5,
  )
  if (candidates.length === 0) return { kind: 'none', why: 'nothing matches' }
  if (candidates.length === 1) return resolved(candidates[0]!, 'only one candidate')
  return ask(question(options), candidates)
}

/**
 * Answer a question the resolver asked. Accepts a name, an ordinal ("the first
 * one"), or a number, and refuses anything it can't place.
 */
export function resolveAnswer(answer: string, candidates: string[]): string | null {
  const said = answer
    .trim()
    .toLowerCase()
    .replace(/^(the|that)\s+/, '')
  const ordinals = ['first', 'second', 'third', 'fourth', 'fifth']
  const ordinal = ordinals.findIndex((word) => said.startsWith(word))
  if (ordinal >= 0) return candidates[ordinal] ?? null

  const number = /^([1-9])\b/.exec(said)
  if (number) return candidates[Number(number[1]) - 1] ?? null

  const named = candidates.filter(
    (candidate) => candidate.toLowerCase() === said || short(candidate).toLowerCase() === said,
  )
  if (named.length === 1) return named[0]!
  const loose = candidates.filter((candidate) => candidate.toLowerCase().includes(said))
  return loose.length === 1 ? loose[0]! : null
}

function byName(said: string, tasks: KnownTask[]): KnownTask[] {
  const collapsed = said.replace(/\s+/g, '-')
  return tasks.filter(
    (task) =>
      task.id.toLowerCase() === said ||
      short(task.id).toLowerCase() === said ||
      short(task.id).toLowerCase() === collapsed,
  )
}

function narrow(tasks: KnownTask[], options: ResolveOptions): KnownTask[] {
  if (options.prefer === 'waiting') {
    const waiting = tasks.filter((t) => t.state === 'blocked')
    if (waiting.length > 0) return waiting
  }
  if (options.prefer === 'running') {
    const running = tasks.filter((t) => t.state === 'working')
    if (running.length > 0) return running
  }
  return tasks
}

function describePreference(options: ResolveOptions): string {
  if (options.prefer === 'waiting') return 'waiting on you'
  if (options.prefer === 'running') return 'running'
  return ''
}

function question(options: ResolveOptions): string {
  if (options.prefer === 'waiting') return 'Which one? More than one is waiting.'
  if (options.prefer === 'running') return 'Which one? More than one is running.'
  return 'Which one?'
}

const resolved = (task: string, why: string): Target => ({ kind: 'resolved', task, why })
const ask = (question: string, candidates: string[]): Target => ({
  kind: 'ask',
  question,
  candidates,
})

function short(task: string): string {
  return task.split('/').at(-1) ?? task
}
