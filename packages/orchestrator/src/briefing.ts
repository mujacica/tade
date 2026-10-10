import {
  ago,
  documentsIn,
  type Effort,
  effortSays,
  historyFrom,
  producedClause,
  type TadeEvent,
  waitingDocuments,
} from '@tade/core'

// Where things stood when the window opened, for an orchestrator picking its
// conversation back up.
//
// Its memory of the talking comes back on its own: the session id never
// changes, so reopening Tade continues the same pi session. What does not come
// back is the world — an agent it left working finished hours ago, queued work
// started, something is held waiting for an answer — and carrying on from "I
// will start that now" without knowing whether it ever started is worse than
// starting again. So the journal, which is the only thing that remembers, is
// folded back into a few lines.
//
// Not core's `composeBrief`, which is the spoken morning brief: this is never
// said out loud, it is what the model is told before it says anything.
//
// Pure: the journal in, sentences out. Every line says when it was true, and
// the last line says the whole thing is a snapshot — status is a query, and
// what is true now is `tade_status`'s to answer, never this.

export interface BriefingInput {
  /** When the window opened, which is what every "ago" is measured from. */
  now: number
  /** The journal, oldest first. */
  events: readonly TadeEvent[]
  /**
   * What is queued and what is scheduled, in the queue's own words — the same
   * answer `tade_queue` gives. Left out when there is no window to ask, which
   * is also when there is no queue.
   */
  queue?: string
  /** How many of the person's own lines to bring back. */
  said?: number
  /** How many tasks to say something about, per project. */
  tasks?: number
  /**
   * Every project open, so the first line can say how big the world is. Without
   * it the orchestrator has to infer how many there are from what it happened
   * to be told about, which is exactly what a briefing is for.
   */
  projects?: readonly string[]
  /**
   * The changes that span repositories, folded from the task files that name
   * them. One line each, and each replaces the several task lines it is made
   * of while saying more than they did: which repository has not landed yet.
   * Passed in rather than derived here — an effort is a fold of task files and
   * this is a fold of the journal.
   */
  efforts?: readonly Effort[]
}

/** Enough to recognise the thread, few enough that nobody skips the section. */
const SAID = 5
const TASKS = 6
/**
 * The per-project cap once there is more than one project.
 *
 * A flat cap across every project was the bug: with five repositories open,
 * six lines is one repository's worth and the other four vanish **without a
 * word**, which reads as "nothing is happening there" — worse than a long
 * briefing and exactly the shape of thing that sends somebody looking for this
 * code. So the cap is per project and what it left out is counted and said. It
 * is only smaller than `TASKS` where there are several projects to spend the
 * budget on; one project briefs exactly as it always did.
 */
const PER_PROJECT = 3
/** What finished long enough ago to be history rather than news. */
const STALE = 3 * 86_400_000

/**
 * What the orchestrator is told about where things stood, or null when the
 * journal has nothing to say — a first window has no past to brief anyone on,
 * and a section that says "nothing happened" is a section nobody reads.
 */
export function composeBriefing(input: BriefingInput): string | null {
  const events = input.events
  const sections: string[] = []
  const since = (ts: string) => ago(Math.max(0, input.now - when(ts)))

  const closed = last(events, (event) => event.type === 'tade_closing')
  const latest = events.at(-1)
  if (closed) sections.push(`Tade was last open until ${since(closed.ts)}.`)
  else if (latest) sections.push(`Tade last wrote something down ${since(latest.ts)}.`)

  // How big the world is, before anything about what is in it.
  const open = input.projects ?? []
  if (open.length > 1) {
    sections.push(`${open.length} projects are open: ${[...open].join(', ')}.`)
  }
  const most = open.length > 1 ? (input.tasks ?? PER_PROJECT) : (input.tasks ?? TASKS)

  const allRunning = stillRunning(events)
  const running = perProject(allRunning, (run) => run.task, most)
  if (running.kept.length > 0) {
    sections.push(
      [
        'Agents that were still running when Tade last closed, and that it reopens where they left off:',
        ...running.kept.map((run) => `- ${run.task}, started ${since(run.ts)}`),
        ...leftOut(running.left),
      ].join('\n'),
    )
  }

  // Before the tasks, because one effort line replaces the several task lines
  // it is made of and says more than they did: which repository has not landed
  // yet is the part anybody can act on.
  const efforts = input.efforts ?? []
  if (efforts.length > 0) {
    sections.push(
      [
        'Changes that span repositories, and how far each has got:',
        ...efforts.map((effort) => `- ${effortSays(effort)}`),
      ].join('\n'),
    )
  }

  // Everything else, most recently touched first, and never a task the lines
  // above already accounted for: a briefing that says the same thing twice is
  // one that gets skimmed.
  const gone = removed(events)
  const finished = finishedBy(events, input.now)
  const inEffort = new Set(efforts.flatMap((one) => one.tasks.map((task) => task.task)))
  const moved = perProject(
    historyFrom(events, input.now).tasks.filter(
      (task) =>
        !gone.has(task.task) &&
        !inEffort.has(task.task) &&
        !allRunning.some((run) => run.task === task.task),
    ),
    (task) => task.task,
    most,
  )
  if (moved.kept.length > 0) {
    sections.push(
      [
        'The rest of the work Tade has written anything down about, most recently touched first:',
        ...moved.kept.map((task) => {
          const touched = ago(Math.max(0, input.now - task.lastEventAt))
          const done = finished.get(task.task)
          // Only what the journal actually knows. Which state a task is in is
          // a query — of git, of its agent — and answering it from here would
          // be exactly the remembered status that goes stale.
          if (done) return `- ${task.task}: finished ${touched} — ${done}`
          if (task.state) return `- ${task.task}: ${task.state} as of ${touched}`
          return `- ${task.task}: nothing written down since ${touched}`
        }),
        ...leftOut(moved.left),
      ].join('\n'),
    )
  }

  // Its own section, uncapped and **not aged**, for the reason `held` is: it is
  // a thing somebody has to act on, and the whole point of a task saying what
  // it produces is that the document is not lost — least of all to a cap or to
  // a clock. The journal is what remembers it, so a window that was shut when
  // the agent finished still opens knowing there is something to read.
  //
  // What bounds it is that anything decided about leaves it (`waitingDocuments`):
  // queued off, picked back up, or triaged. It used to be bounded by three days
  // instead, which lost a document nobody had read on the fourth morning — and
  // the only way to clear a line was to queue work, which is the incentive
  // backwards. One whose task was removed is still named, because a document
  // destroyed before anybody read it is a fact and not an absence.
  const waiting = waitingDocuments(documentsIn(events), input.now)
  if (waiting.length > 0) {
    sections.push(
      [
        'Documents that finished tasks produced and nobody has decided about yet. Read each one before you say anything about it, then say what follows — and record what you decided with tade_document_triage, or this list says it is unread forever:',
        ...waiting.map(
          (one) =>
            `- ${one.task} ${producedClause(one)} (finished ${since(one.at)}${
              one.removedAt ? `, removed ${since(one.removedAt)}` : ''
            })`,
        ),
      ].join('\n'),
    )
  }

  const held = stillHeld(events)
  if (held.length > 0) {
    sections.push(
      [
        'Held, and waiting on the person for an answer:',
        ...held.map((one) => `- ${one.task}: ${one.because} (${since(one.ts)})`),
      ].join('\n'),
    )
  }

  const queue = input.queue?.trim()
  if (queue) sections.push(['What is queued and scheduled:', queue].join('\n'))

  const said = lastSaid(events, input.said ?? SAID)
  if (said.length > 0) {
    sections.push(
      [
        'The last things they said to Tade, in their words, oldest first. They are here so you can pick the thread back up — not to answer again:',
        ...said.map((one) => `- ${since(one.ts)}: "${one.text}"`),
      ].join('\n'),
    )
  }

  if (sections.length === 0) return null
  return [
    'Where things stood when this window opened:',
    ...sections,
    'That is what the journal said as Tade opened, not what is true now. Anything current — where a task is, what is queued, what an agent did — is tade_status, tade_queue and tade_logs to answer.',
  ].join('\n\n')
}

/**
 * The first `most` of each project's, keeping the order they came in, and how
 * many of each were left over. A cap counted per project rather than over the
 * whole list, so one busy repository cannot silently spend every line.
 */
function perProject<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  most: number,
): { kept: T[]; left: Map<string, number> } {
  const seen = new Map<string, number>()
  const left = new Map<string, number>()
  const kept: T[] = []
  for (const item of items) {
    const id = idOf(item)
    const project = id.slice(0, id.indexOf('/')) || id
    const count = (seen.get(project) ?? 0) + 1
    seen.set(project, count)
    if (count <= most) kept.push(item)
    else left.set(project, (left.get(project) ?? 0) + 1)
  }
  return { kept, left }
}

/** What a cap left out, per project — never nothing, because silence reads as calm. */
function leftOut(left: ReadonlyMap<string, number>): string[] {
  return [...left]
    .sort(([one], [other]) => (one < other ? -1 : 1))
    .map(([project, count]) => `- ${project}: ${count} more not listed`)
}

/** Tasks that are not there any more, so nothing is said about them. */
function removed(events: readonly TadeEvent[]): Set<string> {
  const gone = new Set<string>()
  for (const event of events) {
    if (!event.task) continue
    if (event.type === 'task_removed') gone.add(event.task)
    if (event.type === 'task_created') gone.delete(event.task)
  }
  return gone
}

/**
 * Agents whose run started and never ended: what the window is reopening.
 *
 * A task that said it had finished is not one of them, even though its agent's
 * process usually outlives saying so — what is being asked here is what is
 * still being worked on.
 */
function stillRunning(events: readonly TadeEvent[]): { task: string; ts: string }[] {
  const open = new Map<string, string>()
  for (const event of events) {
    if (!event.task) continue
    if (event.type === 'run_started') open.set(event.task, event.ts)
    if (
      event.type === 'run_exited' ||
      event.type === 'task_removed' ||
      event.type === 'task_done'
    ) {
      open.delete(event.task)
    }
  }
  return [...open].map(([task, ts]) => ({ task, ts }))
}

/**
 * Queued work held and not answered since. A hold the person already settled —
 * they started it anyway, chose to wait, or it started — is not something to
 * put in front of them twice.
 */
function stillHeld(events: readonly TadeEvent[]): { task: string; because: string; ts: string }[] {
  const open = new Map<string, { task: string; because: string; ts: string }>()
  for (const event of events) {
    if (!event.task) continue
    if (event.type === 'queue_held') {
      const because =
        typeof event.detail.because === 'string' && event.detail.because
          ? event.detail.because
          : 'it could not start'
      open.set(event.task, { task: event.task, because, ts: event.ts })
    }
    if (
      event.type === 'queue_changed' ||
      event.type === 'queue_started' ||
      event.type === 'task_removed'
    ) {
      open.delete(event.task)
    }
  }
  return [...open.values()]
}

/** Which tasks have finished, and how it was decided, for the ones recent enough to matter. */
function finishedBy(events: readonly TadeEvent[], now: number): Map<string, string> {
  const done = new Map<string, string>()
  const cutoff = now - STALE
  for (const event of events) {
    if (!event.task) continue
    // A task started again is not finished any more, whatever was written down.
    if (event.type === 'run_started' || event.type === 'task_removed') done.delete(event.task)
    if (event.type !== 'task_done' || when(event.ts) < cutoff) continue
    const by = event.detail.by
    done.set(
      event.task,
      by === 'agent'
        ? 'its agent said so'
        : by === 'rule'
          ? `its rule, ${String(event.detail.rule ?? 'unknown')}, was met`
          : by === 'orchestrator'
            ? 'you marked it'
            : 'the person marked it',
    )
  }
  return done
}

/** What the person themselves said, verbatim: the one thing nothing else can reconstruct. */
function lastSaid(events: readonly TadeEvent[], most: number): { text: string; ts: string }[] {
  const said: { text: string; ts: string }[] = []
  for (const event of events) {
    if (event.type !== 'said') continue
    const text = typeof event.detail.text === 'string' ? event.detail.text.trim() : ''
    if (text) said.push({ text, ts: event.ts })
  }
  return said.slice(-most)
}

function last(
  events: readonly TadeEvent[],
  match: (event: TadeEvent) => boolean,
): TadeEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event && match(event)) return event
  }
  return null
}

/** A journal timestamp as a moment; an unreadable one counts as the epoch rather than NaN. */
function when(ts: string): number {
  const at = Date.parse(ts)
  return Number.isNaN(at) ? 0 : at
}
