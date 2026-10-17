import { z } from 'zod'

// What only you know.
//
// Everything else Tade says about the world is derived from something it can
// observe: git, processes, transcripts. Notes are the exception, and they are
// not a contradiction of that — they are the same kind of fact as
// `intent_spoken` and `parked`, things a person said that no probe could ever
// discover. They are kept verbatim for the same reason `intent_spoken` is:
// paraphrasing what someone told you loses the detail that made it worth
// saying.

export const NoteSchema = z.strictObject({
  /** Exactly what was said. Never paraphrase it. */
  text: z.string().min(1),
  /**
   * A headline for it, written by whoever took it down: what the note is
   * about and what it does, in a few words. It sits *beside* the note and
   * never in place of it — `text` is still the whole of what was said, and
   * nothing here may ever be drawn from it by rewording, shortening or
   * lowercasing what a person said.
   *
   * Optional, and always will be: every note taken before this existed has
   * none, and a note can be written down by anything.
   */
  summary: z.string().min(1).optional(),
  /** A task id, a project name, or null when it is about everything. */
  scope: z.string().nullable(),
  /**
   * More tasks or projects the same words are about. One sentence that covers
   * three tasks is one note, never three: written three times it is three rows
   * of the same words in the window and three to retire when they go.
   */
  also: z.array(z.string().min(1)).min(1).optional(),
  /**
   * Where it came from: `voice`, `window`, `cli`. Defaulted rather than
   * required so notes written before this existed still load — losing them to
   * a schema change would be losing the one thing nothing can recover.
   */
  by: z.string().default('unknown'),
  at: z.string(),
})

/**
 * Why a note stopped being told to anybody: who said so, when, and the
 * sentence. Folded out of the file, never written into a note's own line —
 * the note is kept as it was taken, and this is a later line about it.
 */
export interface Retired {
  by: string
  at: string
  because: string
}

export type Note = z.infer<typeof NoteSchema> & {
  retired?: Retired
  /**
   * The machine it was taken on, where that is another one: what the machine
   * it came from here called it (`came` in `memory.jsonl`). Absent for a note
   * taken here. Folded out of the file like `retired`, and said only where
   * somebody asks about a note — never in what anybody is told.
   */
  from?: string
}

/**
 * What a machine may be called where a note says it was taken there: a
 * remote's name here, or what a machine calls itself (`machineLabel`). It is
 * another machine's word and it is drawn, so it is checked wherever one
 * arrives, and anything else is not taken.
 */
export const MACHINE_NAMED = /^[A-Za-z0-9._-][A-Za-z0-9 ._-]{0,119}$/

/** What a note is about: one task or project, several, or null for everything. */
export type Scopes = string | null | readonly (string | null)[]

export function note(
  text: string,
  scope: Scopes,
  by: string,
  now: number,
  summary: string | null = null,
): Note {
  const headline = summary?.trim()
  const [first = null, ...rest] = scopeList(scope)
  // Only the first can be null: `scopeList` answers `[null]` or names alone.
  const also = rest.filter((one): one is string => one !== null)
  return {
    text: text.trim(),
    ...(headline ? { summary: headline } : {}),
    scope: first,
    ...(also.length > 0 ? { also } : {}),
    by,
    at: new Date(now).toISOString(),
  }
}

/**
 * Scopes as a list, each once, blanks dropped — and `[null]` where nothing is
 * left or everything is named, because a note about no task in particular is a
 * note about everything.
 */
export function scopeList(scope: Scopes): (string | null)[] {
  const list = typeof scope === 'string' || scope === null ? [scope] : scope
  // About everything already reaches every task and project a list names.
  if (list.includes(null)) return [null]
  const named = list.flatMap((one) => (one?.trim() ? [one.trim()] : []))
  return named.length > 0 ? [...new Set(named)] : [null]
}

/** Everything a note is about, its own scope first. About everything is `[null]`. */
export function scopesOf(entry: Pick<Note, 'scope' | 'also'>): (string | null)[] {
  return entry.scope === null ? [null] : [entry.scope, ...(entry.also ?? [])]
}

/** How specific a scope is: a task beats its project beats everything. */
function depth(scope: string | null): number {
  return scope === null ? 0 : scope.split('/').length
}

/** Whether one scope a note names reaches `scope`. */
function reaches(named: string | null, scope: string | null): boolean {
  if (named === null) return true
  if (scope === null) return false
  return named === scope || scope.startsWith(`${named}/`)
}

/**
 * Whether a note is worth knowing while talking about `scope`. A note about a
 * project applies to every task in it, and a note about everything always
 * applies; a note about one task never leaks to its siblings.
 */
export function appliesTo(entry: Note, scope: string | null): boolean {
  return scopesOf(entry).some((named) => reaches(named, scope))
}

/** How narrowly a note applies to `scope`: by the narrowest of its scopes that reaches it. */
function depthFor(entry: Note, scope: string | null): number {
  return Math.max(
    ...scopesOf(entry)
      .filter((named) => reaches(named, scope))
      .map(depth),
  )
}

/**
 * What is known about something, narrowest first and newest first within that.
 *
 * Narrowest first because that is the order they should be believed in: told
 * something about a task and something else about the whole workspace, the one
 * about the task is the one that applies. Recency alone would let a passing
 * general remark outrank a specific instruction given weeks ago.
 *
 * A retired note is not known any more: it is in nothing anybody is told.
 */
export function recall(notes: readonly Note[], scope: string | null): Note[] {
  const wanted = notes.filter((entry) => !entry.retired && appliesTo(entry, scope))
  return [...wanted].sort(
    (a, b) => depthFor(b, scope) - depthFor(a, scope) || b.at.localeCompare(a.at),
  )
}

/**
 * Everything known, newest first, whatever it is about — and, asked for, what
 * was retired too: still there to read, marked with who retired it and why.
 */
export function allNotes(notes: readonly Note[], opts: { retired?: boolean } = {}): Note[] {
  return [...notes]
    .filter((entry) => opts.retired === true || !entry.retired)
    .sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * Of `scopes`, the ones a live note with these exact words does not already
 * reach — what writing the same words down again would add. Empty is "already
 * noted": nothing to write, and the caller says so.
 *
 * Reaches, not equals: the same words about a project already go to every
 * task in it, so writing them again about one of those tasks adds nothing. The
 * words are compared exactly, after the trim `note` gives them, and never
 * lowercased or loosened — two sentences that differ are two things said.
 */
export function unnoted(entry: Note, text: string, scopes: Scopes): (string | null)[] {
  if (entry.retired || entry.text !== text.trim()) return scopeList(scopes)
  return scopeList(scopes).filter((one) =>
    one === null ? entry.scope !== null : !appliesTo(entry, one),
  )
}

/** A note that may be retired unasked, and the sentence it is retired with. */
export interface Retiring {
  note: Note
  because: string
  /** Which of the two rules: the same words again, or work that is gone. */
  rule: 'duplicate' | 'gone'
}

/** The last thing the journal says happened to a task, and when (epoch ms). */
export interface TaskLast {
  type: 'task_created' | 'run_started' | 'task_done' | 'task_removed'
  at: number
}

/**
 * How long a note about a task that is gone goes on being told to anybody
 * (`notes.keep_days`). Three days by default — the same three days the
 * briefing calls a gone document stale — because a task name is never used
 * twice, so a note about a removed task reaches nobody again, and the wait is
 * only so that something said this week is still in front of the person who
 * said it.
 */
export const NotesConfigSchema = z
  .strictObject({ keep_days: z.int().positive().default(3) })
  .prefault({})

/**
 * The notes Tade may retire by itself, oldest first, each with why. No model:
 * two rules, each a fact anybody can check, and nothing that needs judgement.
 *
 * - **The same words again, about the same.** A later live note with exactly
 *   the words of an earlier live one, every scope of which the earlier one
 *   names too. The earlier one stays; nothing anybody is told changes.
 * - **Work that is gone.** A note every scope of which is a task (never a
 *   project, never everything) that has finished — its last word in the
 *   journal is `task_done` — or whose task file is gone, either for longer
 *   than `keep`. Aged from the latest of the note and the task's last word, so
 *   a note taken yesterday about a task removed last month waits like any.
 *
 * What it cannot see it keeps: a task with nothing in the journal is aged from
 * the note alone, and a task file that is there is a task — `present` is the
 * caller's look, and a look that failed must answer `true`.
 *
 * **A note taken on another machine is that machine's to call gone** where this
 * journal has never heard of the task: notes are shared between homes and
 * tasks are not, so a task nothing here knows is most likely running there.
 * It is kept here, and when that machine retires it the line comes back over
 * the link (`notes-shared.ts`).
 *
 * Pure, and takes `now`: the clock is the caller's.
 */
export function notesToRetire(
  notes: readonly Note[],
  facts: { last: ReadonlyMap<string, TaskLast>; present: (task: string) => boolean },
  now: number,
  keep: number,
): Retiring[] {
  const out: Retiring[] = []
  const live: Note[] = []
  for (const entry of [...notes].sort((a, b) => a.at.localeCompare(b.at))) {
    if (entry.retired) continue
    const earlier = live.find((one) => one.text === entry.text && sameOrWider(one, entry))
    if (earlier) {
      out.push({
        note: entry,
        because: `the same words as the note of ${earlier.at.slice(0, 10)}, about the same`,
        rule: 'duplicate',
      })
      continue
    }
    live.push(entry)
    const gone = goneFor(entry, facts, now)
    if (gone && gone.since > keep) {
      out.push({ note: entry, because: gone.because, rule: 'gone' })
    }
  }
  return out
}

/** Whether `wide` names every scope `narrow` does — the same scope, never "reaches". */
function sameOrWider(wide: Note, narrow: Note): boolean {
  const named = scopesOf(wide)
  return scopesOf(narrow).every((one) => named.includes(one))
}

/** How long every task a note is about has been gone, and what to say about it; null where one is not. */
function goneFor(
  entry: Note,
  facts: { last: ReadonlyMap<string, TaskLast>; present: (task: string) => boolean },
  now: number,
): { since: number; because: string } | null {
  let since = Number.POSITIVE_INFINITY
  let because = ''
  for (const scope of scopesOf(entry)) {
    if (scope === null || !scope.includes('/')) return null
    const last = facts.last.get(scope)
    const there = facts.present(scope)
    if (there && last?.type !== 'task_done') return null
    if (last === undefined && entry.from !== undefined) return null
    const from = Math.max(Date.parse(entry.at) || 0, last?.at ?? 0)
    if (now - from >= since) continue
    since = now - from
    const days = Math.floor(since / 86_400_000)
    const ago = `${days} day${days === 1 ? '' : 's'} ago`
    because =
      last?.type === 'task_done'
        ? `${scope} finished ${ago}`
        : last?.type === 'task_removed'
          ? `${scope} was removed ${ago}`
          : `${scope} is gone, and nothing has happened to it since ${ago}`
  }
  return Number.isFinite(since) ? { since, because } : null
}
