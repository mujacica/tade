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
    opts: { abortAfterMs?: number; parallel?: number; giveWay?: number } = {},
  ) => {
    const controller = new AbortController()
    if (opts.abortAfterMs !== undefined) {
      const timer = setTimeout(() => controller.abort(), opts.abortAfterMs)
      timer.unref?.()
    }
    const runner = makeLocalRunner({
      parallel: opts.parallel ?? 2,
      ...(opts.giveWay === undefined ? {} : { giveWay: opts.giveWay }),
    })
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

  it('records what a vitest run counted as its summary, not the hint it ends on', async () => {
    const root = tmp('tade-local-')
    const [run] = await runIn(root, [
      check(
        'tests',
        [
          'echo " Test Files  1 failed | 41 passed (42)"',
          'echo "      Tests  2 failed | 400 passed (402)"',
          'echo "    Isolate  42 workers spawned"',
          'echo "             at least ~3.10s faster with isolate: false — reuses workers"',
          'exit 1',
        ].join('; '),
      ),
    ])
    expect(run?.summary).toBe('2 failed · 400 passed · 1 files failed')
  })

  it('kills the whole process group when a check runs past its limit', async () => {
    // Three seconds, not 300 ms: the limit has to outlast the shell getting to
    // `echo $$` on a machine the full suite is loading, or it fires first and
    // there is no pid to ask about — which is how the lowered test below went
    // red at 300 ms.
    const root = tmp('tade-local-')
    const pidFile = join(root, 'pid')
    const [run] = await runIn(root, [
      check('slow', `echo $$ > ${pidFile}; sleep 30`, { minutes: 0.05 }),
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

  it('still kills the whole group when the check it timed out was a lowered one', async () => {
    // The constraint the whole feature is held to: `nice` calls setpriority
    // and then execs in the same process, so the pid the runner is holding is
    // still the group leader and a group signal still reaches everything the
    // check started. A wrapper that forked instead would leave a build
    // running under a run recorded as `timed out`.
    //
    // Three seconds, as above, and here it is the more needed: this line is two
    // shells and an exec at a lower priority, and under the full suite a niced
    // shell is exactly what the machine starves, so at 300 ms the limit fired
    // before it reached `echo $$` and there was no pid to ask about.
    const root = tmp('tade-local-')
    const pidFile = join(root, 'pid')
    const [run] = await runIn(
      root,
      [check('slow', `echo $$ > ${pidFile}; sleep 30`, { minutes: 0.05 })],
      { giveWay: 3 },
    )
    expect(run?.state).toBe('timed out')
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    expect(Number.isInteger(pid)).toBe(true)
    await new Promise((done) => setTimeout(done, 100))
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

  it('hands its commands what the run tells them, so a suite knows the slot it is under', async () => {
    const root = tmp('tade-local-')
    const [run] = await makeLocalRunner().run(
      { name: 'demo', root },
      [check('says', 'echo "slot=$TADE_CHECKS_SLOT"')],
      {
        commit: 'a1b2c3d4',
        by: 'the test',
        signal: new AbortController().signal,
        onRun: () => {},
        onOutput: () => {},
        env: { TADE_CHECKS_SLOT: '/home/checks/slot-0.lock' },
      },
    )
    expect(run?.tail).toContain('slot=/home/checks/slot-0.lock')
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

  // What the check itself can see of its own scheduling priority. Asked of the
  // shell rather than of the first program on the line, because what has to
  // give way is the shell and everything under it: `a && b` runs `b` as a
  // child, and a wrapper on the first word of that line would lower one half
  // of a check and leave the other at full speed.
  const SAYS_ITS_NICE = `${process.execPath} -e "console.log(require('node:os').getPriority())"`
  const niceness = (tail: string | undefined): number =>
    Number.parseInt((tail ?? '').trim().split('\n').at(-1) ?? '', 10)

  it('lowers the shell a check runs in, and everything under it, by what was asked', async () => {
    const root = tmp('tade-local-')
    const base = (await runIn(root, [check('base', SAYS_ITS_NICE)]))[0]
    const lowered = (
      await runIn(root, [check('low', `true && ${SAYS_ITS_NICE}`)], { giveWay: 3 })
    )[0]
    expect(base?.state).toBe('passed')
    expect(lowered?.state).toBe('passed')
    // Against this process rather than against nought: a suite may itself be
    // running niced — which is the whole point of the feature — and what is
    // under test is the step down, not the absolute number. Clamped at 19,
    // because that is where the kernel clamps it.
    expect(niceness(lowered?.tail)).toBe(Math.min(19, niceness(base?.tail) + 3))
  })

  it('runs the line the project wrote, and nothing else, when nobody asked', async () => {
    const root = tmp('tade-local-')
    const base = (await runIn(root, [check('base', SAYS_ITS_NICE)]))[0]
    const off = (await runIn(root, [check('off', SAYS_ITS_NICE)], { giveWay: 0 }))[0]
    expect(niceness(off?.tail)).toBe(niceness(base?.tail))
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
