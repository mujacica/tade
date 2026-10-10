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
 * review is opened on it.
 *
 * It lives here rather than beside the schema because a value only means
 * anything against `workspaceFor`: `branch-and-review` needs a branch of the
 * agent's own, which is what `worktree` is, and in `checkout` there is none to
 * open a review for. That pairing is resolved once, in `pushFor`, and said —
 * and it is also why there is no one default (`pushDefault`).
 */
export const PUSH_MODES = ['never', 'branch', 'branch-and-review'] as const
export type PushMode = (typeof PUSH_MODES)[number]

/**
 * What a project that has said nothing does with finished work, which is a
 * different answer in each workspace.
 *
 * **Asked for in as many words**, and the reason it is a table rather than one
 * value: a worktree is a branch of the agent's own, nobody else is on it, and
 * work that sits there finished and unpushed is work nobody can see — so the
 * end of a worktree task is a branch pushed and a review opened on it. A
 * shared checkout has no such branch, every agent is on the one the project is
 * on, and a push there carries everybody's commits — so it stays `never`, and
 * pushing goes on being a person's.
 *
 * The two halves are the same rule read twice: **the default may only ever put
 * an agent's own work where somebody can read it, never anybody else's.** That
 * is what keeps this from being a resolver that answers with more than was
 * asked for — the one wrong answer `pushFor` has always refused is a shared
 * branch pushed by default, and this cannot reach one.
 *
 * Unset is a real state, which is the whole reason `agents.push` carries no
 * schema default: "nobody said" and "somebody said `never`" have to be two
 * different answers, or a person's deliberate refusal is indistinguishable
 * from a file written before any of this existed.
 */
const PUSH_DEFAULTS: Readonly<Record<AgentWorkspace, PushMode>> = {
  checkout: 'never',
  worktree: 'branch-and-review',
}

/** What finished work does where nobody has said: `PUSH_DEFAULTS`, read. */
export function pushDefault(workspace: AgentWorkspace): PushMode {
  return PUSH_DEFAULTS[workspace]
}

/**
 * Both defaults in one clause, for wherever there is room to say the whole
 * rule: the sentence beside the machine's own row, read on the Settings page
 * and in the orchestrator's listing of the same row. Where there is room for
 * one word instead — the field itself, `tade config`'s padded listing — that
 * word is `pushDefault`'s, and this is what explains it.
 */
export const PUSH_BY_DEFAULT = 'branch-and-review in a worktree, never in a shared checkout'

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
 * Three readings, narrowest first: what this project said, then what the
 * machine said, then `pushDefault` for the workspace in front of us. A value
 * anybody wrote wins over the default in both directions — `push: never` on a
 * project whose agents get a worktree each is a deliberate refusal and is kept
 * as one.
 *
 * Pure, total, and the one pairing that cannot hold resolves to `never` with
 * the reason, never to a push nobody asked for. Pushing straight to a shared
 * branch when somebody asked for a review is the one wrong answer here — it is
 * more on the remote than they asked for, not less — and no default can reach
 * it, because the `checkout` default is `never`.
 *
 * Nothing here pushes anything. The mode is words in an agent's prompt
 * (`pushTold`), said to an agent as it starts, so changing what this answers
 * reaches the next agent and never a branch somebody finished with last week.
 */
export function pushFor(config: Config, project: string | null, workspace: AgentWorkspace): Pushes {
  const said = (project ? config.projects[project]?.push : undefined) ?? config.agents.push
  const asked = said ?? pushDefault(workspace)
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
