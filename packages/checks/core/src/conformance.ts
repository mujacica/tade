import { describe, expect, it } from 'vitest'
import { inOrder, planFor } from './manifest.ts'
import {
  CHECK_STATES,
  type Check,
  type CheckLog,
  type CheckRun,
  type ProjectRef,
  type Runner,
  RunnerError,
  settled,
} from './port.ts'

// The shared suite every Runner must pass, written before any of them.
//
// It asserts the contract, never the content: what a check prints is the
// project's business. What it does assert is the thing this feature could get
// catastrophically wrong — a check nobody ran, or a check still running, drawn
// as a tick. Everything else here is about being watchable while it runs, and
// about leaving nothing behind when it is stopped.
//
// Nothing in the suite reaches the network.

export interface RunnerConformanceOptions {
  /** A project to run in: a directory that exists, made fresh for each test. */
  project(): Promise<ProjectRef> | ProjectRef
  /** Checks this runner understands, in its own terms. */
  checks: {
    /** Ends `passed`. */
    passes: Check
    /** Ends `failed`, with something in its tail. */
    fails: Check
    /** Runs longer than its own `minutes`, so it is stopped. */
    slow: Check
    /** `alone: true`, and takes long enough that an overlap would show. */
    alone: Check
    /** Runs long enough to be aborted in the middle. */
    lingers: Check
  }
  /**
   * A runner that cannot run where it is asked to — its tool is not
   * installed, the directory is not there — for the `unavailable` path.
   */
  missing?():
    | { runner: Runner; project: ProjectRef }
    | Promise<{ runner: Runner; project: ProjectRef }>
}

export function testRunner(
  name: string,
  make: () => Runner | Promise<Runner>,
  options: RunnerConformanceOptions,
): void {
  const { checks } = options

  const runAll = async (
    runner: Runner,
    project: ProjectRef,
    plan: readonly Check[],
    extra: { commit?: string; abortAfterMs?: number } = {},
  ): Promise<{ runs: readonly CheckLog[]; reported: CheckRun[] }> => {
    const reported: CheckRun[] = []
    const controller = new AbortController()
    if (extra.abortAfterMs !== undefined) {
      const timer = setTimeout(() => controller.abort(), extra.abortAfterMs)
      timer.unref?.()
    }
    const runs = await runner.run(project, plan, {
      commit: extra.commit ?? 'a1b2c3d4e5f6',
      by: 'the suite',
      signal: controller.signal,
      onRun: (run) => reported.push({ ...run }),
      onOutput: () => {},
    })
    return { runs, reported }
  }

  describe(`Runner: ${name}`, () => {
    it('declares an id, its words and a full capability set', async () => {
      const runner = await make()
      expect(runner.id).toBeTruthy()
      expect(runner.words.one).toBeTruthy()
      expect(runner.words.many).toBeTruthy()
      const can = runner.capabilities
      for (const key of ['containers', 'services', 'matrix', 'secrets', 'cancel'] as const) {
        expect(typeof can[key]).toBe('boolean')
      }
      expect(['the commands', 'the container']).toContain(can.fidelity)
    })

    it('says whether it can run here without asking anybody', async () => {
      const runner = await make()
      const fetch = globalThis.fetch
      globalThis.fetch = (() => {
        throw new Error('ready() must not touch the network')
      }) as typeof globalThis.fetch
      try {
        expect(await runner.ready(await options.project())).toBeNull()
      } finally {
        globalThis.fetch = fetch
      }
    })

    it('plans the same thing twice, with what is needed first', async () => {
      const runner = await make()
      const project = await options.project()
      const at = { commit: 'a1b2c3d4e5f6', changed: [] as readonly string[] }
      const first = await runner.plan(project, at)
      const second = await runner.plan(project, at)
      expect(second.map((one) => one.id)).toEqual(first.map((one) => one.id))
      for (const [index, check] of first.entries()) {
        for (const need of check.needs ?? []) {
          const before = first.findIndex((one) => one.id === need)
          if (before >= 0) expect(before).toBeLessThan(index)
        }
      }
    })

    it('refuses a plan whose checks wait on each other, naming the cycle', () => {
      const cycle: Check[] = [
        {
          id: 'a',
          title: 'A',
          run: 'true',
          alone: false,
          minutes: 1,
          required: true,
          needs: ['b'],
        },
        {
          id: 'b',
          title: 'B',
          run: 'true',
          alone: false,
          minutes: 1,
          required: true,
          needs: ['a'],
        },
      ]
      try {
        inOrder(cycle)
        expect.unreachable('a cycle must be refused')
      } catch (err) {
        expect(err).toBeInstanceOf(RunnerError)
        expect((err as RunnerError).trouble).toBe('refused')
        expect((err as RunnerError).message).toContain('a')
      }
    })

    it('leaves a check whose paths did not change out of the plan entirely', () => {
      const only: Check[] = [
        {
          id: 'docs',
          title: 'Docs',
          run: 'true',
          alone: false,
          minutes: 1,
          required: true,
          when: ['docs/**'],
        },
      ]
      // Absent, never present and green: a check that was never run must never
      // read as passed.
      expect(planFor(only, { changed: ['src/app.ts'] })).toEqual([])
      expect(planFor(only, { changed: ['docs/readme.md'] })).toHaveLength(1)
    })

    it('reports every state change as it happens, ending in a settled one', async () => {
      const runner = await make()
      const project = await options.project()
      const { runs, reported } = await runAll(runner, project, [checks.passes, checks.fails])
      expect(runs).toHaveLength(2)
      for (const run of [...runs, ...reported]) expect(CHECK_STATES).toContain(run.state)
      for (const check of [checks.passes.id, checks.fails.id]) {
        const mine = reported.filter((run) => run.check === check)
        expect(mine.length).toBeGreaterThan(0)
        expect(settled(mine.at(-1)?.state ?? 'queued')).toBe(true)
        // A run that is queued or running is never reported as passed: that is
        // the bug that draws a red thing green.
        for (const run of mine) {
          if (!settled(run.state)) expect(run.state).not.toBe('passed')
        }
      }
      expect(runs.find((run) => run.check === checks.passes.id)?.state).toBe('passed')
      const failed = runs.find((run) => run.check === checks.fails.id)
      expect(failed?.state).toBe('failed')
      expect(failed?.tail ?? '').not.toBe('')
    })

    it('names the commit on every run, and never issues one id twice', async () => {
      const runner = await make()
      const project = await options.project()
      const { runs, reported } = await runAll(runner, project, [checks.passes, checks.fails], {
        commit: 'deadbeefcafe',
      })
      for (const run of [...runs, ...reported]) expect(run.commit).toBe('deadbeefcafe')
      const ids = runs.map((run) => run.id)
      expect(new Set(ids).size).toBe(ids.length)
      const again = await runAll(runner, project, [checks.passes], { commit: 'deadbeefcafe' })
      expect(ids).not.toContain(again.runs[0]?.id)
    })

    it('stops a check that runs past its own limit, and keeps what it printed', async () => {
      const runner = await make()
      const project = await options.project()
      const { runs } = await runAll(runner, project, [checks.slow])
      expect(runs[0]?.state).toBe('timed out')
      expect(runs[0]?.finishedAt).toBeTruthy()
    })

    it('runs a check that needs the machine by itself', async () => {
      const runner = await make()
      const project = await options.project()
      const { runs } = await runAll(runner, project, [checks.alone, checks.passes])
      const alone = runs.find((run) => run.check === checks.alone.id)
      const other = runs.find((run) => run.check === checks.passes.id)
      expect(alone?.startedAt).toBeTruthy()
      expect(other?.startedAt).toBeTruthy()
      const overlap =
        Date.parse(alone?.startedAt ?? '') < Date.parse(other?.finishedAt ?? '') &&
        Date.parse(other?.startedAt ?? '') < Date.parse(alone?.finishedAt ?? '')
      expect(overlap).toBe(false)
    })

    it('ends every started check when it is stopped, and calls nothing passed', async () => {
      const runner = await make()
      const project = await options.project()
      if (!runner.capabilities.cancel) {
        await expect(
          runAll(runner, project, [checks.lingers], { abortAfterMs: 20 }),
        ).rejects.toMatchObject({ trouble: 'unsupported' })
        return
      }
      const { runs } = await runAll(runner, project, [checks.lingers], { abortAfterMs: 50 })
      for (const run of runs) {
        expect(run.state).not.toBe('passed')
        expect(settled(run.state)).toBe(true)
      }
    })

    it('says what to do when what it needs is not here, and refuses to pretend', async () => {
      if (!options.missing) return
      const { runner, project } = await options.missing()
      const problem = await runner.ready(project)
      expect(typeof problem).toBe('string')
      expect(problem).toBeTruthy()
      // Never a silent fall back to another runner: a runner you selected
      // and did not get is worse than one that was never offered.
      await expect(runAll(runner, project, [checks.passes])).rejects.toMatchObject({
        trouble: 'unavailable',
      })
    })
  })
}
