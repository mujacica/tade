import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { type Reach, sees } from './reach.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs, reachOf } from './surface.ts'

// Where this machine's projects are checked out, and the branches their work
// is on: what another machine of the person's needs to fetch that work into a
// mirror of its own (REMOTE-TADE.md §9.3) — for its conflict forecast.
//
// **An owner's, and only at this machine's own door** (`here` in `routes.ts`):
// the answer names a path on this machine for each project, which no row a
// phone reads ever holds (`input.ts`). What makes it no wider than what
// already was is who may ask and where: an owner is the SSH key (`owner.ts`),
// this machine's own door from anywhere else is that same SSH connection, and
// the fetch it is for goes over it too — whoever holds the key can already
// `ssh` in and `cd` there. A phone's session is refused it however much it was
// granted (`out_of_scope`), and the public listener answers the `404` of a
// path nobody built — **but the person's own** (`Route.theirs`, `theirsOf`),
// on any door, because a path on their own machine is theirs to be told; off
// this machine's door it is asked a trusted origin and the passkey. Within
// what the device reads: a project the window took back from it is left out.
//
// **No credential in it.** What names each repository is `repositoryNamed`'s
// answer — `github.com/owner/name` — never the remote URL, which may hold one.
// It changes nothing and writes nothing.

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
  branches: z.array(BranchSchema).max(BRANCHES_MOST),
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
  device: Device,
  repositories: WebRepositories | undefined,
): Promise<{ body: RepositoriesAnswer } | { refusal: Refusal }> {
  if (repositories === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  if (!z.strictObject({}).safeParse(got.body).success) return { refusal: refuse('malformed') }
  return { body: repositoriesFor(await repositories(), reachOf(device)) }
}

/** What one device is answered: the projects it reads, each within the bounds. */
export function repositoriesFor(all: readonly RepositoryHere[], reach: Reach): RepositoriesAnswer {
  const projects = all
    .filter((one) => sees(reach, one.project))
    .slice(0, REPOSITORIES_MOST)
    .map((one) => ({
      ...one,
      base: named(one.base),
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
