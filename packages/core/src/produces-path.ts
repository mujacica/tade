import { isAbsolute, join, relative } from 'node:path'
import { taskDir, taskDocumentsDir } from './home.ts'

// Where a task's document is on this machine's disk. Apart from `produces.ts`,
// which says what a document is and what has happened to it, because that half
// is drawn in the window — in a browser too (`@tade/core/pure`) — and this half
// is a path in Tade's home.

/**
 * Where the document a task produces goes: the task's folder in the project's
 * documents folder in Tade's home (`taskDocumentsDir`), under the name the task
 * gave it. Removing the task leaves it there.
 *
 * The one reader, so the sentence its agent is told, the path written on
 * `task_done` and the file Tade looks for are one string rather than three
 * that agree today. A name `producesProblem` refuses is not one to join onto a
 * path, so every caller checks first (`createTask`, `checkPlan`,
 * `producedDetail`, and the agent's own prompt).
 */
export function producesPath(home: string, task: string, produces: string): string {
  return join(taskDocumentsDir(home, task), produces.trim())
}

/**
 * Where a document written before documents outlived their tasks belongs now,
 * or null when `path` is not one: a path inside the task's own folder is where
 * every document used to go, and the same name under the task's documents
 * folder is where it is kept from now on.
 *
 * The one rule for both moves — every finished one on the next open, and an
 * agent's still in progress at the moment its task is removed — so the two
 * cannot disagree about where a document went.
 */
export function documentMovedTo(home: string, task: string, path: string): string | null {
  const inside = relative(taskDir(home, task), path)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null
  return join(taskDocumentsDir(home, task), inside)
}
