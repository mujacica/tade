import {
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
} from '@wilco/core'
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
          : `looks with ${does.watch}, and starts work on what it finds`,
    prompt: does.kind === 'watch' ? '' : does.prompt,
    when: describeWhen(schedule.when),
    once: schedule.when.at !== undefined,
    next,
    paused: schedule.paused,
    by: does.kind === 'watch' ? `extension:${does.watch.split('.')[0] ?? ''}` : schedule.by,
    missed: schedule.missed,
    runs: [...runs].reverse(),
  }
}

/** A schedule and when it next runs, in a line, for the orchestrator. */
export function describeSchedule(view: ScheduleView, clock: (at: number) => string): string {
  const next =
    view.next.length > 0 ? `next ${view.next.map(clock).join(', ')}` : 'nothing left to run'
  return `- ${view.id} (${view.name}) — ${view.when}, ${view.does}; ${view.paused ? 'paused' : next}`
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
 */
export function heldMessage(task: string, because: string): string {
  return [
    `${task} is held, and will not start by itself: ${because}.`,
    'Tell the person, and ask what they want: wait for a retry, start it anyway, change the plan, or remove it.',
    'wilco_queue_change does each of those.',
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
  project: string
  made: readonly string[]
  started: readonly string[]
  waiting: readonly { task: string; state: string }[]
  warnings: readonly string[]
}): string {
  const name = (task: string) => task.split('/').slice(1).join('/')
  const lines = [
    `Made ${result.made.length} task${result.made.length === 1 ? '' : 's'} in ${result.project}.`,
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
