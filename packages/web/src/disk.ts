import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { sees } from './reach.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs, reachOf } from './surface.ts'

// What is on this machine's disk in one of its projects, for another of the
// person's machines that stands in the project and presses it: a file in its
// FILES, a change in its CHANGES with what git says about it, or the branches
// its GIT's menu switches between — opened there in the very panels a project
// here opens them in.
//
// **An owner's, and only at this machine's own door** (`here` in `routes.ts`),
// like `/api/side`, which named the files in the first place: whoever holds the
// SSH key can already `cat` them over the same connection, and a phone's
// session is refused it however much it was granted (`out_of_scope`) — **but
// the person's own** (`Route.theirs`), as on every owner's route. Within what
// the device reads: a project the window took back from it is answered as one
// that is not open here.
//
// **The one owner's route that takes a path**, and so the window's half is
// where it is confined: the path is resolved against the tree the side was
// drawn from — the agent's worktree, or the project's checkout — with every
// link followed on both, and anything that lands outside that tree is the
// `404` of a file that is not there (`web-disk.ts`). The ask names a project
// and an agent by name, never a root.
//
// **It reads, and changes nothing.** A file past `DISK_MOST.file` is cut and
// says so, as the viewer here cuts one past what it reads.

/** How much of each kind one answer carries: past that, the rest are not sent. */
export const DISK_MOST = {
  /** Bytes of a file: what the viewer reads of one here, halved for the wire's escaping. */
  file: 512 * 1024,
  /** Characters of what git says changed in it. */
  diff: 512 * 1024,
  branches: 500,
} as const

const NAME = z.string().max(400)
const TEXT = z.string().max(4000)
/** A path as the side or a screen named it: no NUL, and nothing longer than a path is. */
const PATH = z
  .string()
  .min(1)
  .max(4000)
  .refine((path) => !path.includes('\0'), 'a path has no NUL in it')

export const DiskAskSchema = z.strictObject({
  project: NAME,
  /** The agent in front of the asking screen, by its task id here: its worktree is the tree. */
  agent: NAME.nullable(),
  /** A file, or the branches of the tree. */
  what: z.enum(['file', 'branches']),
  /** The file, relative to the tree or within it. */
  path: PATH.optional(),
  /** With the file, what git says changed in it, measured where its CHANGES are. */
  diff: z.boolean().optional(),
})
export type DiskAsk = z.infer<typeof DiskAskSchema>

const FileSchema = z.object({
  what: z.literal('file'),
  /** Where it is on this machine, every link followed. */
  path: TEXT,
  /** The same, from the tree's root: what CHANGES and FILES call it. */
  relative: TEXT,
  size: z.number().int().nonnegative(),
  binary: z.boolean(),
  /** Only the start of it is in `text`. */
  truncated: z.boolean(),
  text: z.string().max(DISK_MOST.file),
  /** Why it could not be read, in words. */
  error: TEXT.nullable(),
  /** What git says changed in it, where it was asked: null where git could not say. */
  diff: z.string().max(DISK_MOST.diff).nullable(),
})

const BranchesSchema = z.object({
  what: z.literal('branches'),
  branches: z
    .array(z.object({ name: NAME, current: z.boolean(), when: NAME }))
    .max(DISK_MOST.branches),
})

/** The answer, as this machine gives it and another reads it: every value bounded. */
export const DiskAnswerSchema = z.discriminatedUnion('what', [FileSchema, BranchesSchema])
export type DiskAnswer = z.infer<typeof DiskAnswerSchema>

/**
 * The window's half: the file or the branches, as its own panels would read
 * them — or null where the project, the agent or the file is not there, or the
 * path leaves the tree.
 */
export type WebDisk = (ask: DiskAsk) => Promise<DiskAnswer | null>

/** The route. `disk` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function diskHere(
  req: IncomingMessage,
  device: Device,
  disk: WebDisk | undefined,
): Promise<{ body: DiskAnswer } | { refusal: Refusal }> {
  if (disk === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const ask = DiskAskSchema.safeParse(got.body)
  if (!ask.success) return { refusal: refuse('malformed') }
  if (ask.data.what === 'file' && ask.data.path === undefined)
    return { refusal: refuse('malformed') }
  // A project the window took back from this device is one that is not open here.
  if (!sees(reachOf(device), ask.data.project)) return { refusal: refuse('no_such') }
  const answer = await disk(ask.data)
  if (answer === null) return { refusal: refuse('no_such') }
  // What leaves is what the schema says may: a field nobody decided on stays here.
  return { body: DiskAnswerSchema.parse(answer) }
}
