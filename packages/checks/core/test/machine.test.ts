import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import {
  holdersSaid,
  insideHeldSlot,
  SLOT_ENV,
  slotHolders,
  slotsDir,
  takeMachineSlot,
  waitForMachineSlot,
} from '../src/machine.ts'

// The machine's own bound, over every worktree: six worktrees each holding
// their own lock was six suites at once, and this is what stops the second.

const holder = (where: string) => ({ what: 'tests', where })

/** A slot file as another process would have left it. */
function slotFile(home: string, slot: number, pid: number): void {
  mkdirSync(slotsDir(home), { recursive: true })
  writeFileSync(
    join(slotsDir(home), `slot-${slot}.lock`),
    `${JSON.stringify({ pid, what: 'tests', where: '/elsewhere', at: 'earlier' })}\n`,
  )
}

describe('the machine runs as many suites as it says, from any worktree', () => {
  it('lets one in and tells the next who has it and where', async () => {
    const home = tmp('tade-machine-')
    const first = await takeMachineSlot(home, 1, holder('/work/one'))
    expect('held' in first).toBe(false)
    const second = await takeMachineSlot(home, 1, holder('/work/two'))
    expect('held' in second && second.held.map((one) => [one.pid, one.where])).toEqual([
      [process.pid, '/work/one'],
    ])
    if (!('held' in first)) await first.release()
    expect('held' in (await takeMachineSlot(home, 1, holder('/work/two')))).toBe(false)
  })

  it('lets in as many as the setting says, and not one more', async () => {
    const home = tmp('tade-machine-')
    const got = [
      await takeMachineSlot(home, 2, holder('/a')),
      await takeMachineSlot(home, 2, holder('/b')),
      await takeMachineSlot(home, 2, holder('/c')),
    ]
    expect(got.map((one) => 'held' in one)).toEqual([false, false, true])
    expect((await slotHolders(home)).map((one) => one.where)).toEqual(['/a', '/b'])
  })

  it('takes over a slot whose process is gone — a crash must not hold the machine', async () => {
    const home = tmp('tade-machine-')
    slotFile(home, 0, 999_999_9)
    expect(await slotHolders(home)).toEqual([])
    expect('held' in (await takeMachineSlot(home, 1, holder('/a')))).toBe(false)
  })

  it('counts a run still going in a slot the setting no longer offers', async () => {
    // Two at once was allowed, then somebody said one: the run in the second
    // slot is still running, and a newcomer must wait for it rather than take
    // the first slot because it happens to be free.
    const home = tmp('tade-machine-')
    slotFile(home, 1, process.pid)
    const got = await takeMachineSlot(home, 1, holder('/a'))
    expect('held' in got && got.held.map((one) => one.where)).toEqual(['/elsewhere'])
  })

  it('waits for its turn, says once who it is waiting for, and takes it when it comes', async () => {
    const home = tmp('tade-machine-')
    const first = await takeMachineSlot(home, 1, holder('/work/one'))
    const told: string[] = []
    setTimeout(() => {
      if (!('held' in first)) void first.release()
    }, 80)
    const got = await waitForMachineSlot(home, 1, holder('/work/two'), {
      waitMs: 5_000,
      everyMs: 10,
      onWait: (ahead) => told.push(holdersSaid(ahead)),
    })
    expect('held' in got).toBe(false)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('tests in /work/one')
  })

  it('keeps a process with nothing else to do alive while it waits', async () => {
    // A suite's main process waiting in its global setup has nothing else
    // holding it open. A wait that let it end there ended the suite with exit
    // code 0 and no tests run, which a gate reads as green.
    const home = tmp('tade-machine-')
    const first = await takeMachineSlot(home, 1, holder('/work/one'))
    setTimeout(() => {
      if (!('held' in first)) void first.release()
    }, 300)
    const machine = fileURLToPath(new URL('../src/machine.ts', import.meta.url))
    const script = [
      `const { waitForMachineSlot } = await import(${JSON.stringify(machine)})`,
      `waitForMachineSlot(${JSON.stringify(home)}, 1, { what: 'child', where: '/child' }, { waitMs: 20000, everyMs: 20 })`,
      `  .then((got) => console.log('held' in got ? 'still held' : 'took it'))`,
    ].join('\n')
    const said = await new Promise<string>((done, fail) =>
      execFile(process.execPath, ['--input-type=module', '-e', script], (err, out) =>
        err ? fail(err) : done(out.trim()),
      ),
    )
    expect(said).toBe('took it')
  })

  it('stops waiting when whoever asked has gone', async () => {
    const home = tmp('tade-machine-')
    await takeMachineSlot(home, 1, holder('/work/one'))
    const gone = new AbortController()
    setTimeout(() => gone.abort(), 30)
    const started = Date.now()
    const got = await waitForMachineSlot(home, 1, holder('/work/two'), {
      waitMs: 20_000,
      everyMs: 10,
      signal: gone.signal,
    })
    expect('held' in got).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('gives up at its deadline, saying who still has the machine', async () => {
    const home = tmp('tade-machine-')
    await takeMachineSlot(home, 1, holder('/work/one'))
    const got = await waitForMachineSlot(home, 1, holder('/work/two'), {
      waitMs: 40,
      everyMs: 10,
    })
    expect('held' in got && got.held[0]?.where).toBe('/work/one')
  })
})

describe('a suite inside a run that already holds a slot', () => {
  it('goes through when the slot it is handed is held by somebody alive', async () => {
    const home = tmp('tade-machine-')
    const slot = await takeMachineSlot(home, 1, holder('/a'))
    if ('held' in slot) throw new Error('the slot should have been free')
    expect(await insideHeldSlot(home, { [SLOT_ENV]: slot.path })).toBe(true)
    await slot.release()
    // A variable left in a shell after its run ended is no pass.
    expect(await insideHeldSlot(home, { [SLOT_ENV]: slot.path })).toBe(false)
  })

  it('is no pass for a lock that is not one of the machine’s slots', async () => {
    const home = tmp('tade-machine-')
    const elsewhere = join(tmp('tade-machine-other-'), 'checks.lock')
    writeFileSync(elsewhere, `${JSON.stringify({ pid: process.pid, what: 'x', at: '' })}\n`)
    expect(await insideHeldSlot(home, { [SLOT_ENV]: elsewhere })).toBe(false)
    expect(await insideHeldSlot(home, {})).toBe(false)
  })
})

describe('who has the machine, said', () => {
  it('names what, where and since when, with the home as ~', () => {
    expect(
      holdersSaid(
        [{ pid: 7, what: 'tests', where: '/Users/me/src/app', at: '2026-10-11T14:00:00.000Z' }],
        '/Users/me',
      ),
    ).toBe('tests in ~/src/app (pid 7 since 2026-10-11T14:00:00.000Z)')
    expect(holdersSaid([])).toBe('somebody')
  })
})
