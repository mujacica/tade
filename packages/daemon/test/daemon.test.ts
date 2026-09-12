import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaneId, WilcoEvent } from '@wilco/core'
import { until } from '@wilco/driver-conformance'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { DaemonClient } from '../src/client.ts'
import { livenessFrom } from '../src/lane-liveness.ts'
import { Daemon } from '../src/server.ts'

const ECHO = fileURLToPath(new URL('../../driver-conformance/src/echo-child.js', import.meta.url))

describe('daemon', () => {
  let home: string
  let socket: string
  let daemon: Daemon
  let client: DaemonClient

  const spawnLane = (id: string, kind: 'agent' | 'shell' = 'shell') =>
    client.spawn({
      id: id as LaneId,
      task: id.split('/').slice(0, 2).join('/'),
      kind,
      cwd: home,
      command: process.execPath,
      args: [ECHO],
      cols: 80,
      rows: 24,
    })

  beforeEach(async () => {
    home = tmp('wilco-daemon-')
    socket = join(home, 'wilco.sock')
    daemon = await Daemon.start({ home, socket, version: '9.9.9' })
    client = await DaemonClient.connect(socket)
  })

  afterEach(async () => {
    await client.close().catch(() => {})
    await daemon.stop().catch(() => {})
  })

  it('reports its own identity and declared capabilities', async () => {
    const info = await client.info()
    expect(info).toMatchObject({ version: '9.9.9', driver: 'pty', lanes: 0, socket })
    expect(info.capabilities.detach).toBe(true)
  })

  it('spawns a lane, writes to it and captures rendered output', async () => {
    const lane = await spawnLane('app/t1/agent', 'agent')
    expect(lane.pid).toBeGreaterThan(0)
    await until(async () => (await client.capture(lane.id as LaneId)).includes('ready'))
    await client.write(lane.id as LaneId, 'hello\n')
    await until(async () => (await client.capture(lane.id as LaneId)).includes('got:hello'))
    expect((await client.lanes()).map((l) => l.id)).toEqual(['app/t1/agent'])
  })

  it('an attached client receives live output and a snapshot of the past', async () => {
    const lane = await spawnLane('app/t2/shell')
    await client.write(lane.id as LaneId, 'before\n')
    await until(async () => (await client.capture(lane.id as LaneId)).includes('got:before'))

    const chunks: string[] = []
    const { snapshot, subscription } = await client.attach(lane.id as LaneId, {
      onData: (c) => chunks.push(c.toString()),
    })
    expect(snapshot).toContain('got:before')
    await client.write(lane.id as LaneId, 'after\n')
    await until(() => chunks.join('').includes('got:after'))
    await client.detach(subscription)

    const before = chunks.length
    await client.write(lane.id as LaneId, 'ignored\n')
    await until(async () => (await client.capture(lane.id as LaneId)).includes('got:ignored'))
    expect(chunks.length).toBe(before)
  })

  it('two simultaneous attachers see identical output', async () => {
    const lane = await spawnLane('app/t3/shell')
    const second = await DaemonClient.connect(socket)
    try {
      const a: string[] = []
      const b: string[] = []
      await client.attach(lane.id as LaneId, { onData: (c) => a.push(c.toString()) })
      await second.attach(lane.id as LaneId, { onData: (c) => b.push(c.toString()) })
      await client.write(lane.id as LaneId, 'shared\n')
      await until(() => a.join('').includes('got:shared') && b.join('').includes('got:shared'))
      expect(a.join('')).toBe(b.join(''))
    } finally {
      await second.close()
    }
  })

  it('resize and title changes are visible to every client', async () => {
    const lane = await spawnLane('app/t4/shell')
    await client.resize(lane.id as LaneId, 100, 30)
    await client.setTitle(lane.id as LaneId, 'app · t4 · shell')
    const record = await client.lane(lane.id as LaneId)
    expect(record).toMatchObject({ title: 'app · t4 · shell' })
    expect(record?.spec.cols).toBe(100)
  })

  it('records lane lifecycle in the event log and streams it to subscribers', async () => {
    const live: WilcoEvent[] = []
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
      // Killing the daemon kills its children: they are its processes.
      await daemon.stop()
      expect(isRunning(pid)).toBe(false)

      daemon = await Daemon.start({ home, socket, version: '9.9.9' })
      client = await DaemonClient.connect(socket)
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

  it('refuses a second daemon on the same socket', async () => {
    await expect(Daemon.start({ home, socket })).rejects.toThrow()
  })

  it('cleans up the socket on stop', async () => {
    await daemon.stop()
    expect(await DaemonClient.isRunning(socket)).toBe(false)
  })
})

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
