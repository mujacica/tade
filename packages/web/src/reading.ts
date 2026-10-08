import { revise, tick } from './delta.ts'
import type { SnapshotInput } from './input.ts'
import { BUDGET, type Budget, type Page, pageOf, withheld } from './page.ts'
import type { Delta, NoteRow, Snapshot } from './protocol.ts'
import { has } from './reach.ts'
import { type Cursors, noteRows, noteSeen } from './snapshot.ts'

// The whole of what the away view may read, declared in one place.
//
// **It is not a port, and that is deliberate.** R1 says a port is an interface
// plus a registry beside a conformance suite, and the reason is that a port has
// implementations somebody chooses between — a driver, a harness, a forge. This
// has exactly one implementation for ever: the window, which is the only
// process that holds `tade.lock`, the pending approvals, the lane liveness and
// `Live`'s held state. A registry would offer a choice nobody has, and a
// conformance suite would describe one implementation to itself. What this is,
// is dependency inversion: `@tade/web` imports neither `@tade/app` nor
// `@tade/workbench` (held by `test/modularity.test.ts`), so it declares what it
// needs and the window implements it.
//
// It is written in this package's own vocabulary and not the workbench's (R2):
// `snapshot()` and `notes()`, never `collectStatus` or `recall`.
//
// This is the one file in the package that is not among `test/modularity.test.ts`'s
// pure ones: `projector` holds the last projection and the revision, which is
// state, and the pure half of what it does is `revise` in `delta.ts`.
//
// **Phase 1 ships only the reading half, and there is no mutation method to
// call.** That is a stronger guarantee than a flag that disables one: a
// `WebActing` that does not exist cannot be reached by a bug, a stolen session
// or a route somebody added in a hurry. Whoever adds one adds a type, and that
// is the conversation.

export interface WebReading {
  /**
   * The projection as of the last beat. The revision it is, is on its own
   * freshness (`fresh.rev`), so a snapshot and a delta say it the same way.
   *
   * Never throws: a projection is the one thing the page needs to draw
   * anything at all, and an away view that answers an exception has nothing to
   * say about why.
   */
  snapshot(): Snapshot
  /**
   * The revision the held projection is, **without building one**.
   *
   * Its own accessor because the stream needs it before it knows whether a
   * snapshot is what it is going to send: a reconnection that the delta ring
   * can answer costs no projection at all, and reading the revision off
   * `snapshot().fresh.rev` would build one every time to find that out.
   */
  readonly rev: number
  /**
   * The notes in one scope, newest first.
   *
   * Its own call rather than a field on the snapshot, because notes are the
   * one collection whose whole value is the text: a budget that cut them to a
   * count on the snapshot would be answering a different question from the one
   * somebody opening the notes page is asking.
   */
  notes(scope: string | null): Page<NoteRow>
}

/**
 * The reading, plus the beat that moves it on.
 *
 * The window calls `beat` on its existing 2-second refresh and sends whatever
 * comes back. Nothing here keeps a timer: a projection nobody is looking at is
 * not built, and the beat belongs to the window because the window is what
 * already has a beat.
 */
export interface Projector extends WebReading {
  /**
   * One beat. Returns what to send, or `null` on a beat where nothing about
   * the projection changed — which is most of them.
   */
  beat(input: SnapshotInput, now: number): Delta | null
  /**
   * The server's own clock moved on and the projection did not.
   *
   * Not a revision: it leaves `rev` where it was and carries the freshness
   * alone. A client that misses one has an older `at` and a correct tree.
   */
  tick(now: number): Delta
}

export interface ProjectorOptions {
  budget?: Budget
  /** Where each collection carries on from, for a client paging one. */
  cursors?: Cursors
}

/**
 * A projector over an input somebody else gathers.
 *
 * The input arrives on every beat rather than being asked for, so this holds
 * no reference to the window and cannot reach back into it — which is the
 * whole of why the projection is testable without a window.
 */
export function projector(
  first: SnapshotInput,
  now: number,
  opts: ProjectorOptions = {},
): Projector {
  const budget = opts.budget ?? BUDGET
  const cursors = opts.cursors ?? {}
  const made = revise(null, first, now, cursors, budget)
  let held = made.snapshot
  let rev = made.rev
  let input = first

  return {
    get rev() {
      return rev
    },
    snapshot(): Snapshot {
      return held
    },
    notes(scope: string | null): Page<NoteRow> {
      return notesOf(input, scope, budget)
    },
    beat(next: SnapshotInput, at: number): Delta | null {
      input = next
      const been = revise(
        held,
        { ...next, lifetime: { ...next.lifetime, rev } },
        at,
        cursors,
        budget,
      )
      if (been.kind === 'unchanged') return null
      held = been.snapshot
      rev = been.rev
      return been.kind === 'changed' ? been.delta : null
    },
    tick(at: number): Delta {
      return tick(held, at)
    },
  }
}

/**
 * `appliesTo`'s rule, over a projected row.
 *
 * Written out rather than called, because `appliesTo` takes a whole `Note` and
 * a row is not one. `test/reading.test.ts` asserts the two agree over a table,
 * so the copy cannot drift: a note about a project applies to every task in
 * it, a note about everything always applies, and a note about one task never
 * leaks to its siblings.
 */
export function inScope(note: string | null, scope: string | null): boolean {
  if (note === null) return true
  if (scope === null) return false
  if (note === scope) return true
  return scope.startsWith(`${note}/`)
}

/**
 * The notes in one scope, newest first, inside this device's reach.
 *
 * A scope is a task id, a project name, or null for everything. Asking for one
 * in a project this device may not read answers the empty page with its real
 * count, exactly as a withheld collection does — being told *there are notes
 * here you may not read* is the answer, and nought would be a lie.
 *
 * Ids are made over the **whole** input and then filtered, never over the
 * filtered set: an ordinal computed after a filter would give one note two
 * different ids on two different routes, and a delta keyed by it would merge
 * one note's words into another's row.
 */
export function notesOf(
  input: SnapshotInput,
  scope: string | null,
  budget: Budget = BUDGET,
  after: string | null = null,
): Page<NoteRow> {
  const rows = noteRows(input.notes, input.reach, budget).filter((row) => inScope(row.scope, scope))
  if (!has(input.reach, 'notes')) return withheld<NoteRow>(rows.length)
  const newest = [...rows].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  return pageOf(newest, budget.notes, (row) => row.id, after)
}
