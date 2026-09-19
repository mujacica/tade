import {
  type Check,
  type CheckLog,
  type CheckState,
  type ProjectRef,
  type RunContext,
  type Runner,
  RunnerError,
  type RunnerOptions,
} from '@tade/checks-core'

// A runner that answers from a table.
//
// It is what every other test uses, what makes the window and the gate
// demoable with no project of your own, and the second implementation the
// port needs to stay honest. It spawns nothing and reaches nothing, but it
// takes the same time a real run does — a check that finished before it
// started would hide every ordering bug the suite is there to find.

/** What one check does when it is run. */
export interface ScriptedCheck {
  state?: CheckState
  /** How long it takes, in milliseconds. */
  ms?: number
  tail?: string
  summary?: string
  code?: number
}

export interface ScriptedRunnerOptions extends RunnerOptions {
  /** What each check does, by id. Anything not named passes at once. */
  answers?: Readonly<Record<string, ScriptedCheck>>
  /** What `plan()` hands back. */
  plan?: readonly Check[]
  /** What `ready()` says, when this runner cannot run here. */
  problem?: string | null
  capabilities?: Partial<Runner['capabilities']>
}

export function makeScriptedRunner(options: ScriptedRunnerOptions = {}): Runner {
  const now = options.now ?? Date.now
  const answers = options.answers ?? {}
  const parallel = Math.max(1, options.parallel ?? 2)
  let counter = 0

  const capabilities: Runner['capabilities'] = {
    containers: false,
    services: false,
    matrix: false,
    secrets: false,
    cancel: true,
    fidelity: 'the commands',
    ...options.capabilities,
  }

  const runOne = async (check: Check, ctx: RunContext): Promise<CheckLog> => {
    const answer = answers[check.id] ?? {}
    const id = `${ctx.commit.slice(0, 7)}:${check.id}:scripted:${++counter}`
    const startedAt = new Date(now()).toISOString()
    const base = {
      id,
      check: check.id,
      commit: ctx.commit,
      where: { kind: 'here' as const, runner: 'scripted', host: options.host ?? 'here' },
      required: check.required,
      startedAt,
      by: ctx.by,
    }
    ctx.onRun({ ...base, state: 'running', finishedAt: null, code: null, summary: null })
    const takes = answer.ms ?? 1
    const limit = check.minutes * 60_000
    const stopped = await sleep(Math.min(takes, limit), ctx.signal)
    if (answer.tail) ctx.onOutput(check.id, answer.tail)
    const state: CheckState =
      stopped === 'aborted' ? 'cancelled' : takes > limit ? 'timed out' : (answer.state ?? 'passed')
    const run: CheckLog = {
      ...base,
      state,
      finishedAt: new Date(now()).toISOString(),
      code: answer.code ?? (state === 'passed' ? 0 : 1),
      summary: answer.summary ?? null,
      tail: answer.tail ?? '',
    }
    ctx.onRun(run)
    return run
  }

  return {
    id: 'scripted',
    capabilities,
    words: { one: 'check', many: 'checks' },
    async ready(): Promise<string | null> {
      return options.problem ?? null
    },
    async plan(_project: ProjectRef, _at): Promise<Check[]> {
      return [...(options.plan ?? [])]
    },
    async run(_project, checks, ctx): Promise<readonly CheckLog[]> {
      if (options.problem) throw new RunnerError('unavailable', options.problem)
      if (!capabilities.cancel && ctx.signal.aborted) {
        throw new RunnerError('unsupported', 'this runner cannot stop a run once it has started')
      }
      const done: CheckLog[] = []
      const queue = [...checks]
      for (const check of queue) {
        ctx.onRun({
          id: `${ctx.commit.slice(0, 7)}:${check.id}:scripted:queued`,
          check: check.id,
          commit: ctx.commit,
          state: 'queued',
          where: { kind: 'here', runner: 'scripted', host: options.host ?? 'here' },
          required: check.required,
          startedAt: null,
          finishedAt: null,
          code: null,
          summary: null,
          by: ctx.by,
        })
      }
      while (queue.length > 0) {
        const next = queue.shift()
        if (!next) break
        if (next.alone || parallel === 1) {
          done.push(await runOne(next, ctx))
          continue
        }
        const batch: Check[] = [next]
        while (batch.length < parallel && queue[0] && !queue[0].alone) {
          const one = queue.shift()
          if (one) batch.push(one)
        }
        done.push(...(await Promise.all(batch.map((check) => runOne(check, ctx)))))
      }
      return done
    },
  }
}

/** Wait, unless we are told to stop first. */
function sleep(ms: number, signal: AbortSignal): Promise<'slept' | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise((done) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      done('slept')
    }, ms)
    timer.unref?.()
    function stop() {
      clearTimeout(timer)
      done('aborted')
    }
    signal.addEventListener('abort', stop, { once: true })
  })
}
