import { z } from 'zod'

// The object model. These schemas are the single source of truth for the shape
// of a Task: the CLI, the RPC layer and the orchestrator's tool definitions
// all derive from them.
//
//   Workspace  one machine, one TADE_HOME
//   └ Project  a repo root + brief + preferences
//     └ Task   an intent + branch + worktree   ← what you talk about
//       └ Lane one PTY: agent | server | tests | shell
//         └ Run one agent session

export const TaskState = z.enum([
  'queued',
  'working',
  'blocked',
  'review',
  'merged',
  'failed',
  'parked',
])
export type TaskState = z.infer<typeof TaskState>

export const LaneKind = z.enum(['agent', 'server', 'tests', 'shell', 'terminal'])
export type LaneKind = z.infer<typeof LaneKind>

/** `<project>/<task>`, e.g. `checkout/stripe-v15`. */
export const TaskId = z.string().regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/)
export type TaskId = z.infer<typeof TaskId>

/** `<project>/<task>/<lane>`. */
export const LaneId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9-]*$/)
export type LaneId = z.infer<typeof LaneId>

/**
 * How a task counts as finished, which is what work waiting on it waits for.
 * Chosen when the task is made, by whoever knows the work; anyone can mark a
 * task finished by hand, whatever its rule.
 */
export const DONE_RULES = ['said', 'idle', 'committed', 'merged', 'manual'] as const
export type DoneRule = (typeof DONE_RULES)[number]

/** What each rule means, in the words the orchestrator is offered them in. */
export const DONE_RULE_MEANS: Readonly<Record<DoneRule, string>> = {
  said: 'its agent says so',
  idle: 'its agent ends a turn with nothing waiting',
  committed: 'its agent stops with everything committed',
  merged: 'its branch is merged into the base',
  manual: 'somebody marks it finished',
}

/**
 * When a task that was asked for now should start: after other tasks finish,
 * not before a time, or both. A task with one is queued work — made, named and
 * waiting — until Tade starts its agent.
 */
export const StartCondition = z.object({
  /** The tasks it waits on, each with why: it starts once every one has finished. */
  after: z.array(z.object({ task: TaskId, why: z.string().default('') })).default([]),
  /** Not before this moment, as an ISO time. */
  at: z.string().optional(),
  /** What its agent is told when it starts. */
  prompt: z.string().default(''),
  /** What it is expected to change, as whoever planned it read the code. */
  touches: z.array(z.string()).default([]),
  /** The model to start it on, when one was named for the work. */
  model: z.object({ provider: z.string().optional(), id: z.string() }).optional(),
  /** How hard it thinks from its first turn, when that was chosen. */
  thinking: z.string().optional(),
})
export type StartCondition = z.infer<typeof StartCondition>

/**
 * `task.yaml` in the task's own folder in Tade's home (`taskDir`), written
 * once when the task is created. `intent_spoken` is stored verbatim.
 */
export const TaskFile = z.object({
  id: TaskId.optional(),
  project: z.string().min(1),
  intent_spoken: z.string(),
  created: z.coerce.date(),
  /** Commit the task branched from; lets a fast-forward merge be told apart from "no commits yet". */
  base: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
  parked: z.boolean().default(false),
  lanes: z.array(z.string()).default([]),
  /**
   * What the agent's work is called, once there is something to call it: the
   * name you gave its session, or the start of the first thing you asked it.
   */
  title: z.string().optional(),
  /** The title is one a person chose, so nothing renames it. */
  title_named: z.boolean().optional(),
  /**
   * Where the work came from and where to read about it — an issue, a trace —
   * put there by whoever started it, so an agent and a person both find it.
   */
  links: z.array(z.object({ title: z.string(), url: z.string() })).default([]),
  /** Where the agent works: the project's own checkout, or a worktree of its own. */
  workspace: z.enum(['checkout', 'worktree']).optional(),
  /**
   * The change this task is one repository's share of, by its slug. An effort
   * is nothing but the fold of the task files that name it — no table, no
   * registry — so removing a task leaves the effort correctly smaller and
   * there is never anything to keep in sync.
   */
  effort: z.string().optional(),
  /** The harness its agent runs in, when it is not the route's. */
  harness: z.string().optional(),
  /** The account its agent runs as, when it is not its harness's usual one. */
  account: z.string().optional(),
  /** Who asked for it (see `TaskOrigin`). Absent on tasks made before this was kept. */
  by: z.string().optional(),
  /** How it counts as finished; `said` unless chosen. */
  done: z.enum(DONE_RULES).optional(),
  /**
   * What it produces that is not a change to the code: a document of this name,
   * in the task's own folder in Tade's home (`producesPath`) and never in the
   * repository. Named when the task is made, by whoever asked for the plan, the
   * audit or the analysis — so that when the task finishes, the path goes with
   * the summary and whoever reads it can read the document rather than be told
   * one exists.
   *
   * A plain string and not refused by the schema: `producesProblem` refuses a
   * bad one where a task is made and again where the journal records it, and a
   * hand-edited file with nonsense in this field must not stop the whole task
   * file parsing.
   */
  produces: z.string().optional(),
  /** When it starts, for work asked for now and started later. */
  start: StartCondition.optional(),
})
export type TaskFile = z.infer<typeof TaskFile>

/**
 * Who asked for a task, as the task file and the journal say it: `you`,
 * `orchestrator`, `extension:<name>`, `schedule:<name>` or `intake:<source>`.
 * A string rather than an object so it reads the same in the journal as it does
 * in a file.
 *
 * **`intake` is its own kind and not a schedule**, which is the whole point of
 * it: a ticket a colleague filed arriving as `schedule:intake.github` makes
 * "who asked" wrong in the window, in the journal and in everything folded out
 * of either. What it does *not* do is make the requester an authority — who the
 * source said asked is a handle, and what allowed the work is the owner's own
 * grant, recorded on `intake_accepted`.
 */
export type TaskOrigin = {
  kind: 'you' | 'orchestrator' | 'extension' | 'schedule' | 'intake'
  name: string
}

/** A task's `by`, read back. Anything unrecognised — or nothing — was you. */
export function taskOrigin(by: string | null | undefined): TaskOrigin {
  if (by === 'orchestrator') return { kind: 'orchestrator', name: 'orchestrator' }
  const [kind, ...rest] = (by ?? '').split(':')
  const name = rest.join(':')
  if ((kind === 'extension' || kind === 'schedule' || kind === 'intake') && name) {
    return { kind, name }
  }
  return { kind: 'you', name: 'you' }
}

/** Write an origin the way `taskOrigin` reads it. */
export function saidBy(origin: TaskOrigin): string {
  return origin.kind === 'you' || origin.kind === 'orchestrator'
    ? origin.kind
    : `${origin.kind}:${origin.name}`
}

/** The harnesses there are, and what each is, for choosing between them. */
export const HARNESS_CHOICES: readonly {
  id: string
  title: string
  about: string
  /** Offered to choose: false for one that is coming but cannot run yet. */
  ready: boolean
}[] = [
  { id: 'pi', title: 'pi', about: 'the pi coding agent, supervised by Tade', ready: true },
  {
    id: 'claude-code',
    title: 'Claude Code',
    about: 'the official claude, signed in with your own account, supervised by Tade',
    ready: true,
  },
  {
    id: 'codex',
    title: 'Codex',
    about: 'the official codex, signed in with your own account, supervised by Tade',
    ready: true,
  },
]

/**
 * Where a review stands, in the forge port's neutral words rather than any
 * one forge's: GitHub shouts `MERGED`, GitLab says merge request, Gerrit says
 * change. `draft` is a review that says it is not finished being argued with.
 */
export const ReviewState = z.enum(['draft', 'open', 'merged', 'closed'])
export type ReviewState = z.infer<typeof ReviewState>

export const GitSnapshot = z.object({
  branch: z.string().nullable(),
  head: z.string().nullable(),
  headSubject: z.string().nullable(),
  headTime: z.number().nullable(),
  /** Paths with staged, unstaged or untracked changes. */
  dirty: z.array(z.string()),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  baseRef: z.string().nullable(),
  /** HEAD moved past `base` and is now contained in the base branch. */
  mergedIntoBase: z.boolean(),
  upstreamGone: z.boolean(),
  /** The review this branch is out for, when there is one. */
  pr: z.object({ state: ReviewState, url: z.string() }).nullable(),
})
export type GitSnapshot = z.infer<typeof GitSnapshot>

export const TurnState = z.enum(['running', 'idle', 'unknown'])
export type TurnState = z.infer<typeof TurnState>

/**
 * One agent attached to a task, however it was found: a Tade lane, or a
 * session adopted from a provider's transcript files.
 */
export const AgentSignal = z.object({
  /**
   * `lane` is a PTY Tade opened, `run` a supervised agent it is driving, and
   * `adopted` a session someone started outside Tade entirely.
   */
  source: z.enum(['lane', 'run', 'adopted']),
  provider: z.string(),
  sessionId: z.string(),
  /** Process liveness; `null` when unknowable (adopted sessions). */
  alive: z.boolean().nullable(),
  lastActivityAt: z.number().nullable(),
  turn: TurnState,
  pendingPermissions: z.array(z.string()).default([]),
  consecutiveFailures: z.number().int().default(0),
  exitCode: z.number().int().nullable().default(null),
  /**
   * For an agent Tade is running: the conversation its harness keeps, by the
   * harness's own id. An adopted session with this id is the same agent, seen
   * again through its transcript, and is not counted twice.
   */
  conversation: z.string().optional(),
})
export type AgentSignal = z.infer<typeof AgentSignal>

export const TestSignal = z.enum(['pass', 'fail', 'unknown'])
export type TestSignal = z.infer<typeof TestSignal>

export const Lane = z.object({
  id: LaneId,
  kind: LaneKind,
  alive: z.boolean(),
  pid: z.number().int().nullable(),
  lastOutputAt: z.number().nullable(),
  attach: z.string(),
})
export type Lane = z.infer<typeof Lane>

export const Run = z.object({
  id: z.string(),
  lane: LaneId,
  worker: z.string(),
  startedAt: z.number(),
})
export type Run = z.infer<typeof Run>

export const Task = z.object({
  id: TaskId,
  project: z.string(),
  intent_spoken: z.string(),
  /** Empty until an agent that started without a branch changes something. */
  branch: z.string(),
  /** What the work is called, when the agent has said. */
  title: z.string().optional(),
  /** Where the work came from: an issue, a trace. */
  links: z.array(z.object({ title: z.string(), url: z.string() })).optional(),
  /** Where it works: the checkout, shared with other agents, or a worktree of its own. */
  workspace: z.enum(['checkout', 'worktree']).optional(),
  /** The change it is one repository's share of, as its task file says. */
  effort: z.string().optional(),
  /** The directory its work is in: the project's checkout, or its worktree. */
  worktree: z.string(),
  /** Who asked for it, as its task file says. */
  by: z.string().optional(),
  /**
   * Set aside by a person, as its task file says — present only when it is.
   *
   * `state` already answers this for anything being drawn, but a merge is
   * ahead of a park in `deriveState` and so can mask one. The queue's rule
   * reads the told fact instead, which is why it travels here rather than
   * being inferred back out of the state.
   */
  parked: z.boolean().optional(),
  /** How it counts as finished, as its task file says. */
  done: z.enum(DONE_RULES).optional(),
  /** The document it produces rather than a change to the code, as its task file says. */
  produces: z.string().optional(),
  /** When it starts, when it is queued work. */
  start: StartCondition.optional(),
  created: z.string(),
  state: TaskState,
  reason: z.string(),
  stalled: z.boolean(),
  git: GitSnapshot.nullable(),
  agents: z.array(AgentSignal),
  lanes: z.array(Lane),
})
export type Task = z.infer<typeof Task>

export const Project = z.object({
  name: z.string(),
  root: z.string(),
  brief: z.string().nullable(),
  tasks: z.array(Task),
  /** Agent sessions in this repo that don't belong to any Tade task. */
  untracked: z.array(AgentSignal.extend({ cwd: z.string() })),
})
export type Project = z.infer<typeof Project>

/**
 * Tade's own tools, lent into an agent as an MCP server of its own, as a look
 * at the machine found them.
 *
 * The other direction from a brokered server: a harness that speaks MCP starts
 * a small program of Tade's and every tool the agent calls through it comes
 * back into the window. It is the harness's child, so Tade never started it and
 * is never told when it goes — looking is the only way to know.
 *
 * `looked` is why this is two fields rather than one number: nought from a scan
 * that could not run is `unknown`, and reading it as "every one of them has
 * gone" is the one lie that would make a light about this worthless.
 */
export const ToolServers = z.object({
  looked: z.boolean(),
  /**
   * How many agents have one alive beside them. Only ones still beside a living
   * harness are counted, so a server left behind by an agent that has gone
   * cannot prop the figure up.
   */
  alive: z.number(),
})
export type ToolServers = z.infer<typeof ToolServers>

export const Workspace = z.object({
  generatedAt: z.string(),
  projects: z.array(Project),
  /** Recently active agent sessions outside any known project. */
  elsewhere: z.array(AgentSignal.extend({ cwd: z.string() })),
  /** Which agents still have Tade's own tools beside them. */
  toolServers: ToolServers,
  warnings: z.array(z.string()),
})
export type Workspace = z.infer<typeof Workspace>

/** Stop listening. Returned by anything that starts a subscription. */
export type Unsubscribe = () => void

/**
 * A value, or the promise of one.
 *
 * Ports use this where an implementation may reasonably be either: asking a
 * running object is immediate, asking across a process is not, and a port that
 * insisted on a promise would make the immediate answer pretend.
 */
export type Awaitable<T> = T | Promise<T>
