import { z } from 'zod'
import { cleanAway } from './cleaning.ts'
import { withoutPaths } from './fields.ts'
import { PROTOCOL_VERSION } from './protocol.ts'
import type { Reach } from './reach.ts'
import { inTime } from './request.ts'
import type { ServerOptions } from './serving.ts'

// What one agent has changed, file by file with each file's diff, for the page
// that opened its changes (`GET /api/agent/:project/:task/changes`) — the
// window's own Show changes, from away.
//
// **The same thing leaving the machine as an agent's screen.** A diff is
// source, and an agent's screen is whatever it printed, and a call's whole
// answer (`answered.ts`) is whatever it read — a `read` of a file is the file.
// So this is its own answer, and never a field of a row or a snapshot (`diff` and
// `patch` are still names `NEVER_A_FIELD` refuses): it is asked when somebody
// opens it, answered once, and held by nobody.
//
// **The same cleaning at the boundary** (`cleanText`, off the window's thread
// for a long one): every machine path, every key Tade knows of and anything
// shaped like a credential taken out, counted, never said. A diff of a file
// that holds a key arrives with the key taken out of it.
//
// **Every file, and the whole of each**: nothing is cut and no line says the
// rest is at the machine. What could not be read in time is said per file
// (`unread`), never drawn as a file nobody changed. git's own header lines go —
// the page names the file, and `--- /dev/null` is a machine path to the
// cleaning — so a file's text starts at its first hunk.

/**
 * How long the window may take over the whole of one agent's changes: git is
 * asked once or more a file, so a change of a hundred files is a few seconds.
 */
export const CHANGES_MS = 30_000

export const CHANGES_SAY = [
  /** `files` is every file it changed. */
  'files',
  /** It has changed nothing. */
  'none',
  /** Nobody has looked at its tree yet: ask again in a moment. */
  'not looked',
  /** Its tree could not be read, or not in time. */
  'unread',
  /** No such task. */
  'not here',
] as const

export const FILE_SAYS = [
  /** `text` is its diff, from its first hunk. */
  'lines',
  /** git says it differs and shows no lines: a binary file. */
  'binary',
  /** git answered nothing for it: a mode change, or a file changed back since the list. */
  'nothing',
  /** git could not be asked about it, or not in time. */
  'unread',
] as const

export const ChangedFileSchema = z.strictObject({
  /** Where it is in the project, as git names it. */
  path: z.string(),
  /** git's letter: `M`odified, `A`dded, `D`eleted, `R`enamed, `?` untracked, `U`nmerged. */
  mark: z.string(),
  added: z.int().nonnegative().nullable(),
  removed: z.int().nonnegative().nullable(),
  says: z.enum(FILE_SAYS),
  /** Its diff from the first hunk, cleaned. Null for every `says` but `lines`. */
  text: z.string().nullable(),
  /** How many things the cleaning took out of it. A count, never what. */
  taken: z.int().nonnegative(),
})
export type ChangedFile = z.infer<typeof ChangedFileSchema>

export const ChangesOutSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  task: z.string(),
  says: z.enum(CHANGES_SAY),
  /** What it is measured from, as the window's CHANGES section is: its base branch, or `HEAD`. */
  base: z.string().nullable(),
  files: z.array(ChangedFileSchema),
})
export type ChangesOut = z.infer<typeof ChangesOutSchema>

/** One changed file, as the window read it. `text` is git's whole answer, header and all. */
export interface ChangedIn {
  path: string
  mark: string
  added: number | null
  removed: number | null
  /** git's diff of it; null where it answered nothing, `unread` where it could not be asked. */
  text: string | null | 'unread'
}

/**
 * What the window read of one agent's changes: every file and its diff, or
 * why not — `none` for a tree that changed nothing, `not looked` where no look
 * at it has answered yet, `unread` where it could not be read, null for a task
 * the window does not have.
 */
export type ChangesIn =
  | { files: readonly ChangedIn[]; base: string | null }
  | 'none'
  | 'not looked'
  | 'unread'
  | null

/**
 * The window's half: one agent's changes read when a page opens them, out of
 * the same look and the same git question as its own CHANGES section and
 * Show changes. It says at the machine what it could not read.
 */
export interface WebChanges {
  read(task: string): Promise<ChangesIn>
  /** Every value the window knows to be a key, taken out exactly (`knownKeys`). */
  known(): readonly string[]
}

/**
 * git's answer for one file from its first hunk: the header names the file
 * (which the page already does) and the two sides by machine path for a new
 * one. Null where there is no hunk; `binary` where git says that instead.
 */
export function hunksOf(text: string): string | 'binary' | null {
  const at = text.search(/^@@/m)
  if (at >= 0) return text.slice(at)
  return /^Binary files /m.test(text) ? 'binary' : null
}

function out(task: string, says: ChangesOut['says'], base: string | null = null): ChangesOut {
  return { v: PROTOCOL_VERSION, task, says, base, files: [] }
}

/** One file as a device is sent it: its diff from the first hunk, cleaned. */
async function fileOut(one: ChangedIn, known: readonly string[]): Promise<ChangedFile> {
  const base = {
    path: withoutPaths(one.path),
    mark: one.mark,
    added: one.added,
    removed: one.removed,
    text: null,
    taken: 0,
  }
  if (one.text === 'unread') return { ...base, says: 'unread' }
  const hunks = one.text === null ? null : hunksOf(one.text)
  if (hunks === null) return { ...base, says: 'nothing' }
  if (hunks === 'binary') return { ...base, says: 'binary' }
  // A cleaning that broke throws: the server says it at the machine, never a
  // line of source uncleaned.
  const clean = await cleanAway(hunks, known)
  return { ...base, says: 'lines', text: clean.text, taken: clean.taken }
}

/**
 * The route's answer: one agent's changes, or that there is no such task —
 * asked before the window is asked to read anything.
 */
export async function changesHere(
  params: Readonly<Record<string, string>>,
  reach: Reach,
  opts: Pick<ServerOptions, 'readingFor' | 'changes'>,
): Promise<ChangesOut> {
  const task = `${params.project ?? ''}/${params.task ?? ''}`
  if (!opts.readingFor(reach).agent(task).here) return out(task, 'not here')
  const changes = opts.changes
  if (changes === undefined) return out(task, 'unread')
  // The window's half says at the machine what it could not read and answers
  // `unread`: nothing is caught here to be passed off as anything else.
  const read = await inTime<ChangesIn>(changes.read(task), CHANGES_MS, 'unread')
  if (read === null) return out(task, 'not here')
  if (typeof read === 'string') return out(task, read)
  if (read.files.length === 0) return out(task, 'none', read.base)
  const known = changes.known()
  const files: ChangedFile[] = []
  for (const one of read.files) files.push(await fileOut(one, known))
  return { ...out(task, 'files', read.base), files }
}
