// Another machine's work in a repository this machine has a project of
// (REMOTE-TADE.md §9.3, §9.5).
//
// One repository may be a project on two machines — two checkouts, two homes,
// two journals, never merged — and the work on each is still one repository's
// work: a branch on the VPS and a branch here can collide when both land. So
// this machine keeps a **mirror** of each such project in its own home
// (`mirrorDir`): a bare repository that borrows the project's own objects as
// alternates and holds what the other machines added, fetched over the link
// this machine already holds to each. The forecast merges in it, the landing
// desk and the patch reader read in it, and **nothing is written into the
// person's checkout** — the alternates are only ever read.
//
// Pure: what is handed between the window, status and the drawing, and the
// rules for it. The git is `status/src/mirror.ts`'s; the asking is the window's.

/** One branch another machine is working on, in a repository this machine has a project of. */
export interface ElsewhereBranch {
  /** The machine it is on: its `remotes.<name>` here. */
  machine: string
  /** Its task's id there, in that machine's own names: `<project>/<task>`. */
  task: string
  /** The branch there. */
  branch: string
  /** The commit it is on, as this machine's mirror holds it — never only as that machine said. */
  head: string
}

/** What one project here is handed of other machines' live work: the mirror, and their branches. */
export interface Elsewhere {
  /** The mirror in this home that holds their commits beside this checkout's (`mirrorDir`). */
  mirror: string
  branches: readonly ElsewhereBranch[]
}

/** One branch a machine says it has, as its owner answer gave it (`web`'s `repositories.ts`). */
export interface BranchThere {
  task: string
  branch: string
  /** Where its work is measured from there: `main`, or the branch it is stacked on. */
  base: string | null
  /** The commit it is on there, as that machine last looked. */
  head: string | null
  /** Live work a merge could collide over, by that machine's own rule (`liveBranchOf`). */
  live: boolean
}

/** Where a machine keeps another machine's branches in a mirror: one namespace per machine. */
export function mirrorRef(machine: string, branch: string): string {
  return `refs/remotes/${machine}/${branch}`
}

/**
 * Whether two checkouts are one repository: both name one, and it is the
 * same name — host, owner and repository, as `repositoryNamed` (status) reads
 * it out of each one's `origin`. Never a guess from what a project is called:
 * two projects called `api` on two machines are as likely two repositories.
 */
export function sameRepository(here: string | null, there: string | null): boolean {
  return here !== null && there !== null && here === there
}

/**
 * Whether the mirror has to be fetched into before it can answer for a
 * machine's branches: one of them is on a commit the mirror does not hold
 * under its name. Nothing moved there is nothing fetched.
 */
export function fetchDue(
  machine: string,
  branches: readonly BranchThere[],
  heads: ReadonlyMap<string, string>,
): boolean {
  return branches.some(
    (one) => one.head !== null && heads.get(mirrorRef(machine, one.branch)) !== one.head,
  )
}

/**
 * The machine's live branches the forecast may merge: each live by that
 * machine's rule, and **only on the commit the mirror holds** for it — a head
 * the mirror has not got yet is a merge git cannot make, and a merge against
 * an older commit than the one there is a forecast about work that has moved.
 */
export function liveThere(
  machine: string,
  branches: readonly BranchThere[],
  heads: ReadonlyMap<string, string>,
): ElsewhereBranch[] {
  const out: ElsewhereBranch[] = []
  for (const one of branches) {
    const held = heads.get(mirrorRef(machine, one.branch))
    if (!one.live || held === undefined || held !== one.head) continue
    out.push({ machine, task: one.task, branch: one.branch, head: held })
  }
  return out.sort((a, b) => a.task.localeCompare(b.task))
}
