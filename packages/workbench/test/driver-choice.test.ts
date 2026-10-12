import { join } from 'node:path'
import { ConfigSchema, type LaneId } from '@tade/core'
import { PtyDriver } from '@tade/drivers-pty'
import { TmuxDriver } from '@tade/drivers-tmux'
import { noReporter, type Trouble } from '@tade/telemetry'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { chooseDriver, troubleSaid } from '../src/driver-choice.ts'
import { EventLog } from '../src/events.ts'
import { drivers } from '../src/registry.ts'

// Where lanes go when the driver you asked for is not on this machine.
//
// Injected rather than probed, because the alternative is a test that only
// means something on a machine without tmux — which is not the machine anyone
// runs the suite on, and so would never actually check this.

const unavailable = (id: string, reason: string) => () =>
  Object.assign(new PtyDriver(), {
    id,
    available: async () => ({ ok: false, reason }),
  }) as unknown as PtyDriver

/** A config whose `workspace.fallback` is this, and everything else as unasked. */
const fallingBackTo = (fallback: 'pty' | 'tmux') => ConfigSchema.parse({ workspace: { fallback } })

describe('choosing a driver', () => {
  const home = '/tmp/tade-choice'

  it('uses the one you asked for when it can', async () => {
    const chosen = await chooseDriver({
      wanted: 'pty',
      config: fallingBackTo('pty'),
      home,
      registry: { pty: () => new PtyDriver() },
    })
    expect(chosen.driver.id).toBe('pty')
    expect(chosen.warning).toBe('')
  })

  it('falls back, and says what happened and why', async () => {
    const chosen = await chooseDriver({
      wanted: 'tmux',
      config: fallingBackTo('pty'),
      home,
      registry: { tmux: unavailable('tmux', 'tmux is not installed'), pty: () => new PtyDriver() },
    })
    expect(chosen.driver.id).toBe('pty')
    expect(chosen.warning).toContain('tmux is not installed')
    // The consequence, not just the substitution: this is the part that would
    // otherwise be discovered at the worst possible moment.
    expect(chosen.warning).toContain('will not outlive this window')
  })

  it('says nothing alarming when the fallback can do the same job', async () => {
    const chosen = await chooseDriver({
      wanted: 'ghostly',
      config: fallingBackTo('tmux'),
      home,
      registry: {
        ghostly: unavailable('ghostly', 'no such terminal here'),
        tmux: () => new TmuxDriver({ socket: `tade-test-${process.pid}` }),
      },
    })
    expect(chosen.driver.id).toBe('tmux')
    expect(chosen.warning).not.toContain('outlive')
  })

  // A driver that carried on through something — the pty driver's emulators
  // dying and being started again — has to be able to say so, or a pane drawn
  // afresh from its replay looks like nothing went wrong at all.
  it('tells the driver it made where to say what went wrong, the fallback too', async () => {
    const said: string[] = []
    const handed: Array<((problem: Error) => void) | undefined> = []
    const chosen = await chooseDriver({
      wanted: 'tmux',
      config: fallingBackTo('pty'),
      home,
      registry: {
        tmux: (_home, trouble) => {
          handed.push(trouble)
          return unavailable('tmux', 'no tmux')()
        },
        pty: (_home, trouble) => {
          handed.push(trouble)
          return new PtyDriver({ trouble })
        },
      },
      trouble: (problem) => said.push(problem.message),
    })
    expect(chosen.driver.id).toBe('pty')
    expect(handed).toHaveLength(2)
    handed[1]?.(new Error('the terminal emulators stopped'))
    expect(said).toEqual(['the terminal emulators stopped'])
  })

  // `drivers.pty.scrollback`, from the config to the lanes: a setting that
  // stopped at the registry would be one Tade accepts and ignores.
  it('makes the pty driver with the scrollback the config says, and hands it to the fallback too', async () => {
    const handed: unknown[] = []
    await chooseDriver({
      wanted: 'tmux',
      home,
      registry: {
        tmux: (_home, _trouble, made) => {
          handed.push(made)
          return unavailable('tmux', 'no tmux')()
        },
        pty: (_home, _trouble, made) => {
          handed.push(made)
          return new PtyDriver()
        },
      },
      config: ConfigSchema.parse({
        workspace: { fallback: 'pty' },
        drivers: { pty: { scrollback: 20 } },
      }),
    })
    expect(handed).toEqual([{ pty: { scrollback: 20 } }, { pty: { scrollback: 20 } }])

    const make = drivers.pty
    if (!make) throw new Error('no pty driver in the registry')
    const kept = async (made?: { pty: { scrollback: number } }) => {
      const driver = make(home, undefined, made)
      try {
        const lane = 'keep/long' as LaneId
        await driver.open({
          id: lane,
          cwd: process.cwd(),
          command: process.execPath,
          args: [
            '-e',
            "for (let i = 0; i < 300; i++) console.log('line ' + i)\nsetInterval(() => {}, 1000)",
          ],
          cols: 80,
          rows: 10,
        })
        await expect
          .poll(() => driver.capture(lane, { lines: 10 }), { timeout: 10_000 })
          .toContain('line 299')
        return (await driver.screen(lane)).lines
      } finally {
        await driver.shutdown()
      }
    }
    // Twenty lines above a screen of ten, where unasked it keeps all of it.
    expect(await kept({ pty: { scrollback: 20 } })).toBeLessThanOrEqual(30)
    expect(await kept()).toBeGreaterThanOrEqual(300)
  }, 30_000)

  // And what it says reaches the two places it has to: the journal, which is
  // where somebody reads what went wrong, and the reporter, where it is counted.
  it('puts what a driver says in the journal and in front of the reporter', async () => {
    const log = await EventLog.open({ path: join(tmp('tade-driver-trouble-'), 'events.jsonl') })
    try {
      const reported: Trouble[] = []
      const say = troubleSaid(log, {
        ...noReporter(),
        trouble: (one) => void reported.push(one),
      })
      const problem = new Error('the terminal emulators failed (it stopped answering)')
      say(problem)
      await expect
        .poll(async () => (await log.read({ types: ['warning'] })).map((e) => e.detail))
        .toEqual([{ message: problem.message }])
      expect(reported).toEqual([{ error: problem, where: 'the workspace driver', level: 'error' }])
      // With nowhere to report to, the journal still hears it.
      troubleSaid(log)(new Error('again'))
      await expect.poll(async () => (await log.read({ types: ['warning'] })).length).toBe(2)
    } finally {
      await log.close()
    }
  })

  it('refuses when the fallback is the driver itself', async () => {
    // Asking for the same thing twice is how you say "this or nothing".
    await expect(
      chooseDriver({
        wanted: 'tmux',
        config: fallingBackTo('tmux'),
        home,
        registry: { tmux: unavailable('tmux', 'tmux is not installed') },
      }),
    ).rejects.toThrow(/tmux is not installed/)
  })

  it('refuses when neither can run here', async () => {
    await expect(
      chooseDriver({
        wanted: 'tmux',
        config: fallingBackTo('pty'),
        home,
        registry: {
          tmux: unavailable('tmux', 'no tmux'),
          pty: unavailable('pty', 'no pseudo-terminals'),
        },
      }),
    ).rejects.toThrow(/neither/)
  })

  it('is an error, not a fallback, when the name means nothing at all', async () => {
    await expect(
      chooseDriver({ wanted: 'nowhere', config: fallingBackTo('pty'), home, registry: {} }),
    ).rejects.toThrow(/unknown workspace driver/)
  })
})
