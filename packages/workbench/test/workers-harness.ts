import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { effectByName } from '@tade/core'
import type {
  PermissionDecision,
  RunId,
  WorkerAdapter,
  WorkerCapabilities,
  WorkerHandle,
  WorkerSignal,
  WorkerSignalListener,
  WorkerSpec,
} from '@tade/harnesses-core'
import { noHarnessSpend, PermissionNotPendingError } from '@tade/harnesses-core'
import type { Reporter } from '@tade/telemetry'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { EventLog } from '../src/events.ts'
import { WorkerSupervisor, type WorkerSupervisorOptions } from '../src/workers.ts'

// The world a supervisor test runs in, and the only one: what is under test is
// the decision and bookkeeping around a worker, so the worker is fake, every
// signal is delivered on demand, and nothing here reaches a model or a network.
//
// Its own file because the tests using it outgrew one — a file over its line is
// a conversation, and the harness is the half of that conversation that is not
// about any particular behaviour.

// A scripted adapter: no agent, no model, no network. What is under test is
// the decision and bookkeeping around a worker, so the worker is fake and
// every signal is delivered on demand.

export class FakeAdapter implements WorkerAdapter {
  readonly id = 'fake'
  /** It routes, like pi: what a run was reached through is the route's to say. */
  readonly provider = null
  readonly capabilities: WorkerCapabilities = {
    permissionGate: true,
    steer: 'live',
    queue: 'live',
    abort: 'live',
    model: 'live',
    thinking: 'live',
    thinkingLevels: ['low', 'high'],
    rename: 'live',
    visibleUi: false,
    resume: false,
    resumeKeeps: true,
    images: 'none',
    done: true,
    nativeExtensions: false,
    skills: false,
    tools: true,
    spend: { usd: 'none', tokens: false, limits: 'none' },
    accounts: false,
    mcp: false,
    headless: true,
    why: {},
  }
  readonly decisions: Array<{ run: string; requestId: string; decision: PermissionDecision }> = []
  readonly steered: Array<{ run: string; message: string }> = []
  readonly stopped: string[] = []
  readonly answers: Array<{ run: string; callId: string; ok: boolean; text: string }> = []
  private readonly listeners = new Map<string, Set<WorkerSignalListener>>()
  private readonly handles = new Map<string, WorkerHandle>()

  launchSpec(spec: WorkerSpec) {
    return { command: 'fake', args: [spec.run], env: {} }
  }

  async probe() {
    return { ok: true, version: null, problems: [] }
  }

  effectOf(tool: string) {
    return tool === 'bash' ? ('exec' as const) : effectByName(tool)
  }

  conversationKey(task: string) {
    return task
  }

  async hasConversation() {
    return false
  }

  async spent() {
    return noHarnessSpend()
  }

  async models() {
    return []
  }

  async resolveModel() {
    return { ok: false as const, reason: 'the fake has no models' }
  }

  async modelOf() {
    return null
  }

  async account() {
    return { signedIn: true, who: null, plan: null, method: null, problem: null }
  }

  signIn() {
    return null
  }

  async signOut() {}

  limits() {
    return null
  }

  async prepareAccount() {}

  async carryConversation() {
    return false
  }

  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    return this.supervise(spec)
  }

  async supervise(spec: WorkerSpec): Promise<WorkerHandle> {
    const handle: WorkerHandle = {
      run: spec.run,
      task: spec.task,
      sessionId: 's1',
      startedAt: 1,
      lane: null,
    }
    this.handles.set(spec.run, handle)
    return handle
  }
  async prompt(): Promise<void> {}
  async steer(run: RunId, message: string): Promise<void> {
    this.steered.push({ run, message })
  }
  async queue(): Promise<void> {}
  async decide(run: RunId, requestId: string, decision: PermissionDecision): Promise<void> {
    this.decisions.push({ run, requestId, decision })
  }
  async answer(run: RunId, callId: string, result: { ok: boolean; text: string }): Promise<void> {
    this.answers.push({ run, callId, ...result })
  }
  async setModel(): Promise<void> {}
  async setThinking(): Promise<void> {}
  async name(): Promise<void> {}
  async abort(): Promise<void> {}
  async stop(run: RunId): Promise<void> {
    this.stopped.push(run)
    this.handles.delete(run)
  }
  onSignal(run: RunId, listener: WorkerSignalListener) {
    let set = this.listeners.get(run)
    if (!set) {
      set = new Set()
      this.listeners.set(run, set)
    }
    set.add(listener)
    return () => set.delete(listener)
  }
  async list(): Promise<WorkerHandle[]> {
    return [...this.handles.values()]
  }
  /** Letting go must be distinguishable from stopping, so it records neither. */
  async detach(): Promise<void> {}
  async shutdown(): Promise<void> {}

  /** Deliver a signal as the agent would. */
  emit(run: string, signal: Record<string, unknown>): void {
    const full = { run, at: 1, ...signal } as unknown as WorkerSignal
    for (const listener of this.listeners.get(run) ?? []) listener(full)
  }

  askPermission(run: string, requestId: string, tool: string, input: unknown, summary: string) {
    this.emit(run, { type: 'permission_request', requestId, tool, input, summary })
  }
}

export const WORKTREE = '/work/wt/app-refunds'

/**
 * Signals are handled asynchronously and `blocking` events are fsynced before
 * the append resolves, so tests wait for the condition they care about rather
 * than for a fixed delay.
 */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeout = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

export const logged = (
  log: EventLog,
  type: Parameters<EventLog['read']>[0] extends never ? never : string,
) => log.read({ types: [type] as never })

export async function setup(
  mode: 'bypass' | 'policy',
  report?: Reporter,
  caution?: WorkerSupervisorOptions['caution'],
  /** A real directory, for the one thing the supervisor reads off disk: what the task produces. */
  cwd: string = WORKTREE,
) {
  const log = await EventLog.open({ path: join(tmp('tade-workers-'), 'events.jsonl') })
  const adapter = new FakeAdapter()
  const supervisor = new WorkerSupervisor({
    adapter,
    log,
    approvals: { mode },
    ...(report ? { report } : {}),
    ...(caution ? { caution } : {}),
  })
  const handle = await supervisor.start({
    run: 'r1',
    task: 'app/refunds',
    cwd,
    prompt: 'fix the refund flow',
  })
  return { log, adapter, supervisor, handle }
}

/**
 * A worktree with a task file in it saying what the task produces, and the
 * document beside it unless `wrote` says otherwise — the two cases the line
 * that says a task finished has to tell apart.
 */
export function worktreeProducing(produces: string, wrote = true): string {
  const worktree = tmp('tade-produces-')
  mkdirSync(join(worktree, '.tade'), { recursive: true })
  writeFileSync(
    join(worktree, '.tade', 'task.yaml'),
    [
      'id: app/refunds',
      'project: app',
      'intent_spoken: work out where the token gets taken twice',
      'created: 2026-09-15T09:00:00Z',
      `produces: ${produces}`,
    ].join('\n'),
  )
  if (!wrote) return worktree
  mkdirSync(join(worktree, dirname(produces)), { recursive: true })
  writeFileSync(join(worktree, produces), '# what I found\n')
  return worktree
}
