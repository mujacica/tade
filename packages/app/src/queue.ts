import {
  describeLook,
  describeQueueState,
  describeWhen,
  joined,
  type Queued,
  type QueueFacts,
  type QueueState,
  queueStateOf,
  runsOf,
  type Schedule,
  scheduleEnded,
  type Watched,
} from '@tade/core'
import type { ScheduleView } from './model.ts'

// What the queue says, in words: to the journal when it starts something, to
// the orchestrator when something is held or it asks, and to you in the
// transcript. The rules themselves are core's; this is how they are told.
//
// Pure: queued work and facts in, sentences out.

/** A schedule as the SMART QUEUE shows it, from what was set and what the journal says it did. */
export function scheduleView(
  schedule: Schedule & { paused: boolean },
  runs: readonly { due: number; ran: boolean; missed: number; task: string | null }[],
  now: number,
  watched?: Watched,
): ScheduleView {
  const last = runs.at(-1)?.due ?? null
  const ran = runs.filter((run) => run.ran).length
  const created = Date.parse(schedule.created)
  const left = schedule.when.count === undefined ? 3 : Math.max(0, schedule.when.count - ran)
  const next = scheduleEnded(schedule, last, ran, now)
    ? []
    : runsOf(
        schedule.when,
        created,
        Math.max(last ?? created - 1, now),
        Number.POSITIVE_INFINITY,
        3,
      ).slice(0, left)
  const does = schedule.does
  return {
    id: schedule.id,
    name: schedule.name,
    project: schedule.project,
    said: schedule.said,
    kind: does.kind,
    does:
      does.kind === 'agent'
        ? 'starts an agent'
        : does.kind === 'ask'
          ? 'asks the orchestrator'
          : `looks with ${does.watch}, and ${does.found === 'ask' ? 'tells the orchestrator what it finds' : 'starts work on what it finds'}`,
    prompt: does.kind === 'watch' ? '' : does.prompt,
    when: describeWhen(schedule.when),
    once: schedule.when.at !== undefined,
    next,
    paused: schedule.paused,
    by: does.kind === 'watch' ? `extension:${does.watch.split('.')[0] ?? ''}` : schedule.by,
    missed: schedule.missed,
    runs: [...runs].reverse(),
    ...(does.kind === 'watch'
      ? {
          watch: {
            id: does.watch,
            turnedOnBy: schedule.by,
            found: does.found,
            most: does.most,
            looks: watched?.looks ?? [],
            findings: watched?.findings ?? [],
          },
        }
      : {}),
  }
}

/** A schedule and when it next runs, in a line, for the orchestrator; a watch with how it last looked. */
export function describeSchedule(view: ScheduleView, clock: (at: number) => string): string {
  const next =
    view.next.length > 0 ? `next ${view.next.map(clock).join(', ')}` : 'nothing left to run'
  const look = view.watch?.looks[0]
  const looked = look ? `; last looked ${clock(look.at)}: ${describeLook(look)}` : ''
  return `- ${view.id} (${view.name}) — ${view.when}, ${view.does}; ${view.paused ? 'paused' : next}${looked}`
}

/**
 * What the orchestrator is told when a watch finds something it is to be told
 * about: what, where to look, and that deciding is the person's.
 */
export function foundMessage(req: {
  name: string
  watch: string
  project: string
  who: string
  found: readonly { title: string; links?: readonly { title: string; url: string }[] }[]
  left: number
}): string {
  const lines = [
    `"${req.name}", a watch ${req.who} turned on in ${req.project} (${req.watch}), found ${req.found.length === 1 ? 'something new' : `${req.found.length} new things`}:`,
    ...req.found.map(
      (one) =>
        `- ${one.title}${(one.links ?? []).length > 0 ? ` (${(one.links ?? []).map((link) => link.url).join(', ')})` : ''}`,
    ),
  ]
  if (req.left > 0)
    lines.push(`${req.left} more ${req.left === 1 ? 'waits' : 'wait'} for its next look.`)
  lines.push(
    'Tell the person what it found and what you would do about each, and start work only on what they ask for.',
  )
  return lines.join('\n')
}

/** Why queued work is starting now. */
export function whyStarting(item: Queued, facts: QueueFacts): string {
  const anyway = facts.events.some(
    (event) =>
      event.type === 'queue_changed' && event.task === item.task && event.detail.change === 'start',
  )
  if (anyway) return 'it was started anyway'
  const waited = item.start.after.map((dep) => dep.task)
  if (waited.length > 0) {
    return `${joined(waited)} ${waited.length === 1 ? 'has' : 'have'} finished`
  }
  if (item.start.at) return 'its time came'
  return 'there was room for it'
}

/**
 * What the orchestrator is told when queued work is held. It does not choose:
 * it tells the person, and does what they say.
 *
 * A hold on what the tree says gets a sentence of its own, because the answer
 * is a different one: the work can still be started, but the code it was
 * planned against is not the code it would start on. The reason is Tade's own
 * words either way — a judge may be asked for a second reading of the plan or
 * of what should go first, and what it says is material for the orchestrator,
 * never the reason a person is given.
 */
export function heldMessage(task: string, because: string, changed?: readonly string[]): string {
  if (changed && changed.length > 0) {
    return [
      `${task} is held, and will not start by itself: ${because}.`,
      'It was planned against code that has moved since, so what its agent was told may no longer fit.',
      'Tell the person what changed and ask what they want: start it anyway, change what it is told, put something else first, or leave it until the other work has landed.',
      'tade_queue_change does each of those (start, order, pause), and tade_plan writes a new plan.',
      'jev_plan_check and jev_queue_order will read the plan and the queue again beside what has changed, if you want a second reading before you ask — say what you think in your own words, not theirs.',
    ].join(' ')
  }
  return [
    `${task} is held, and will not start by itself: ${because}.`,
    'Tell the person, and ask what they want: wait for a retry, start it anyway, change the plan, or remove it.',
    'tade_queue_change does each of those.',
  ].join(' ')
}

/** Queued work and where each stands, in lines, oldest first. */
export function describeQueue(
  items: readonly Queued[],
  facts: QueueFacts,
  clock: (at: number) => string,
): string {
  if (items.length === 0) return 'Nothing is queued.'
  const lines: string[] = []
  for (const item of items) {
    const state: QueueState = queueStateOf(item, facts)
    const reasons = item.start.after
      .filter((dep) => dep.why)
      .map((dep) => `${dep.task}: ${dep.why}`)
    lines.push(
      `- ${item.task} — ${describeQueueState(state, clock)}${reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}`,
    )
  }
  return lines.join('\n')
}

/** What a plan made and did, for the orchestrator to say back. */
export function planAnswer(result: {
  /** Every repository it made something in, the plan's own first. */
  projects: readonly string[]
  /** What the whole change is called, when it is one change. */
  effort?: string | undefined
  made: readonly string[]
  started: readonly string[]
  waiting: readonly { task: string; state: string }[]
  warnings: readonly string[]
}): string {
  // A name only loses its project where there is one project to lose it to:
  // across repositories two tasks are called the same thing far more often
  // than not, and `oauth-scopes and oauth-scopes` says nothing at all.
  const name = (task: string) =>
    result.projects.length > 1 ? task : task.split('/').slice(1).join('/')
  const where = joined([...result.projects])
  const lines = [
    `Made ${result.made.length} task${result.made.length === 1 ? '' : 's'} in ${where}${
      result.effort ? `, as ${result.effort}` : ''
    }.`,
  ]
  if (result.started.length > 0) lines.push(`Started ${joined(result.started.map(name))}.`)
  if (result.waiting.length > 0) {
    lines.push(
      `Queued ${result.waiting.map((one) => `${name(one.task)} (${one.state})`).join(', ')}.`,
    )
  }
  for (const warning of result.warnings) lines.push(`Watch out: ${warning}.`)
  return lines.join('\n')
}
