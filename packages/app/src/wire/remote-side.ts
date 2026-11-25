import { printable } from '@tade/core'
import type { RemoteLink } from '@tade/remotes-core'
import { SideAnswerSchema, type SideAsk } from '@tade/web'
import type { Frame } from '../frame.ts'
import { elsewhereOf, type Place } from '../machines.ts'
import { sectionOpen } from '../model.ts'
import { type SideShown, type SideThere, sideThere } from '../side.ts'
import { notify, type Wiring, why } from './context.ts'

// The project on another machine you are standing in, as that machine's own
// window would draw it (`/api/side`, `side.ts`): asked over the link already
// up every `SIDE_MS` while you stand there and never otherwise, one ask at a
// time, so what is drawn keeps in step with what changes there — an agent
// starting, a file changed, a note told, a schedule run.
//
// **What was last answered stays while the next is asked**, so nothing blinks,
// and while the link is down: the side is drawn from it as of when it was
// read, as everything else of that machine's is. A machine whose Tade is too
// old to answer is said once, as text, and the side is drawn from nothing it
// did not say — every section there, each `…` or empty, never a layout of its
// own.

/** How often the project there you stand in is asked for again. */
export const SIDE_MS = 1_000

export interface RemoteSideDeps {
  /** The link holding a machine, or null where none does. */
  reach(machine: string): { link: RemoteLink; live: boolean } | null
  /** Whether the agent in front's ACTIONS tab is shown, so that machine is asked for it. */
  actions?(): boolean
}

export class RemoteSide {
  private readonly wire: Wiring
  private readonly deps: RemoteSideDeps
  /** The last answer, and which machine and project it is of. */
  private shown: SideShown | null = null
  /** The ask on its way, by machine and project, so a late answer about another is dropped. */
  private asking: string | null = null
  private askedAt = 0
  /** The last reason for no answer that was said, so it is said once. */
  private toldSaid: string | null = null

  constructor(wire: Wiring, deps: RemoteSideDeps) {
    this.wire = wire
    this.deps = deps
  }

  facts(): Partial<Frame> {
    const place = elsewhereOf(this.wire.state)
    if (place === null || this.shown === null) return {}
    if (this.shown.machine !== place.machine || this.shown.project !== place.project) return {}
    return { side: this.shown }
  }

  /** The window's beat: the project asked for again, while somebody stands in one. */
  beat(): void {
    const place = elsewhereOf(this.wire.state)
    if (place === null || this.asking !== null) return
    const key = keyOf(place)
    const same = this.shown !== null && keyOf(this.shown) === key
    if (same && this.wire.now() - this.askedAt < SIDE_MS) return
    void this.read(place)
  }

  /** What was last answered about a place, or null where nothing about it was. */
  shownFor(place: { machine: string; project: string }): SideThere | null {
    if (this.shown === null || keyOf(this.shown) !== keyOf(place)) return null
    return this.shown.there
  }

  /** Where the agent in front of you there works, as that machine said: its worktree or its checkout. */
  worktreeFor(place: Place | null): string | null {
    if (place === null) return null
    return this.shownFor(place)?.where?.path ?? null
  }

  /** Asked now rather than on the next beat: something pressed there moved it. */
  soon(): void {
    this.askedAt = 0
  }

  private async read(place: Place): Promise<void> {
    const key = keyOf(place)
    const reach = this.deps.reach(place.machine)
    if (reach === null || !reach.live) return
    const state = this.wire.state
    const ask: SideAsk = {
      project: place.project,
      agent: place.agent ?? null,
      expanded: state.expanded.slice(0, 256),
      files: sectionOpen(state, 'files', false),
      // Asked for only while shown, and said only then: a Tade there from
      // before ACTIONS was drawn for another screen refuses a field it does not know.
      ...(this.deps.actions?.() === true ? { actions: true } : {}),
    }
    this.asking = key
    this.askedAt = this.wire.now()
    const was = this.shown !== null && keyOf(this.shown) === key ? this.shown.there : null
    try {
      const answer = await reach.link.request(place.machine, '/api/side', ask)
      const now = elsewhereOf(this.wire.state)
      if (now === null || keyOf(now) !== key) return
      if (answer.status !== 200) {
        this.shown = { ...placeOf(place), there: was, said: saidOf(answer.status, place.machine) }
        return
      }
      const read = SideAnswerSchema.safeParse(answer.body)
      this.shown = read.success
        ? { ...placeOf(place), there: sideThere(read.data), said: null }
        : {
            ...placeOf(place),
            there: was,
            said: `${place.machine} answered with a side this Tade cannot read`,
          }
    } catch (err) {
      this.shown = { ...placeOf(place), there: was, said: printable(why(err)) }
    } finally {
      if (this.asking === key) this.asking = null
      // Why there is no answer is said once, where somebody reads it, and
      // again only when it changes: a side drawn from less than that machine
      // knows is never drawn as though it were all of it.
      const said = this.shown?.said ?? null
      if (said !== null && said !== this.toldSaid) notify(this.wire, said)
      this.toldSaid = said
      this.wire.draw()
    }
  }
}

function placeOf(place: Place): { machine: string; project: string } {
  return { machine: place.machine, project: place.project }
}

function keyOf(place: { machine: string; project: string }): string {
  return `${place.machine}\u001f${place.project}`
}

/** Why there is no answer, in this window's words. */
function saidOf(status: number, machine: string): string {
  if (status === 404)
    return `${machine} does not say how its window draws a project: update Tade there`
  if (status === 403) return `${machine} did not let this machine read the project`
  return `${machine} answered ${status}`
}
