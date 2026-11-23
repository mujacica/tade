import type { EventType, TadeEvent } from './events.ts'
import { DOCUMENT_EVENTS } from './produces.ts'

// Queued work waiting on work on another of the person's machines: the rules,
// pure. What they read is the copy of each other machine's journal kept here
// (`feeds.ts`), folded by the window into a `Fleet` (`@tade/workbench`'s
// `fleet-waits.ts`).
//
// **Evidence may only ever hold**, unchanged. A wait on `vps:api/migrate` is
// released by one thing: that task's `task_done` in vps's own journal, as the
// copy here holds it. Not there, the copy behind, the link down, the machine
// never heard of: the wait holds, and says why ("vps last heard 14:02"). A
// machine silent for days is said on the card with the wait offered to be
// dropped — as a person's act (`queue-drop`), never by itself, because a
// machine that is only switched off would come back to find its work started
// on without it.
//
// **A move is a forwarding pointer.** `task_moved {to, as}` in the journal of
// the machine a task left and `task_taken {from, was}` in the journal of the
// one that took it say together where it went, so a wait follows it — across
// any number of moves, and back here — by folding both journals. Until both
// lines are seen it holds. That is what lets work that is waited on move at all.
//
// **A machine is named by either of its names**: what this machine calls it
// (`remotes.<name>`, which is what a person types) or what it calls itself
// (the label its journal is kept under, which is what crosses to a third
// machine). A wait written on a machine that links here may name this one by
// that machine's own `remotes.<name>`, which it says as it dials
// (`FeedsAsk.calls`) and is kept beside its copy. Pure: facts in, answers
// out, no clock.

/** The kinds of line out of other machines' journals a wait is settled by. */
export const FLEET_WAIT_READS = [
  'task_created',
  'task_done',
  'task_moved',
  'task_taken',
  'task_removed',
  // What its queued work waits on in turn, for the loop check (`waitsThere`).
  'queue_changed',
  'queue_started',
  // Whether the person approved a document a wait is for (`approvedFrom`).
  ...DOCUMENT_EVENTS,
] as const satisfies readonly EventType[]

/** One other machine, as the copy of its journal kept here says it. */
export interface FleetMachine {
  /** What it calls itself: the label its journal is kept under here. */
  name: string
  /** What this machine calls it, where this machine links to it (`remotes.<name>`). */
  called?: string
  /** What it calls this machine, where it links to this one (its `remotes.<name>`): how its waits name this one. */
  calls?: string
  /** When anything of it was last heard here, by this machine's clock; null for never. */
  heardAt: number | null
  /** The lines of its journal a wait is settled by (`FLEET_WAIT_READS`), oldest first. */
  lines: readonly TadeEvent[]
}

/** Every other machine whose journal is kept here, and what this one calls itself there. */
export interface Fleet {
  /** This machine's own label, as the others' journals name it (`machineLabel`). */
  self: string
  machines: readonly FleetMachine[]
}

/** How long a machine may go unheard before its card says so and offers to drop the wait. */
export const SILENT_DAYS = 2

const DAY_MS = 86_400_000

/** A wait as written: on which machine (null for this one), and the task there. */
export interface WaitParsed {
  machine: string | null
  task: string
}

/** `vps:api/migrate` → vps, api/migrate; `api/migrate` → this machine. */
export function parseWait(id: string): WaitParsed {
  const colon = id.indexOf(':')
  const slash = id.indexOf('/')
  if (colon > 0 && (slash < 0 || colon < slash)) {
    return { machine: id.slice(0, colon), task: id.slice(colon + 1) }
  }
  return { machine: null, task: id }
}

/** Whether a wait names another machine. */
export function waitsElsewhere(id: string): boolean {
  return parseWait(id).machine !== null
}

/** A wait on a task of another machine, as it is written: `vps:api/migrate`. */
export function waitOn(machine: string, task: string): string {
  return `${machine}:${task}`
}

/** Whether a name is this machine's own. */
export function isSelf(fleet: Fleet | undefined, name: string): boolean {
  return fleet !== undefined && name.toLowerCase() === fleet.self.toLowerCase()
}

/** The machine a name means, by either of its names; null where none here is called it. */
export function machineNamed(fleet: Fleet | undefined, name: string): FleetMachine | null {
  if (fleet === undefined) return null
  const exact = fleet.machines.find((one) => one.called === name || one.name === name)
  if (exact) return exact
  const lower = name.toLowerCase()
  return (
    fleet.machines.find(
      (one) => one.called?.toLowerCase() === lower || one.name.toLowerCase() === lower,
    ) ?? null
  )
}

/** What a machine is called in a sentence here: this machine's name for it, or its own. */
export function calledHere(machine: FleetMachine): string {
  return machine.called ?? machine.name
}

/** Where a wait stands once every move it made has been followed. */
export type Followed =
  /** A task of this machine's — never moved, or come back — read from its own lines. */
  | { kind: 'here'; task: string }
  /** A task of that machine's, as the copy of its journal kept here says. */
  | {
      kind: 'there'
      machine: FleetMachine
      task: string
      finished: boolean
      /** Removed there without finishing, and not moved on. */
      removed: boolean
      /** Its journal says it was ever made there. */
      known: boolean
    }
  /** Somewhere this machine cannot see yet, and why. */
  | { kind: 'unseen'; machine: string; task: string; why: string; heardAt: number | null }

interface Moved {
  to: string
  as: string
}

/** The last move of a task in one journal, where it says what it went as. */
function movedIn(lines: readonly TadeEvent[], task: string): Moved | null {
  let moved: Moved | null = null
  for (const line of lines) {
    if (line.type !== 'task_moved' || line.task !== task) continue
    const as = line.detail.as
    const to = line.detail.to
    if (typeof as === 'string' && typeof to === 'string') moved = { to, as }
  }
  return moved
}

/** Whether a line is the take of a task that moved: made as `as`, from `was`. */
function takes(line: TadeEvent, as: string, was: string): boolean {
  return line.type === 'task_taken' && line.task === as && line.detail.was === was
}

/**
 * Where a task that moved was taken: this machine (`machine: null`), another,
 * or null where no journal here shows it yet. The machine it came from is
 * named on the take (`task_taken.from`) and is preferred; one take of that
 * name and origin anywhere is enough where a machine was renamed since.
 */
function takenWhere(
  fleet: Fleet | undefined,
  own: readonly TadeEvent[],
  as: string,
  was: string,
  from: string,
): WaitParsed | null {
  const found: { at: WaitParsed; from: unknown }[] = []
  for (const line of own) {
    if (takes(line, as, was))
      found.push({ at: { machine: null, task: as }, from: line.detail.from })
  }
  for (const machine of fleet?.machines ?? []) {
    for (const line of machine.lines) {
      if (takes(line, as, was))
        found.push({ at: { machine: machine.name, task: as }, from: line.detail.from })
    }
  }
  const named = found.find((one) => one.from === from)
  if (named) return named.at
  return found.length === 1 && found[0] ? found[0].at : null
}

/** How many moves a wait follows before it gives up: a chain longer than this is a loop. */
const HOPS_MOST = 16

/**
 * Where a wait stands: on this machine, on another as the copy of its journal
 * here says, or somewhere not seen yet. Every move is followed — `task_moved`
 * in the journal it left, `task_taken` in the one that took it — and a move
 * with only its first half seen holds where it is.
 */
export function followWait(
  id: string,
  fleet: Fleet | undefined,
  own: readonly TadeEvent[],
): Followed {
  let at = parseWait(id)
  if (at.machine !== null && isSelf(fleet, at.machine)) at = { machine: null, task: at.task }
  const seen = new Set<string>()
  for (;;) {
    const key = `${at.machine ?? ''}:${at.task}`
    if (seen.has(key) || seen.size >= HOPS_MOST) {
      return {
        kind: 'unseen',
        machine: at.machine ?? fleet?.self ?? 'here',
        task: at.task,
        why: `${id} moved round in a circle, so where it is cannot be told`,
        heardAt: null,
      }
    }
    seen.add(key)
    if (at.machine === null) {
      const moved = movedIn(own, at.task)
      if (moved === null) return { kind: 'here', task: at.task }
      const next = takenWhere(fleet, own, moved.as, at.task, fleet?.self ?? '')
      if (next === null) {
        const there = machineNamed(fleet, moved.to)
        return {
          kind: 'unseen',
          machine: moved.to,
          task: moved.as,
          why: `${at.task} moved to ${moved.to} as ${moved.as}, and ${moved.to}'s journal here does not show it taken yet`,
          heardAt: there?.heardAt ?? null,
        }
      }
      at = next
      continue
    }
    const machine = machineNamed(fleet, at.machine)
    if (machine === null) {
      return {
        kind: 'unseen',
        machine: at.machine,
        task: at.task,
        why:
          fleet === undefined || fleet.machines.length === 0
            ? `no other machine's journal is kept here`
            : `nothing of ${at.machine}'s journal is kept here`,
        heardAt: null,
      }
    }
    let finished = false
    let removed = false
    let known = false
    for (const line of machine.lines) {
      if (line.task !== at.task) continue
      if (line.type === 'task_created' || line.type === 'task_taken') known = true
      else if (line.type === 'task_done') finished = true
      else if (line.type === 'task_removed') removed = true
    }
    if (finished) {
      return { kind: 'there', machine, task: at.task, finished, removed: false, known: true }
    }
    const moved = movedIn(machine.lines, at.task)
    if (moved !== null) {
      const next = takenWhere(fleet, own, moved.as, at.task, machine.name)
      if (next === null) {
        const there = machineNamed(fleet, moved.to)
        return {
          kind: 'unseen',
          machine: there ? calledHere(there) : moved.to,
          task: moved.as,
          why: `${calledHere(machine)} moved it to ${moved.to} as ${moved.as}, and no journal here shows it taken yet`,
          heardAt: there?.heardAt ?? null,
        }
      }
      at = next
      continue
    }
    return { kind: 'there', machine, task: at.task, finished: false, removed, known }
  }
}

/** A wait on another machine that holds, as the card says it. */
export interface WaitThere {
  /** The wait as written: `vps:api/migrate`. */
  on: string
  /** The machine it waits on now, every move followed, as named here. */
  machine: string
  /** The task there it waits on now. */
  task: string
  /** When that machine was last heard here; null for never. */
  heardAt: number | null
  /** Whole days unheard, where that is `SILENT_DAYS` or more: the wait is offered to be dropped. */
  silentDays: number | null
  /** Why it cannot be followed further, where it cannot. */
  why?: string
}

/** A wait on another machine that holds, from where it was followed to. */
export function waitThere(
  on: string,
  followed: Exclude<Followed, { kind: 'here' }>,
  now: number,
): WaitThere {
  const machine = followed.kind === 'there' ? calledHere(followed.machine) : followed.machine
  const heardAt = followed.kind === 'there' ? followed.machine.heardAt : followed.heardAt
  const days = heardAt === null ? null : Math.floor((now - heardAt) / DAY_MS)
  const why =
    followed.kind === 'unseen'
      ? followed.why
      : followed.known
        ? undefined
        : `${machine}'s journal here has no task called ${followed.task} yet`
  return {
    on,
    machine,
    task: followed.task,
    heardAt,
    silentDays: days !== null && days >= SILENT_DAYS ? days : null,
    ...(why ? { why } : {}),
  }
}

/**
 * A wait on another machine, in the words its card and the orchestrator get:
 * where it stands and when that machine was last heard, or that it has been
 * silent for days and the wait may be dropped — by a person.
 */
export function thereSays(one: WaitThere, clock: (at: number) => string): string {
  const where =
    one.on === waitOn(one.machine, one.task) ? '' : `, now ${waitOn(one.machine, one.task)}`
  const why = one.why ? `${one.why}; ` : ''
  if (one.silentDays !== null) {
    return `${one.on}${where}: ${why}${one.machine} not heard from in ${one.silentDays} days — the wait can be dropped, by you`
  }
  const heard =
    one.heardAt === null
      ? `${one.machine} not heard from here yet`
      : `${one.machine} last heard ${clock(one.heardAt)}`
  return `${one.on}${where}: ${why}${heard}`
}

/**
 * Why a wait on another machine cannot be written, or null where it can: the
 * machine is one whose journal is kept here, the task is one that journal
 * made or took, and it is not a wait for a document's approval — which is
 * that machine's person's to give, at that machine.
 */
export function waitThereProblem(
  waiting: string,
  id: string,
  fleet: Fleet | undefined,
  approved: boolean,
): string | null {
  const { machine, task } = parseWait(id)
  if (machine === null) return null
  if (!task.includes('/')) {
    return `${waiting} cannot wait on ${id}: say which project on ${machine}, as ${machine}:<project>/${task}`
  }
  if (isSelf(fleet, machine)) return null
  const there = machineNamed(fleet, machine)
  if (there === null) {
    const kept = (fleet?.machines ?? []).map(calledHere)
    return `${waiting} cannot wait on ${id}: no machine called ${machine} has its journal kept here${
      kept.length > 0 ? ` (the ones kept are ${kept.join(', ')})` : ''
    }`
  }
  const followed = followWait(id, fleet, [])
  if (followed.kind === 'there' && !followed.known) {
    return `${waiting} cannot wait on ${id}: ${calledHere(there)}'s journal here has no task called ${task}`
  }
  if (approved) {
    return `${waiting} cannot wait for ${id}'s document to be approved: a document is approved on the machine that holds it, so wait for ${id} to finish instead`
  }
  return null
}

/** The tasks a line of another machine's journal says its task waits on: a list of ids, or of waits. */
function waitedOn(after: unknown): string[] {
  if (!Array.isArray(after)) return []
  const ids: string[] = []
  for (const one of after) {
    const id = typeof one === 'string' ? one : (one as { task?: unknown } | null)?.task
    if (typeof id === 'string' && id.trim() !== '') ids.push(id.trim())
  }
  return ids
}

/**
 * What a task of another machine waits on, as the copy of its journal kept
 * here says: what it was made or taken with (`task_created`, `task_taken`),
 * then every `queue_changed` that rewrote it — and nothing once it started
 * (`queue_started`), finished, was removed or moved away, as at home. Each id
 * as that machine wrote it.
 */
export function waitsThere(machine: FleetMachine, task: string): string[] {
  let waits: string[] = []
  for (const line of machine.lines) {
    if (line.task !== task) continue
    if (line.type === 'task_created' || line.type === 'task_taken') {
      waits = waitedOn(line.detail.after)
    } else if (line.type === 'queue_changed' && line.detail.change === 'after') {
      waits = waitedOn(line.detail.after)
    } else if (
      line.type === 'queue_started' ||
      line.type === 'task_done' ||
      line.type === 'task_removed' ||
      line.type === 'task_moved'
    ) {
      waits = []
    }
  }
  return waits
}

/** Whether a machine names this one by a name of its own: what it calls this one where it links here. */
function callsSelf(writer: FleetMachine | null, name: string): boolean {
  return writer?.calls !== undefined && writer.calls.toLowerCase() === name.toLowerCase()
}

/**
 * An id as written on one machine (null for this one), as this machine names
 * it: a task of its own bare — by its label, or by the name the writer calls
 * it — any other `<its own name>:<task>`. A machine nothing here is called is
 * left as written, which nothing waits from.
 */
function spelledHere(fleet: Fleet | undefined, writer: FleetMachine | null, id: string): string {
  const { machine, task } = parseWait(id)
  if (machine === null) return writer === null ? task : waitOn(writer.name, task)
  if (isSelf(fleet, machine) || callsSelf(writer, machine)) return task
  const there = machineNamed(fleet, machine)
  return there === null ? id : waitOn(there.name, task)
}

/**
 * What queued work waits on across every machine whose journal is kept here,
 * for the loop check (`checkWaits`): this machine's own as `here` answers,
 * another's as the copy of its journal says (`waitsThere`), every move
 * followed. A wait is written on one machine at a time, so a loop closed on
 * two at once, before either heard the other, is not seen — and a machine
 * that names this one by a name of its own that has not crossed here yet (it
 * has not dialled since) ends the walk where it does, which can only miss a
 * loop, never refuse a wait.
 */
export function waitsAcross(
  fleet: Fleet | undefined,
  own: readonly TadeEvent[],
  here: (task: string) => readonly string[],
): (task: string) => readonly string[] {
  return (id) => {
    const followed = waitsElsewhere(id) ? followWait(id, fleet, own) : null
    if (followed === null || followed.kind === 'here') {
      return here(followed?.task ?? id).map((dep) => spelledHere(fleet, null, dep))
    }
    if (followed.kind === 'unseen' || followed.finished || followed.removed) return []
    const { machine } = followed
    return waitsThere(machine, followed.task).map((dep) => spelledHere(fleet, machine, dep))
  }
}

/**
 * A piece of another machine's queued work, as the copy of its journal kept
 * here says it: work only that machine starts, because a queue is started by
 * the window of the machine whose home holds its task file — tied to a laptop,
 * it waits for that laptop to be opened again, and a phone reading the hub
 * while the lid is shut is the one place that can say so.
 */
export interface QueuedThere {
  /** The machine it waits for, as named here. */
  machine: string
  /** The task there. */
  task: string
  /** Its project there: the first part of its id. */
  project: string
  /** When that machine was last heard here; null for never. */
  heardAt: number | null
  /** Whole days unheard, where that is `SILENT_DAYS` or more. */
  silentDays: number | null
}

/**
 * Every other machine's queued work: made with a `start` (`task_created`
 * carries its `after`, empty or not, only then — a take writes one too), and
 * not yet started, finished, removed or moved away. Work moved here from there
 * is this machine's own queue, and work moved on to a third machine is that
 * one's. Oldest first, machine by machine.
 */
export function queuedThere(fleet: Fleet | undefined, now: number): QueuedThere[] {
  const out: QueuedThere[] = []
  for (const machine of fleet?.machines ?? []) {
    const queued = new Set<string>()
    for (const line of machine.lines) {
      const task = line.task
      if (typeof task !== 'string') continue
      if (line.type === 'task_created' && Array.isArray(line.detail.after)) queued.add(task)
      else if (
        line.type === 'queue_started' ||
        line.type === 'task_done' ||
        line.type === 'task_removed' ||
        line.type === 'task_moved'
      ) {
        queued.delete(task)
      }
    }
    const days = machine.heardAt === null ? null : Math.floor((now - machine.heardAt) / DAY_MS)
    for (const task of queued) {
      out.push({
        machine: calledHere(machine),
        task,
        project: task.split('/')[0] ?? task,
        heardAt: machine.heardAt,
        silentDays: days !== null && days >= SILENT_DAYS ? days : null,
      })
    }
  }
  return out
}

/** Another machine's queued work, in the words its card gets: `waits for mac (mac last heard 14:02)`. */
export function queuedThereSays(
  one: Pick<QueuedThere, 'machine' | 'heardAt' | 'silentDays'>,
  clock: (at: number) => string,
): string {
  const heard =
    one.silentDays !== null
      ? `${one.machine} not heard from in ${one.silentDays} days`
      : one.heardAt === null
        ? `${one.machine} not heard from here yet`
        : `${one.machine} last heard ${clock(one.heardAt)}`
  return `waits for ${one.machine} (${heard})`
}
