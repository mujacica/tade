import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type IntakeCandidate, intakeSpool, newerRevision } from '@tade/core'
import { z } from 'zod'

// The local intake door's spool: one file per request, written by `tade intake`
// and read by the `intake.cli` watch.
//
// **It is the testing adapter and it is also the real thing.** Every other
// source will be a network client with a credential and a rate limit; this one
// is a folder, so the whole pipeline — the rule, the grant, the propose, the
// approval, the re-check at the start, the reply — can be exercised end to end
// with no key, no listener and nothing to mock. The way `drivers/scripted` and
// `forges/scripted` are, except that a person can use this one.
//
// **Every file is written once and never edited.** That is what makes it the
// immutable raw material an envelope's `material.ref` points at: an edit is a
// new file at a new revision, a withdrawal is a new file that says closed, and
// the hash of the body at the revision a task was made from stays true whatever
// happens next. Nothing here ever rewrites or deletes one, so "the text has
// moved since you approved it" is a comparison rather than a guess.
//
// **No path comes in from outside.** The folder is `intakeSpool(home)` and a
// file is named from an id that passed `ID`, so there is no route that takes a
// path — the shape that removes a containment problem rather than sanitising
// one.

/** What a request's own id may be: the id goes in a filename, so nothing else. */
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** One request, as `tade intake` writes it and the watch reads it back. */
export const SpoolEntry = z.strictObject({
  /** The request's own id, which is the external id every revision of it shares. */
  id: z.string().regex(ID),
  /** A decimal counter: this door's revision semantics, compared as a number. */
  revision: z.int().positive(),
  /** The project the person named, which the grant's own list either allows or does not. */
  project: z.string().min(1),
  /** Who asked, as this door was told. A handle, and never an authority. */
  requester: z.strictObject({
    id: z.string().min(1),
    label: z.string().default(''),
    bot: z.boolean().default(false),
  }),
  /** THE REQUEST, VERBATIM. Material, and it goes nowhere but a context file. */
  body: z.string(),
  url: z.string().default(''),
  attachments: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        url: z.string().min(1),
        mediaType: z.string().default(''),
        bytes: z.int().nonnegative().default(0),
      }),
    )
    .default([]),
  /**
   * Withdrawn: this revision says the request is over.
   *
   * It is how the local door exercises the case every tracker has — a ticket
   * closed while its task waited — and it holds work rather than stopping an
   * agent, because nothing outside this machine stops an agent.
   */
  closed: z.boolean().default(false),
  /** When the person wrote it. */
  at: z.string(),
  /** One id per delivery, carried into every line about it. */
  correlation: z.string().min(1),
})
export type SpoolEntry = z.infer<typeof SpoolEntry>

/** How many of the newest spool files one look reads. A folder is not a database. */
export const SPOOL_MOST = 200

/** What is wrong with an id somebody typed, or null. */
export function spoolIdProblem(id: string): string | null {
  return ID.test(id)
    ? null
    : `"${id}" is not a usable request id: lowercase letters, digits and dashes, up to 64`
}

function fileFor(id: string, revision: number): string {
  return `${id}.${String(revision).padStart(4, '0')}.json`
}

/** sha256 of the body as it was written: what a later look compares against. */
export function bodyHash(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`
}

/**
 * Write one request into the spool, at the next revision of its id.
 *
 * Written to a temporary name and renamed, so a look never reads half a file:
 * a request that arrived is a request that is wholly there or not there at all.
 */
export async function spool(
  home: string,
  req: Omit<SpoolEntry, 'revision' | 'at' | 'correlation'> & {
    at?: string
    correlation?: string
  },
): Promise<{ entry: SpoolEntry; file: string }> {
  const problem = spoolIdProblem(req.id)
  if (problem) throw new Error(problem)
  const dir = intakeSpool(home)
  await mkdir(dir, { recursive: true })
  const existing = await readSpool(home)
  const mine = existing.entries.filter((one) => one.id === req.id)
  const revision = mine.reduce((most, one) => Math.max(most, one.revision), 0) + 1
  const at = req.at ?? new Date().toISOString()
  const entry = SpoolEntry.parse({
    ...req,
    revision,
    at,
    correlation: req.correlation ?? `${req.id}-${revision}-${at}`,
  })
  const file = fileFor(entry.id, entry.revision)
  const path = join(dir, file)
  const temp = `${path}.writing`
  await writeFile(temp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
  return { entry, file }
}

/** What the spool holds, and what in it could not be read. */
export interface SpoolRead {
  entries: (SpoolEntry & { file: string })[]
  /** A file that is there and is not a request, named rather than passed over. */
  broken: { file: string; problem: string }[]
}

/**
 * Every request in the spool, oldest first, and whatever could not be read.
 *
 * A file that is not a request is **named**, never thrown over and never
 * silently skipped: somebody hand-edited a file, and a look that quietly found
 * nothing would be a request that vanished.
 */
export async function readSpool(home: string): Promise<SpoolRead> {
  const dir = intakeSpool(home)
  const names = await readdir(dir).catch(() => [] as string[])
  const wanted = names.filter((name) => name.endsWith('.json')).sort()
  const read: SpoolRead = { entries: [], broken: [] }
  for (const file of wanted.slice(-SPOOL_MOST)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(dir, file), 'utf8'))
    } catch (err) {
      read.broken.push({ file, problem: err instanceof Error ? err.message : String(err) })
      continue
    }
    const entry = SpoolEntry.safeParse(parsed)
    if (!entry.success) {
      read.broken.push({ file, problem: entry.error.issues[0]?.message ?? 'not a request' })
      continue
    }
    read.entries.push({ ...entry.data, file })
  }
  read.entries.sort((a, b) => (a.id === b.id ? a.revision - b.revision : a.id < b.id ? -1 : 1))
  return read
}

/** The newest revision of each request in the spool, by id. */
export function newestOf(
  entries: readonly (SpoolEntry & { file: string })[],
): Map<string, SpoolEntry & { file: string }> {
  const newest = new Map<string, SpoolEntry & { file: string }>()
  for (const entry of entries) {
    const was = newest.get(entry.id)
    // Through the source's own comparison, like every other revision question:
    // these are numbers and comparing them as strings is how `"10"` comes
    // before `"9"`.
    const order = was ? newerRevision('cli', String(entry.revision), String(was.revision)) : 1
    if (order !== null && order > 0) newest.set(entry.id, entry)
  }
  return newest
}

/** One spool entry as the envelope a watch hands over: no grant, no template, no project. */
export function candidateOf(entry: SpoolEntry & { file: string }, seenAt: string): IntakeCandidate {
  return {
    source: 'cli',
    externalId: entry.id,
    revision: String(entry.revision),
    url: entry.url,
    requester: entry.requester,
    // What this door called where it came from. The owner's own list is what
    // decides whether that may become work, which is `intakeMapped`'s.
    from: entry.project,
    verbatim: entry.body,
    material: { ref: entry.file, hash: bodyHash(entry.body) },
    attachments: entry.attachments,
    sourceAt: entry.at,
    seenAt,
    correlation: entry.correlation,
  }
}
