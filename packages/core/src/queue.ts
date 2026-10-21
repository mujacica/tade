import type { Finished } from './done.ts'
import { type EventType, type TadeEvent, typeNow } from './events.ts'
import type { DoneRule, StartCondition, TaskState } from './model.ts'
import { approvedFrom, type Triage } from './produces.ts'
import { RuntimeFold } from './runtime.ts'

// Work asked for now and started later.
//
// Queued work is a task that has not started, with a start condition in its
// task file: the tasks it waits on, and the time it waits for. Whether it can
// start is a query — of what status says the tasks are, what the journal says
// has finished or gone wrong, and the clock — so Tade acts on it by rule,
// without a model deciding again, and gives the same answer every time.
//
// Pure: facts in, answers out.

export interface Queued {
  task: string
  project: string
  /**
   * Set aside by a person, out of its own task file.
   *
   * Every other answer below is folded out of the journal, the clock or the
   * tree. This one is told — it is one of the two things "no probe could ever"
   * answer — and `deriveState` gives it precedence over every state but a
   * merge, so the queue has to read it or a task drawn as parked everywhere
   * else starts anyway. Not optional: the one unsafe answer is `false`, and a
   * caller that has to say which cannot arrive at it by forgetting.
   */
  parked: boolean
  start: StartCondition
  /** Who made it, as its task file says (`taskOrigin`): what tells a schedule's work from yours. */
  by?: string
}

export interface QueueFacts {
  /** What status says each task is now. A task it does not list has gone. */
  tasks: ReadonlyMap<string, { state: TaskState; reason: string }>
  finished: ReadonlyMap<string, Finished>
  /** The journal: what was removed, stopped, failed, paused or started anyway. */
  events: readonly TadeEvent[]
  now: number
  /**
   * What each project's tree actually says, for work about to start in it.
   * A project nobody has looked at is absent — which is not the same as a
   * project where nothing has changed, and is why this is a map and not a
   * list: with no look, the last hold written stands until it is answered.
   */
  reality?: ReadonlyMap<string, Reality>
}

/**
 * What a project's tree says now, rather than what whoever planned the work
 * read in it. Gathered at the moment something is about to start, because
 * that is the moment it is true: an agent that began after the plan was
 * written has been changing files ever since.
 */
export interface Reality {
  workspace: 'checkout' | 'worktree'
  /** The agents at work in it now, by task (`atWorkFrom`). */
  working: readonly string[]
  /** Changed and not committed, whoever changed them. */
  dirty: readonly string[]
  /** What each agent at work has committed since it started, by task. */
  committed: readonly { task: string; paths: readonly string[] }[]
  /**
   * Why git could not read the tree, where it could not. What is above is then
   * the last look that could, and a look that could not read the files is no
   * evidence they have settled: it may add a hold and never heals one.
   */
  unread?: string
}

/**
 * What `atWorkFrom` reads: what opens a run, and everything `RuntimeFold`
 * takes as the end of one. A reader that hands it less keeps a run open that
 * runtime has closed.
 */
export const AT_WORK_READS = [
  'run_started',
  'run_exited',
  'lane_exited',
  'task_removed',
  'tade_opened',
  'tade_closing',
] as const satisfies readonly EventType[]

const READS: ReadonlySet<EventType> = new Set(AT_WORK_READS)

export interface AtWorkFacts {
  /**
   * Every task there is, with its own workspace — out of its task file, never
   * its project's. A task not in it has gone.
   */
  tasks: ReadonlyMap<string, { workspace: 'checkout' | 'worktree' }>
  finished: ReadonlyMap<string, Finished>
}

/**
 * The agents at work in a project's checkout now, and when each started.
 *
 * A run counts while `RuntimeFold` would call it open — no exit, no lane gone,
 * no removal, no window closing or opening since — so the queue and the Spend
 * page can never disagree about whether an agent is there. Its ceiling is not
 * applied: that bounds how long a run's time may be believed, and dropping an
 * agent that is there could only let work start under it.
 *
 * And only a task that still exists, in this checkout, and unfinished. On
 * 2026-10-11 a watch's CI fix, in a worktree of its own and removed two seconds
 * after a relaunch the day before, was named in every hold in tade's checkout:
 * the reading this replaced saw only `run_started` and `run_exited`.
 *
 * An agent between turns is still here and still about to change things,
 * which is why this is its run and not whether status calls it `working`.
 */
export function atWorkFrom(
  events: readonly TadeEvent[],
  project: string,
  facts: AtWorkFacts,
): Map<string, number> {
  const fold = new RuntimeFold()
  for (const event of events) if (READS.has(typeNow(event.type))) fold.add(event)
  const at = new Map<string, number>()
  for (const run of fold.openRuns) {
    const task = run.task
    if (!task?.startsWith(`${project}/`)) continue
    // A watch's work that cannot share a tree has a worktree whatever the
    // project says, so whose checkout it is in is the task's own answer.
    if (facts.tasks.get(task)?.workspace !== 'checkout') continue
    // Finished work is what whatever starts next builds on, not work going on around it.
    if (facts.finished.has(task)) continue
    at.set(task, Math.min(run.at, at.get(task) ?? run.at))
  }
  return at
}

/** What queued work would land in the middle of, and why that is held. */
export interface Collision {
  /** The files both it and work going on now change. */
  paths: string[]
  /** Whose changes they are, where git says whose. */
  by: string[]
  /** Why it is held, in a sentence a person can read. */
  because: string
}

export type QueueState =
  /**
   * What it waits on has not finished — or, for those in `approval`, the
   * person has not yet approved the document it produced.
   */
  | { kind: 'waiting'; on: string[]; approval?: string[] }
  /** Someone has to decide: what it waits on failed, stopped or went, or it could not start. */
  | {
      kind: 'held'
      on: string | null
      because: string
      /** The files work going on now has changed, when that is what holds it. */
      changed?: readonly string[]
      /** Whose changes they are, where git says whose. */
      by?: readonly string[]
    }
  /** Not before a time. */
  | { kind: 'scheduled'; at: number }
  /**
   * Paused, on its own or with everything else in its project — or parked,
   * which is the same answer to "may this start" and a different word for
   * why: a pause is a choice about the queue, a park a choice about the task.
   */
  | { kind: 'paused'; all: boolean; parked?: boolean }
  /** It can start, and does as soon as its project has room. */
  | { kind: 'ready' }

/**
 * What a person can do to queued work.
 *
 * `after` and `retell` change the task file rather than only the journal:
 * what it waits on, and what its agent is told or says it will touch. They are
 * how a plan is changed once it is made — re-ordering is a wait written on the
 * work, never the work removed and planned again, which uses its name up for
 * good and holds everything that waited on it. There is no rename: a task's id
 * is its folder, its conversation and its trailer.
 */
export const QUEUE_CHANGES = [
  'pause',
  'resume',
  'start',
  'wait',
  'order',
  'after',
  'retell',
] as const
export type QueueChange = (typeof QUEUE_CHANGES)[number]

export interface Choices {
  paused: boolean
  /** Started anyway, whatever it waits on. */
  anyway: boolean
  /** Where the last choice was made: trouble before it has been answered. */
  answeredAt: number
  /**
   * Where the start-anyway that stands was written, which a whole queue paused
   * before it does not hold; 0 where none stands.
   */
  startedAt: number
}

/** Every choice a person has made about one piece of queued work. */
export function choicesFor(task: string, events: readonly TadeEvent[]): Choices {
  const choices: Choices = { paused: false, anyway: false, answeredAt: 0, startedAt: 0 }
  for (const event of events) {
    if (event.type !== 'queue_changed' || event.task !== task) continue
    switch (event.detail.change) {
      case 'pause':
        choices.paused = true
        break
      case 'resume':
        choices.paused = false
        choices.answeredAt = event.seq
        break
      // A start is newer than a pause and says the opposite, so it lifts this
      // piece's own pause — ▶ on a paused row is a start (`view/queue.ts`),
      // and one that left the pause standing was a press that did nothing. A
      // pause written after it holds again.
      case 'start':
        choices.anyway = true
        choices.paused = false
        choices.answeredAt = event.seq
        choices.startedAt = event.seq
        break
      case 'wait':
        choices.anyway = false
        choices.startedAt = 0
        choices.answeredAt = event.seq
        break
      // A wait written down is newer than a start-anyway and says the
      // opposite. It answers no trouble: adding a wait may only ever make a
      // start later, so a failure it was held on still holds. Waits handed on
      // by a removal (`inheritWaits`) say nothing new — it already waited on
      // all of them through the task removed — so a start-anyway stands.
      case 'after':
        if (event.detail.inherited === undefined) {
          choices.anyway = false
          choices.startedAt = 0
        }
        break
    }
  }
  return choices
}

/**
 * Whether a project's whole queue is paused: the last word on it, for that
 * project or for every project.
 */
export function queuePaused(events: readonly TadeEvent[], project: string): boolean {
  return queuePausedAt(events, project) !== null
}

/** Where the pause that holds a project's whole queue now was written, or null where none does. */
function queuePausedAt(events: readonly TadeEvent[], project: string): number | null {
  let paused: number | null = null
  for (const event of events) {
    if (event.type !== 'queue_changed' || event.detail.all !== true) continue
    const scope = event.detail.project
    if (typeof scope === 'string' && scope !== project) continue
    if (event.detail.change === 'pause') paused = event.seq
    if (event.detail.change === 'resume') paused = null
  }
  return paused
}

/**
 * Why something a task waits on is in trouble, if it is: gone, failed, or
 * stopped before it finished. Only trouble since the last time somebody chose
 * to wait anyway counts, and a run started again clears what came before it.
 */
function troubleWith(dep: string, facts: QueueFacts, since: number): string | null {
  let removed = false
  let stopped = false
  let failed = false
  for (const event of facts.events) {
    if (event.task !== dep) continue
    if (event.type === 'run_started') {
      stopped = false
      failed = false
    }
    if (event.seq <= since) continue
    if (event.type === 'task_removed') removed = true
    if (event.type === 'run_exited' && event.detail.stopped === true) stopped = true
    const code = event.detail.code
    if (
      event.type === 'failed' ||
      (event.type === 'run_exited' && typeof code === 'number' && code !== 0)
    ) {
      failed = true
    }
  }
  const now = facts.tasks.get(dep)
  if (!now)
    return removed ? `${dep} was removed before it finished` : `${dep} is not there any more`
  // A failure somebody already chose to wait past holds nothing until it fails again.
  //
  // What status calls failed is read as it is now, never as it was when a hold
  // was written: a `queue_held` from it is a sentence, not a state, so the hold
  // goes by itself the moment status reads otherwise, and nobody owes it an
  // answer. That, rather than waiting for a failure to be seen twice, is what
  // keeps one bad look from holding the queue: a second look is no confirmation
  // if the probe still cannot see, and status may only call a task failed on
  // evidence (`ProbeBundle.unread` — a look git could not answer is never
  // `checkout missing`, which on 2026-10-21 held every queued task in vrolta).
  if (now.state === 'failed' && (since === 0 || failed)) {
    return now.reason ? `${dep} failed: ${now.reason}` : `${dep} failed`
  }
  if (stopped && now.state !== 'working') return `${dep} was stopped before it finished`
  return null
}

/**
 * Why a task's own start failed, since anyone last answered it.
 *
 * Exported because the inbox asks the same question of an intake-originated
 * task and the answer must be the same sentence: a second reading of the same
 * events is a second answer, and the one place this is read from is here.
 */
export function troubleStarting(
  task: string,
  events: readonly TadeEvent[],
  since: number,
): string | null {
  let because: string | null = null
  for (const event of events) {
    if (event.task !== task || event.seq <= since) continue
    if (event.type === 'queue_held' && event.detail.start === 'failed') {
      because =
        typeof event.detail.because === 'string' ? event.detail.because : 'it could not start'
    }
  }
  return because
}

/**
 * Whether a hold was already said since anyone last answered it: said once, a
 * hold waits for an answer, and asking again every refresh is nagging.
 *
 * A hold on what the tree says is matched by being one, not by its words: the
 * files being changed under queued work change from one look to the next, and
 * a sentence that grows a filename is not news worth waking anybody for.
 *
 * Every change is an answer — a wait written on it and a retelling included —
 * so a hold after one is news again: whoever made it is told it did not take.
 */
export function holdSaid(
  task: string,
  held: { because: string; changed?: readonly string[] },
  events: readonly TadeEvent[],
): boolean {
  let said = false
  for (const event of events) {
    if (event.task !== task) continue
    const change = event.detail.change
    if (event.type === 'queue_changed' && change !== 'pause' && change !== 'order') {
      said = false
    }
    if (event.type !== 'queue_held') continue
    if (event.detail.because === held.because) said = true
    if (held.changed && Array.isArray(event.detail.changed)) said = true
  }
  return said
}

/**
 * Where one piece of queued work stands before anybody looks at the tree:
 * everything the journal and the clock say, and nothing about what other
 * agents have been doing to the files since.
 *
 * This is how the window knows which trees are worth the git calls: what this
 * says is ready is what is about to start, and only those are looked at.
 */
export function queueStanding(item: Queued, facts: QueueFacts): QueueState {
  return stateOf(item, facts, false)
}

/** Where one piece of queued work stands. */
export function queueStateOf(item: Queued, facts: QueueFacts): QueueState {
  return stateOf(item, facts, true)
}

function stateOf(item: Queued, facts: QueueFacts, tree: boolean): QueueState {
  // Parked first, above the journal and above `anyway`. Parking is the only
  // thing read here that a person told Tade rather than Tade deriving it, and
  // the only way to undo it is to pick the task up again — so it is newer
  // than any choice in the journal by construction, and there is nothing it
  // should lose to. `deriveState` orders it the same way, which is what keeps
  // the queue and the task list from giving two answers about one task.
  if (item.parked) return { kind: 'paused', all: false, parked: true }
  const choices = choicesFor(item.task, facts.events)
  // A whole queue paused holds every piece of it but one somebody started
  // anyway since: that start is a person's newer word about this one piece,
  // and the rest of the queue stays paused.
  const whole = queuePausedAt(facts.events, item.project)
  if (whole !== null && choices.startedAt <= whole) return { kind: 'paused', all: true }
  if (choices.paused) return { kind: 'paused', all: false }
  const own = troubleStarting(item.task, facts.events, choices.answeredAt)
  if (own) return { kind: 'held', on: null, because: own }
  // Started anyway: somebody has already answered for this one, and an answer
  // is not asked twice — not for what it waits on, and not for the tree.
  if (choices.anyway) return { kind: 'ready' }
  const on: string[] = []
  const approval: string[] = []
  // An approval wait waits on the person as well as on the work: finished and
  // approved, in either order, and neither stands in for the other.
  const approved: ReadonlyMap<string, Triage> | null = item.start.after.some((dep) => dep.approved)
    ? approvedFrom(facts.events)
    : null
  for (const dep of item.start.after) {
    const finished = facts.finished.has(dep.task)
    const unapproved = dep.approved === true && !approved?.has(dep.task)
    if (finished && !unapproved) continue
    if (!finished) {
      const trouble = troubleWith(dep.task, facts, choices.answeredAt)
      if (trouble) return { kind: 'held', on: dep.task, because: trouble }
    }
    on.push(dep.task)
    if (unapproved) approval.push(dep.task)
  }
  if (on.length > 0) return { kind: 'waiting', on, ...(approval.length > 0 ? { approval } : {}) }
  const at = item.start.at ? Date.parse(item.start.at) : Number.NaN
  if (Number.isFinite(at) && at > facts.now) return { kind: 'scheduled', at }
  if (!tree) return { kind: 'ready' }
  // Last, and only ever to hold: what the plan guessed about the code,
  // against what has actually happened to it since.
  const clash = collides(item, facts, choices.answeredAt)
  if (clash) {
    return { kind: 'held', on: null, because: clash.because, changed: clash.paths, by: clash.by }
  }
  return { kind: 'ready' }
}

/**
 * What holds queued work on the evidence: what the last look at the tree
 * found, or — where nobody has looked — what the last look wrote down and
 * nobody has answered. A hold heals on its own: the look that reads the
 * files and finds them settled says ready, so work never waits on a person
 * for a reason that has gone.
 */
function collides(item: Queued, facts: QueueFacts, since: number): Collision | null {
  const seen = facts.reality?.get(item.project)
  if (seen && seen.unread === undefined) return collidesNow(item, seen)
  // A look git could not answer is not one that found nothing: the hold
  // written stands, and what the last look that could read found may add one.
  const written = writtenCollision(item.task, facts.events, since)
  return written ?? (seen ? collidesNow(item, seen) : null)
}

/**
 * Where what queued work says it touches meets what agents at work have
 * actually changed. `touches` is a reading of the code somebody made when the
 * work was planned; this is the same files an hour later, and the difference
 * is the whole point.
 *
 * Only in a shared checkout: with a worktree each, nothing is being changed
 * under anybody, and what two branches do to one file is a merge — which was
 * said when the plan was checked, and is not a reason to hold a start.
 */
export function collidesNow(item: Queued, seen: Reality): Collision | null {
  if (seen.workspace !== 'checkout') return null
  // Work that said nothing about what it would change cannot be checked
  // against the tree, and holding everything that said nothing would stop the
  // queue rather than guard it.
  if (item.start.touches.length === 0) return null
  const others = seen.working.filter((task) => task !== item.task)
  if (others.length === 0) return null
  // What it waits on is what it builds on: those changes are the reason it is
  // starting at all.
  const waits = new Set(item.start.after.map((dep) => dep.task))
  const shares = (theirs: readonly string[]) =>
    item.start.touches.filter((path) => theirs.some((other) => sameOrInside(path, other)))
  const paths = new Set<string>()
  const by: string[] = []
  const said: string[] = []
  for (const one of seen.committed) {
    if (one.task === item.task || waits.has(one.task)) continue
    const shared = shares(one.paths)
    if (shared.length === 0) continue
    for (const path of shared) paths.add(path)
    by.push(one.task)
    said.push(
      `${one.task}, which is working, has already changed ${joined(shared)}, which this was planned to change`,
    )
  }
  // Nobody's name is on an uncommitted change — git does not say whose it is,
  // and Tade does not guess. What it says instead is true: the file is being
  // changed now, and these are the agents in the same checkout.
  const loose = shares(seen.dirty).filter((path) => !paths.has(path))
  if (loose.length > 0) {
    for (const path of loose) paths.add(path)
    said.push(
      `${joined(loose)}, which this was planned to change, ${loose.length === 1 ? 'is' : 'are'} changed and not committed, while ${joined(others)} ${others.length === 1 ? 'works' : 'work'} in the same checkout`,
    )
  }
  if (said.length === 0) return null
  return { paths: [...paths].sort(), by, because: said.join('; ') }
}

/** The last hold written about the tree and not answered since. */
function writtenCollision(
  task: string,
  events: readonly TadeEvent[],
  since: number,
): Collision | null {
  let found: Collision | null = null
  for (const event of events) {
    if (event.task !== task || event.seq <= since) continue
    if (event.type !== 'queue_held' || !Array.isArray(event.detail.changed)) continue
    found = {
      paths: event.detail.changed.map(String),
      by: Array.isArray(event.detail.by) ? event.detail.by.map(String) : [],
      because:
        typeof event.detail.because === 'string'
          ? event.detail.because
          : 'the code it was planned against has changed since',
    }
  }
  return found
}

/**
 * What to start now, in the order given: whatever is ready, as far as each
 * project has room. `room` is how many more agents a project may run; one it
 * does not name has no limit.
 *
 * Evidence reaches this the only way it may: through `queueStateOf`, which
 * holds work the tree has moved under. Held work is not ready, so it never
 * takes a slot from work behind it — and nothing the rule would not have
 * started can be started by anything anybody looked at.
 */
export function readyToStart(
  items: readonly Queued[],
  facts: QueueFacts,
  room: ReadonlyMap<string, number>,
): string[] {
  const left = new Map(room)
  const out: string[] = []
  for (const item of items) {
    if (queueStateOf(item, facts).kind !== 'ready') continue
    const free = left.get(item.project)
    if (free !== undefined) {
      if (free <= 0) continue
      left.set(item.project, free - 1)
    }
    out.push(item.task)
  }
  return out
}

/** What queued work will wait on after a change, or every reason it cannot. */
/**
 * One thing queued work waits on, as its task file keeps it: a task, why, and
 * whether it waits for the person to approve what that task produced as well.
 */
export interface Wait {
  task: string
  why: string
  approved?: boolean
}

export type WaitsCheck = { ok: true; after: Wait[] } | { ok: false; problems: string[] }

/**
 * A change to what existing queued work waits on, checked by the rules a plan
 * is checked by (`checkPlan`), and refused whole with every reason at once:
 * each task named is one Tade has, nothing waits on itself, and no queued work
 * ends up waiting on itself through others — which would leave all of it
 * waiting for ever. A bare name is read in the waiting task's own project, and
 * `project/name` names a task anywhere, as a plan's waits do. A wait for an
 * approval is refused on a task that produces no document, which nobody could
 * ever approve.
 */
export function checkWaits(req: {
  /** The queued task whose waits change, as its qualified id. */
  task: string
  /** What its task file says it waits on now. */
  current: readonly Wait[]
  /** What was asked for. */
  after: readonly Wait[]
  /** The list replaces what it waits on, rather than being added to it. */
  replace: boolean
  /** Every task Tade has, by qualified id. */
  tasks: ReadonlySet<string>
  /** What other queued work waits on; work that has started waits on nothing. */
  waits: (task: string) => readonly string[]
  /** Whether a task says it produces a document; unsaid, nothing is refused for it. */
  produces?: (task: string) => boolean
}): WaitsCheck {
  const problems: string[] = []
  const here = req.task.split('/')[0] ?? req.task
  const added: Wait[] = []
  for (const dep of req.after) {
    const said = dep.task.trim()
    const task = said.includes('/') ? said : `${here}/${said}`
    if (task === req.task) {
      problems.push(`${req.task} cannot wait on itself`)
    } else if (!req.tasks.has(task)) {
      problems.push(
        `${req.task} cannot wait on ${said || 'nothing'}, which is not a task Tade has: wait only on one tade_queue or tade_status lists`,
      )
    } else if (dep.approved && req.produces && !req.produces(task)) {
      problems.push(
        `${req.task} cannot wait for ${task}'s document to be approved: ${task} produces none, so wait for it to finish instead`,
      )
    } else if (!added.some((one) => one.task === task)) {
      added.push({ task, why: dep.why.trim(), ...(dep.approved ? { approved: true } : {}) })
    }
  }
  if (!req.replace && req.after.length === 0) {
    problems.push(`say what ${req.task} waits on, or replace its waits with none`)
  }
  if (problems.length > 0) return { ok: false, problems }
  const kept = req.replace
    ? []
    : req.current.filter((one) => !added.some((dep) => dep.task === one.task))
  const after = [...kept, ...added]
  // From each new wait, whether its own waits lead back here. Only what is
  // added can close a loop: what it already waited on was checked when it was
  // written, and taking a wait away never makes one.
  for (const dep of added) {
    const through = pathTo(dep.task, req.task, req.waits)
    if (!through) continue
    const middle = through.slice(1, -1)
    problems.push(
      `${req.task} cannot wait on ${dep.task}: ${dep.task} already waits on ${req.task}${
        middle.length > 0 ? ` through ${joined(middle)}` : ''
      }, so ${middle.length > 0 ? 'none of them' : 'neither'} could start`,
    )
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, after }
}

/**
 * What queued work waits on once a task it waited on is removed and hands its
 * own waits on (`remove` with `dependents: inherit`): the wait on the removed
 * task becomes the removed task's waits, in its place, so taking one task out
 * of the middle of a chain holds nothing after it.
 *
 * Not checked again the way a wait somebody writes is (`checkWaits`), because
 * it can neither close a loop nor make a start later: everything it now waits
 * on, it already waited on through the task removed. A wait on work that has
 * gone since is handed on as it was — the removed task was held on it, and
 * dropping it would start what nobody said could start.
 */
export function inheritWaits(req: {
  /** The queued task that waited on the removed one. */
  task: string
  /** What its task file says it waits on now. */
  current: readonly Wait[]
  removed: string
  /** What the removed task waited on. */
  waits: readonly Wait[]
}): Wait[] {
  // A wait it already has keeps its place and its own reason.
  const own = new Set(req.current.map((dep) => dep.task))
  const after: Wait[] = []
  for (const dep of req.current) {
    if (after.some((one) => one.task === dep.task)) continue
    if (dep.task !== req.removed) {
      after.push(dep)
      continue
    }
    const instead = `in place of ${req.removed}, which was removed`
    for (const its of req.waits) {
      if (its.task === req.task || its.task === req.removed || own.has(its.task)) continue
      if (after.some((one) => one.task === its.task)) continue
      // An approval the removed task waited for is one this waited for through it.
      const why = dep.why ? `${dep.why}; ${instead}` : instead
      after.push({ task: its.task, why, ...(its.approved ? { approved: true } : {}) })
    }
  }
  return after
}

/** The waits from one task to another, both ends included; null where there are none. */
function pathTo(
  from: string,
  to: string,
  waits: (task: string) => readonly string[],
): string[] | null {
  const came = new Map<string, string>([[from, '']])
  const queue = [from]
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (at === to) {
      const path = [at]
      for (let back = came.get(at); back; back = came.get(back)) path.unshift(back)
      return path
    }
    for (const next of waits(at)) {
      if (came.has(next)) continue
      came.set(next, at)
      queue.push(next)
    }
  }
  return null
}

/** What queued work in a worktree begins from, per task it waited on. */
export interface Upstream {
  workspace: 'checkout' | 'worktree'
  /** Its branch, or empty when it has none. */
  branch: string
  head: string | null
  done: DoneRule
}

/**
 * Where queued work in a worktree begins: on top of what it waited on, so it
 * has that work to build on — unless that finished by being merged, in which
 * case the base has it and the base is where to begin. With nothing to build
 * on it begins from the base as it is now, not as it was when it was planned.
 *
 * **Only ever inside one repository.** The upstream map is flat across every
 * project, because a wait is, so without `project` a task in `sentry-cli`
 * waiting on one in `sentry` was handed `sentry`'s branch name to start from —
 * which fails in the good case and in the bad one finds a ref of that name
 * that is somebody else's work entirely. A cross-repo wait is a wait on when,
 * not on what: the other repository's commits are not this one's to build on,
 * so this begins from its own base exactly as it would with no wait at all.
 *
 * **Work that says where it begins (`StartCondition.from`) begins there, and
 * nowhere else.** That is work made to change one branch — a review's — and
 * whatever it waits on decides only when: anything merged in under it would be
 * pushed to somebody's review along with the fix.
 */
export function startFrom(
  after: readonly { task: string }[],
  upstream: ReadonlyMap<string, Upstream>,
  baseRef: string | null,
  /** The project the work is starting in. Required: a silent default here is
   * a ref handed to the wrong repository, which is the failure this exists for. */
  project: string,
  /** Where it said it begins, in its own repository. */
  from?: string,
): string[] {
  if (from) return [from]
  const refs: string[] = []
  for (const dep of after) {
    if (!dep.task.startsWith(`${project}/`)) continue
    const found = upstream.get(dep.task)
    if (found?.workspace !== 'worktree' || found.done === 'merged') continue
    const ref = found.branch || found.head
    if (ref && !refs.includes(ref)) refs.push(ref)
  }
  return refs.length > 0 ? refs : baseRef ? [baseRef] : []
}

/** Whether two paths are the same, or one is a folder the other is in. */
export function sameOrInside(a: string, b: string): boolean {
  const clean = (path: string) => path.replace(/^\.\//, '').replace(/\/+$/, '')
  const x = clean(a)
  const y = clean(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/** `a`, `a and b`, `a, b and c`. */
export function joined(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/**
 * What queued work waits on the person for, as a clause after what it waits
 * on: ", once the person approves what plan produced". Nothing when nothing.
 */
export function approvalSays(approval: readonly string[] | undefined): string {
  if (!approval || approval.length === 0) return ''
  return `, once the person approves what ${joined(approval)} produced`
}

/** Where queued work stands, in a few words. */
export function describeQueueState(state: QueueState, clock: (at: number) => string): string {
  switch (state.kind) {
    case 'waiting':
      return `after ${joined(state.on)}${approvalSays(state.approval)}`
    case 'held':
      return `held: ${state.because}`
    case 'scheduled':
      return `at ${clock(state.at)}`
    case 'paused':
      if (state.parked) return 'parked'
      return state.all ? 'paused with the queue' : 'paused'
    case 'ready':
      return 'next'
  }
}
