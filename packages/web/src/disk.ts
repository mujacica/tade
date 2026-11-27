import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// What is on this machine's disk in one of its projects, for another of the
// person's machines that stands in the project and presses it: a file in its
// FILES, a change in its CHANGES with what git says about it, or the branches
// its GIT's menu switches between — opened there in the very panels a project
// here opens them in.
//
// **An owner's, and only at this machine's own door** (`here` in `routes.ts`),
// like `/api/side`, which named the files in the first place: whoever holds the
// SSH key can already `cat` them over the same connection — or a paired
// phone, every one of which is the person's own, as on every owner's route.
//
// **The one owner's route that takes a path**, and so the window's half is
// where it is confined: the path is resolved against the tree the side was
// drawn from — the agent's worktree, or the project's checkout — with every
// link followed on both, and anything that lands outside that tree is the
// `404` of a file that is not there (`web-disk.ts`). The ask names a project
// and an agent by name, never a root.
//
// **And it writes what the same panels write here**, to the same tree and
// confined the same way: a file saved, one file's changes discarded, a branch
// switched to, made, renamed or pulled (`checkout-write.ts`). Each ask names
// what it expects, as every verb a device sends does (`verbs.ts`): a save the
// size and the time the file was read at, refused where it has moved since; a
// rename the branch it is renaming. Whoever may ask this may already change
// the checkout over the same SSH, and the person's own device is one they
// decided may do what they can — so nothing an owner can do here is held back
// from there, and what is refused is said in git's words or the disk's.
//
// A file past `DISK_MOST.file` is cut and says so, as the viewer here cuts one
// past what it reads, and a cut file is never one a save may write.

/** How much of each kind one answer carries: past that, the rest are not sent. */
export const DISK_MOST = {
  /** Bytes of a file: what the viewer reads of one here, halved for the wire's escaping. */
  file: 512 * 1024,
  /** Characters of what git says changed in it. */
  diff: 512 * 1024,
  branches: 500,
} as const

/**
 * The most a save's body may be: a whole file of `DISK_MOST.file` characters,
 * with room for JSON's escaping of them. The one owner's route past
 * `BODY_MAX`, and read only once the request is known to be a paired device's.
 */
export const DISK_BODY_MAX = 4 * DISK_MOST.file

const NAME = z.string().max(400)
const TEXT = z.string().max(4000)
/** A path as the side or a screen named it: no NUL, and nothing longer than a path is. */
const PATH = z
  .string()
  .min(1)
  .max(4000)
  .refine((path) => !path.includes('\0'), 'a path has no NUL in it')

/**
 * A branch as somebody typed or chose it: never one git would read as an
 * option. Whether git takes the rest of it is git's to say, in its own words.
 */
const BRANCH = z
  .string()
  .min(1)
  .max(250)
  .refine((name) => !name.startsWith('-') && !name.includes('\0'), 'not a branch name')

/** Where every ask is: the project, and the agent whose worktree is the tree. */
const Where = {
  project: NAME,
  /** The agent in front of the asking screen, by its task id here: its worktree is the tree. */
  agent: NAME.nullable(),
}

export const DiskAskSchema = z.discriminatedUnion('what', [
  z.strictObject({
    ...Where,
    what: z.literal('file'),
    /** The file, relative to the tree or within it. */
    path: PATH,
    /** With the file, what git says changed in it, measured where its CHANGES are. */
    diff: z.boolean().optional(),
  }),
  z.strictObject({ ...Where, what: z.literal('branches') }),
  z.strictObject({
    ...Where,
    what: z.literal('save'),
    path: PATH,
    /** The whole of what it should hold. */
    text: z.string().max(DISK_MOST.file),
    /** What it was when it was read: a file that is not that now is not written. */
    was: z.strictObject({
      size: z.number().int().nonnegative(),
      mtimeMs: z.number().nonnegative(),
    }),
  }),
  /** One file's uncommitted changes thrown away. */
  z.strictObject({ ...Where, what: z.literal('discard'), path: PATH }),
  /** Onto a branch, or onto a new one made where it stands. */
  z.strictObject({ ...Where, what: z.literal('switch'), name: BRANCH, create: z.boolean() }),
  /**
   * The agent's branch renamed, or named where it has none yet: `from` is the
   * one the asking screen showed, `''` for none.
   */
  z.strictObject({
    ...Where,
    what: z.literal('rename'),
    name: BRANCH,
    from: z.string().max(250),
  }),
  /** The checkout's branch fast-forwarded to its upstream. */
  z.strictObject({ ...Where, what: z.literal('pull') }),
])
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
  /**
   * When it was last written, as that disk says: what a save hands back, so a
   * file that moved since is not written over. Absent from a Tade older than
   * saving there.
   */
  mtimeMs: z.number().nonnegative().optional(),
})

const BranchesSchema = z.object({
  what: z.literal('branches'),
  branches: z
    .array(z.object({ name: NAME, current: z.boolean(), when: NAME }))
    .max(DISK_MOST.branches),
})

/** A write that happened, or why not: git's words, or the disk's. A save that happened is the file, read again. */
const WroteSchema = z.object({
  what: z.literal('wrote'),
  ok: z.boolean(),
  /** What it is now (`on tade/x`), or why it is not. */
  said: TEXT,
})

/** The answer, as this machine gives it and another reads it: every value bounded. */
export const DiskAnswerSchema = z.discriminatedUnion('what', [
  FileSchema,
  BranchesSchema,
  WroteSchema,
])
export type DiskAnswer = z.infer<typeof DiskAnswerSchema>

/**
 * The window's half: the file or the branches, as its own panels would read
 * them, or what a write did — or null where the project, the agent or the
 * file is not there, or the path leaves the tree.
 */
export type WebDisk = (ask: DiskAsk) => Promise<DiskAnswer | null>

/** The route. `disk` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function diskHere(
  req: IncomingMessage,
  disk: WebDisk | undefined,
): Promise<{ body: DiskAnswer } | { refusal: Refusal }> {
  if (disk === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req, DISK_BODY_MAX)
  if (!got.read) return { refusal: got.refusal }
  const ask = DiskAskSchema.safeParse(got.body)
  if (!ask.success) return { refusal: refuse('malformed') }
  const answer = await disk(ask.data)
  if (answer === null) return { refusal: refuse('no_such') }
  // What leaves is what the schema says may: a field nobody decided on stays here.
  return { body: DiskAnswerSchema.parse(answer) }
}
