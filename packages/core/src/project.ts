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

/**
 * What each project is called on screen, by its name — and only the ones that
 * have been given a name of their own.
 *
 * Every project is in `Config.projects` and most of them are called what they
 * are called, so this is a map of the exceptions rather than of everything: a
 * reader falls back to the name (`shownProject`), which is the same answer a
 * config written before this key existed gives.
 */
export function titlesOf(config: Config): Record<string, string> {
  const titles: Record<string, string> = {}
  for (const [name, project] of Object.entries(config.projects))
    if (project.title) titles[name] = project.title
  return titles
}

/**
 * What an agent does with its work once it is committed and green.
 *
 * Three answers, and they are the three the person asked for: nothing reaches
 * the remote, the branch it is on is pushed, or its own branch is pushed and a
 * review is opened on it. `never` is the default, so a Tade nobody has
 * configured behaves exactly as it did — agents commit and stop.
 *
 * It lives here rather than beside the schema because a value only means
 * anything against `workspaceFor`: `branch-and-review` needs a branch of the
 * agent's own, which is what `worktree` is, and in `checkout` there is none to
 * open a review for. That pairing is resolved once, in `pushFor`, and said.
 */
export const PUSH_MODES = ['never', 'branch', 'branch-and-review'] as const
export type PushMode = (typeof PUSH_MODES)[number]

/** What reaches the remote in a project, and why that is not what was asked for. */
export interface Pushes {
  /** What actually happens. */
  mode: PushMode
  /** What the config asked for, where that is not what happens; null when it is. */
  asked: PushMode | null
  /** Why they differ, in one sentence a person can act on; null when they do not. */
  problem: string | null
}

/**
 * Why a project cannot open a review for work its agents did, and the two ways
 * out of it.
 *
 * One sentence, written once, because it is read in three places somebody is
 * deciding: the Settings row where the mode is set, `tade_settings` where the
 * orchestrator reads the same row, and `tade config --check` for a file
 * somebody wrote by hand.
 */
export function pushNeedsABranch(project: string): string {
  return `${project} is set to push a branch and open a review on it, and its agents all work in its own checkout on the branch it is on — so none of them has a branch of its own to open one for, and nothing is pushed. Give ${project} a worktree each, or have it push the branch they are on instead.`
}

/**
 * What reaches the remote for one task: the project's own answer, or the
 * machine's, resolved against where that task actually works.
 *
 * The workspace is a parameter rather than read here, and that is the whole
 * care in this function: a task keeps the workspace it was made with
 * (`TaskFile.workspace`), so asking the config where an agent works would push
 * a review-opening agent into a shared checkout the moment somebody changed
 * the setting under it. Callers about to make a task pass `workspaceFor`;
 * callers about an existing one pass what its file says.
 *
 * Pure, total, and it only ever answers with *less*: the one pairing that
 * cannot hold resolves to `never` with the reason, never to a push nobody
 * asked for. Pushing straight to a shared branch when somebody asked for a
 * review is the one wrong answer here — it is more on the remote than they
 * asked for, not less.
 */
export function pushFor(config: Config, project: string | null, workspace: AgentWorkspace): Pushes {
  const asked = (project ? config.projects[project]?.push : undefined) ?? config.agents.push
  if (asked === 'branch-and-review' && workspace === 'checkout') {
    return { mode: 'never', asked, problem: pushNeedsABranch(project ?? 'this project') }
  }
  return { mode: asked, asked: null, problem: null }
}

/**
 * Every project whose push mode cannot mean what it says, as sentences.
 *
 * Read where a config is loaded, so a file somebody wrote by hand is told
 * rather than quietly doing nothing — a setting Tade accepts and ignores is
 * worse than one it does not have. A warning and never an issue: refusing the
 * file would take away everything else they wrote in it, and the answer this
 * resolves to is the safe one either way.
 */
export function pushProblems(config: Config): string[] {
  return Object.keys(config.projects).flatMap((name) => {
    const problem = pushFor(config, name, workspaceFor(config, name)).problem
    return problem ? [problem] : []
  })
}
