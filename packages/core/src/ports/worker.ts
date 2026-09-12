import { z } from 'zod'
import type { LaneId, TaskId } from '../model.ts'
import type { Unsubscribe } from './workspace.ts'

// The WorkerAdapter port: what an agent is telling us, and how we answer it.
//
// Deliberately says nothing about how the agent is driven. A worker may render
// its own UI in a lane, or run headless; either way Wilco consumes the same
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
  /** Lane to render into, for adapters that show a UI. */
  lane?: LaneId
  env?: Record<string, string>
}

/**
 * Everything a worker tells us. This is the wire format between an in-session
 * agent and the daemon, so it is a schema rather than a bare type.
 */
export const WorkerSignal = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('started'),
    run: RunId,
    at: z.number(),
    sessionId: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal('turn_started'), run: RunId, at: z.number() }),
  z.object({ type: z.literal('message'), run: RunId, at: z.number(), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    run: RunId,
    at: z.number(),
    callId: z.string(),
    tool: z.string(),
    input: z.unknown(),
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
  }),
  z.object({ type: z.literal('failed'), run: RunId, at: z.number(), error: z.string() }),
  /** No turn in flight and nothing queued: the agent is waiting on a human. */
  z.object({ type: z.literal('idle'), run: RunId, at: z.number() }),
  z.object({
    type: z.literal('context'),
    run: RunId,
    at: z.number(),
    tokens: z.number().nullable(),
    percent: z.number().nullable(),
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
}

/**
 * What Wilco sends back down the supervision channel. The agent is held on
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
])
export type WorkerCommand = z.infer<typeof WorkerCommand>

/** Environment a supervised agent is started with. */
export const WORKER_ENV = {
  socket: 'WILCO_RUN_SOCKET',
  run: 'WILCO_RUN_ID',
  task: 'WILCO_TASK_ID',
} as const

export interface WorkerCapabilities {
  /** Can hold a tool call until a decision arrives. Without this there are no reliable approvals. */
  permissionGate: boolean
  /** Can deliver a message into a running turn. */
  steer: boolean
  /** Can change model without restarting the run. */
  modelSwitch: boolean
  /** Renders its own interface in a lane. */
  visibleUi: boolean
  /** Can resume a previous session. */
  resume: boolean
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

export interface WorkerAdapter {
  readonly id: string
  readonly capabilities: WorkerCapabilities

  start(spec: WorkerSpec): Promise<WorkerHandle>
  /** Send an instruction, to be handled when the agent is ready for it. */
  prompt(run: RunId, message: string): Promise<void>
  /** Deliver a message into the current turn. */
  steer(run: RunId, message: string): Promise<void>
  /** Deliver a message after the current turn finishes. */
  queue(run: RunId, message: string): Promise<void>
  /** Answer a pending `permission_request`. */
  decide(run: RunId, requestId: string, decision: PermissionDecision): Promise<void>
  setModel(run: RunId, model: WorkerModel): Promise<void>
  /** Stop the current turn, leaving the run alive. */
  abort(run: RunId): Promise<void>
  stop(run: RunId): Promise<void>
  onSignal(run: RunId, listener: WorkerSignalListener): Unsubscribe
  list(): Promise<WorkerHandle[]>
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
