import { resolve } from 'node:path'
import {
  type Check,
  type CheckLog,
  type CheckRun,
  type ChecksRead,
  carryOver,
  followRenames,
  latestAt,
  planFor,
  type Runner,
  type RunningNow,
  readChecks,
  readRuns,
  rollup,
  runChecks,
  runningIn,
} from '@tade/checks-core'
import {
  type ChecksConfig,
  type Config,
  checksFor,
  expandHome,
  overrideFor,
  recordsDir,
  runsBefore,
  type TadeEvent,
} from '@tade/core'
import { makeRunner } from './runners.ts'

/**
 * Whether this directory is the project's own checkout, which every task in it
 * shares — so one lock and one history of runs, however many agents are in it.
 */
export function sharesCheckout(config: Config, project: string, worktree: string): boolean {
  const root = config.projects[project]?.root
  return root !== undefined && resolve(expandHome(root)) === resolve(worktree)
}

/**
 * Whose records a run in this worktree is: the task's where it has a worktree
 * of its own, and the project's where the worktree *is* the project's checkout.
 *
 * Asked of the directory rather than of the task, because that is what a run
 * is about: `checks_run` from four agents in one checkout must reach one lock.
 */
function whose(opts: {
  config: Config
  project: string
  worktree: string
  task?: string | null
}): string | null {
  if (!opts.task || sharesCheckout(opts.config, opts.project, opts.worktree)) return null
  return opts.task
}

// Running a project's own checks, and the rule about pushing without them.
//
// What the gate can honestly do is the whole design here. A push an agent
// makes is seen by the supervisor only under `approvals.mode: 'policy'`;
// under the default nothing can be held, and a person typing `git push` in a
// terminal is nobody's to hold. So the gate never runs anything itself — it
// reads what is recorded for the commit in hand, which is instant, and
// refuses a push that has no green run behind it with what is missing and
// the one call that fixes it. Holding a tool call for the three minutes a
// suite takes is the thing that would break the agent, not the thing that
// would protect the branch.

export interface ProjectChecks {
  /** What this project says it checks, read out of its CI and its commit hook. */
  read: ChecksRead
  /** What would run for this commit, in order. */
  plan: Check[]
  /** Every run recorded in this worktree, oldest first. */
  runs: CheckLog[]
  /** The newest run of each check at the commit in hand. */
  at: CheckRun[]
  /**
   * Of those, the ones recorded against an earlier commit that still stand,
   * because what they read is byte-for-byte what this commit holds.
   */
  carried: ReadonlySet<string>
  rollup: ReturnType<typeof rollup>
  rule: ChecksConfig
  /**
   * A run going on in this worktree now, whoever started it — this window's
   * button, an agent's tool call, `tade check` in a terminal. Null when
   * nothing is running, which includes a window that died holding the file.
   */
  running: RunningNow | null
}

/** What a project checks, and how that stands at a commit. Files only: no processes. */
export async function checksAt(opts: {
  config: Config
  project: string
  worktree: string
  /** Tade's own home, where what ran in this worktree is written down. */
  tadeHome: string
  /** The task whose worktree this is, where it has one of its own. */
  task?: string | null
  commit: string | null
  changed?: readonly string[]
}): Promise<ProjectChecks> {
  const rule = checksFor(opts.config, opts.project)
  const read = await readChecks({
    name: opts.project,
    root: opts.worktree,
    test: opts.config.projects[opts.project]?.test_command,
    chosen: rule.run_here,
  })
  const plan = planFor(read.checks, {
    ...(opts.changed ? { changed: opts.changed } : {}),
    only: rule.only,
  })
  // A run recorded under a step's earlier name still speaks for it where it
  // ran the same command, so retitling a step costs no history.
  const records = recordsDir(opts.tadeHome, opts.project, whose(opts))
  const runs = followRenames(read.checks, await readRuns(records))
  // A run is about a tree, not a commit id: one taken just before the commit
  // that holds exactly what it read still speaks for it. Anything else — a
  // partial commit, somebody else's file caught in the run — does not.
  const at = await carryOver(opts.worktree, runs, opts.commit)
  return {
    read,
    plan,
    runs,
    at: latestAt(runs, at),
    carried: at.carried ?? new Set(),
    rollup: rollup(plan, runs, at),
    rule,
    running: await runningIn(records),
  }
}

/** Run a project's checks here, the way Tade runs them: one at a time, written down. */
export async function runProjectChecks(opts: {
  config: Config
  project: string
  worktree: string
  /** The task whose worktree this is, where it has one of its own. */
  task?: string | null
  commit: string
  by: string
  /** $HOME, so a tail says `~` rather than where you live. */
  home: string
  /** Tade's own home, where what ran here is written down. */
  tadeHome: string
  only?: readonly string[]
  changed?: readonly string[]
  runner?: Runner
  signal?: AbortSignal
  waitMs?: number
  onRun?: (run: CheckRun) => void
  onOutput?: (check: string, chunk: string) => void
}): Promise<CheckLog[]> {
  const rule = checksFor(opts.config, opts.project)
  const read = await readChecks({
    name: opts.project,
    root: opts.worktree,
    test: opts.config.projects[opts.project]?.test_command,
    chosen: rule.run_here,
  })
  const only = opts.only?.length ? opts.only : rule.only
  const plan = planFor(read.checks, {
    ...(opts.changed ? { changed: opts.changed } : {}),
    only,
  })
  const runner = opts.runner ?? makeRunner('local', { parallel: rule.parallel })
  return runChecks({
    runner,
    project: { name: opts.project, root: opts.worktree },
    records: recordsDir(opts.tadeHome, opts.project, whose(opts)),
    checks: plan,
    commit: opts.commit,
    by: opts.by,
    home: opts.home,
    keep: rule.keep,
    waitMs: opts.waitMs ?? 0,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onRun ? { onRun: opts.onRun } : {}),
    ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
  })
}

/** What a tool call is, as far as this rule cares. */
export function pushOrCommit(
  tool: string,
  input: Readonly<Record<string, unknown>>,
): 'push' | 'commit' | null {
  const command = ['command', 'script', 'cmd']
    .map((key) => input[key])
    .find((value): value is string => typeof value === 'string' && value !== '')
  if (!command) return null
  if (/\bgit\b[^;&|]*\bpush\b/.test(command)) return 'push'
  if (/\bgit\b[^;&|]*\bcommit\b/.test(command)) return 'commit'
  void tool
  return null
}

/** What the gate says about one call: let it through, or refuse it with why. */
export type GateAnswer = { allow: true; note?: string } | { allow: false; reason: string }

export interface GateCall {
  task: string | null
  project: string | null
  worktree: string
  tool: string
  input: Readonly<Record<string, unknown>>
}

export interface GateOptions {
  config: Config
  /** Tade's own home, where what ran in a worktree is written down. */
  tadeHome: string
  /** The journal, for the overrides written in it. Read, never remembered. */
  events: () => Promise<readonly TadeEvent[]>
  /** The commit the worktree is on, so a run can be matched to it. */
  head: (worktree: string) => Promise<string | null>
  now?: () => number
}

/**
 * The rule, as a question the supervisor asks before it lets a push or a
 * commit through: is there a green run of this project's required checks at
 * the commit in hand?
 */
export function checksGate(options: GateOptions): (call: GateCall) => Promise<GateAnswer> {
  const now = options.now ?? Date.now
  return async (call) => {
    const what = pushOrCommit(call.tool, call.input)
    if (!what || !call.project) return { allow: true }
    const rule = checksFor(options.config, call.project)
    if (!runsBefore(rule, what)) return { allow: true }
    const commit = await options.head(call.worktree)
    const stood = await checksAt({
      config: options.config,
      project: call.project,
      worktree: call.worktree,
      tadeHome: options.tadeHome,
      task: call.task,
      commit,
    })
    if (stood.plan.length === 0) return { allow: true }
    if (stood.rollup.state === 'pass') return { allow: true }

    const said = [
      stood.rollup.failed.length > 0
        ? `${stood.rollup.failed.join(', ')} failed at this commit`
        : '',
      stood.rollup.missing.length > 0
        ? `${stood.rollup.missing.join(', ')} ${stood.rollup.missing.length === 1 ? 'has' : 'have'} not run at this commit`
        : '',
    ]
      .filter(Boolean)
      .join('; ')

    // Somebody said to let it through anyway, and said why: their word, read
    // back out of the journal, and the orchestrator hears what they said.
    const override = overrideFor(await options.events(), {
      task: call.task,
      project: call.project,
      now: now(),
    })
    if (override) {
      return {
        allow: true,
        note: `${said}, and ${override.by} overruled the rule: ${override.reason}`,
      }
    }
    if (rule.on_red !== 'hold') return { allow: true, note: said }
    const failing = stood.at.find((run) => stood.rollup.failed.includes(run.check))
    const tail = failing ? tailOf(stood.runs, failing) : ''
    return {
      allow: false,
      reason: [
        `${said}. Run them with checks_run and fix what is red before pushing.`,
        tail ? `\n\nWhat it said:\n${tail}` : '',
        '\n\nIf you are certain the failure is not yours, call checks_override with the reason and try again.',
      ].join(''),
    }
  }
}

function tailOf(runs: readonly CheckLog[], run: CheckRun): string {
  const found = [...runs].reverse().find((one) => one.id === run.id)
  return (found?.tail ?? '').split('\n').slice(-20).join('\n')
}
