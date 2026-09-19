// The Runner port: what runs a project's own checks here, on this machine,
// before anybody else has to look at them.
//
// A check is a named unit of verification a project defines — `format`,
// `types`, `tests` — and it is the same noun whether it ran here or on a
// forge: one shape, or the window draws two things that mean one. What ran is
// a `CheckRun`, always against a named commit, because a run that does not say
// which commit it checked says nothing about this one.
//
// Vocabulary rule (R2): "workflow", "job", "step", "pipeline" and "action" are
// GitHub's, GitLab's and Buildkite's words and appear only inside an
// implementation. On screen a person still reads their own, by declaration:
// every runner carries `words`.

/** A project, as this port needs it: where its checks run. */
export interface ProjectRef {
  name: string
  /** Absolute: the worktree the checks run in, which is a task's in `worktree` mode. */
  root: string
  /** The one command the config has always had, for a project with nothing else written down. */
  test?: string | undefined
}

/** A named unit of verification a project defines. Ids are stable: CI names its steps after them. */
export interface Check {
  /** `format`, `types`, `tests`. Lowercase, dashes; unique in a project. */
  id: string
  /** What it checks, as a person says it: "Formatting and lint". */
  title: string
  /** The command line, run through a shell, in the worktree. Exactly what CI runs. */
  run: string
  /**
   * It needs the machine to itself: nothing else of ours runs beside it.
   * Tade's own suite is the reason this exists — the tests spawn real git and
   * PTY processes with short timeouts, and anything CPU-heavy beside them
   * starves them into what looks exactly like a regression and is not one.
   */
  alone: boolean
  /** Stopped and called `timed out` after this long. */
  minutes: number
  /** Merging waits on it. A check that is not required is run and reported, never held on. */
  required: boolean
  /** Only when one of these paths changed since the base; always, when empty. */
  when?: readonly string[]
  /** Checks that must have passed first. A cycle is a config error, caught before anything runs. */
  needs?: readonly string[]
  /** Why it cannot be run here, when it cannot: `needs CI`. Planned, reported, never ticked. */
  skip?: string
}

export type CheckState =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'timed out'

export const CHECK_STATES: readonly CheckState[] = [
  'queued',
  'running',
  'passed',
  'failed',
  'skipped',
  'cancelled',
  'timed out',
]

/** Whether nothing more will happen to a run in this state. */
export function settled(state: CheckState): boolean {
  return state !== 'queued' && state !== 'running'
}

/** Where a run happened. `here` is this machine; a forge names itself and its run. */
export type RunPlace =
  | { kind: 'here'; runner: string; host: string }
  | { kind: 'forge'; forge: string; job: string; url: string | null }

/** What was at a path: the blob git would store there, and the mode. Both null where nothing was. */
export interface CoveredPath {
  path: string
  oid: string | null
  /** `100644`, `100755`. Null where nothing was there. */
  mode: string | null
}

/**
 * What a run actually read, which is a tree and not a commit id.
 *
 * A run is recorded against the commit that was checked out, but what the
 * commands read is the worktree: that commit's tree, with whatever differed
 * from it on disk. Recording both is what lets a run still speak for the
 * commit made right after it — see `coverage.ts` for when it does.
 */
export interface Covered {
  /** The tree of the commit the run ran at. */
  tree: string
  /** Tracked paths whose bytes on disk differed from that tree, and what was there. Sorted. */
  dirty: readonly CoveredPath[]
  /** Untracked, unignored files that were also on disk, as far as they were read. Sorted. */
  untracked: readonly CoveredPath[]
}

/** One run of one check against one commit. The same shape wherever it ran. */
export interface CheckRun {
  /** Stable for the life of the run, so a row does not jump: `<commit>:<check>:<where>:<n>`. */
  id: string
  check: string
  /** The commit it ran against. A run that does not name this commit says nothing about it. */
  commit: string
  state: CheckState
  where: RunPlace
  /** Whether merging waits on it, as the project or the forge says. */
  required: boolean
  startedAt: string | null
  finishedAt: string | null
  /** Exit status, where there was one. */
  code: number | null
  /** One line for a person: "8 failed", "2 files need formatting". Never invented. */
  summary: string | null
  /** Who asked: an agent's task, the orchestrator, you, a rule, or the forge. */
  by: string | null
  /**
   * The bytes it read, where anybody looked: what makes a run still true of a
   * commit that came after it. Absent on a forge's run, and on every run
   * recorded before this was written down — and absent means the run says
   * nothing about any commit but its own.
   */
  covered?: Covered | null
}

/** A run with what it printed. Kept as a tail, scrubbed; never the whole log. */
export interface CheckLog extends CheckRun {
  tail: string
}

/** What a runner can do here, declared. Never inferred from its id. */
export interface RunnerCapabilities {
  /** Runs steps in the container the project's CI names, rather than on this machine. */
  containers: boolean
  /** Service containers — a database a check needs. */
  services: boolean
  /** Can run the same check across the OS or version matrix CI uses. */
  matrix: boolean
  /** Can supply secrets. Off means: a check that needs one is `skipped`, and says so. */
  secrets: boolean
  /** A run can be stopped; without it, an abort is refused rather than obeyed. */
  cancel: boolean
  /** How close to CI this is, for the sentence the window puts beside a green tick. */
  fidelity: 'the commands' | 'the container'
}

export type RunnerTrouble =
  /** The runner needs something that is not here: Docker, `act`. */
  | 'unavailable'
  /** No such check in this project. */
  | 'unknown'
  /** Something is already running here, and this one needs the machine. */
  | 'busy'
  /** A capability is false and it was called anyway. */
  | 'unsupported'
  /** The plan cannot run: a cycle, a check with no command. */
  | 'refused'

/** How running checks fails. Kinds, not strings, because callers act differently on each. */
export class RunnerError extends Error {
  readonly trouble: RunnerTrouble
  /** What the tool itself said, unchanged, for the human. */
  readonly said?: string

  constructor(trouble: RunnerTrouble, message: string, said?: string) {
    super(message)
    this.name = 'RunnerError'
    this.trouble = trouble
    if (said !== undefined) this.said = said
  }
}

/** What a run is asked for with: the commit it is about, who asked, and how to watch it. */
export interface RunContext {
  commit: string
  by: string
  signal: AbortSignal
  /** Called on every state change, terminal one included. */
  onRun(run: CheckRun): void
  /** Output as it arrives, so a run can be watched while it runs. */
  onOutput(check: string, chunk: string): void
}

export interface Runner {
  /** Registered under this: `local`, `act`, `scripted`. */
  readonly id: string
  readonly capabilities: RunnerCapabilities
  readonly words: { one: string; many: string }
  /**
   * Whether it can run here, and if not, what to do about it — "install Docker
   * and start it". Null when it can. Never throws, never touches the network.
   */
  ready(project: ProjectRef): Promise<string | null>
  /**
   * What would run for this commit, in order, and what each waits on. Pure
   * apart from reading the project's files: no processes, no network. This is
   * what the window draws before anything has run.
   */
  plan(project: ProjectRef, at: { commit: string; changed: readonly string[] }): Promise<Check[]>
  /**
   * Run them, reporting every state change as it happens — a run nobody can
   * watch while it runs is a progress bar that only appears when it is over.
   * Honours the signal: cancelling kills the process group, because everything
   * Tade starts is detached and a group signal is the only thing that reaches
   * a `pnpm` child.
   */
  run(project: ProjectRef, checks: readonly Check[], ctx: RunContext): Promise<readonly CheckLog[]>
}

/** What a runner is made with: how many at once, and how much of a log to keep. */
export interface RunnerOptions {
  /** How many checks may run at once here. A check marked `alone` still runs by itself. */
  parallel?: number
  /** Characters of output kept per run. */
  tail?: number
  /** The machine's home, so a tail says `~` rather than where you live. */
  home?: string
  /** This machine's name, for `where`. */
  host?: string
  now?: () => number
}
