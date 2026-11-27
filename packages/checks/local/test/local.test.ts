import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Check, OUT_OF_DISK, ranOutOfDisk, SLEPT, sleptThrough } from '@tade/checks-core'
import { testRunner } from '@tade/checks-core/conformance'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { loweredFrom } from '../../../../test/fixtures/nice.ts'
import { CI_WORKFLOW, ciWorkflow } from '../../../../test/fixtures/workflow.ts'
import { makeLocalRunner } from '../src/index.ts'
import type { SleepAnswer } from '../src/slept.ts'

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

  it('keeps the failures a long run named above the end it keeps', async () => {
    const root = tmp('tade-local-')
    // Twenty failures, each followed by most of what the whole tail can hold.
    const [run] = await runIn(root, [
      check(
        'tests',
        'for i in $(seq 1 20); do echo " FAIL  test/f$i.test.ts > case $i"; head -c 3000 /dev/zero | tr "\\0" x; echo; done; exit 1',
      ),
    ])
    expect(run?.tail.length).toBeLessThanOrEqual(4_000)
    for (let i = 1; i <= 20; i++)
      expect(run?.tail).toContain(` FAIL  test/f${i}.test.ts > case ${i}`)
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
    // under test is the step down, not the absolute number. Clamped where
    // the kernel clamps it.
    expect(niceness(lowered?.tail)).toBe(loweredFrom(niceness(base?.tail), 3))
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

  it('runs a step in the folder it names, and never runs one in a folder a checkout action makes', async () => {
    // vrolta-web's shape: a second repository checked out under `.ci/` by an
    // action, and a build that runs in it. Run at the root, that build failed
    // here with "could not find Cargo.toml" and held every push.
    const repo = mkrepo()
    repo.commit('ci', {
      'site/package.json': '{}\n',
      [CI_WORKFLOW]: [
        'on: [push, pull_request]',
        'jobs:',
        '  check:',
        '    steps:',
        '      - uses: actions/checkout@v5',
        '      - name: where',
        '        run: pwd',
        '        working-directory: site',
        '      - uses: actions/checkout@v5',
        '        with:',
        '          repository: someone/game',
        '          path: .ci/game',
        '      - name: botctl',
        '        run: cargo build --locked --bin botctl',
        '        working-directory: .ci/game/server',
        '',
      ].join('\n'),
    })
    const plan = await makeLocalRunner().plan(
      { name: 'demo', root: repo.root },
      { commit: repo.head(), changed: [] },
    )
    const byId = new Map(plan.map((one) => [one.id, one]))
    expect(byId.get('botctl')).toMatchObject({
      required: false,
      skip: 'it runs in .ci/game/server, which the action actions/checkout@v5 makes',
    })
    const runs = await runIn(
      repo.root,
      plan.filter((one) => !one.skip),
    )
    expect(runs.map((run) => [run.check, run.state])).toEqual([['where', 'passed']])
    expect(runs[0]?.tail.trim()).toBe(join(repo.root, 'site'))
  })
})

const YES: SleepAnswer = { slept: true, trouble: null }

describe('a check the machine slept through', () => {
  // The clock is injected and the check closes the lid itself: when it prints
  // `lid`, an hour passes on the clock and not a moment on the machine. Never
  // a real sleep, and never a wait for one.
  // What the machine says about it is injected too: the jump is only why it is
  // asked, and its answer is what the run is recorded by.
  const HOUR = 3_600_000
  const asked: [number, number][] = []
  const sleptIn = async (run: string, minutes: number, answer: SleepAnswer = YES) => {
    let away = 0
    const runner = makeLocalRunner({
      now: () => Date.now() + away,
      sleptBetween: async (from, to) => {
        asked.push([from, to])
        return answer
      },
    })
    const [one] = await runner.run(
      { name: 'demo', root: tmp('tade-local-') },
      [check('tests', run, { minutes })],
      {
        commit: 'a1b2c3d4',
        by: 'the test',
        signal: new AbortController().signal,
        onRun: () => {},
        onOutput: (_, chunk) => {
          if (chunk.includes('lid')) away = HOUR
        },
      },
    )
    return one
  }

  it('does not count the sleep against its limit', async () => {
    // Three seconds of limit and an hour on the clock: a limit counted on the
    // clock would have ended this the moment the lid opened.
    const run = await sleptIn('echo lid; sleep 1.5; echo done', 0.05)
    expect(run?.state).toBe('passed')
    expect(run?.tail).toContain('done')
  })

  it('is not red when it then runs out of time, and says the machine slept', async () => {
    const run = await sleptIn('echo lid; sleep 30', 0.05)
    expect(run?.state).toBe('cancelled')
    expect(run?.summary).toBe(SLEPT)
    expect(run && sleptThrough(run)).toBe(true)
  })

  it('is not red when it then fails, because what failed may be its own clock', async () => {
    // A suite's own timeouts count the sleep: scroll.test.ts failed at
    // 1047932 ms, the length of the nap, and the run was blamed on a commit.
    const run = await sleptIn('echo lid; sleep 0.2; echo "1 failed" >&2; exit 1', 1)
    expect(run?.state).toBe('cancelled')
    expect(run?.summary).toBe(SLEPT)
    expect(run?.code).toBe(1)
    expect(run?.tail).toContain('1 failed')
  })

  it('is red when the clock jumped and the machine says it never slept, failure and all', async () => {
    // Three related runs one day: a loaded machine's beat came ninety seconds
    // late with the lid open, and thirteen failing tests were recorded as a
    // sleep pmset never saw.
    asked.length = 0
    const run = await sleptIn(
      'echo lid; sleep 0.2; echo " FAIL  test/a.test.ts > keeps the failure"; echo "1 failed" >&2; exit 1',
      1,
      { slept: false, trouble: null },
    )
    expect(asked).toHaveLength(1)
    expect(run?.state).toBe('failed')
    expect(run && sleptThrough(run)).toBe(false)
    expect(run?.summary).toBe('1 failed')
    expect(run?.tail).toContain(' FAIL  test/a.test.ts > keeps the failure')
  })

  it('is red when whether it slept cannot be told, and says so beside the output', async () => {
    const run = await sleptIn('echo lid; sleep 0.2; echo "1 failed" >&2; exit 1', 1, {
      slept: null,
      trouble: 'sysctl could not be asked: ENOENT',
    })
    expect(run?.state).toBe('failed')
    expect(run?.summary).toBe('1 failed')
    expect(run?.tail).toContain(
      '[the clock jumped while this ran, and whether the machine slept could not be told: sysctl could not be asked: ENOENT]',
    )
  })

  it('runs out of time as itself when the machine stayed awake', async () => {
    const run = await sleptIn('echo lid; sleep 30', 0.05, { slept: false, trouble: null })
    expect(run?.state).toBe('timed out')
  })

  it('counts a jump the machine says it stayed up through against its limit, as it runs', async () => {
    // A minute of limit and an hour on the clock the machine denies sleeping
    // through: a check left to run its thirty seconds would have passed past
    // its limit, with the hour counted as nothing.
    asked.length = 0
    const run = await sleptIn('echo lid; sleep 30; echo done', 1, { slept: false, trouble: null })
    expect(run?.state).toBe('timed out')
    expect(run?.tail).not.toContain('done')
    // Asked about the gap, from the beat before it, and not about the whole run.
    const [from, to] = asked[0] ?? [0, 0]
    expect(to - from).toBeGreaterThanOrEqual(HOUR)
  })

  it('leaves a jump out of its limit when whether it slept cannot be told', async () => {
    const run = await sleptIn('echo lid; sleep 1.5; echo done', 0.05, {
      slept: null,
      trouble: 'sysctl could not be asked: ENOENT',
    })
    expect(run?.state).toBe('passed')
    expect(run?.tail).toContain('done')
  })

  it('asks nothing of a run that passed before a beat saw its clock jump, or one whose clock never jumped', async () => {
    asked.length = 0
    expect((await sleptIn('echo lid; echo done', 1))?.state).toBe('passed')
    expect((await sleptIn('echo "1 failed" >&2; exit 1', 1))?.state).toBe('failed')
    expect(asked).toEqual([])
  })
})

describe('a check the disk was full for', () => {
  // How full the disk is, injected; the words are the check's own. The look
  // is what decides: this repository's tests fake a full disk and print them.
  const fullIn = async (run: string, share: number | null | Error) => {
    const looked: string[] = []
    const runner = makeLocalRunner({
      spaceLeft: async (path) => {
        looked.push(path)
        if (share instanceof Error) throw share
        return share
      },
    })
    const root = tmp('tade-local-')
    const [one] = await runner.run({ name: 'demo', root }, [check('tests', run)], {
      commit: 'a1b2c3d4',
      by: 'the test',
      signal: new AbortController().signal,
      onRun: () => {},
      onOutput: () => {},
    })
    return { run: one, looked, root }
  }
  const NO_ROOM =
    'echo "fatal: Unable to create \'x/index.lock\': No space left on device" >&2; exit 1'

  it('is not red when it failed saying so and the disk was full, and says the disk', async () => {
    const { run, looked, root } = await fullIn(NO_ROOM, 0.001)
    expect(run?.state).toBe('cancelled')
    expect(run?.summary).toBe(OUT_OF_DISK)
    expect(run && ranOutOfDisk(run)).toBe(true)
    expect(run?.code).toBe(1)
    expect(run?.tail).toContain('No space left on device')
    expect(looked).toContain(root)
  })

  it('is red when it says so and the disk has room: a faked full disk is the code', async () => {
    const { run } = await fullIn(NO_ROOM, 0.4)
    expect(run?.state).toBe('failed')
    expect(run && ranOutOfDisk(run)).toBe(false)
  })

  it('is red when the disk cannot be told, and says why where a look failed', async () => {
    expect((await fullIn(NO_ROOM, null)).run?.state).toBe('failed')
    const { run } = await fullIn(NO_ROOM, new Error('EACCES: permission denied, statfs'))
    expect(run?.state).toBe('failed')
    expect(run?.tail).toContain(
      '[whether the disk was full could not be told: EACCES: permission denied, statfs]',
    )
  })

  it('is red on a full disk it never said a word about, and passes on one it did', async () => {
    const quiet = await fullIn('echo "1 failed" >&2; exit 1', 0)
    expect(quiet.run?.state).toBe('failed')
    expect(quiet.looked).toEqual([])
    const fine = await fullIn('echo "ENOSPC: no space left on device, write"', 0)
    expect(fine.run?.state).toBe('passed')
  })

  it('finds the words split across two writes', async () => {
    const { run } = await fullIn(
      'printf "fatal: No space left "; sleep 0.2; printf "on device\\n" >&2; exit 1',
      0,
    )
    expect(run?.state).toBe('cancelled')
  })
})
