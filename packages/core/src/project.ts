import type { AgentWorkspace, Config } from './config.ts'

// What one project answers for itself, with the machine's answer under it.
//
// Tade was built for one project at a time, so every "how does this work here"
// was a setting on the machine. It is not: somebody running two repositories
// daily wants agents side by side in the one where work is sequential, and a
// worktree each in the one where two unrelated efforts run at once — and both
// are true in the same window at the same moment. So the question is asked of
// a project, never of the machine, and the machine's setting is what a project
// that has not answered gets.
//
// Pure, and a resolution rather than a merge: what a project leaves unset it
// does not half-inherit. `checksFor` is the same shape and lives with the rest
// of checks; anything else that becomes a project's own answer belongs here.

/**
 * Where a project's agents work: its own answer, or the machine's.
 *
 * Read wherever a task is about to be made, a plan is about to be checked, or
 * a tree is about to be read for what agents have changed in it. Never read to
 * ask where a task that already exists works — that is written in the task's
 * own file, and it stays true if somebody changes this setting underneath it.
 */
export function workspaceFor(config: Config, project: string | null): AgentWorkspace {
  return (project ? config.projects[project]?.workspace : undefined) ?? config.agents.workspace
}
