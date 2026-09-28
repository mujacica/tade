import {
  describeLook,
  describeQueueState,
  describeWhen,
  joined,
  ONLY_TELLS,
  type Queued,
  type QueueFacts,
  type QueueState,
  queueStateOf,
  runsOf,
  type Schedule,
  STARTS_AGENTS,
  scheduleEnded,
  WATCH_REACH,
  type Watched,
} from '@tade/core'
import type { WatchOffer } from '@tade/extensions-core'
import { type AppState, type QueueRow, queueTree, queueViewOf, type ScheduleView } from './model.ts'
import { shownBy } from './queue-view.ts'

// What the queue and the schedules say, in words: to the journal when something
// starts, to the orchestrator when something is held or it asks, to you in the
// transcript, and — where a list in the side has come out empty — in its
// heading. The rules themselves are core's; this is how they are told.
//
// Pure: queued work and facts in, sentences out.

/**
 * Why queued work at the front of the queue is not starting, in a word.
 *
 * Waiting for a time is not one of them: work on a clock at the front of the
 * tree *is* next, and starts by itself when its time comes. Nobody is needed,
 * so there is nothing here to say about it.
 */
type QueueHold = 'held' | 'paused' | 'stuck'

/** What each of those is, said the way it would be said out loud. */
const HOLD_SAYS: Readonly<Record<QueueHold, string>> = {
  held: 'is held',
  paused: 'is paused',
  stuck: 'cannot start itself',
}

/** The same, as one word in a list of them. */
const HOLD_WORDS: Readonly<Record<QueueHold, string>> = {
  held: 'held',
  paused: 'paused',
  stuck: 'unable to start itself',
}

/** Why a piece of queued work is not the front of anything that will start. */
function holdOf(row: QueueRow): QueueHold {
  const kind = row.pane.queued.state.kind
  return kind === 'held' || kind === 'paused' ? kind : 'stuck'
}

/**
 * Why the SMART QUEUE is showing nothing, in the words of the reason it
 * actually is — everything at the front is held, everything is paused, or
 * nothing is queued at all. One sentence for every case reads as a bug the
 * moment one of the cases is not true: "nothing is next" beside work that
 * plainly is queued is what sent somebody looking for this code.
 *
 * Nothing about the clocks any more, in either direction. The schedules used
 * to be counted here, because the switch over them could empty a list that had
 * something in it; they have a section of their own now, and a queue with
 * nothing queued in it says so whatever is on a clock next door.
 */
export function queueEmptySays(state: AppState): string {
  const view = queueViewOf(state)
  const rows = queueTree(state)
  if (rows.length === 0) return 'nothing is queued'
  if (view.scope === 'all') return 'nothing is queued'
  // Nothing shown under `next` means the front of the tree is what is stopping
  // it: what waits behind held or paused work is not next, it is behind that.
  // Only the fronts the view is not showing, since a front that is shown is a
  // list with something in it.
  const fronts = rows.filter(
    (row) => row.parent === null && !shownBy(view, { queued: row.pane.queued, parent: row.parent }),
  )
  const kinds = [...new Set(fronts.map(holdOf))]
  // One reason is said as that reason, and by name where there is one thing
  // it is about. No front at all is a plan that waits on itself: there is
  // nothing to name, but there is still an answer to give.
  if (kinds.length <= 1) {
    const who = fronts.length === 1 ? (fronts[0]?.pane.name ?? '') : 'the work at the front'
    return `nothing is next: ${who} ${HOLD_SAYS[kinds[0] ?? 'stuck']}`
  }
  const words = (['held', 'paused', 'stuck'] as const)
    .filter((kind) => kinds.includes(kind))
    .map((kind) => HOLD_WORDS[kind])
  const list = `${words.slice(0, -1).join(', ')} or ${words.at(-1) ?? ''}`
  return `nothing is next: what is at the front is ${list}`
}

/**
 * Why SCHEDULES is showing nothing, in the room a heading has. There is one
 * reason, and it has no control to blame: nothing in this project runs on a
 * clock. The section is still there, and folded, so a person looking for the
 * clockwork finds where it would be rather than finding nothing at all.
 */
export function schedulesEmptySays(): string {
  return 'nothing on a clock'
}

/**
 * The same, with the one thing there is to do about it, in the room the open
 * section has. A watch is turned on from the Extensions page or by asking, and
 * an empty list that does not say so is a dead end.
 */
export function schedulesEmptyMeans(): string {
  return 'nothing here runs on a clock — the Extensions page turns a watch on'
}

/**
 * What a standing rule makes each time it fires, in a word: work, or a
 * sentence for somebody.
 *
 * The difference between a watch queueing an agent at three in the morning and
 * one telling you in the morning, which is the thing about a standing rule
 * worth a column of its own on its row. A watch answers with what it does about
 * what it *finds* — looking costs nothing and is not the news.
 */
export function scheduleMakes(view: ScheduleView): 'agents' | 'tells' {
  if (view.watch) return view.watch.found === 'agent' ? 'agents' : 'tells'
  return view.kind === 'agent' ? 'agents' : 'tells'
}

/** A schedule as SCHEDULES shows it, from what was set and what the journal says it did. */
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

/**
 * A schedule and when it next runs, in a line, for the orchestrator; a watch
 * with how it last looked.
 *
 * With its project, because this list is every project's at once and the same
 * watch runs in several of them under the same name: two lines reading "New
 * Sentry errors" are two lines nobody can tell apart, and an id somebody has
 * never seen is not an answer to which repository a thing is watching.
 */
export function describeSchedule(view: ScheduleView, clock: (at: number) => string): string {
  const next =
    view.next.length > 0 ? `next ${view.next.map(clock).join(', ')}` : 'nothing left to run'
  const look = view.watch?.looks[0]
  const looked = look ? `; last looked ${clock(look.at)}: ${describeLook(look)}` : ''
  return `- ${view.id} (${view.name}, in ${view.project}) — ${view.when}, ${view.does}; ${view.paused ? 'paused' : next}${looked}`
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

/**
 * Every watch there is, as something to read: what it looks for, how often,
 * what it does about what it finds, and whether it is on in each project.
 *
 * Every watch and not only the ones that can look: one whose extension needs
 * a key is still worth knowing about, and saying what it needs is how somebody
 * comes to set it up.
 *
 * `watching` is asked rather than read, because whether a watch is on in a
 * project is a schedule in the window and this file knows about neither.
 */
export function watchesListed(req: {
  offers: readonly WatchOffer[]
  projects: readonly string[]
  watching: (watch: string, project: string) => { paused: boolean } | null
  find: string
}): string {
  const words = req.find.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  for (const offer of req.offers) {
    const text = `${offer.id} ${offer.title} ${offer.means}`.toLowerCase()
    if (!words.every((word) => text.includes(word))) continue
    const where = req.projects.map((project) => {
      const one = req.watching(offer.id, project)
      return `${project}: ${one ? (one.paused ? 'off, paused' : 'on') : 'off'}`
    })
    lines.push(
      `${offer.id} — ${offer.title}, looks ${describeWhen({ every: offer.every })}, and ${
        offer.offers === 'agent' ? STARTS_AGENTS : ONLY_TELLS
      }`,
    )
    lines.push(`  ${offer.means}`)
    lines.push(
      `  ${where.length > 0 ? where.join(' · ') : 'no project is open'}${
        offer.problem ? ` · it cannot look yet: ${offer.problem}` : ''
      }`,
    )
  }
  if (lines.length === 0) {
    return req.offers.length === 0
      ? 'No extension here offers anything to watch.'
      : `Nothing matches ${req.find}. Ask again with fewer words, or with none for all of them.`
  }
  return [
    ...lines,
    '',
    `Turning one on or off takes the person's own words naming that watch: ${WATCH_REACH.because}.`,
  ].join('\n')
}
