import { stat } from 'node:fs/promises'
import { machineLabel } from '@tade/core'
import { type Held, LinkError, type Remote, type RemoteLink } from '@tade/remotes-core'
import type { WebNotes } from '@tade/web'
import type { Memory } from '@tade/workbench/memory'
import {
  answerNotes,
  type Exchanged,
  LINE_MOST,
  NotesRefused,
  shareNotes,
} from '@tade/workbench/notes-shared'
import type { Wiring } from './context.ts'

// The person's notes, shared with every machine this window is linked to
// (REMOTE-TADE.md §4.5, §9.6; `@tade/workbench`'s `notes-shared.ts` is the
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
      this.troubles(name, leftSays(name, done.left))
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
      // Not reaching it is the link's news, said as the link goes down; a
      // remote that answered and would not, or notes that would not be read
      // here, are this exchange's.
      if (err instanceof NotesRefused || !(err instanceof LinkError)) {
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

/** What lines left unshared come to, in words: null for none. */
function leftSays(name: string, left: number): string | null {
  if (left === 0) return null
  return `${left} ${left === 1 ? 'line' : 'lines'} of notes could not be shared with ${name} yet: one longer than ${LINE_MOST.toLocaleString('en')} characters never is, and the rest go next time`
}

/** The window's half of it, for remotes: each linked remote's notes shared from the beat. */
export function sharedNotesFor(
  wire: Wiring,
  reach: SharedNotesDeps['reach'],
  say: SharedNotesDeps['say'],
): SharedNotes {
  return new SharedNotes({
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
 * told them from now on — and written down where anything was taken.
 */
export function notesFor(wire: Wiring): WebNotes {
  return async (body, by) => {
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
