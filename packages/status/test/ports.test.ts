import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { ConfigSchema, type LaneId } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  listeningPorts,
  newPortsHeld,
  PORTS_MS,
  parseListening,
  parseProcessRows,
  portsByLane,
  portsFor,
  processesOf,
} from '../src/ports.ts'
import type { Ran } from '../src/processes.ts'
import { collectStatus } from '../src/status.ts'

describe('reading ps and lsof', () => {
  it('reads every address shape lsof gives, and skips what is not one', () => {
    const out = [
      'p100',
      'f5',
      'n*:3000',
      'f6',
      'n127.0.0.1:5173',
      'p200',
      'n[::1]:8080',
      'n[::1]:8080',
      'nnonsense',
      'px',
      'n*:9',
    ]
    expect(parseListening(out.join('\n'))).toEqual(
      new Map([
        [100, [3000, 5173]],
        [200, [8080]],
      ]),
    )
  })

  it('reads three numbers a line', () => {
    expect(parseProcessRows('  10   1  10\n 11 10 11\nbad line\n')).toEqual([
      { pid: 10, ppid: 1, pgid: 10 },
      { pid: 11, ppid: 10, pgid: 11 },
    ])
  })
})

describe('whose a port is', () => {
  // 10 is a lane; 11 is in its group; 12 is its child in a group of its own,
  // and 13 that child's; 20 is somebody else's, and 21 was 10's until it
  // detached all the way to init.
  const rows = [
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 11, ppid: 10, pgid: 10 },
    { pid: 12, ppid: 10, pgid: 12 },
    { pid: 13, ppid: 12, pgid: 12 },
    { pid: 20, ppid: 1, pgid: 20 },
    { pid: 21, ppid: 1, pgid: 21 },
  ]

  it('is the lane’s group and everything descended from it', () => {
    expect([...processesOf(10, rows)].sort()).toEqual([10, 11, 12, 13])
  })

  it('puts each port on the lane it belongs to, sorted, and claims nobody’s for anybody', () => {
    const listening = new Map([
      [13, [5173]],
      [11, [3000]],
      [20, [8080]],
      [21, [4000]],
    ])
    expect(portsByLane([10, 20], rows, listening)).toEqual(
      new Map([
        [10, [3000, 5173]],
        [20, [8080]],
      ]),
    )
  })
})

describe('listeningPorts', () => {
  const ran = (over: Partial<Ran>): Ran => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    ...over,
  })

  it('reads lsof finding nothing as nothing listening, not as a failure', async () => {
    const looked = await listeningPorts([10], {
      run: async (command) =>
        command === 'ps' ? ran({ stdout: '10 1 10\n' }) : ran({ exitCode: 1 }),
    })
    expect(looked).toEqual({ ports: new Map([[10, []]]), warnings: [] })
  })

  it('never answers an empty list for a look that could not be made', async () => {
    const looked = await listeningPorts([10], {
      run: async (command) =>
        command === 'ps'
          ? ran({ stdout: '10 1 10\n' })
          : ran({ exitCode: undefined, code: 'ENOENT' }),
    })
    expect(looked.ports).toBeNull()
    expect(looked.warnings).toEqual([
      'listening ports could not be looked at: there is no lsof on this machine',
    ])
  })

  it('looks at nothing when there are no lanes', async () => {
    const looked = await listeningPorts([], {
      run: async () => {
        throw new Error('should not be asked')
      },
    })
    expect(looked).toEqual({ ports: new Map(), warnings: [] })
  })

  it('looks again only once the last look is old, or a lane it was not asked about is there', async () => {
    let looks = 0
    const run = async (command: string) => {
      if (command === 'lsof') looks++
      return command === 'ps'
        ? ran({ stdout: '10 1 10\n20 1 20\n' })
        : ran({ stdout: `p10\nn*:${3000 + looks}\n` })
    }
    const held = newPortsHeld()
    const at = async (now: number, lanes = [10], lane = 10) =>
      (await portsFor(lanes, now, held, { run })).ports?.get(lane)
    expect(await at(0)).toEqual([3001])
    expect(await at(PORTS_MS - 1)).toEqual([3001])
    expect(looks).toBe(1)
    expect(await at(PORTS_MS)).toEqual([3002])
    expect(await at(PORTS_MS + 1, [10, 20])).toEqual([3003])
    // A lane gone is not a reason to look: what is left was in the last look.
    expect(await at(PORTS_MS + 2, [20], 20)).toEqual([])
    expect(looks).toBe(3)
    // Nobody holding a look looks every time.
    await portsFor([10], 0, undefined, { run })
    await portsFor([10], 0, undefined, { run })
    expect(looks).toBe(5)
  })

  it('holds a look that could not be made as well, rather than failing twice a beat', async () => {
    let looks = 0
    const run = async (command: string) => {
      if (command === 'lsof') looks++
      return command === 'ps'
        ? ran({ stdout: '10 1 10\n' })
        : ran({ exitCode: undefined, code: 'ENOENT' })
    }
    const held = newPortsHeld()
    await portsFor([10], 0, held, { run })
    const again = await portsFor([10], 1, held, { run })
    expect(looks).toBe(1)
    expect(again.ports).toBeNull()
    expect(again.warnings).toHaveLength(1)
  })
})

// Against the machine: a lane that is a shell, whose child listens.
const hasLsof = spawnSync('lsof', ['-v']).error === undefined

describe.skipIf(!hasLsof)('listeningPorts, on this machine', () => {
  let lane: ChildProcess | null = null
  afterEach(() => {
    if (lane?.pid) process.kill(-lane.pid, 'SIGKILL')
    lane = null
  })

  /** A lane that is a shell, whose child listens on a port it picks; and that port. */
  async function listening(): Promise<{ pid: number; port: number }> {
    const server = `require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port) })`
    lane = spawn('/bin/sh', ['-c', `"${process.execPath}" -e "${server}"; :`], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const port = await new Promise<number>((done) =>
      lane!.stdout!.once('data', (b: Buffer) => done(Number(b.toString().trim()))),
    )
    return { pid: lane.pid!, port }
  }

  it('finds the port a lane’s child is listening on', async () => {
    const { pid, port } = await listening()
    const looked = await listeningPorts([pid])
    expect(looked.warnings).toEqual([])
    expect(looked.ports?.get(pid)).toEqual([port])
  })

  it('puts it on the task’s lane in a look that asked, and nowhere in one that did not', async () => {
    const { pid, port } = await listening()
    const r = mkrepo()
    r.addTask('web', { project: 'app' })
    const record = {
      id: 'app/web/agent' as LaneId,
      kind: 'agent' as const,
      alive: true,
      pid,
      lastOutputAt: null,
      attach: '',
    }
    const look = (ports: boolean) =>
      collectStatus({
        config: ConfigSchema.parse({ projects: { app: { root: r.root } } }),
        now: Date.now(),
        home: tmp('tade-home-'),
        tadeHome: r.home,
        pr: false,
        ports,
        processes: async () => ({
          processes: [],
          servers: { looked: true, alive: 0 },
          warnings: [],
        }),
        liveness: {
          lanes: async () => [],
          records: async (task) => (task === 'app/web' ? [record] : []),
        },
      })
    const asked = await look(true)
    expect(asked.projects[0]?.tasks[0]?.lanes[0]?.ports).toEqual([port])
    const not = await look(false)
    expect(not.projects[0]?.tasks[0]?.lanes[0]?.ports).toBeUndefined()
    // The record the look was handed is not written on.
    expect(record).not.toHaveProperty('ports')
  })
})
