import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type RemoteLink, readDelta, readKept, readSnapshot, writeKept } from '@tade/remotes-core'
import {
  applyDelta,
  COLLECTIONS,
  type CopyIn,
  deltaBetween,
  Pieces,
  ProjectionAnswerSchema,
  type ProjectionTold,
  piecesOf,
  type Snapshot,
  type WebProjectionTold,
} from '@tade/web'
import { machineFolder } from '@tade/workbench/inventory'
import { seenName } from './machines-seen.ts'

// Every machine's projection on every other machine of the person's, so the
// page a phone opens is a door that draws all of them (ONE-AWAY-VIEW step 2).
//
// **Two halves, because only one machine can dial.** The Mac follows ipax's
// stream, so it already holds ipax's projection (`@tade/remotes-core`'s
// `held.ts`); ipax can never call the Mac, so the Mac tells it its own over
// the link it holds (`ProjectionShared`, the sender, on the Mac's links'
// beat), and ipax keeps what it is told (`ProjectionsHeld`, the receiver, the
// heart's — so a `tade serve` with no window keeps them too).
//
// **The cursor is the away protocol's own `(epoch, rev)`**, the projector's
// on the machine that sends: another epoch is a whole projection, a change
// says what it was made from, and a receiver not at that revision answers
// `gap` and is sent it whole. Nothing reads `seq` or a byte offset.
//
// **A copy of what that machine said, never a second truth about it**: kept
// in memory, and on disk as `<home>/machines/<name>/projection.json` (`0600`,
// `kept.ts`, the file the Mac keeps of ipax in), written at most every thirty
// seconds, read back when the heart opens so a Mac shut overnight is drawn as
// of its last word rather than not at all, and always safe to delete. What is
// drawn of it is the page's (`copies.ts`), only on the person's own device.

/** How often the whole of one machine's copy is written down at most. */
export const KEEP_EVERY_MS = 30_000

/** How often this machine tells each machine it links to its projection, at most. */
export const TELL_EVERY_MS = 2_000

/** How long a machine whose Tade has no door for it, or refused what it was told, is left alone. */
const QUIET_MS = 60_000

/** The far side's door (`@tade/web`'s `projection-told.ts`). */
const DOOR = '/api/projection'

interface HeldCopy {
  projection: Snapshot
  /** When it was last told, in this machine's clock. */
  heardAt: number
  /** Whether it moved since it was last written down. */
  dirty: boolean
}

export interface ProjectionsHeldDeps {
  home: string
  now: () => number
  /** Something a person should know: a copy that could not be kept or read back. */
  say: (said: string) => void
  /** A machine's copy moved: what it is doing is drawn now, not at the next beat (`fleet-talk.ts`). */
  moved?: () => void
}

/**
 * What this machine is told of every machine that links here: the receiver.
 *
 * Keyed by the name its row has among the machines (`seenName` of the label
 * its device has now — renamed by `/api/seen`), so the page finds a copy
 * under the same name as the machine's state and since when.
 */
export class ProjectionsHeld {
  private readonly deps: ProjectionsHeldDeps
  private readonly held = new Map<string, HeldCopy>()
  private readonly pieces = new Pieces()
  private keptAt = 0
  private keeping = false
  /** What was said about a copy that could not be kept, by name: said once. */
  private readonly said = new Map<string, string>()

  constructor(deps: ProjectionsHeldDeps) {
    this.deps = deps
  }

  /** The route's half: the pieces, and what is done with each whole revision. */
  web(): { pieces: Pieces; take: WebProjectionTold } {
    return { pieces: this.pieces, take: async (told, _device, label) => this.take(told, label) }
  }

  /** One whole revision of what a machine said, taken or refused. */
  take(told: ProjectionTold, label: string): 'kept' | 'gap' | 'refused' {
    const name = seenName(label)
    if (told.kind === 'whole') {
      const read = readSnapshot(told.text)
      if (typeof read === 'string') return this.refused(name, read)
      this.keep(name, stamped(read, told.epoch, told.rev))
      return 'kept'
    }
    const was = this.held.get(name)
    if (was === undefined) return 'gap'
    const at = was.projection.fresh
    if (at.epoch !== told.epoch || at.rev !== told.from) return 'gap'
    const delta = readDelta(told.text)
    if (typeof delta === 'string') return this.refused(name, delta)
    // A change in another version of the protocol than the copy held is
    // answered as one nobody had: the sender tells it whole, which is always
    // correct. `applyDelta` throws for nothing else.
    if (delta.v !== was.projection.v) return 'gap'
    this.keep(name, stamped(applyDelta(was.projection, delta), told.epoch, told.rev))
    return 'kept'
  }

  /** Every copy held, for the page (`AwayDeps.copies`). */
  copies(): CopyIn[] {
    return [...this.held].map(([name, one]) => ({ name, projection: one.projection }))
  }

  /** When one machine's copy was last told, or null for one never told. */
  heardAt(name: string): number | null {
    return this.held.get(name)?.heardAt ?? null
  }

  /**
   * Read back what was kept, once, as the heart opens: every machine folder
   * here that holds a copy. One that cannot be read is said and not drawn.
   * Never throws.
   */
  async open(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(join(this.deps.home, 'machines'))
    } catch (err) {
      // No machine was ever kept here: nothing to read back. Anything else is said.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.say(`the copies of other machines kept here could not be read: ${messageOf(err)}`)
      }
      return
    }
    for (const folder of names) {
      try {
        const kept = await readKept(this.deps.home, folder)
        if (kept === null || this.held.has(folder)) continue
        this.held.set(folder, { projection: kept.projection, heardAt: kept.heardAt, dirty: false })
      } catch (err) {
        this.deps.say(err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** The beat: what moved is written down, at most every thirty seconds, one write at a time. */
  beat(): void {
    const now = this.deps.now()
    if (this.keeping || now - this.keptAt < KEEP_EVERY_MS) return
    const due = [...this.held].filter(([, one]) => one.dirty)
    if (due.length === 0) return
    this.keptAt = now
    this.keeping = true
    void this.write(due).finally(() => {
      this.keeping = false
    })
  }

  private async write(due: readonly [string, HeldCopy][]): Promise<void> {
    for (const [name, one] of due) {
      const folder = machineFolder(name)
      one.dirty = false
      if (folder === null) {
        // Drawn while it is heard, and said once: nothing of it outlives a restart here.
        const said = `${name} is drawn here but not kept: its name makes no folder in this home`
        if (this.said.get(name) !== said) this.deps.say(said)
        this.said.set(name, said)
        continue
      }
      try {
        await writeKept(this.deps.home, folder, {
          projection: one.projection,
          heardAt: one.heardAt,
          cursor: { epoch: one.projection.fresh.epoch, rev: one.projection.fresh.rev },
        })
        this.said.delete(name)
      } catch (err) {
        const said = `what ${name} last said could not be kept here: ${err instanceof Error ? err.message : String(err)}`
        if (this.said.get(name) !== said) this.deps.say(said)
        this.said.set(name, said)
      }
    }
  }

  private keep(name: string, projection: Snapshot): void {
    // What was read back from disk is held by its folder's name; once the
    // machine tells it again, it is held by the name its row has.
    const folder = machineFolder(name)
    if (folder !== null && folder !== name) this.held.delete(folder)
    this.held.set(name, { projection, heardAt: this.deps.now(), dirty: true })
    this.deps.moved?.()
  }

  private refused(name: string, read: string): 'refused' {
    const said = `${name} told this machine its projection and it could not be read: ${read}`
    if (this.said.get(name) !== said) this.deps.say(said)
    this.said.set(name, said)
    return 'refused'
  }
}

/**
 * Every copy the page is handed: what the machines this one links to hold of
 * each (live, over the link) and, for any other, what one that links here
 * told it. A name both have is the link's — the same machine, heard live.
 */
export function copiesJoined(told: readonly CopyIn[], linked: readonly CopyIn[]): CopyIn[] {
  const names = new Set(linked.map((one) => one.name))
  return [...linked, ...told.filter((one) => !names.has(one.name))]
}

/** A projection whose freshness says the cursor it was told at. */
function stamped(projection: Snapshot, epoch: string, rev: number): Snapshot {
  return { ...projection, fresh: { ...projection.fresh, epoch, rev } }
}

export interface ProjectionSharedDeps {
  /** This machine's own projection as an owner of it is sent, or null while it has none (the away view is off). */
  own: () => Snapshot | null
  now: () => number
  /** Something a person should know: a projection too large to tell. Said once. */
  say: (said: string) => void
}

/** Where one machine this one links to stands, as this one has told it. */
interface Told {
  /** What it was last told, which the next change is made against; null to tell it whole. */
  sent: Snapshot | null
  at: number
  busy: boolean
}

/**
 * This machine's projection, told every machine it links to: the sender.
 *
 * On the links' own beat, never awaited by a frame: at most every two
 * seconds per machine, one telling in flight to each, whole first and then
 * each change against what it was last told. A link that is down is told
 * nothing and told it whole once it is back; a `gap` is the same.
 */
export class ProjectionShared {
  private readonly deps: ProjectionSharedDeps
  private readonly told = new Map<string, Told>()
  /** What was last said of a telling that failed, per machine, so it is said once. */
  private readonly failed = new Map<string, string>()
  /** Whether a projection too big to send has been said, until a whole one fits again. */
  private tooLarge = false

  constructor(deps: ProjectionSharedDeps) {
    this.deps = deps
  }

  beat(
    names: readonly string[],
    reach: (name: string) => { link: RemoteLink; live: boolean } | null,
  ): void {
    const now = this.deps.now()
    for (const name of [...this.told.keys()]) if (!names.includes(name)) this.told.delete(name)
    let own: Snapshot | null | undefined
    for (const name of names) {
      const at = reach(name)
      const one = this.told.get(name) ?? { sent: null, at: 0, busy: false }
      this.told.set(name, one)
      if (at === null || !at.live) {
        one.sent = null
        continue
      }
      if (one.busy || now - one.at < TELL_EVERY_MS) continue
      own ??= this.deps.own()
      if (own === null) return
      const told = toldOf(one.sent, own)
      if (told === null) continue
      one.at = now
      one.busy = true
      void this.tell(name, at.link, one, own, told).finally(() => {
        one.busy = false
      })
    }
  }

  private async tell(
    name: string,
    link: RemoteLink,
    one: Told,
    own: Snapshot,
    told: ProjectionTold,
  ): Promise<void> {
    let pieces: ReturnType<typeof piecesOf>
    try {
      pieces = piecesOf(told)
    } catch (err) {
      // Too big to send: rebuilding and recutting several megabytes every two
      // seconds only to throw again is work for nothing, so it is tried again
      // once a minute, as a door that refused it is — and said once.
      if (!this.tooLarge) this.deps.say(`${messageOf(err)}; ${heaviestOf(own)}`)
      this.tooLarge = true
      one.at = this.deps.now() + QUIET_MS - TELL_EVERY_MS
      return
    }
    // A whole that cuts is a projection that fits again, so outgrowing the
    // limit a second time is said again. A change that cuts says nothing of
    // the whole: another machine may still be owed one that does not fit.
    if (told.kind === 'whole') this.tooLarge = false
    try {
      for (const piece of pieces) {
        const answer = await link.request(name, DOOR, piece)
        const read = ProjectionAnswerSchema.safeParse(answer.body)
        const kept = answer.status === 200 && read.success ? read.data.kept : null
        if (kept === 'piece') continue
        if (kept === 'kept') break
        // A gap, or anything but an answer: told it whole next time. A Tade
        // there with no such door, or one that could not read what it was
        // told, is not told again every two seconds but once a minute.
        one.sent = null
        if (answer.status === 404 || kept === 'refused') {
          one.at = this.deps.now() + QUIET_MS - TELL_EVERY_MS
        }
        return
      }
      one.sent = own
      this.failed.delete(name)
    } catch (err) {
      // A link that went down: told it whole once it is back, and said once
      // until a telling gets through, so a link that is down is not a line
      // every two seconds.
      one.sent = null
      const said = `this machine could not tell ${name} what it is doing: ${messageOf(err)}`
      if (this.failed.get(name) !== said) this.deps.say(said)
      this.failed.set(name, said)
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Which of a projection's collections it is that is too big to send, so the
 * line says where to look rather than only how much: the three heaviest, by
 * bytes and rows — counts and the collections' own names, never a word
 * anybody wrote.
 */
export function heaviestOf(own: Snapshot): string {
  const heaviest = COLLECTIONS.map((collection) => {
    const rows = own[collection] as readonly unknown[]
    return { collection, rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)) }
  })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((one) => `${one.collection} ${Math.ceil(one.bytes / 1024)} KB in ${one.rows} rows`)
  return `the heaviest of it: ${heaviest.join(', ')}`
}

/**
 * What to tell a machine: its first projection whole, a change against what
 * it was last told, or nothing where nothing moved.
 */
export function toldOf(sent: Snapshot | null, own: Snapshot): ProjectionTold | null {
  if (sent === null || sent.fresh.epoch !== own.fresh.epoch || own.fresh.rev < sent.fresh.rev) {
    // Only stringified where it is told whole: a change never pays for the whole text.
    return { kind: 'whole', epoch: own.fresh.epoch, rev: own.fresh.rev, text: JSON.stringify(own) }
  }
  if (own.fresh.rev === sent.fresh.rev) return null
  const delta = deltaBetween(sent, own)
  if (delta === null) return null
  return {
    kind: 'change',
    epoch: own.fresh.epoch,
    rev: own.fresh.rev,
    from: sent.fresh.rev,
    text: JSON.stringify(delta),
  }
}
