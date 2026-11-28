import { stat } from 'node:fs/promises'
import { machineLabel, printable } from '@tade/core'
import { type Held, LinkError, type Remote, type RemoteLink } from '@tade/remotes-core'
import type { WebNotes } from '@tade/web'
import type { HeldChange, Memory, NoteChange } from '@tade/workbench/memory'
import {
  answerNotes,
  type Exchanged,
  LINE_MOST,
  NotesRefused,
  shareNotes,
} from '@tade/workbench/notes-shared'
import type { Wiring } from './context.ts'

// The person's notes, shared with every machine this window is linked to
// (`@tade/workbench`'s `notes-shared.ts` is the
// exchange): both halves of it from the window, because it is the window that
// holds the links and the window that answers another machine's.
//
// **When it shares, by itself**: when a link comes up; when this home's
// `memory.jsonl` moved — a note taken here, by voice, a tool or `tade
// remember` from a shell, or lines just taken from another machine, which is
// how a note taken on one remote reaches the next; when what a remote's
// projection says of its notes moved, which is how one taken there arrives
// here within a beat; and every ten minutes while a link is up, which picks up
// a word about a note that moves nothing a projection shows (`also`). An
// exchange where both sides already hold the same lines is one small request.
//
// **Nothing waits on it.** One exchange at a time per remote, started from
// the beat and never awaited by anything that draws. A remote that cannot be
// reached is its link's news; one that answered and would not share is said
// in the strip once for as long as it is the same trouble. Each exchange that
// moved anything is written down here as `notes_shared` — counts, never words.
//
// **A change another machine gave to a note taken here waits for a press**
// (`Memory.held`): kept here as the file last stood, looked at again only when
// it moved, so the Remotes page asks nothing of the disk four times a second;
// taken or left from there (`settle`).
//
// **And the other way, a change made here waits for a press there**: a
// machine sharing with this one names, opening each exchange, the changes it
// holds from here (`NotesAsk.held`), kept by `WaitingThere` for as long as
// this window is open — the asker says it again at its next exchange, which a
// press there brings within a beat — so this machine's own Machines page can
// say a note it retired is still told to every agent on the machine it was
// taken on. **And the same from the side that asks**: a remote answers the
// opening with what it holds from here (`NotesAnswer.held`), which
// `SharedNotes` keeps per remote, resolved into this home's words as it comes
// so Settings › Remotes reads no file to draw it, and tells `WaitingThere`
// for this machine's own Machines page.

/** How long a linked remote goes before its notes are looked at again anyway. */
const AGAIN_MS = 10 * 60_000

/** The far side's door for it (`@tade/web`'s `shared-notes.ts`). */
const DOOR = '/api/notes/share'

export interface SharedNotesDeps {
  /** This home's notes: the workbench's own, so what is taken is what the window recalls. */
  memory: () => Memory
  /** The link that holds a remote and the remote as it was opened, or null for none held. */
  reach: (name: string) => { link: RemoteLink; remote: Remote; live: boolean } | null
  /** What this machine calls itself there. */
  from: () => string
  log: (line: { type: 'notes_shared'; detail: Record<string, string | number> }) => Promise<void>
  /** Said in the strip: an exchange that could not be made, once per trouble. */
  say: (said: string) => void
  now: () => number
  /** Told what each remote holds of this one's changes, for the away view's Machines page. */
  waiting?: WaitingThere
}

export class SharedNotes {
  private readonly deps: SharedNotesDeps
  /** When each remote's notes were last shared, or last could not be. */
  private readonly at = new Map<string, number>()
  private readonly busy = new Set<string>()
  private readonly owed = new Set<string>()
  /** What each remote's last exchange could not do, so it is said once and not every time. */
  private readonly troubled = new Map<string, string>()
  /** What each remote's projection last said of its notes, as their ids. */
  private readonly theirs = new Map<string, string>()
  /** This home's notes file as last looked at: its size and when it was written. */
  private file: string | null = null
  private looking = false
  /** What the last look at it could not do, so it is said once. */
  private unlooked: string | null = null
  /** The changes to notes taken here waiting for a press, as the file last stood. */
  private waiting: HeldChange[] = []
  /** Each remote's last word on this one's changes it holds for a press there, in this home's words. */
  private readonly there = new Map<string, NoteChange[]>()

  constructor(deps: SharedNotesDeps) {
    this.deps = deps
  }

  /** A link came up: share with it on the next beat. */
  up(name: string): void {
    this.owed.add(name)
  }

  /** What a remote holds moved: shared with on the next beat where what it says of its notes did. */
  moved(name: string, held: Held): void {
    const rows = held.projection?.notes
    if (rows === undefined) return
    const said = rows.map((row) => row.id).join(' ')
    const was = this.theirs.get(name)
    this.theirs.set(name, said)
    if (was !== undefined && was !== said) this.owed.add(name)
  }

  /** A remote is gone: what was held for it goes with it. */
  forget(name: string): void {
    this.at.delete(name)
    this.owed.delete(name)
    this.troubled.delete(name)
    this.theirs.delete(name)
    this.there.delete(name)
    this.deps.waiting?.heard(name, [], 'answered')
  }

  /**
   * The window's beat: what is owed, shared. Returns at once — the promise is
   * what it started, settled, which nothing that draws waits on.
   */
  beat(names: readonly string[]): Promise<void> {
    const started: Promise<unknown>[] = [this.look(names)]
    const now = this.deps.now()
    for (const name of names) {
      const held = this.deps.reach(name)
      if (held === null || !held.live || this.busy.has(name)) continue
      const last = this.at.get(name)
      if (!this.owed.has(name) && last !== undefined && now - last < AGAIN_MS) continue
      this.owed.delete(name)
      started.push(this.share(name))
    }
    return Promise.all(started).then(() => {})
  }

  /** One exchange with one remote: what came of it, or null where none could be made. Never throws. */
  async share(name: string): Promise<Exchanged | null> {
    const held = this.deps.reach(name)
    if (held === null || this.busy.has(name)) return null
    this.busy.add(name)
    try {
      const done = await shareNotes(
        this.deps.memory(),
        (body) => held.link.request(name, DOOR, body),
        { from: this.deps.from(), name, now: this.deps.now },
      )
      this.troubles(name, leftSays(name, done) ?? refusedSays(name, done))
      this.heardThere(name, done.held)
      if (done.took > 0 || done.gave > 0 || done.refused > 0) {
        const detail = { with: name, took: done.took, notes: done.notes, gave: done.gave }
        await this.deps
          .log({ type: 'notes_shared', detail: { ...detail, refused: done.refused } })
          .catch((err: unknown) => {
            // They are shared; only this machine's record of it is not.
            this.deps.say(`Notes were shared with ${name}, and not written down here: ${err}`)
          })
      }
      return done
    } catch (err) {
      // A link that went down is the link's news, said as it goes; anything
      // else — a remote that answered and would not, a request that failed
      // while the link stayed up, notes that would not be read here — is this
      // exchange's, and said.
      const down = err instanceof LinkError && !(err instanceof NotesRefused)
      if (!down || this.deps.reach(name)?.live === true) {
        const said = err instanceof Error ? err.message : String(err)
        this.troubles(name, `Notes are not shared with ${name}: ${said}`)
      }
      return null
    } finally {
      // Tried again when something moves, or on the next round of ten minutes.
      this.at.set(name, this.deps.now())
      this.busy.delete(name)
    }
  }

  /** The changes another machine gave to notes taken here, waiting for a press here. Never reads. */
  held(): readonly HeldChange[] {
    return this.waiting
  }

  /** This one's changes that a remote said, at its last exchange, it holds for a press there. Never reads. */
  waitingOn(name: string): readonly NoteChange[] {
    return this.there.get(name) ?? []
  }

  /** What a remote answered it holds from here: kept in this home's words, and told to the Machines page. */
  private heardThere(name: string, digests: readonly string[]): void {
    const changes = digests.length === 0 ? [] : this.deps.memory().changes(digests)
    if (changes.length === 0) this.there.delete(name)
    else this.there.set(name, changes)
    this.deps.waiting?.heard(name, digests, 'answered')
  }

  /** The person's press on one, here: what it was, in a sentence, or why it could not be. */
  settle(digest: string, answer: 'take' | 'leave', by: string): string {
    const memory = this.deps.memory()
    try {
      const done = memory.settle(digest, answer, by, this.deps.now())
      return answer === 'take' ? `Took it here: ${heldSaid(done)}` : `Left it: ${heldSaid(done)}`
    } finally {
      this.waiting = memory.held()
    }
  }

  /** This home's notes file, looked at: moved since the last look, every remote is owed a share. */
  private async look(names: readonly string[]): Promise<void> {
    if (this.looking) return
    this.looking = true
    try {
      const was = await stat(this.deps.memory().path).then(
        (one) => `${one.size}:${one.mtimeMs}`,
        (err: NodeJS.ErrnoException) => {
          // No file is no notes yet, which is a look like any other.
          if (err.code === 'ENOENT') return 'none'
          throw err
        },
      )
      if (this.file !== null && was !== this.file) for (const name of names) this.owed.add(name)
      if (was !== this.file) this.waiting = this.deps.memory().held()
      this.file = was
      this.unlooked = null
    } catch (err) {
      // A look that could not look is not a file that did not move: said, once,
      // and a note taken here goes at the next round of ten minutes instead.
      const said = `This machine's notes could not be looked at, so one taken here is shared at the next round instead: ${err instanceof Error ? err.message : String(err)}`
      if (said !== this.unlooked) this.deps.say(said)
      this.unlooked = said
    } finally {
      this.looking = false
    }
  }

  /** Said once for as long as it stays the same trouble, and forgotten once it has gone. */
  private troubles(name: string, said: string | null): void {
    if (said === null) this.troubled.delete(name)
    else if (this.troubled.get(name) !== said) {
      this.troubled.set(name, said)
      this.deps.say(said)
    }
  }
}

/**
 * What each machine that shares notes with this one last said it holds of
 * this one's changes, for the person's press there: only digests, kept only
 * while the window is open, each machine's list replaced whole by its next
 * word — an exchange it opened here (`asked`, `NotesAsk.held`) or one this
 * window opened there (`answered`, `NotesAnswer.held`), kept apart because the
 * two name this machine differently there.
 */
export class WaitingThere {
  private readonly told = new Map<string, { machine: string; digests: readonly string[] }>()

  /** A machine said what it holds from here now, in place of what it held. */
  heard(machine: string, digests: readonly string[], way: 'asked' | 'answered' = 'asked'): void {
    const key = `${way} ${machine}`
    if (digests.length === 0) this.told.delete(key)
    else this.told.set(key, { machine, digests: [...digests] })
  }

  /**
   * Each change waiting on another machine, in this home's own words, with the
   * machine it waits on. A change waits only where its note was taken, so one
   * named both ways is drawn once.
   */
  shown(memory: Memory): { machine: string; change: NoteChange }[] {
    const seen = new Set<string>()
    return [...this.told.values()].flatMap(({ machine, digests }) =>
      memory.changes(digests).flatMap((change) => {
        if (seen.has(change.digest)) return []
        seen.add(change.digest)
        return [{ machine, change }]
      }),
    )
  }
}

/**
 * A change made here that waits on `machine`, in words: `Retired here; mac
 * still tells it to every agent there until you take it there — device phone:
 * the freeze was lifted`. Made printable here, as `heldSaid` is.
 */
export function waitingSaid(machine: string, change: NoteChange): string {
  const there = printable(machine)
  const by = printable(change.by)
  const until = 'until you take it there'
  if (change.kind === 'retire') {
    return `Retired here; ${there} still tells it to every agent there ${until} — ${by}: ${printable(change.because ?? '')}`
  }
  if (change.kind === 'forget') {
    return `Taken back here; ${there} still tells it to every agent there ${until} — ${by}`
  }
  const more =
    change.scopes == null ? 'everything' : change.scopes.map((one) => printable(one)).join(', ')
  return `Told to ${more} here; ${there} tells it only where it did ${until} — ${by}`
}

/** What each kind of held change would do, as its label begins. */
export const HELD_DOES = { retire: 'Retired', forget: 'Taken back', also: 'Widened' } as const

/**
 * A held change in words, whose word it is first: `vps would retire “…” —
 * device phone: the freeze was lifted`. Another machine's text, so made
 * printable here.
 */
export function heldSaid(change: HeldChange): string {
  const note = `“${printable(change.note.text)}”`
  const from = printable(change.from)
  const by = printable(change.by)
  if (change.kind === 'retire') {
    return `${from} would retire ${note} — ${by}: ${printable(change.because ?? '')}`
  }
  if (change.kind === 'forget') return `${from} would take back ${note} — ${by}`
  const more =
    change.scopes == null ? 'everything' : change.scopes.map((one) => printable(one)).join(', ')
  return `${from} would tell ${note} to ${more} too — ${by}`
}

/** What lines left unshared come to, in words: null for none. */
function leftSays(name: string, done: Exchanged): string | null {
  const left = done.left
  if (left === 0) return null
  return `${left} ${left === 1 ? 'line' : 'lines'} of notes could not be shared with ${name} yet: one longer than ${LINE_MOST.toLocaleString('en')} characters never is, and the rest go next time`
}

/** What lines neither side would take come to, in words: null for none. */
function refusedSays(name: string, done: Exchanged): string | null {
  const refused = done.refused
  if (refused === 0) return null
  return `${refused} ${refused === 1 ? 'line' : 'lines'} of notes between this machine and ${name} ${refused === 1 ? 'was' : 'were'} not taken: not one of the kinds this Tade reads, as a newer Tade's or one edited by hand may be`
}

/** The window's half of it, for remotes: each linked remote's notes shared from the beat. */
export function sharedNotesFor(
  wire: Wiring,
  reach: SharedNotesDeps['reach'],
  say: SharedNotesDeps['say'],
  waiting?: WaitingThere,
): SharedNotes {
  return new SharedNotes({
    ...(waiting && { waiting }),
    memory: () => wire.opts.client.memory,
    reach,
    from: () => machineLabel(),
    log: async (line) => {
      await wire.opts.client.log.append(line)
    },
    say,
    now: () => wire.now(),
  })
}

/**
 * The window's `WebNotes`: another machine's notes taken into this home's —
 * the workbench's own memory, so every agent and the orchestrator here are
 * told them from now on — and written down where anything was taken; and what
 * it holds of this one's changes for a press there, kept in `waiting`.
 */
export function notesFor(wire: Wiring, waiting?: WaitingThere): WebNotes {
  return async (body, by) => {
    // Only the opening request says what waits there; the rounds after leave it out.
    if (body.sum !== undefined) waiting?.heard(by.from, body.held ?? [])
    const answer = answerNotes(wire.opts.client.memory, body, by.from, machineLabel(), wire.now())
    if (answer.took > 0 || answer.refused > 0) {
      await wire.opts.client.log.append({
        type: 'notes_shared',
        detail: { with: by.from, took: answer.took, refused: answer.refused, device: by.device },
      })
    }
    return answer
  }
}
