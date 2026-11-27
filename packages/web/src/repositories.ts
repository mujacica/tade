import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// Where this machine's projects are checked out, and the branches their work
// is on: what another machine of the person's needs to fetch that work into a
// mirror of its own — for its conflict forecast.
//
// **An owner's, and only at this machine's own door** (`here` in `routes.ts`):
// the answer names a path on this machine for each project, which no row a
// phone reads ever holds (`input.ts`). What makes it no wider than what
// already was is who may ask and where: an owner is the SSH key (`owner.ts`),
// this machine's own door from anywhere else is that same SSH connection, and
// the fetch it is for goes over it too — whoever holds the key can already
// `ssh` in and `cd` there. **And a paired device's**, on any door, because
// every one is the person's own and a path on their own machine is theirs to
// be told; off this machine's door it is asked a trusted origin and the
// passkey.
//
// **No credential in it.** What names each repository is `repositoryNamed`'s
// answer — `github.com/owner/name` — never the remote URL, which may hold one.
// It changes nothing in a project. Where it can, it says where this machine's
// mirror of the project is (`mirror`), made ready in this home if it was not:
// the bare repository another machine pushes its own branches into, under its
// own name, for this machine to keep its checkout in step from (`sync.ts`).

/** How many projects, and branches in each, one answer carries; past that, the rest wait. */
export const REPOSITORIES_MOST = 64
export const BRANCHES_MOST = 256

/** A branch name as this machine fetches it under another's name: what Tade names one, and git allows. */
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/@+-]{1,250}$/
/** A commit id, in either of git's hashes. */
const HEAD = /^[0-9a-f]{40,64}$/

const BranchSchema = z.object({
  /** Its task's id here: `<project>/<task>`. */
  task: z.string().min(1).max(200),
  branch: z.string().regex(BRANCH),
  /** Where its work is measured from here: the project's base, or the branch it is stacked on. */
  base: z.string().regex(BRANCH).nullable(),
  /** The commit it is on, as this machine last looked. */
  head: z.string().regex(HEAD).nullable(),
  /** Live work a merge could collide over, by this machine's rule (`liveBranchOf`). */
  live: z.boolean(),
})

const RepositorySchema = z.object({
  project: z.string().min(1).max(200),
  /** Where it is checked out on this machine. */
  root: z.string().min(1).max(4096),
  /** What names it wherever it is checked out (`repositoryNamed`), or null with no origin. */
  repository: z.string().max(400).nullable(),
  /** The branch its work merges into, or null where none could be found. */
  base: z.string().regex(BRANCH).nullable(),
  /**
   * The commit that branch is on here, where it is a branch of this
   * checkout's own: what tells another machine its mirror of it is behind,
   * which no task's branch does where every agent works in the checkout.
   * Absent from an older Tade.
   */
  baseHead: z.string().regex(HEAD).nullable().optional(),
  branches: z.array(BranchSchema).max(BRANCHES_MOST),
  /**
   * This machine's mirror of the project, in its home, ready to be pushed
   * into; absent from an older Tade, or where it could not be made.
   */
  mirror: z.string().min(1).max(4096).optional(),
})

/**
 * The answer, as this machine gives it and another reads it: read for its
 * shape and nothing more — another field from a newer Tade is let be — and
 * every value bounded, because it was written on another machine.
 */
export const RepositoriesAnswerSchema = z.object({
  projects: z.array(RepositorySchema).max(REPOSITORIES_MOST),
})
export type RepositoriesAnswer = z.infer<typeof RepositoriesAnswerSchema>
export type RepositoryHere = RepositoriesAnswer['projects'][number]

/** The window's half: every open project with its root and branches, as status last looked. */
export type WebRepositories = () => Promise<readonly RepositoryHere[]>

/** The route. `repositories` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function repositoriesHere(
  req: IncomingMessage,
  repositories: WebRepositories | undefined,
): Promise<{ body: RepositoriesAnswer } | { refusal: Refusal }> {
  if (repositories === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  if (!z.strictObject({}).safeParse(got.body).success) return { refusal: refuse('malformed') }
  return { body: repositoriesFor(await repositories()) }
}

/** What a device is answered: every project, each within the bounds. */
export function repositoriesFor(all: readonly RepositoryHere[]): RepositoriesAnswer {
  const projects = all.slice(0, REPOSITORIES_MOST).map((one) => ({
    ...one,
    base: named(one.base),
    ...(one.baseHead === undefined
      ? {}
      : { baseHead: one.baseHead !== null && HEAD.test(one.baseHead) ? one.baseHead : null }),
    branches: one.branches
      .filter((branch) => BRANCH.test(branch.branch))
      .slice(0, BRANCHES_MOST)
      .map((branch) => ({
        ...branch,
        base: named(branch.base),
        head: branch.head !== null && HEAD.test(branch.head) ? branch.head : null,
      })),
  }))
  return { projects }
}

/** A branch name another machine can read back, or null: nothing it would refuse the whole answer over. */
function named(branch: string | null): string | null {
  return branch !== null && BRANCH.test(branch) ? branch : null
}
