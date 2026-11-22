import { liveBranchOf, mirrorDir, type Workspace } from '@tade/core'
import { readyMirror, repositoryAt, resolveBase } from '@tade/status'
import { inTime, type RepositoryHere, type WebRepositories } from '@tade/web'

// This machine's half of another machine's mirror of its work (`@tade/web`'s
// `repositories.ts`): every open project with where it is
// checked out, what names its repository, the branch its work merges into, and
// each task's own branch — out of status's last look, which already read every
// head, plus the two small questions status does not keep, each with a
// deadline. An owner on another machine asks, then fetches over the same SSH —
// and pushes its own branches into this machine's mirror of the project, which
// is made ready here once per window and named in the answer, so this machine
// can keep its checkout in step with work that machine never pushed to origin
// (`project-sync.ts`).

/** How long either question about a checkout may take before it is answered as unknown. */
const LOOK_MS = 5_000

/** The window's `WebRepositories`, over whatever status last looked at. */
export function repositoriesFrom(world: () => Workspace | null, home: string): WebRepositories {
  // Each project's mirror, made ready once while this window is open: by its root, which is what it borrows from.
  const ready = new Map<string, Promise<string | null>>()
  const mirrorOf = (project: Workspace['projects'][number]): Promise<string | null> => {
    const mirror = mirrorDir(home, project.name)
    const key = `${mirror}\0${project.root}`
    let made = ready.get(key)
    if (made === undefined) {
      // One that could not be made is asked again next time, not remembered as none.
      made = readyMirror(mirror, project.root).then(
        (problem) => {
          if (problem !== null) ready.delete(key)
          return problem === null ? mirror : null
        },
        (err: unknown) => {
          ready.delete(key)
          throw err
        },
      )
      ready.set(key, made)
    }
    return made
  }
  return async () => {
    const seen = world()
    if (seen === null) return []
    return Promise.all(seen.projects.map((project) => repositoryOf(project, mirrorOf)))
  }
}

async function repositoryOf(
  project: Workspace['projects'][number],
  mirrorOf: (project: Workspace['projects'][number]) => Promise<string | null>,
): Promise<RepositoryHere> {
  // None throws for anything git says; past the deadline, each is unknown.
  const [repository, base, mirror] = await Promise.all([
    inTime(repositoryAt(project.root), LOOK_MS, null),
    inTime(resolveBase(project.root), LOOK_MS, null),
    inTime(mirrorOf(project), LOOK_MS, null),
  ])
  return {
    ...(mirror === null ? {} : { mirror }),
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
