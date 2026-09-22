import { isAbsolute } from 'node:path'
import { declarationProblems, LIMITS_SUPPORT, type TaskId, THINKING_LEVELS } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type HarnessFeature,
  modelsOffered,
  SUPPORT,
  WORKER_ENV,
  type WorkerAdapter,
  WorkerNotFoundError,
  type WorkerSpec,
} from './port.ts'

// The shared suite every WorkerAdapter must pass, pi included.
//
// It asserts what Tade relies on without running a model: that what a harness
// says it can do is said in words a person can read, that the line written
// down to come back to an agent never carries its first instruction, that a
// task's conversation is named the same way every time, and that letting go
// of an agent never ends it. What a harness does with a real turn is its own
// test's business, against a fake provider.
//
// Nothing in the suite starts an agent or reaches the network.

export interface HarnessConformanceOptions {
  /**
   * A fresh adapter whose own records — sessions, transcripts — are empty,
   * so "no conversation yet" is true of every task the suite names.
   */
  make(): WorkerAdapter | Promise<WorkerAdapter>
  /** A directory the agent would work in, made fresh for each test. */
  cwd(): string | Promise<string>
}

/** Features that must say why whenever they are anything short of full. */
const PARTIAL: Array<[HarnessFeature, (adapter: WorkerAdapter) => boolean]> = [
  ['permissionGate', (a) => !a.capabilities.permissionGate],
  ['steer', (a) => a.capabilities.steer !== 'live'],
  ['queue', (a) => a.capabilities.queue !== 'live'],
  ['abort', (a) => a.capabilities.abort !== 'live'],
  ['model', (a) => a.capabilities.model !== 'live'],
  ['thinking', (a) => a.capabilities.thinking !== 'live'],
  ['rename', (a) => a.capabilities.rename !== 'live'],
  ['images', (a) => a.capabilities.images !== 'inline'],
  ['done', (a) => !a.capabilities.done],
  ['resume', (a) => !a.capabilities.resume],
  ['nativeExtensions', (a) => !a.capabilities.nativeExtensions],
  ['skills', (a) => !a.capabilities.skills],
  ['tools', (a) => !a.capabilities.tools],
  ['mcp', (a) => !a.capabilities.mcp],
  ['headless', (a) => !a.capabilities.headless],
  ['accounts', (a) => !a.capabilities.accounts],
  ['spend', (a) => a.capabilities.spend.usd !== 'exact' || !a.capabilities.spend.tokens],
  // Anything less than being askable whenever has to say so in words, because
  // that sentence is exactly what the window shows in place of a number: a
  // harness that only speaks while an agent runs has nothing to show until one
  // has, and "nothing yet" must never be read as "nothing used".
  ['limits', (a) => a.capabilities.spend.limits !== 'anytime'],
]

let counter = 0

export function testHarness(name: string, options: HarnessConformanceOptions): void {
  describe(`${name} WorkerAdapter conformance`, () => {
    const made: WorkerAdapter[] = []

    const adapter = async (): Promise<WorkerAdapter> => {
      const one = await options.make()
      made.push(one)
      return one
    }

    const spec = async (over: Partial<WorkerSpec> = {}): Promise<WorkerSpec> => {
      const task = `conformance/t${++counter}-${process.pid}` as TaskId
      return {
        run: `${task}/agent`,
        task,
        cwd: await options.cwd(),
        prompt: '',
        ...over,
      }
    }

    afterEach(async () => {
      // Letting go, never ending: nothing here started a process to end.
      for (const one of made.splice(0)) await one.detach()
    })

    describe('what it says it can do', () => {
      it('declares every support level from the port', async () => {
        const { capabilities: can } = await adapter()
        for (const support of [
          can.steer,
          can.queue,
          can.abort,
          can.model,
          can.thinking,
          can.rename,
        ]) {
          expect(SUPPORT).toContain(support)
        }
        expect(['inline', 'path', 'none']).toContain(can.images)
        expect(['exact', 'estimate', 'none']).toContain(can.spend.usd)
        expect(LIMITS_SUPPORT).toContain(can.spend.limits)
      })

      it('says how much of a plan is used only in percentages of a window, or not at all', async () => {
        const one = await adapter()
        const limits = one.limits()
        // Never asks anybody — the window reads this every frame — so a fresh
        // adapter has nothing to say, and says that rather than saying zero.
        if (one.capabilities.spend.limits === 'none') expect(limits).toBeNull()
        if (limits === null) return
        expect(Number.isFinite(limits.at)).toBe(true)
        for (const window of [limits.fiveHour, limits.sevenDay]) {
          if (!window) continue
          expect(Number.isFinite(window.used)).toBe(true)
          expect(window.used).toBeGreaterThanOrEqual(0)
          expect(Number.isFinite(window.resetsAt)).toBe(true)
        }
      })

      it('declares the programs it needs in a way anything can look up and ask', async () => {
        // `probe` says whether the one here runs; this says what it is and
        // how to see its version, so keeping it current never means knowing
        // at a call site where this harness came from.
        expect(declarationProblems((await adapter()).programs)).toEqual([])
      })

      it('says why, in words, wherever it does something only partly', async () => {
        const one = await adapter()
        for (const [feature, partial] of PARTIAL) {
          if (!partial(one)) continue
          const why = one.capabilities.why[feature]
          expect(why, `${feature} is limited, and says nothing about why`).toBeTruthy()
          expect(why?.trim().length ?? 0).toBeGreaterThan(10)
        }
      })

      it('offers only thinking levels Tade knows, in order, when it can be told any', async () => {
        const { capabilities: can } = await adapter()
        for (const level of can.thinkingLevels) expect(THINKING_LEVELS).toContain(level)
        const order = can.thinkingLevels.map((level) => THINKING_LEVELS.indexOf(level))
        expect(order).toEqual([...order].sort((a, b) => a - b))
        if (can.thinking !== 'none') expect(can.thinkingLevels.length).toBeGreaterThan(0)
      })

      it('says who it is signed in as without throwing, and why not when it cannot', async () => {
        const status = await (await adapter()).account()
        expect(typeof status.signedIn).toBe('boolean')
        if (!status.signedIn && status.problem !== null)
          expect(status.problem.length).toBeGreaterThan(0)
      })

      it('offers a sign-in to run where a person can see it, never one that carries a secret', async () => {
        const sign = (await adapter()).signIn()
        if (sign) {
          expect(sign.launch.command.length).toBeGreaterThan(0)
          expect(sign.launch.opening ?? []).toEqual([])
          expect(sign.how.length).toBeGreaterThan(10)
        }
      })

      it('probes without throwing, and says what is wrong when it cannot run', async () => {
        const probe = await (await adapter()).probe()
        expect(typeof probe.ok).toBe('boolean')
        if (!probe.ok) expect(probe.problems.length).toBeGreaterThan(0)
      })

      it('says what any tool does, including one it has never heard of', async () => {
        const one = await adapter()
        for (const tool of ['', 'nonsense_tool_x', 'Bash', 'bash', 'Edit', 'read']) {
          expect(['read', 'write', 'exec', 'other']).toContain(one.effectOf(tool))
        }
        expect(one.effectOf('nonsense_tool_x')).toBe('other')
      })

      it('lists models as provider/id, and answers any name without throwing', async () => {
        const one = await adapter()
        for (const model of await one.models()) {
          expect(model.id.startsWith(`${model.provider}/`)).toBe(true)
        }
        const found = await one.resolveModel('surely-not-a-model-anyone-offers')
        if (!found.ok) expect(found.reason.length).toBeGreaterThan(0)
      })

      it('says in its own words when it cannot say which models it runs', async () => {
        // Nothing may fall back to another harness's list, so an empty answer
        // has to carry a sentence instead — and a list has to carry none.
        const offered = await modelsOffered(await adapter())
        expect(offered.harness).toBe((await adapter()).id)
        expect(offered.why === null).toBe(offered.models.length > 0)
        if (offered.why !== null) expect(offered.why.trim().length).toBeGreaterThan(0)
      })

      it('names where a contained agent must write with absolute paths', async () => {
        const writes = (await adapter()).sandboxWrites()
        for (const path of [...writes.paths, ...writes.prefixes])
          expect(isAbsolute(path)).toBe(true)
      })
    })

    describe('the line that comes back to an agent', () => {
      it('never carries the opening instruction, which is said once', async () => {
        const one = await adapter()
        const told = await spec({ prompt: 'fix the flaky login test, it is urgent' })
        const launch = one.launchSpec(told)
        expect(launch.args.join('\n')).not.toContain(told.prompt)
        expect(launch.opening?.join('\n') ?? '').toContain(told.prompt)
      })

      it('is the same line whether or not there is something to say first', async () => {
        const one = await adapter()
        const told = await spec({ prompt: 'start here' })
        const silent = { ...told, prompt: '' }
        expect(one.launchSpec(told).args).toEqual(one.launchSpec(silent).args)
        expect(one.launchSpec(silent).opening ?? []).toEqual([])
      })

      it('is the same line every time it is asked for, so it can be written down', async () => {
        const one = await adapter()
        const told = await spec({ prompt: 'again' })
        const first = one.launchSpec(told)
        const second = one.launchSpec(told)
        expect(second.command).toBe(first.command)
        expect(second.args).toEqual(first.args)
      })

      it('tells the agent where to report, which run it is and which task', async () => {
        const one = await adapter()
        const told = await spec()
        const { env } = one.launchSpec(told)
        expect(env[WORKER_ENV.socket]).toBeTruthy()
        expect(env[WORKER_ENV.run]).toBe(told.run)
        expect(env[WORKER_ENV.task]).toBe(told.task)
        expect(env[WORKER_ENV.approvals]).toMatch(/^(bypass|policy)$/)
      })
    })

    describe('conversations', () => {
      it('names a task the same way every time, and two tasks differently', async () => {
        const one = await adapter()
        const a = 'proj/fix-login' as TaskId
        const b = 'proj/fix-logout' as TaskId
        expect(one.conversationKey(a)).toBe(one.conversationKey(a))
        expect(one.conversationKey(a)).not.toBe(one.conversationKey(b))
        expect((await adapter()).conversationKey(a)).toBe(one.conversationKey(a))
      })

      it('has no conversation, and has spent nothing, for a task never started', async () => {
        const one = await adapter()
        const fresh = await spec()
        expect(await one.hasConversation(fresh.task, fresh.cwd)).toBe(false)
        const spent = await one.spent(fresh.task, fresh.cwd)
        expect(spent.messages).toBe(0)
        expect(spent.tokens).toBe(0)
        expect(spent.usd).toBe(0)
      })
    })

    describe('supervising', () => {
      it('supervises a run it was told about, once', async () => {
        const one = await adapter()
        const told = await spec()
        const handle = await one.supervise(told)
        expect(handle.run).toBe(told.run)
        expect(handle.task).toBe(told.task)
        expect((await one.list()).map((h) => h.run)).toContain(told.run)
        await expect(one.supervise(told)).rejects.toThrow()
      })

      it('lets go of every run on detach, and can supervise it again after', async () => {
        const one = await adapter()
        const told = await spec()
        await one.supervise(told)
        await one.detach()
        expect(await one.list()).toEqual([])
        await one.supervise(told)
        expect((await one.list()).map((h) => h.run)).toContain(told.run)
      })

      it('unsubscribes a listener', async () => {
        const one = await adapter()
        const told = await spec()
        const stop = one.onSignal(told.run, () => {})
        expect(typeof stop).toBe('function')
        stop()
        stop()
      })

      it('says what a run it does not know is thinking with, rather than inventing one', async () => {
        const one = await adapter()
        await expect(one.modelOf('conformance/nobody/agent')).rejects.toBeInstanceOf(
          WorkerNotFoundError,
        )
      })

      it('says a run it does not know is not there', async () => {
        const one = await adapter()
        await expect(one.abort('conformance/nobody/agent')).rejects.toBeInstanceOf(
          WorkerNotFoundError,
        )
      })
    })
  })
}
