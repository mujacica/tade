import { join } from 'node:path'
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
import { PermissionNotPendingError } from '@tade/harnesses-core'
import type { Reporter, Span, Work } from '@tade/telemetry'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { EventLog } from '../src/events.ts'
import { WorkerSupervisor } from '../src/workers.ts'

// A scripted adapter: no agent, no model, no network. What is under test is
// the decision and bookkeeping around a worker, so the worker is fake and
// every signal is delivered on demand.

class FakeAdapter implements WorkerAdapter {
  readonly id = 'fake'
  readonly capabilities: WorkerCapabilities = {
    permissionGate: true,
    steer: true,
    modelSwitch: true,
    thinking: true,
    visibleUi: false,
    resume: false,
    images: false,
    done: true,
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

const WORKTREE = '/work/wt/app-refunds'

/**
 * Signals are handled asynchronously and `blocking` events are fsynced before
 * the append resolves, so tests wait for the condition they care about rather
 * than for a fixed delay.
 */
async function until(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const logged = (
  log: EventLog,
  type: Parameters<EventLog['read']>[0] extends never ? never : string,
) => log.read({ types: [type] as never })

async function setup(mode: 'bypass' | 'policy', report?: Reporter) {
  const log = await EventLog.open({ path: join(tmp('tade-workers-'), 'events.jsonl') })
  const adapter = new FakeAdapter()
  const supervisor = new WorkerSupervisor({
    adapter,
    log,
    approvals: { mode },
    ...(report ? { report } : {}),
  })
  const handle = await supervisor.start({
    run: 'r1',
    task: 'app/refunds',
    cwd: WORKTREE,
    prompt: 'fix the refund flow',
  })
  return { log, adapter, supervisor, handle }
}

describe('WorkerSupervisor', () => {
  let close: (() => Promise<void>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('records the run and its posture when it starts', async () => {
    const { log, supervisor, handle } = await setup('bypass')
    close = () => log.close()
    expect(handle.run).toBe('r1')
    expect(supervisor.list().map((h) => h.run)).toEqual(['r1'])
    const started = (await logged(log, 'run_started'))[0]
    expect(started?.detail).toMatchObject({ adapter: 'fake', approvals: 'bypass' })
    expect(started?.task).toBe('app/refunds')
  })

  describe('bypass (the default)', () => {
    it('answers every request immediately, without asking', async () => {
      const { log, adapter, supervisor } = await setup('bypass')
      close = () => log.close()
      adapter.askPermission('r1', 'q1', 'bash', { command: 'npm test' }, 'bash: npm test')
      await until(() => adapter.decisions.length > 0)

      expect(adapter.decisions).toEqual([{ run: 'r1', requestId: 'q1', decision: { allow: true } }])
      expect(supervisor.pending()).toEqual([])
    })

    it('still records what ran, so the journal stays honest', async () => {
      const { log, adapter } = await setup('bypass')
      close = () => log.close()
      adapter.askPermission(
        'r1',
        'q1',
        'bash',
        { command: 'git push --force origin main' },
        'bash: git push --force origin main',
      )
      await until(async () => (await logged(log, 'tool_call')).length > 0)

      const [event] = await logged(log, 'tool_call')
      expect(event?.detail).toMatchObject({
        tier: 'hard',
        rule: 'force-push',
        approved: 'automatically',
        summary: 'bash: git push --force origin main',
      })
      // A destructive command that ran unasked is not filed as routine noise.
      expect(event?.urgency).toBe('notable')
    })
  })

  describe('policy mode', () => {
    it('holds anything that is not routine and logs it as blocking', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      adapter.askPermission(
        'r1',
        'q1',
        'bash',
        { command: 'git push --force origin main' },
        'bash: git push --force origin main',
      )
      await until(() => supervisor.pending().length > 0)

      expect(adapter.decisions).toEqual([])
      expect(supervisor.pending()).toMatchObject([
        { run: 'r1', requestId: 'q1', tier: 'hard', rule: 'force-push', task: 'app/refunds' },
      ])
      await until(async () => (await logged(log, 'permission_request')).length > 0)
      const [event] = await logged(log, 'permission_request')
      expect(event?.urgency).toBe('blocking')
      expect(event?.detail.summary).toBe('bash: git push --force origin main')
    })

    it('does not ask twice about something you already refused', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      const force = 'bash: git push --force origin main'
      adapter.askPermission('r1', 'q1', 'bash', { command: 'git push --force origin main' }, force)
      await until(() => supervisor.pending().length > 0)
      await supervisor.decide('r1', 'q1', { allow: false, said: 'no, never force push' })

      // The agent tries the same thing again, as agents do.
      adapter.askPermission('r1', 'q2', 'bash', { command: 'git push --force origin main' }, force)
      await until(() => adapter.decisions.length > 1)

      // Refused without troubling anyone: being asked the same destructive
      // question repeatedly is how people start saying yes to make it stop.
      expect(adapter.decisions.at(-1)).toMatchObject({
        requestId: 'q2',
        decision: { allow: false, reason: 'already refused in this run' },
      })
      expect(supervisor.pending()).toEqual([])
    })

    it('asks again when it is a different command, which is new information', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      adapter.askPermission(
        'r1',
        'q1',
        'bash',
        { command: 'git push --force origin main' },
        'bash: git push --force origin main',
      )
      await until(() => supervisor.pending().length > 0)
      await supervisor.decide('r1', 'q1', { allow: false, said: 'no' })

      adapter.askPermission(
        'r1',
        'q2',
        'bash',
        { command: 'sudo rm -rf /var/lib/thing' },
        'bash: sudo rm -rf /var/lib/thing',
      )
      await until(() => supervisor.pending().length > 0)
      // A refusal of one thing is not a refusal of everything.
      expect(supervisor.pending()).toMatchObject([{ requestId: 'q2' }])
    })

    it('keeps the exact words that decided it', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      adapter.askPermission(
        'r1',
        'q1',
        'bash',
        { command: 'git push --force origin main' },
        'bash: git push --force origin main',
      )
      await until(() => supervisor.pending().length > 0)
      await supervisor.decide('r1', 'q1', { allow: false, said: 'no — we never force push main' })

      await until(async () => (await logged(log, 'permission_denied')).length > 0)
      const [event] = await logged(log, 'permission_denied')
      // Verbatim, because "why did it do that" is only answerable if what you
      // actually said is what was kept.
      expect(event?.detail.said).toBe('no — we never force push main')
    })

    it('lets routine work through untouched', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      adapter.askPermission('r1', 'q1', 'read', { path: `${WORKTREE}/src/a.ts` }, 'read src/a.ts')
      await until(() => adapter.decisions.length > 0)

      expect(adapter.decisions[0]?.decision).toEqual({ allow: true })
      expect(supervisor.pending()).toEqual([])
    })

    it('granting an approval answers the agent and records it', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      adapter.askPermission('r1', 'q1', 'bash', { command: 'npm test' }, 'bash: npm test')
      await until(() => supervisor.pending().length > 0)

      await supervisor.decide('r1', 'q1', { allow: true })
      expect(adapter.decisions.at(-1)).toMatchObject({ requestId: 'q1', decision: { allow: true } })
      expect(supervisor.pending()).toEqual([])
      const [granted] = await logged(log, 'permission_granted')
      expect(granted?.detail).toMatchObject({ requestId: 'q1', summary: 'bash: npm test' })
    })

    it('denying passes the reason back to the agent', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      adapter.askPermission('r1', 'q1', 'bash', { command: 'npm publish' }, 'bash: npm publish')
      await until(() => supervisor.pending().length > 0)

      await supervisor.decide('r1', 'q1', { allow: false, reason: 'not from here' })
      expect(adapter.decisions.at(-1)?.decision).toEqual({ allow: false, reason: 'not from here' })
      const [denied] = await logged(log, 'permission_denied')
      expect(denied?.detail.reason).toBe('not from here')
    })

    it('refuses to answer a request that is not pending', async () => {
      const { log, supervisor } = await setup('policy')
      close = () => log.close()
      await expect(supervisor.decide('r1', 'ghost', { allow: true })).rejects.toBeInstanceOf(
        PermissionNotPendingError,
      )
    })

    it('lists approvals per task, oldest first', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      adapter.emit('r1', {
        type: 'permission_request',
        requestId: 'q2',
        tool: 'bash',
        input: { command: 'npm test' },
        summary: 'later',
        at: 200,
      })
      adapter.emit('r1', {
        type: 'permission_request',
        requestId: 'q1',
        tool: 'bash',
        input: { command: 'npm test' },
        summary: 'earlier',
        at: 100,
      })
      await until(() => supervisor.pending().length === 2)

      expect(supervisor.pending('app/refunds').map((p) => p.summary)).toEqual(['earlier', 'later'])
      expect(supervisor.pending('app/other')).toEqual([])
    })
  })

  it('knows whether an agent is in the middle of a turn, from what it says', async () => {
    const { log, adapter, supervisor } = await setup('bypass')
    close = () => log.close()
    // Nothing said yet: nobody can tell, least of all its lane.
    expect(supervisor.turnOf('r1')).toBe('unknown')
    // A session that opens has nothing in flight until it is given something.
    adapter.emit('r1', { type: 'started', sessionId: null, model: 'openrouter/kimi' })
    await until(() => supervisor.turnOf('r1') === 'idle')
    adapter.emit('r1', { type: 'turn_started' })
    await until(() => supervisor.turnOf('r1') === 'running')
    // A model changed mid-turn says `started` again, and the turn goes on.
    adapter.emit('r1', { type: 'started', sessionId: null, model: 'openrouter/opus' })
    // Ending one step of the work is not ending the work: more steps may follow.
    adapter.emit('r1', { type: 'turn_done', status: 'ok' })
    await until(async () => (await logged(log, 'turn_done')).length > 0)
    expect(supervisor.turnOf('r1')).toBe('running')
    adapter.emit('r1', { type: 'idle' })
    await until(() => supervisor.turnOf('r1') === 'idle')
    // An agent that has gone is in the middle of nothing.
    adapter.emit('r1', { type: 'exited', code: 0 })
    await until(() => supervisor.turnOf('r1') === 'unknown')
  })

  it('writes down an agent saying its task is finished, in its words', async () => {
    const { log, adapter } = await setup('bypass')
    close = () => log.close()
    adapter.emit('r1', { type: 'done', summary: 'Refunds charge once, with a test.' })
    await until(async () => (await logged(log, 'task_done')).length > 0)
    const [done] = await logged(log, 'task_done')
    expect(done).toMatchObject({
      task: 'app/refunds',
      detail: { by: 'agent', summary: 'Refunds charge once, with a test.' },
    })
  })

  it('logs turn completion and failures', async () => {
    const { log, adapter } = await setup('bypass')
    close = () => log.close()
    adapter.emit('r1', { type: 'turn_done', status: 'ok' })
    adapter.emit('r1', { type: 'failed', error: 'model unreachable' })
    await until(async () => (await logged(log, 'failed')).length > 0)

    expect((await logged(log, 'turn_done'))[0]?.detail.status).toBe('ok')
    const [failed] = await logged(log, 'failed')
    expect(failed?.detail.error).toBe('model unreachable')
    expect(failed?.urgency).toBe('blocking')
  })

  it('stopping a run clears its pending approvals and stops the agent', async () => {
    const { log, adapter, supervisor } = await setup('policy')
    close = () => log.close()
    adapter.askPermission('r1', 'q1', 'bash', { command: 'npm publish' }, 'bash: npm publish')
    await until(() => supervisor.pending().length > 0)

    await supervisor.stop('r1')
    expect(adapter.stopped).toEqual(['r1'])
    expect(supervisor.pending()).toEqual([])
    expect(supervisor.list()).toEqual([])
    expect((await logged(log, 'run_exited')).length).toBeGreaterThan(0)
  })

  it('steering reaches the agent', async () => {
    const { log, adapter, supervisor } = await setup('bypass')
    close = () => log.close()
    await supervisor.steer('r1', 'also update the docs')
    expect(adapter.steered).toEqual([{ run: 'r1', message: 'also update the docs' }])
  })

  // Scenarios the build plan named and nobody had written. Each is a thing
  // that happens to real agents, and each used to be answered by hoping.

  describe('when things go wrong', () => {
    it('holds a second request while the first is still waiting', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      adapter.askPermission(
        'r1',
        'p1',
        'bash',
        { command: 'git push --force origin main' },
        'git push --force origin main',
      )
      adapter.askPermission('r1', 'p2', 'bash', { command: 'rm -rf /etc' }, 'rm -rf /etc')
      await until(() => supervisor.pending().length === 2)

      // Answering one must not answer the other: they are separate decisions
      // about separate commands, and a yes is never transferable.
      await supervisor.decide('r1', 'p1', { allow: true })
      const left = supervisor.pending()
      expect(left.map((p) => p.requestId)).toEqual(['p2'])
      expect(adapter.decisions.map((d) => d.requestId)).toEqual(['p1'])
    })

    it('forgets what an agent was waiting on when it dies', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      adapter.askPermission(
        'r1',
        'p1',
        'bash',
        { command: 'git push --force origin main' },
        'git push --force origin main',
      )
      await until(() => supervisor.pending().length === 1)

      // Killed from outside: nobody told us, the process simply ended.
      adapter.emit('r1', { type: 'exited', code: 137 })
      // Wait for the journal rather than the in-memory state: it is the slower
      // of the two, so seeing it means both have happened.
      await until(async () => (await logged(log, 'run_exited')).length > 0)
      // An approval for an agent that no longer exists would sit there forever
      // looking like something is waiting on you — and would keep the task
      // `blocked` against an agent that cannot act on a yes.
      expect(supervisor.pending()).toEqual([])
    })

    it('reports a run that failed rather than dropping it', async () => {
      const { log, adapter } = await setup('bypass')
      close = () => log.close()
      // A crash mid-turn: pi says what happened before going away.
      adapter.emit('r1', { type: 'failed', error: 'harness exited unexpectedly' })
      adapter.emit('r1', { type: 'exited', code: 1 })
      await until(async () => (await logged(log, 'failed')).length > 0)
      const [failure] = await logged(log, 'failed')
      expect(failure?.detail.error).toBe('harness exited unexpectedly')
    })

    it('ignores a signal it cannot make sense of', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      // Malformed output from the agent — a version skew, a half-written line.
      // The rule is the same as for transcripts: skip it, never throw over it.
      adapter.emit('r1', { type: 'nonsense-from-the-future' } as never)
      adapter.askPermission(
        'r1',
        'p1',
        'bash',
        { command: 'git push --force origin main' },
        'git push --force origin main',
      )
      await until(() => supervisor.pending().length === 1)
      expect(supervisor.pending()).toHaveLength(1)
    })

    it('answers an approval for an agent that has gone, without throwing', async () => {
      const { log, adapter, supervisor } = await setup('policy')
      close = () => log.close()
      adapter.askPermission(
        'r1',
        'p1',
        'bash',
        { command: 'git push --force origin main' },
        'git push --force origin main',
      )
      await until(() => supervisor.pending().length === 1)
      adapter.emit('r1', { type: 'exited', code: 0 })
      await until(() => supervisor.pending().length === 0)

      // You said yes a moment after it died. That is an answer to a question
      // nobody is asking any more, not an error worth a stack trace.
      await expect(supervisor.decide('r1', 'p1', { allow: true })).rejects.toThrow(
        PermissionNotPendingError,
      )
    })
  })
})

describe('what an agent does, as the work of a model', () => {
  /** A reporter that keeps the spans it was asked for, and how they nest. */
  function timing() {
    const spans: {
      name: string
      op: string
      attributes: Record<string, unknown>
      startedAt?: number
      endedAt?: number | 'open'
      inside: string[]
    }[] = []
    const make = (work: Work): Span => {
      const kept = {
        name: work.name,
        op: work.op,
        attributes: { ...(work.attributes ?? {}) },
        ...(work.startedAt ? { startedAt: work.startedAt } : {}),
        endedAt: 'open' as number | 'open',
        inside: [] as string[],
      }
      spans.push(kept)
      return {
        about: (attributes) => Object.assign(kept.attributes, attributes),
        inside: (child) => {
          kept.inside.push(child.name)
          return make(child)
        },
        wrong: () => {},
        end: (at) => {
          kept.endedAt = at ?? Date.now()
        },
      }
    }
    const report = {
      id: 'keeping',
      on: true,
      trouble: () => {},
      note: () => {},
      measure: () => {},
      doing: make,
      flush: async () => {},
      close: async () => {},
    } as Reporter
    return { report, spans }
  }

  it('times a turn, the tools it called and what it cost, and nothing of what was said', async () => {
    const { report, spans } = timing()
    const { adapter, supervisor } = await setup('bypass', report)
    adapter.emit('r1', { type: 'started', sessionId: null, model: 'openrouter/opus' })
    adapter.emit('r1', { type: 'turn_started', at: 1_000 })
    adapter.emit('r1', {
      type: 'tool_call',
      callId: 'c1',
      tool: 'bash',
      input: { command: 'pnpm test' },
      at: 1_100,
    })
    adapter.emit('r1', {
      type: 'tool_result',
      callId: 'c1',
      ok: true,
      summary: 'tests passed',
      at: 1_400,
    })
    adapter.emit('r1', {
      type: 'usage',
      model: 'openrouter/opus',
      input: 900,
      output: 120,
      cacheRead: 40,
      cacheWrite: 0,
      tokens: 1_060,
      usd: 0.31,
    })
    adapter.emit('r1', { type: 'turn_done', status: 'ok', at: 2_000 })
    await until(() => spans.every((span) => span.endedAt !== 'open'))

    const turn = spans.find((span) => span.op === 'gen_ai.invoke_agent')
    expect(turn).toMatchObject({
      name: 'invoke_agent app/refunds',
      startedAt: 1_000,
      endedAt: 2_000,
      inside: ['execute_tool bash'],
    })
    expect(turn?.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'app/refunds',
      'gen_ai.request.model': 'openrouter/opus',
      'gen_ai.usage.input_tokens': 900,
      'gen_ai.usage.output_tokens': 120,
      'gen_ai.usage.total_tokens': 1_060,
      'gen_ai.usage.input_tokens.cached': 40,
      'gen_ai.cost.total_tokens': 0.31,
      'tade.project': 'app',
      'tade.harness': 'fake',
    })
    const tool = spans.find((span) => span.op === 'gen_ai.execute_tool')
    expect(tool).toMatchObject({ name: 'execute_tool bash', startedAt: 1_100, endedAt: 1_400 })
    // What the agent was asked, what it answered and what a tool was given are
    // not the shape of the work, and are nowhere in it.
    expect(JSON.stringify(spans)).not.toContain('pnpm test')
    expect(JSON.stringify(spans)).not.toContain('tests passed')
    expect(JSON.stringify(spans)).not.toContain('fix the refund flow')
    await supervisor.shutdown()
  })

  it('ends a turn its agent never finished, when the agent is gone', async () => {
    const { report, spans } = timing()
    const { adapter, supervisor } = await setup('bypass', report)
    adapter.emit('r1', { type: 'turn_started', at: 1_000 })
    adapter.emit('r1', { type: 'tool_call', callId: 'c1', tool: 'bash', input: {}, at: 1_100 })
    adapter.emit('r1', { type: 'exited', code: 1 })
    await until(() => spans.length === 2 && spans.every((span) => span.endedAt !== 'open'))
    expect(spans.map((span) => span.op)).toEqual(['gen_ai.invoke_agent', 'gen_ai.execute_tool'])
    await supervisor.shutdown()
  })
})
