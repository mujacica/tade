import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Where Tade's own files are, which is a different question from what is in
// them. Four answers, and nothing here reads or writes anything: they are the
// paths the rest of the house joins onto, and `TADE_HOME` is the one override,
// so a test can point the whole of Tade at a temp directory by setting it.

/**
 * Where sockets for this home go.
 *
 * Not in the home itself: a Unix socket path is capped near 104 bytes, and a
 * home under a temp directory or a deep checkout blows that — which shows up as
 * an agent that will not start, for a reason no user could act on. These are
 * runtime files with no value after a restart, so somewhere short and
 * disposable is also the honest place for them.
 */
export function runtimeDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR || tmpdir()
  return join(base, `tade-${createHash('sha1').update(home).digest('hex').slice(0, 8)}`)
}

/** Root of Tade's per-user state. `TADE_HOME` overrides for tests. */
export function tadeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TADE_HOME ?? join(homedir(), '.tade')
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(tadeHome(env), 'config.yaml')
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

// Where everything Tade writes *about a project* goes, which is a different
// question again — and the answer is "not in the project".
//
// It used to be `.tade/` in the checkout, which meant every repository Tade
// touched needed a `.gitignore` line before the first task file was written,
// or somebody pushed a branch carrying another person's screenshots. The line
// worked, and it was still a file Tade edited in somebody else's repository to
// undo a mess Tade had made. Nothing Tade writes is the project's — a task
// file is what one person asked for, a check run died with the worktree it ran
// in, an attachment is a screenshot off one clipboard — so none of it was ever
// inside the repository for a reason. Here it needs no rule, no exception and
// no permission, and a project Tade has never worked in looks exactly like one
// it has.

/** The folder under the home that holds one folder per project. */
export const PROJECTS_DIR = 'projects'

/** Everything Tade writes about one project, by the name the config gives it. */
export function projectDir(home: string, project: string): string {
  return join(home, PROJECTS_DIR, project)
}

/**
 * The folder name a task keeps its files in, from its id.
 *
 * The project is already the folder above, so only what follows it is left —
 * flattened, because a task id may carry slashes and a folder per level would
 * make `tasks/a/b` and the task `a` indistinguishable.
 */
export function taskFolder(id: string): string {
  return id.split('/').slice(1).join('-')
}

/** Everything Tade writes about one task: its file, its context, its attachments. */
export function taskDir(home: string, id: string): string {
  return join(projectDir(home, id.split('/')[0] ?? ''), 'tasks', taskFolder(id))
}

/**
 * Where what Tade records *about a directory* goes — check runs, the run lock,
 * what is running now.
 *
 * A task with a worktree of its own is the only thing in it, so its records are
 * its own; every task in the project's own checkout shares the directory, so
 * they share the project's. That is the same answer as before, written the same
 * way round: one directory, one set of records.
 */
export function recordsDir(home: string, project: string, task?: string | null): string {
  return task ? taskDir(home, task) : projectDir(home, project)
}
