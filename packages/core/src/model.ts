import { z } from 'zod'

// The object model. These schemas are the single source of truth for the shape
// of a Task: the CLI, the RPC layer and the orchestrator's tool definitions
// all derive from them.
//
//   Workspace  one machine, one WILCO_HOME
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

export const LaneKind = z.enum(['agent', 'server', 'tests', 'shell'])
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
 * `.wilco/task.yaml` inside a task's worktree, written once when the task is
 * created. `intent_spoken` is stored verbatim.
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
})
export type TaskFile = z.infer<typeof TaskFile>

export const PrState = z.enum(['OPEN', 'MERGED', 'CLOSED'])

export const GitSnapshot = z.object({
  branch: z.string().nullable(),
  head: z.string().nullable(),
  headSubject: z.string().nullable(),
  headTime: z.number().nullable(),
  /** Paths with staged, unstaged or untracked changes (excluding `.wilco/`). */
  dirty: z.array(z.string()),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  baseRef: z.string().nullable(),
  /** HEAD moved past `base` and is now contained in the base branch. */
  mergedIntoBase: z.boolean(),
  upstreamGone: z.boolean(),
  pr: z.object({ state: PrState, url: z.string() }).nullable(),
})
export type GitSnapshot = z.infer<typeof GitSnapshot>

export const TurnState = z.enum(['running', 'idle', 'unknown'])
export type TurnState = z.infer<typeof TurnState>

/**
 * One agent attached to a task, however it was found: a Wilco lane, or a
 * session adopted from a provider's transcript files.
 */
export const AgentSignal = z.object({
  /**
   * `lane` is a PTY Wilco opened, `run` a supervised agent it is driving, and
   * `adopted` a session someone started outside Wilco entirely.
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
  worktree: z.string(),
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
  /** Agent sessions in this repo that don't belong to any Wilco task. */
  untracked: z.array(AgentSignal.extend({ cwd: z.string() })),
})
export type Project = z.infer<typeof Project>

export const Workspace = z.object({
  generatedAt: z.string(),
  projects: z.array(Project),
  /** Recently active agent sessions outside any known project. */
  elsewhere: z.array(AgentSignal.extend({ cwd: z.string() })),
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
