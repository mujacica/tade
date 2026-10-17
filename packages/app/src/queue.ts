import {
  type Conflict,
  decidesOf,
  describeLook,
  describeQueueState,
  describeWhen,
  elsewhereSaid,
  joined,
  mirrorRef,
  ONLY_TELLS,
  otherSide,
  type PlanBusy,
  type Queued,
  type QueueFacts,
  type QueueHolds,
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
import {
  type AppState,
  type QueueRow,
  queueTree,
  queueViewOf,
  type ScheduleView,
  type TaskSnapshot,
} from './model.ts'
import { shownBy } from './queue-view.ts'
import { NEVER_RAN, type ScheduleRuns } from './schedule-fold.ts'

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

/** What the journal says each schedule did: how often it ran and its newest runs, and a watch's looks. */
export interface ScheduleJournal {
  runsOf(schedule: string): ScheduleRuns
  watchedOf(schedule: string): Watched
}

/** Every schedule as SCHEDULES shows it, at one moment. */
export function scheduleViews(
  schedules: readonly (Schedule & { paused: boolean })[],
  journal: ScheduleJournal | null,
  now: number,
): ScheduleView[] {
  return schedules.map((one) =>
    scheduleView(
      one,
      journal?.runsOf(one.id) ?? NEVER_RAN,
      now,
      one.does.kind === 'watch' ? journal?.watchedOf(one.id) : undefined,
    ),
  )
}

/** A schedule as SCHEDULES shows it, from what was set and what the journal says it did. */
export function scheduleView(
  schedule: Schedule & { paused: boolean },
  { ran, runs }: ScheduleRuns,
  now: number,
  watched?: Watched,
): ScheduleView {
  const last = runs.at(-1)?.due ?? null
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
    // Whose call starting its work is, in the sentence, because that is the
    // difference between an agent at 3am and a question at 3am (`decidesOf`).
    does:
      does.kind === 'agent'
        ? decidesOf(does) === 'itself'
          ? 'starts an agent'
          : 'proposes an agent to the orchestrator'
        : does.kind === 'ask'
          ? 'asks the orchestrator'
          : `looks with ${does.watch}, and ${
              does.found === 'ask'
                ? 'tells the orchestrator what it finds'
                : decidesOf(does) === 'itself'
                  ? 'starts work on what it finds'
                  : 'proposes work on what it finds to the orchestrator'
            }`,
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
  const approved = item.start.after.filter((dep) => dep.approved).map((dep) => dep.task)
  if (waited.length > 0) {
    return `${joined(waited)} ${waited.length === 1 ? 'has' : 'have'} finished${
      approved.length > 0 ? ` and the person approved what ${joined(approved)} produced` : ''
    }`
  }
  if (item.start.at) return 'its time came'
  return 'there was room for it'
}

/** A hold, as much of it as the orchestrator is told: `QueueState`'s, or a start that failed. */
export interface HoldTold {
  because: string
  /** What it waits on went wrong, where that is what holds it. */
  on?: string | null
  /** The files the tree moved under it, where that is what holds it. */
  changed?: readonly string[]
  /** Whose commits those were, where git says whose. */
  by?: readonly string[]
  /** A plan window held it (`planTooTight`), which a start does not answer while the window is full. */
  plan?: boolean
}

/** Each way of answering a hold that went wrong, as the call that does it. */
const ANSWERS = {
  trouble: (on: string) =>
    `start it anyway (start), change what it waits on (after, with replace: true to drop ${on}), or remove it (remove)`,
  failed: 'try it again (wait), start it anyway (start), or remove it (remove)',
  tree: 'leave it to start by itself, have it wait on one of them (after), change what its agent is told or will touch (retell), or start it anyway (start)',
  // A start while that window is this full is held again and told again, so
  // offering one would be offering a loop: what answers it is the window
  // starting over, and only then a start.
  plan: 'leave it until that window has started over and then start it (start), or remove it (remove) — a start while the window is this full holds it again, and turning queue.hold_scheduled off is the person’s to say',
}

/**
 * Who answers (`queue.holds`): `orchestrator`, the default, and it decides,
 * then says what it did; `ask`, as the person set it, and it puts it to them.
 * Said in every hold rather than only in its prompt, which is as old as its
 * session.
 */
function whoDecides(holds: QueueHolds, choices: string): string {
  return holds === 'orchestrator'
    ? `Deciding is yours (queue.holds): ${choices}. Then tell them what you did and why, in a sentence.`
    : `The person decides, as they set it (queue.holds): tell them what holds it and what you would do — ${choices} — and do what they choose.`
}

/**
 * What the orchestrator is told when queued work is held: why, whether it
 * heals, the call that answers it, and whose answer it is (`queue.holds`).
 *
 * A hold on what the tree says gets a message of its own, because it is the
 * one that heals: the look that finds the files settled starts it (`collides`)
 * with nobody doing anything. Told it "will not start by itself", the
 * orchestrator concluded waiting would not help and removed eleven tasks to
 * plan them again. So it is told the truth, the agents at work in that
 * checkout by the ids the tools take (`working`, from `atWorkFrom`), and the
 * one call that turns the hold into a wait on one of them — never a choice
 * with no tool behind it. The reason is Tade's own words either way — a judge
 * may be asked for a second reading, and what it says is material for the
 * orchestrator, never the reason a person is given.
 */
export function heldMessage(
  task: string,
  held: HoldTold,
  told: { holds: QueueHolds; working?: readonly string[] },
): string {
  const changed = held.changed ?? []
  if (changed.length > 0) {
    const by = held.by ?? []
    const heals =
      by.length > 0
        ? `once ${joined(by)} ${by.length === 1 ? 'has' : 'have'} finished and nothing it was planned to change is left uncommitted`
        : `once ${changed.length === 1 ? 'that file is' : 'those files are'} committed`
    const working = (told.working ?? []).filter((one) => one !== task)
    const candidates = by.length > 0 ? by : working
    const pick = candidates.length === 1 ? candidates[0] : `<${candidates.join(' or ')}>`
    const wait = `tade_queue_change with change: after, task: ${task}, after: [{task: ${pick}, why: <why it has to wait>}]`
    return [
      `${task} is held: ${held.because}.`,
      `It starts by itself ${heals}: the first look that finds that starts it, with nobody doing anything.`,
      candidates.length > 0
        ? `At work in that checkout: ${joined(working.length > 0 ? working : by)}. To have it start after one of them instead, which is a wait and not a hold: ${wait}.${by.length > 0 ? '' : ' Git cannot say whose an uncommitted change is, so which is a judgement: tade_status says what each is doing.'}`
        : `To have it start after other work instead: tade_queue_change with change: after, task: ${task}, after: [{task, why}], naming a task tade_queue or tade_status lists.`,
      'It was planned against code that has moved since: if what its agent was told no longer fits, retell changes its prompt or touches.',
      whoDecides(told.holds, ANSWERS.tree),
      'jev_plan_check and jev_queue_order will read the plan and the queue again beside what has changed, if you want a second reading — say what you think in your own words, not theirs.',
    ].join(' ')
  }
  // The call is spelled out with its arguments rather than named: told only
  // "tade_queue_change does each of those", a model sent `{"change":"wait"}`
  // twelve times running, sure each time that it had written the task.
  const on = held.on ?? null
  return [
    `${task} is held, and will not start by itself: ${held.because}.`,
    whoDecides(
      told.holds,
      held.plan ? ANSWERS.plan : on !== null ? ANSWERS.trouble(on) : ANSWERS.failed,
    ),
    `Each is tade_queue_change with task: ${task} and the change named.`,
  ].join(' ')
}

/**
 * What is said, once, when a look at a project's checkout before starting work
 * in it could not read the tree (`Reality.unread`): why, and that it lets
 * nothing go — the queue keeps every hold on those files until a look can.
 */
export function unreadSays(project: string, why: string): string {
  return `could not read ${project}'s checkout before starting work in it: ${why.replace(/\.$/, '')}. Nothing held on its files is let go until a look can read them.`
}

/** What a conflict's message needs to know besides the conflict: names the tools take. */
export interface ConflictTold {
  holds: QueueHolds
  /** The side the call is addressed to, and the other one (`whoYields`). */
  yields: string
  keeps: string | null
  /** Each task's branch, where it has one. */
  branches: ReadonlyMap<string, string>
  /** Queued work planned to change these files that does not wait on `keeps` yet. */
  queued: readonly string[]
  /** For `elsewhere`: this home's mirror of the repository, which holds the other machine's branch. */
  mirror?: string
}

/**
 * What the orchestrator is told when two pieces of live work would collide:
 * what, between whom, over which files, and the one call that answers it.
 *
 * Spelled out with its arguments for the reason a hold's is, and with the
 * other side named by its branch, because "merge the other one in" is not
 * something an agent can do. Whose it is to resolve is `queue.holds`, read at
 * the moment of telling: by default the orchestrator's, without asking anybody
 * — which is what was asked for. Nothing has been held: a forecast tells.
 */
export function conflictSays(conflict: Conflict, told: ConflictTold): string {
  const files = joined(conflict.files)
  const them = conflict.files.length === 1 ? 'it' : 'them'
  const [a = '', b = ''] = conflict.tasks
  const branchOf = (task: string) => told.branches.get(task) || task
  const steer = (message: string) => `tade_steer with task: ${told.yields}, message: "${message}"`
  const keeps = told.keeps ?? ''
  if (conflict.kind === 'elsewhere') return elsewhereSays(conflict, told, files, them, steer)
  const said =
    conflict.kind === 'base'
      ? [
          `${a} would no longer merge into ${conflict.base} cleanly: ${conflict.base} has moved since its branch left it, and the two conflict in ${files}.`,
          `The one call: ${steer(`${conflict.base} has moved under your branch and the two conflict in ${files}: merge ${conflict.base} into your branch now and resolve ${them}, keeping what both meant — never a rebase and a force-push.`)}.`,
        ]
      : conflict.kind === 'branches'
        ? [
            `${a} and ${b} would conflict in ${files} if both were merged: git merge-tree says so of their branches as they stand.`,
            `The one call: ${steer(`${keeps} (branch ${branchOf(keeps)}) changes ${files} too, and merging the two would conflict: merge ${branchOf(keeps)} into your branch now and resolve ${them}, keeping what both meant, then carry on.`)}.`,
          ]
        : [
            `${a} and ${b} both have uncommitted changes in ${files}, in the checkout they share: each wrote ${them} and nothing has committed ${them} since.`,
            `The one call: ${steer(`${keeps} has uncommitted changes in ${files} too: leave ${them} alone until ${keeps} has committed, then build on what it committed and commit only your own changes, each file by path.`)}.`,
          ]
  const queued = told.queued.map(
    (task) =>
      `Queued ${task} was planned to change ${files} too: to have it start after ${keeps} instead, tade_queue_change with change: after, task: ${task}, after: [{task: ${keeps}, why: <why it has to wait>}].`,
  )
  const who =
    told.holds === 'orchestrator'
      ? `Resolving it is yours (queue.holds), without asking them: make that call, or another — tade_steer the other side, retell queued work, stop one — if you judge it better. Then tell them what you did and why, in a sentence.`
      : `The person decides, as they set it (queue.holds): tell them what collides and what you would do — that call — and do what they choose.`
  return [
    ...said,
    ...(keeps ? queued : []),
    who,
    'It is a forecast: nothing has been held or stopped, and the next look says whether it is still true.',
  ].join(' ')
}

/**
 * The same, for this machine's branch and another machine's in one repository:
 * the side here is the one told, because the other is that machine's to steer
 * — reached only through its own orchestrator, and only where the person names
 * it (`tade_remote_tell`) — and it is told where the other branch can be
 * fetched from, because "merge the other one in" is not something an agent
 * can do with a branch that is not on this machine.
 */
function elsewhereSays(
  conflict: Conflict,
  told: ConflictTold,
  files: string,
  them: string,
  steer: (message: string) => string,
): string {
  const here = conflict.tasks[0] ?? ''
  const there = conflict.elsewhere ?? { machine: 'another machine', task: '', branch: '' }
  const from = told.mirror
    ? `git fetch ${told.mirror} ${mirrorRef(there.machine, there.branch)}, then git merge FETCH_HEAD`
    : `fetch it from ${there.machine}`
  const who =
    told.holds === 'orchestrator'
      ? `Resolving it is yours (queue.holds), without asking them: make that call, or another on this side — retell queued work, stop ${here} — if you judge it better. Then tell them what you did and why, in a sentence.`
      : `The person decides, as they set it (queue.holds): tell them what collides and what you would do — that call — and do what they choose.`
  return [
    `${here} and ${elsewhereSaid(there)} would conflict in ${files} if both were merged: git merge-tree says so of ${here}'s branch and ${there.machine}'s branch ${there.branch} as this machine last fetched it.`,
    `The other side is ${there.machine}'s to steer: nothing there has been told or held, and it is reached only through its own orchestrator where the person names that machine (tade_remote_tell).`,
    `The one call here: ${steer(`${elsewhereSaid(there)} (its branch ${there.branch} there) changes ${files} too, and merging the two would conflict: merge it into your branch now — ${from} — and resolve ${them}, keeping what both meant, then carry on.`)}.`,
    who,
    'It is a forecast: nothing has been held or stopped on either machine, and the next look says whether it is still true.',
  ].join(' ')
}

/** That a collision told before is no longer there, for the next thing said. */
export function conflictGoneSays(conflict: Conflict): string {
  return `${goneBetween(conflict)} no longer collide over ${joined(conflict.files)}`
}

function goneBetween(conflict: Conflict): string {
  if (conflict.kind === 'base') return `${conflict.tasks[0]} and ${conflict.base}`
  if (conflict.kind === 'elsewhere') return `${conflict.tasks[0]} and ${otherSide(conflict, '')}`
  return joined(conflict.tasks)
}

/** One line in the conversation: who would collide with whom, over what. */
export function conflictLine(conflict: Conflict): string {
  const other =
    conflict.kind === 'base' || conflict.kind === 'elsewhere'
      ? otherSide(conflict, conflict.tasks[0] ?? '')
      : conflict.tasks[1]
  const how = conflict.kind === 'hunks' ? 'both have uncommitted changes in' : 'would conflict in'
  return `⇄ ${conflict.tasks[0]} and ${other} ${how} ${joined(conflict.files)}`
}

/**
 * Why a change meant for one piece of queued work was refused when the call
 * named none: the argument it was missing, and what there is to name.
 *
 * "Say which" is an answer to a person. A model that believes it already said
 * which — and blames the harness for losing it — needs to be told that this
 * call had no `task`, and handed the ids it can copy.
 */
export function unnamedSays(change: string, queued: readonly string[]): string {
  const now = queued.length > 0 ? ` — queued now: ${joined(queued)}` : ''
  return `${change} is for one piece of queued work, and this call named none: say which as task${now}`
}

/**
 * Where one piece of queued work stands after somebody changed something, in
 * a sentence that says what happens next and whether anybody is needed for it.
 *
 * Read after the queue has looked again, never the change's intention: `wait`
 * on work the tree still holds is held again in the same second, and an answer
 * of "waits again" sent the orchestrator off to remove and re-plan eleven
 * tasks to get what one wait written on one of them would have done.
 */
export function nowSays(
  task: string,
  state: QueueState | null,
  clock: (at: number) => string,
): string {
  if (!state) return `${task} is not queued any more`
  switch (state.kind) {
    case 'waiting':
      return `${task} waits on ${joined(state.on)}, and starts by itself once ${state.on.length === 1 ? 'that has' : 'they have'} finished${
        state.approval
          ? ` and the person has approved what ${joined(state.approval)} produced — tade_document_triage with approved, in their words, once they have`
          : ''
      }`
    case 'held':
      // What the tree holds heals: the look that finds the files settled
      // starts it (`collides`). Nothing else does — trouble with what it waits
      // on, or its own start failing, waits for an answer.
      if (state.changed) {
        return `${task} is held: ${state.because}. That heals by itself — the first look that finds those files settled starts it`
      }
      return state.on !== null
        ? `${task} is held: ${state.because}. It stays held until it is answered: start it anyway, change what it waits on (after, with replace to drop ${state.on}), or remove it`
        : `${task} is held: ${state.because}. It stays held until it is answered: wait tries it again, or start it anyway`
    case 'scheduled':
      return `${task} starts at ${clock(state.at)}`
    case 'paused':
      if (state.parked)
        return `${task} is parked: nothing starts it until somebody starts it or picks it up again`
      return state.all ? `${task} is paused with its project's queue` : `${task} is paused`
    case 'ready':
      return `${task} is next, and starts as soon as its project has room`
  }
}

/**
 * What a change to queued work came to: what started, then where each piece
 * it was about stands now. One piece is a sentence; several are lines.
 */
export function changedSays(lead: string, started: readonly string[], lines: readonly string[]) {
  const head = started.length > 0 ? `${lead} Started ${joined(started)}.` : lead
  if (lines.length === 0) return head
  if (lines.length === 1 && started.length === 0) return `${head} ${lines[0]}.`
  return [head, ...lines.map((line) => `- ${line}`)].join('\n')
}

/**
 * What removing work answers once its waits were handed on (`dependents:
 * inherit`): which pieces took them over, then where each stands now. One a
 * task file would not take (`HandedOn`'s `problem`) still waits on the task
 * that went, so it is named with why, and its state says it is held.
 */
export function handedOnSays(
  task: string,
  handed: readonly { task: string; problem?: string }[],
  started: readonly string[],
  now: readonly string[],
): string {
  if (handed.length === 0) {
    return changedSays(`${task} is removed. Nothing waited on it.`, started, [])
  }
  const took = handed.flatMap((one) => (one.problem === undefined ? [one.task] : []))
  const lines = [
    ...handed.flatMap((one) =>
      one.problem === undefined
        ? []
        : [`${one.task} could not take over what ${task} waited on: ${one.problem}`],
    ),
    ...now,
  ]
  const lead =
    took.length > 0
      ? `${task} is removed, and ${joined(took)} ${took.length === 1 ? 'takes' : 'take'} over its waits`
      : `${task} is removed`
  return changedSays(`${lead}${lines.length > 0 ? ':' : '.'}`, started, lines)
}

/**
 * What the orchestrator is told after removing work that never started: what
 * changes queued work where it is, and what removing it cost.
 *
 * Removing was how queued work got changed — seventeen tasks in nine seconds on
 * 2026-10-13, each to be planned again, and the plan refused over the names —
 * because the tool's description the model held was the one its conversation
 * began with, which knew no `retell` or `after`. An answer is never frozen, so
 * the route is said here, where the next removal is read.
 */
export function inPlaceSays(answer: string, task: string): string {
  const said = `${task} had not started. To change what queued work is told or when it starts, tade_queue_change retell (prompt, touches) and after change it in place; removing it uses its name for good, so planning it again needs a new one.`
  // Lines stay lines: under the last one it would read as about that piece.
  return `${answer}${answer.includes('\n') ? '\n' : ' '}${said}`
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

/**
 * The work already in the projects a plan reaches, which the plan is checked
 * against: what each says it will change, what it waits on, and what it is
 * doing in a few words.
 *
 * Never work that has finished: what it did is committed and the base, or an
 * uncommitted file of nobody's, which the look before starting holds on. A
 * checkout agent that has said it is done sits at its prompt, and status calls
 * that `blocked` — on 2026-10-11 four of those were 28 of one plan's 44
 * warnings, each called "waiting on you". One running again is working.
 */
export function planBusyOf(
  tasks: readonly TaskSnapshot[],
  projects: readonly string[],
): PlanBusy[] {
  const busy: PlanBusy[] = []
  for (const task of tasks) {
    if (!projects.some((project) => task.task.startsWith(`${project}/`))) continue
    if (task.finished && task.state !== 'working') continue
    const said = task.queued
      ? 'queued'
      : task.state === 'working'
        ? 'working'
        : task.state !== 'blocked'
          ? null
          : task.waiting
            ? 'waiting on your approval'
            : // It stopped without saying it was done, which is how a question looks.
              'waiting on you'
    if (!said) continue
    busy.push({
      task: task.task,
      said,
      touches: task.queued ? task.queued.touches : (task.touches ?? []),
      // Carried even with nothing to touch: it is a link in somebody's chain.
      after: (task.queued ? task.queued.after : (task.waitsOn ?? [])).map((dep) => dep.task),
    })
  }
  return busy
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
