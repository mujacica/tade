import type { TaskState } from './model.ts'

// A change that spans repositories, and what it is made of.
//
// One intent, three repos, three branches, three reviews, an order between
// them. The unit is not a task with several workspaces — a lane has one `cwd`,
// a `Task` has one worktree and one git snapshot, `done: merged` has no
// meaning across three branches, and the `Tade-Task:` trailer would stop
// naming one history. So the unit is an *effort*: a name, the sentence
// somebody said, and one ordinary task per repository underneath it, each with
// its own branch, agent, checks, review and done rule exactly as tasks work
// today. Git, the forge port and the checks record learn no new word.
//
// It lives nowhere new. `TaskFile.effort` is one optional field, and an effort
// is the **fold of the task files that name it** — status already reads every
// task file in every project, so grouping is free, a removed task leaves the
// effort correctly smaller, and there is nothing to rebuild or keep in sync. A
// table would be wrong the moment somebody removed a task.
//
// And it has no state, deliberately: until every task in it has finished it
// has a *list*. "Two of three" is not something anybody can act on; which one
// is not, is. There is no effort-level done rule, merge, review or branch — a
// fourth rule above three rules is a rule that will eventually disagree with
// them, and nothing could say which was right.

/** One task's part in an effort, flat enough to say in a sentence. */
export interface EffortTask {
  task: string
  project: string
  state: TaskState
  finished: boolean
}

/** A change that spans repositories, folded out of the task files naming it. */
export interface Effort {
  /** Its slug, as the task files spell it. */
  name: string
  /** The repositories it reaches into, in the order they were found. */
  projects: string[]
  /** Its tasks, in id order. */
  tasks: EffortTask[]
  /** How many of them have finished, and how many there are. */
  finished: number
  /** What has not finished, which is the part anybody can act on. */
  unfinished: EffortTask[]
}

/**
 * The efforts among these tasks, by name. Tasks naming no effort are in none:
 * a group called "no effort" is noise in the common case where nothing has one.
 */
export function effortsIn(
  /**
   * What each task is, at its narrowest: an id, its project, what state it is
   * in and which effort it names. A `Task` from status fits, and so does a
   * snapshot the window already holds — a fold has no business asking for a
   * git snapshot and a list of lanes to count to three.
   */
  tasks: readonly { id: string; project: string; state: TaskState; effort?: string | undefined }[],
  /**
   * The tasks the journal says are finished (`finishedFrom`). A task is
   * finished when the journal says so and never because of what state it
   * happens to be in — that is the same rule everywhere else, and an effort
   * inventing a second one is how "two of three" would start disagreeing with
   * the ticks beside the tasks themselves. `merged` counts too: there is
   * nothing left for anybody to do with a branch that has landed.
   */
  finished: ReadonlySet<string> = new Set(),
): Effort[] {
  const by = new Map<string, EffortTask[]>()
  for (const task of tasks) {
    const name = task.effort
    if (!name) continue
    by.set(name, [
      ...(by.get(name) ?? []),
      {
        task: task.id,
        project: task.project,
        state: task.state,
        finished: finished.has(task.id) || task.state === 'merged',
      },
    ])
  }
  return [...by]
    .map(([name, found]) => {
      const inOrder = [...found].sort((one, other) => (one.task < other.task ? -1 : 1))
      const projects: string[] = []
      for (const one of inOrder) if (!projects.includes(one.project)) projects.push(one.project)
      return {
        name,
        projects,
        tasks: inOrder,
        finished: inOrder.filter((one) => one.finished).length,
        unfinished: inOrder.filter((one) => !one.finished),
      }
    })
    .sort((one, other) => (one.name < other.name ? -1 : 1))
}

/**
 * One effort in a sentence: how far along it is, and — the part worth saying —
 * which task is not finished. `2 of 3` is a number nobody can act on; the name
 * of the one still working is the whole of what anybody wants from it.
 */
export function effortSays(effort: Effort): string {
  const where = effort.projects.length > 0 ? ` (${effort.projects.join(', ')})` : ''
  const count = `${effort.finished} of ${effort.tasks.length} finished`
  if (effort.unfinished.length === 0) return `${effort.name}${where}: ${count}`
  const left = effort.unfinished
    .slice(0, 3)
    .map((one) => `${one.task} ${one.state}`)
    .join(', ')
  const more = effort.unfinished.length > 3 ? `, and ${effort.unfinished.length - 3} more` : ''
  return `${effort.name}${where}: ${count} — ${left}${more}`
}
