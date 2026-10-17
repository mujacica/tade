import { liveBranchOf, type Workspace } from '@tade/core'
import { repositoryAt, resolveBase } from '@tade/status'
import { inTime, type RepositoryHere, type WebRepositories } from '@tade/web'

// This machine's half of another machine's mirror of its work (`@tade/web`'s
// `repositories.ts`, REMOTE-TADE.md §9.3): every open project with where it is
// checked out, what names its repository, the branch its work merges into, and
// each task's own branch — out of status's last look, which already read every
// head, plus the two small questions status does not keep, each with a
// deadline. An owner on another machine asks, then fetches over the same SSH.

/** How long either question about a checkout may take before it is answered as unknown. */
const LOOK_MS = 5_000

/** The window's `WebRepositories`, over whatever status last looked at. */
export function repositoriesFrom(world: () => Workspace | null): WebRepositories {
  return async () => {
    const seen = world()
    if (seen === null) return []
    return Promise.all(seen.projects.map((project) => repositoryOf(project)))
  }
}

async function repositoryOf(project: Workspace['projects'][number]): Promise<RepositoryHere> {
  // Neither throws for anything git says; past the deadline, each is unknown.
  const [repository, base] = await Promise.all([
    inTime(repositoryAt(project.root), LOOK_MS, null),
    inTime(resolveBase(project.root), LOOK_MS, null),
  ])
  return {
    project: project.name,
    root: project.root,
    repository,
    base: base?.ref ?? null,
    // A task's own branch, and nothing of one in the shared checkout: its work
    // there is hunks nobody has committed, which no fetch can carry.
    branches: project.tasks.flatMap((task) => {
      const git = task.git
      if (task.workspace === 'checkout' || !git?.branch || git.mergedIntoBase) return []
      return [
        {
          task: task.id,
          branch: git.branch,
          base: git.baseRef,
          head: git.head,
          live: liveBranchOf(task),
        },
      ]
    }),
  }
}
