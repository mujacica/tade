import type { LaneId, SandboxSpec, TaskId, ThinkingLevel, Unsubscribe } from '@tade/core'
import { z } from 'zod'

// The WorkerAdapter port: what an agent is telling us, and how we answer it.
//
// Deliberately says nothing about how the agent is driven. A worker may render
// its own UI in a lane, or run headless; either way Tade consumes the same
// signals. Vocabulary rule applies: no harness's private words appear here.

export const RunId = z.string().min(1)
export type RunId = z.infer<typeof RunId>

export const WorkerModel = z.object({
  provider: z.string().optional(),
  id: z.string(),
})
export type WorkerModel = z.infer<typeof WorkerModel>

export interface WorkerSpec {
  run: RunId
  task: TaskId
  /** Where the agent works. Always a task worktree, never the main checkout. */
  cwd: string
  /** The opening instruction, verbatim from the human. */
  prompt: string
  model?: WorkerModel
  /** How hard it thinks, from its first turn: the harness's default when absent. */
  thinking?: ThinkingLevel
  /** Lane to render into, for adapters that show a UI. */
  lane?: LaneId
  env?: Record<string, string>
  /**
   * How to contain this worker. An adapter that spawns a process must apply
   * it: the harness has no permission system of its own.
   */
  sandbox?: SandboxSpec
  /** What extensions add to this worker. */
  extras?: WorkerExtras
  /** A name a person gave the work, for the harness's own session to carry. */
  title?: string
  /** Pictures to send with the opening prompt. */
  images?: readonly WorkerImage[]
}

/**
 * What Tade's extensions give an agent beyond the harness it runs in: words
 * about what it can use, tools Tade runs on its behalf, and the pieces an
 * extension ships in this harness's own terms.
 */
export interface WorkerExtras {
  /** Appended to the agent's own instructions. */
  instructions?: string
  /** A file listing tools Tade runs for it, which the agent's side registers at launch. */
  tools?: string
  /** Native extension modules for this harness. */
  extensions?: readonly string[]
  /** Skills, in this harness's own format. */
  skills?: readonly string[]
}

/**
 * Everything a worker tells us. This is the wire format between an in-session
 * agent and Tade, so it is a schema rather than a bare type.
 */
export const WorkerSignal = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('started'),
    run: RunId,
    at: z.number(),
    sessionId: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
    /** How hard it is thinking now, as the harness took the level it was given. */
    thinking: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal('turn_started'), run: RunId, at: z.number() }),
  /** The agent says its task is finished, in a line saying what it did. */
  z.object({
    type: z.literal('done'),
    run: RunId,
    at: z.number(),
    summary: z.string().default(''),
  }),
  /**
   * What the work is called: the name you gave the session (`named`), or the
   * start of the first thing you asked. Tade names the agent's branch from it.
   */
  z.object({
    type: z.literal('titled'),
    run: RunId,
    at: z.number(),
    title: z.string(),
    named: z.boolean().default(false),
  }),
  z.object({ type: z.literal('message'), run: RunId, at: z.number(), text: z.string() }),
  /**
   * Part of what it is saying, as it says it. Only a surface that draws the
   * agent itself needs these; `message` still arrives with the whole block.
   */
  z.object({ type: z.literal('message_delta'), run: RunId, at: z.number(), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    run: RunId,
    at: z.number(),
    callId: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  /** The agent is running one of Tade's extension tools, and waits for the answer. */
  z.object({
    type: z.literal('extension_call'),
    run: RunId,
    at: z.number(),
    callId: z.string(),
    tool: z.string(),
    input: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    type: z.literal('tool_result'),
    run: RunId,
    at: z.number(),
    callId: z.string(),
    ok: z.boolean(),
    summary: z.string().default(''),
  }),
  /** The agent is held, waiting for a human decision. */
  z.object({
    type: z.literal('permission_request'),
    run: RunId,
    at: z.number(),
    requestId: z.string(),
    tool: z.string(),
    input: z.unknown(),
    /** One line, exact enough to read back before approving. */
    summary: z.string(),
  }),
  z.object({
    type: z.literal('permission_resolved'),
    run: RunId,
    at: z.number(),
    requestId: z.string(),
    allowed: z.boolean(),
    reason: z.string().default(''),
  }),
  z.object({
    type: z.literal('turn_done'),
    run: RunId,
    at: z.number(),
    status: z.enum(['ok', 'error', 'aborted']),
    /** Why a turn ended in error, as the provider said it. */
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal('failed'), run: RunId, at: z.number(), error: z.string() }),
  /**
   * Something went wrong that the agent carries on after: a request it is
   * retrying, a harness extension that threw, a compaction that failed. Said
   * so a person can go and fix it, never swallowed.
   */
  z.object({ type: z.literal('problem'), run: RunId, at: z.number(), text: z.string() }),
  /** No turn in flight and nothing queued: the agent is waiting on a human. */
  z.object({ type: z.literal('idle'), run: RunId, at: z.number() }),
  z.object({
    type: z.literal('context'),
    run: RunId,
    at: z.number(),
    tokens: z.number().nullable(),
    percent: z.number().nullable(),
  }),
  /**
   * What a turn consumed, in tokens and money. The harness prices it against
   * its own model catalog, which is the only place that knows what was
   * actually charged — a table we kept ourselves would be out of date the
   * first time a provider changed anything.
   */
  z.object({
    type: z.literal('usage'),
    run: RunId,
    at: z.number(),
    model: z.string().nullable().default(null),
    input: z.number().default(0),
    output: z.number().default(0),
    cacheRead: z.number().default(0),
    cacheWrite: z.number().default(0),
    tokens: z.number().default(0),
    /** US dollars, as the harness computed them. */
    usd: z.number().default(0),
  }),
  z.object({
    type: z.literal('exited'),
    run: RunId,
    at: z.number(),
    code: z.number().nullable(),
  }),
])
export type WorkerSignal = z.infer<typeof WorkerSignal>
export type WorkerSignalType = WorkerSignal['type']

export interface PermissionDecision {
  allow: boolean
  /** Shown to the agent when denied, so it can choose another route. */
  reason?: string
  /**
   * The exact words that decided it. Recorded verbatim in the ledger, because
   * "why did it do that" is only answerable if what you actually said is kept.
   */
  said?: string
}

/**
 * What Tade sends back down the supervision channel. The agent is held on
 * `permission_request` until a matching `decision` arrives, so this is the
 * only thing standing between an agent and a destructive command.
 */
export const WorkerCommand = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('decision'),
    requestId: z.string(),
    allow: z.boolean(),
    reason: z.string().default(''),
  }),
  /** Deliver into the running turn. */
  z.object({ type: z.literal('steer'), message: z.string() }),
  /** Deliver once the current turn finishes. */
  z.object({ type: z.literal('queue'), message: z.string() }),
  z.object({ type: z.literal('abort') }),
  z.object({ type: z.literal('shutdown') }),
  /** A name for the work, chosen by a person: the agent's session takes it too. */
  z.object({ type: z.literal('name'), title: z.string() }),
  /** How hard to think from the next turn on, for this session only. */
  z.object({ type: z.literal('thinking'), level: z.string() }),
  /** Switch the model the agent is running on, for this session only. */
  z.object({ type: z.literal('model'), provider: z.string().default(''), id: z.string() }),
  /** What an extension tool the agent called answered. */
  z.object({
    type: z.literal('extension_result'),
    callId: z.string(),
    ok: z.boolean(),
    text: z.string(),
  }),
])
export type WorkerCommand = z.infer<typeof WorkerCommand>

/** Environment a supervised agent is started with. */
export const WORKER_ENV = {
  socket: 'TADE_RUN_SOCKET',
  run: 'TADE_RUN_ID',
  task: 'TADE_TASK_ID',
  /**
   * Whether tool calls are gated. The agent has to be told, because what it
   * should do when Tade is unreachable depends on the answer: under `bypass`
   * nothing was ever going to be held, so it carries on; under `policy` a
   * gate that cannot be asked has to refuse.
   */
  approvals: 'TADE_APPROVALS',
  /** Where the list of Tade's extension tools for this agent is. */
  tools: 'TADE_EXTENSION_TOOLS',
  /** The name a person gave the work, which the agent's session takes when it has none. */
  title: 'TADE_TITLE',
} as const

/** A picture sent with an instruction: a screenshot, usually. */
export interface WorkerImage {
  /** The bytes, base64. */
  data: string
  mimeType: string
}

export interface WorkerCapabilities {
  /** Can hold a tool call until a decision arrives. Without this there are no reliable approvals. */
  permissionGate: boolean
  /** Can deliver a message into a running turn. */
  steer: boolean
  /** Can change model without restarting the run. */
  modelSwitch: boolean
  /** Can be told how hard to think without restarting the run. */
  thinking: boolean
  /** Renders its own interface in a lane. */
  visibleUi: boolean
  /** Can resume a previous session. */
  resume: boolean
  /** Can be sent pictures with an instruction, not only told where they are. */
  images: boolean
  /**
   * Its agent can say its task is finished (the `done` signal). Without it, a
   * task's rule cannot be `said`: nothing would ever say it.
   */
  done: boolean
}

export interface WorkerHandle {
  run: RunId
  task: TaskId
  sessionId: string | null
  startedAt: number
  /** Set when the worker renders into a lane the human can attach to. */
  lane: LaneId | null
}

export type WorkerSignalListener = (signal: WorkerSignal) => void

/** Everything needed to run an agent somewhere we can see it. */
export interface LaunchSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface WorkerAdapter {
  readonly id: string
  readonly capabilities: WorkerCapabilities

  /**
   * How to run this agent in a lane. Tade places the process — that is the
   * driver's job — so the adapter only says what to run.
   */
  launchSpec(spec: WorkerSpec): LaunchSpec
  /**
   * Be ready for an agent that is about to be launched: open whatever channel
   * it reports back over, so signals and approvals work from the first turn.
   * Pairs with `launchSpec`.
   */
  supervise(spec: WorkerSpec): Promise<WorkerHandle>
  /**
   * Run the agent headless, under our own protocol, as a child of this
   * process. For an agent whose interface Tade draws itself — the
   * orchestrator — never for work you are meant to watch.
   */
  start(spec: WorkerSpec): Promise<WorkerHandle>
  /**
   * Send an instruction. One sent while the agent is in the middle of a turn
   * goes into that turn (`steer`, unless said) or waits for it to end (`queue`)
   * — never refused for arriving at a busy moment.
   */
  prompt(
    run: RunId,
    message: string,
    images?: readonly WorkerImage[],
    opts?: { whenBusy?: 'steer' | 'queue' },
  ): Promise<void>
  /** Deliver a message into the current turn. */
  steer(run: RunId, message: string): Promise<void>
  /** Deliver a message after the current turn finishes. */
  queue(run: RunId, message: string): Promise<void>
  /** Answer a pending `permission_request`. */
  decide(run: RunId, requestId: string, decision: PermissionDecision): Promise<void>
  /** Answer an `extension_call` with what the tool said. */
  answer(run: RunId, callId: string, result: { ok: boolean; text: string }): Promise<void>
  setModel(run: RunId, model: WorkerModel): Promise<void>
  /** How hard to think from the next turn on, for this session. */
  setThinking(run: RunId, level: ThinkingLevel): Promise<void>
  /** Give the agent's work a name a person chose; the harness's own session takes it too. */
  name(run: RunId, title: string): Promise<void>
  /** Stop the current turn, leaving the run alive. */
  abort(run: RunId): Promise<void>
  stop(run: RunId): Promise<void>
  onSignal(run: RunId, listener: WorkerSignalListener): Unsubscribe
  list(): Promise<WorkerHandle[]>
  /**
   * Let go of every agent without ending it: close the channels, leave the
   * work running. This is the window closing, and under a driver whose lanes
   * outlive it the agents carry on — so this must never say `shutdown` to one.
   */
  detach(): Promise<void>
  /** End every agent we are running, and release everything. */
  shutdown(): Promise<void>
}

export class WorkerNotFoundError extends Error {
  readonly code = 'WORKER_NOT_FOUND'
  constructor(run: string) {
    super(`no such run: ${run}`)
    this.name = 'WorkerNotFoundError'
  }
}

export class PermissionNotPendingError extends Error {
  readonly code = 'PERMISSION_NOT_PENDING'
  constructor(requestId: string) {
    super(`no pending permission request: ${requestId}`)
    this.name = 'PermissionNotPendingError'
  }
}
