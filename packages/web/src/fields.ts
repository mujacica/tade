// Which values in a projection are Tade's own words, and which are somebody's.
//
// `input.ts` carries the argument; this file is the mechanical half of it, so
// that the two kinds can be told apart by a test rather than by a reader.
//
// - **Metadata** — what Tade generated about the work: a name, a count, a
//   state, `deriveState`'s clause, an id, a branch, a check's id, a question's
//   id, a probability, a repository-relative file name. Tade wrote every word,
//   so none of it holds a machine path or a credential, and that is what the
//   leakage tests hold every metadata string to.
// - **Authored free text** — what a person (or an agent, about its own work)
//   typed or spoke, kept verbatim: a title, `intent_spoken`, a note, the
//   sentence accounting for a finding. It is **never scrubbed**, because
//   scrubbing is rewording and the house rule about a note is that it is never
//   reworded. It travels as `Said`, cut to a budget, only where the device was
//   granted it, and is drawn as text and never as markup.
//
// The claim the projection makes, exactly: *the away view adds no path and no
// credential of its own, and it shows what you wrote as you wrote it.*
// Anything stronger is a promise this design cannot keep (DECISIONS.md §4.11).

/** One string found in a projection, and where it was. */
export interface Found {
  /** `tasks[].title.words`: array indices flattened, so one path names a field. */
  at: string
  words: string
}

/**
 * Every string in a value, with the path it was at.
 *
 * Indices are flattened to `[]` so that a path names a *field* and a test can
 * talk about fields rather than about rows. Keys are not walked for their own
 * text — a key is this file's own vocabulary — but `keysIn` collects them.
 */
export function stringsIn(value: unknown, at = ''): Found[] {
  if (typeof value === 'string') return [{ at, words: value }]
  if (Array.isArray(value)) return value.flatMap((one) => stringsIn(one, `${at}[]`))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, one]) =>
    stringsIn(one, at === '' ? key : `${at}.${key}`),
  )
}

/** Every key name anywhere in a value. */
export function keysIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const one of value) keysIn(one, into)
    return into
  }
  if (typeof value !== 'object' || value === null) return into
  for (const [key, one] of Object.entries(value as Record<string, unknown>)) {
    into.add(key)
    keysIn(one, into)
  }
  return into
}

/**
 * The paths that hold free text somebody wrote.
 *
 * Every other string in a projection is metadata and is held to carrying no
 * path and no credential. A field added here is a field whose content stops
 * being checked, which is why the list is short, is a list of paths rather than
 * a rule about names, and is asserted in both directions: a path here that the
 * projection never produces is a line that outlived its field.
 */
export const AUTHORED: readonly string[] = [
  'projects[].title.words',
  'tasks[].title.words',
  'tasks[].intent.words',
  'tasks[].account.words',
  'queue[].waitsOn[].why.words',
  'findings[].account.said.words',
  'notes[].text.words',
  'notes[].summary.words',
  'plans[].account.words',
]

/** Whether a string at this path is free text somebody wrote. */
export function authored(at: string): boolean {
  return AUTHORED.includes(at)
}

/**
 * Field names that may never appear anywhere in a projection, and the reason
 * each one is named rather than left to judgement.
 *
 * This is the hook for whatever reads work in from outside later — a ticket, a
 * Slack thread, a review comment — and it is a hook in the only shape that
 * holds: **a name that fails a test**, not a reserved column. Nothing here
 * reserves a route, a key or a type for an intake; DECISIONS.md §1 is explicit
 * that a reserved thing nobody earned is a setting with no reader by another
 * name. What this does is make the *shape* of the mistake fail.
 *
 * The mistake, specifically. A connector written months from now hands the
 * window an envelope with `verbatim` on it — a stranger's words, written in a
 * system Tade does not control. Somebody spreads it into a row because the type
 * allows it, and it is on a phone and in a service-worker cache with nobody
 * having decided that. What a row about outside work may carry is what *Tade*
 * generated about it: the source, the external id, the requester's handle, the
 * state, the task it became, the grant that allowed it, and a link. The words
 * stay in the task's context file, where the agent reads them under the
 * sentence that says they are material and grant no permission.
 *
 * The same applies to things that are not an intake and never were: a diff
 * body, a lane's bytes, a tool call's arguments, a transcript. Each is behind
 * its own `never`-tier setting in a later phase, and none of them is a field on
 * this projection.
 *
 * **These are field *names*, and nothing here is a word list over values.** A
 * leakage test that searched values for `token` would pass on every credential
 * that does not contain the word, which is most of them — so the tests look
 * for values out of their own fixture instead, and this holds the shape of the
 * row. The two answer different mistakes and neither stands in for the other.
 */
export const NEVER_A_FIELD: Readonly<Record<string, string>> = {
  verbatim: 'an outside request body is a stranger’s words; it stays in the context file',
  body: 'the same thing under the name a connector is most likely to reach for',
  attachments: 'references to files Tade did not download belong to the intake’s own record',
  requester: 'who asked, as a source names them, is the intake’s record and not a task row',
  thread: 'review comments are attacker-controlled text: material, never a page',
  comment: 'one review comment is the same text as a thread of them, and the same answer',
  diff: 'a diff ships source to a device and to a cache; that is its own act and its own setting',
  patch: 'a patch is a diff with a different name on it, and ships the same source',
  output: 'a lane’s bytes can carry anything an agent printed by accident',
  transcript: 'the largest, least structured, most injection-prone surface Tade has',
  payload: 'a tool call’s arguments are the call itself, machine paths and all',
  args: 'the arguments of a call under the name a harness is most likely to use',
  root: 'a project’s checkout is an absolute path and names nothing a page can act on',
  worktree: 'a task’s worktree is an absolute path, and a branch name says what it is for',
  cwd: 'a working directory is an absolute path by another name',
  pid: 'a process id is the machine’s own bookkeeping and nothing a page can act on',
  socket: 'the ToolHost is the window’s own children’s and is reachable from nowhere else',
  token: 'nothing that is a credential, and nothing that names where one is kept',
  secret: 'the same, under the word the config itself uses for one',
  cookie: 'a session credential belongs in a header the page never reads',
  env: 'an environment is where credentials live, and all of it stays on the machine',
}

/** Any name in a projection that must never be one. */
export function forbidden(keys: Iterable<string>): string[] {
  return [...keys].filter((key) => key in NEVER_A_FIELD)
}
