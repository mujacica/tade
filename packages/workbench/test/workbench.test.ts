import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneId, TadeEvent } from '@tade/core'
import { ECHO_CHILD, until } from '@tade/drivers-core/conformance'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { livenessFrom } from '../src/lane-liveness.ts'
import { Workbench } from '../src/workbench.ts'

describe('the workbench', () => {
  let home: string
  let client: Workbench

  const spawnLane = (id: string, kind: 'agent' | 'shell' = 'shell') =>
    client.spawn({
      id: id as LaneId,
      task: id.split('/').slice(0, 2).join('/'),
      kind,
      cwd: home,
      command: process.execPath,
      args: [ECHO_CHILD],
      cols: 80,
      rows: 24,
    })

  beforeEach(async () => {
    home = tmp('tade-workbench-')
    client = await Workbench.open({ home, version: '9.9.9' })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('reports its own identity and declared capabilities', async () => {
    const info = await client.info()
    expect(info).toMatchObject({ version: '9.9.9', driver: 'pty', lanes: 0, home })
    // Under pty the lanes are our own children: they go when we go.
    expect(info.capabilities.detach).toBe(false)
  })

  it('spawns a lane, writes to it and captures rendered output', async () => {
    const lane = await spawnLane('app/t1/agent', 'agent')
    expect(lane.pid).toBeGreaterThan(0)
    await until(async () => (await client.capture(lane.id as LaneId)).includes('ready'))
    await client.write(lane.id as LaneId, 'hello\n')
    await until(async () => (await client.capture(lane.id as LaneId)).includes('got:hello'))
    expect((await client.lanes()).map((l) => l.id)).toEqual(['app/t1/agent'])
  })

  it('watching a lane replays what it missed, then follows it live', async () => {
    const lane = await spawnLane('app/t2/shell')
    await client.write(lane.id as LaneId, 'before\n')
    await until(async () => (await client.capture(lane.id as LaneId)).includes('got:before'))

    const chunks: string[] = []
    const watching = await client.watch(lane.id as LaneId, (c) =>
      chunks.push(Buffer.from(c).toString()),
    )
    // The snapshot first, or a new watcher stares at an empty pane until the
    // agent next says something.
    expect(watching.snapshot).toContain('got:before')
    await client.write(lane.id as LaneId, 'after\n')
    await until(() => chunks.join('').includes('got:after'))
    watching.stop()

    const before = chunks.length
    await client.write(lane.id as LaneId, 'ignored\n')
    await until(async () => (await client.capture(lane.id as LaneId)).includes('got:ignored'))
    expect(chunks.length).toBe(before)
  })

  it('two watchers of one lane see the same output', async () => {
    const lane = await spawnLane('app/t3/shell')
    const a: string[] = []
    const b: string[] = []
    const first = await client.watch(lane.id as LaneId, (c) => a.push(Buffer.from(c).toString()))
    const second = await client.watch(lane.id as LaneId, (c) => b.push(Buffer.from(c).toString()))
    try {
      await client.write(lane.id as LaneId, 'shared\n')
      await until(() => a.join('').includes('got:shared') && b.join('').includes('got:shared'))
      expect(a.join('')).toBe(b.join(''))
    } finally {
      first.stop()
      second.stop()
    }
  })

  it('resize and title changes are visible to everything reading the lane', async () => {
    const lane = await spawnLane('app/t4/shell')
    await client.resize(lane.id as LaneId, 100, 30)
    await client.setTitle(lane.id as LaneId, 'app · t4 · shell')
    const record = await client.lane(lane.id as LaneId)
    expect(record).toMatchObject({ title: 'app · t4 · shell' })
    expect(record?.spec.cols).toBe(100)
  })

  it('records lane lifecycle in the event log and streams it to subscribers', async () => {
    const live: TadeEvent[] = []
    await client.subscribe((e) => live.push(e))
    const lane = await spawnLane('app/t5/shell')
    await client.closeLane(lane.id as LaneId)

    await until(() => live.some((e) => e.type === 'lane_closed'))
    const logged = await client.events({ lane: lane.id })
    expect(logged.map((e) => e.type)).toEqual(
      expect.arrayContaining(['lane_opened', 'lane_closed']),
    )
    expect(logged[0]?.detail.command).toBe(process.execPath)
  })

  it('a lane that exits is reported as exited, not as alive', async () => {
    const lane = await spawnLane('app/t6/shell')
    await client.write(lane.id as LaneId, 'exit\n')
    await until(async () => (await client.lane(lane.id as LaneId))?.alive === false)
    expect((await client.lane(lane.id as LaneId))?.exitCode).toBe(0)
  })

  it('lane liveness feeds status as agent signals', async () => {
    await spawnLane('app/t7/agent', 'agent')
    await spawnLane('app/t7/tests', 'shell')
    const signals = await livenessFrom(client).lanes('app/t7')
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ source: 'lane', sessionId: 'app/t7/agent', alive: true })
  })

  describe('restart', () => {
    it('reports lanes as dead rather than pretending they are alive', async () => {
      const lane = await spawnLane('app/t8/agent', 'agent')
      const pid = lane.pid!
      await client.close()
      // Closing Tade closes them: under pty they are its own children.
      // Killing is asynchronous: the signal goes out, then the child exits.
      await until(() => !isRunning(pid))

      client = await Workbench.open({ home, version: '9.9.9' })
      const after = await client.lane(lane.id as LaneId)
      expect(after).toMatchObject({ id: lane.id, alive: false })
      // The spec is kept so the lane can be relaunched.
      expect(after?.spec.command).toBe(process.execPath)

      const relaunched = await client.relaunch(lane.id as LaneId)
      expect(relaunched.alive).toBe(true)
      expect(relaunched.pid).not.toBe(pid)
    })

    it('persists the registry to lanes.json on every mutation', async () => {
      await spawnLane('app/t9/shell')
      const saved = JSON.parse(readFileSync(join(home, 'lanes.json'), 'utf8'))
      expect(saved.driver).toBe('pty')
      expect(saved.lanes.map((l: { id: string }) => l.id)).toEqual(['app/t9/shell'])
    })
  })

  it('refuses a second window on the same home, and says who has it', async () => {
    await expect(Workbench.open({ home })).rejects.toThrow(/already open/)
  })

  it('lets the next window in once this one has closed', async () => {
    await client.close()
    // A lock that outlived the thing holding it would lock you out of your own
    // workbench, which is worse than the corruption it was guarding against.
    client = await Workbench.open({ home, version: '9.9.9' })
    expect(client.info().home).toBe(home)
  })

  it('closing twice is safe', async () => {
    await client.close()
    await expect(client.close()).resolves.toBeUndefined()
  })

  // An open that gets as far as the journal and then goes wrong used to give
  // the lock back and leave the file behind. Nothing noticed, because nothing
  // looks at a descriptor — until the garbage collector reaches the handle, and
  // since Node 20 that is an error thrown at whatever happens to be running.
  // Which in this repository was the test suite, blaming files at random under
  // load for a handle none of them had opened.
  it('lets go of the journal when opening goes wrong, not only of the lock', async () => {
    const before = openDescriptors()
    for (let i = 0; i < TRIES; i++) {
      const fresh = tmp('tade-workbench-')
      // Past the journal, and then as far as the driver: an unknown one throws.
      await expect(Workbench.open({ home: fresh, driver: 'nope' })).rejects.toThrow(
        /unknown workspace driver/,
      )
      // The lock went back too, so the home is not locked out either.
      const second = await Workbench.open({ home: fresh, version: '9.9.9' })
      await second.close()
    }
    expect(openDescriptors() - before).toBeLessThan(TRIES)
  }, 30_000)

  // The same rule on the way out: a step that fails must not take the ones
  // after it with it. A detach that failed leaves a lane running, which the
  // tmux driver does on purpose and is survivable; a journal left open is a
  // descriptor nobody can reach again.
  it('closes the journal and lets the home go even when detaching fails', async () => {
    const before = openDescriptors()
    for (let i = 0; i < TRIES; i++) {
      const fresh = tmp('tade-workbench-')
      const one = await Workbench.open({ home: fresh, version: '9.9.9' })
      const registry = (one as unknown as { registry: { detach(): Promise<void> } }).registry
      registry.detach = () => Promise.reject(new Error('the driver went away'))
      // Said rather than swallowed: the first thing that went wrong is thrown,
      // once everything has been let go of.
      await expect(one.close()).rejects.toThrow(/the driver went away/)
      const next = await Workbench.open({ home: fresh, version: '9.9.9' })
      await next.close()
    }
    expect(openDescriptors() - before).toBeLessThan(TRIES)
  }, 30_000)
})

/** How many times the two tests below repeat what they are watching for a leak. */
const TRIES = 5

/**
 * How many file descriptors this process is holding, now.
 *
 * `/dev/fd` is the process's own open files on both systems this runs on — a
 * symlink to `/proc/self/fd` on Linux. Counting them is the only way to see a
 * leak from in here: a handle nobody holds a reference to any more is invisible
 * until the garbage collector reaches it, which is far too late to blame the
 * code that dropped it.
 *
 * It counts rather than names, because naming is not portable — on macOS
 * `/dev/fd/N` resolves to itself rather than to the file, so a helper that
 * looked for the journal by path answered nought on this machine whether or not
 * it had leaked, which is a test that cannot fail. So the tests repeat what they
 * are testing instead: a leak is a run of descriptors, and a stray one from
 * somewhere else in the process cannot be mistaken for it.
 */
function openDescriptors(): number {
  return readdirSync('/dev/fd').length
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
