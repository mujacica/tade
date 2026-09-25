import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Check } from '@tade/checks-core'
import { testRunner } from '@tade/checks-core/conformance'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { CI_WORKFLOW, ciWorkflow } from '../../../../test/fixtures/workflow.ts'
import { makeLocalRunner } from '../src/index.ts'

// Real commands in a real directory. Never a mocked shell: the thing worth
// knowing about a runner is what happens to the processes it started.

const check = (id: string, run: string, over: Partial<Check> = {}): Check => ({
  id,
  title: id,
  run,
  alone: false,
  minutes: 1,
  required: true,
  ...over,
})

testRunner('local', () => makeLocalRunner(), {
  project: () => ({ name: 'demo', root: tmp('tade-local-') }),
  checks: {
    passes: check('passes', 'echo hello'),
    fails: check('fails', 'echo "8 failed" >&2; exit 1'),
    slow: check('slow', 'sleep 30', { minutes: 0.005 }),
    alone: check('alone', 'sleep 0.3', { alone: true }),
    lingers: check('lingers', 'sleep 30'),
  },
  missing: () => ({
    runner: makeLocalRunner(),
    project: { name: 'gone', root: join(tmp('tade-local-'), 'not-there') },
  }),
})

describe('the local runner', () => {
  const runIn = async (
    root: string,
    checks: readonly Check[],
    opts: { abortAfterMs?: number; parallel?: number } = {},
  ) => {
    const controller = new AbortController()
    if (opts.abortAfterMs !== undefined) {
      const timer = setTimeout(() => controller.abort(), opts.abortAfterMs)
      timer.unref?.()
    }
    const runner = makeLocalRunner({ parallel: opts.parallel ?? 2 })
    return runner.run({ name: 'demo', root }, checks, {
      commit: 'a1b2c3d4',
      by: 'the test',
      signal: controller.signal,
      onRun: () => {},
      onOutput: () => {},
    })
  }

  it('keeps what a failing check said, and its last line as the summary', async () => {
    const root = tmp('tade-local-')
    const [run] = await runIn(root, [check('fails', 'echo one; echo "8 failed"; exit 2')])
    expect(run?.state).toBe('failed')
    expect(run?.code).toBe(2)
    expect(run?.tail).toContain('8 failed')
    expect(run?.summary).toBe('8 failed')
  })

  it('kills the whole process group when a check runs past its limit', async () => {
    const root = tmp('tade-local-')
    const pidFile = join(root, 'pid')
    const [run] = await runIn(root, [
      check('slow', `echo $$ > ${pidFile}; sleep 30`, { minutes: 0.005 }),
    ])
    expect(run?.state).toBe('timed out')
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    expect(Number.isInteger(pid)).toBe(true)
    await new Promise((done) => setTimeout(done, 100))
    // Asserted by pid, not by hope: a check that "timed out" while its shell
    // kept building is a lie the window would draw as red and the machine
    // would keep paying for.
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('stops everything it started when the run is abandoned, and calls none of it passed', async () => {
    const root = tmp('tade-local-')
    const runs = await runIn(root, [check('lingers', 'sleep 30')], { abortAfterMs: 50 })
    expect(runs[0]?.state).toBe('cancelled')
    expect(runs.some((run) => run.state === 'passed')).toBe(false)
  })

  it('runs a check that needs the machine on its own, and the rest together', async () => {
    const root = tmp('tade-local-')
    const runs = await runIn(root, [
      check('alone', 'sleep 0.3', { alone: true }),
      check('a', 'sleep 0.3'),
      check('b', 'sleep 0.3'),
    ])
    const at = (id: string) => runs.find((run) => run.check === id)
    const overlaps = (one: string, other: string) =>
      Date.parse(at(one)?.startedAt ?? '') < Date.parse(at(other)?.finishedAt ?? '') &&
      Date.parse(at(other)?.startedAt ?? '') < Date.parse(at(one)?.finishedAt ?? '')
    expect(overlaps('alone', 'a')).toBe(false)
    expect(overlaps('a', 'b')).toBe(true)
  })

  it('does not run a check whose need did not pass, and says why', async () => {
    const root = tmp('tade-local-')
    const runs = await runIn(
      root,
      [check('types', 'exit 1'), check('tests', 'echo ran', { needs: ['types'] })],
      { parallel: 1 },
    )
    const tests = runs.find((run) => run.check === 'tests')
    expect(tests?.state).toBe('skipped')
    expect(tests?.summary).toContain('types')
  })

  it('reads what the project already says to work out what would run', async () => {
    const root = tmp('tade-local-')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(root, CI_WORKFLOW), ciWorkflow([{ id: 'tests', run: 'pnpm test' }]))
    const plan = await makeLocalRunner().plan(
      { name: 'demo', root },
      { commit: 'a1b2c3d4', changed: [] },
    )
    expect(plan.map((one) => one.id)).toEqual(['tests'])
  })
})
