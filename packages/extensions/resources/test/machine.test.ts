import { tmpdir } from 'node:os'
import { ExtensionHost } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { machineSaid, resourcesExtension } from '../src/extension.ts'
import {
  cpuBusy,
  cpuTotals,
  diskLow,
  MachineEye,
  type MachineReaders,
  room,
  tightest,
  vmStatUsed,
} from '../src/machine.ts'
import { machineReaders, Watch } from '../src/watch.ts'

// The machine as a whole, beside what Tade uses of it: read off what the
// kernel answers, written here, and once off this machine's own, because the
// point is that looking is cheap where it runs.

const GB = 1024 ** 3
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     5687.
Pages active:                                 447190.
Pages inactive:                               441897.
Pages wired down:                             374072.
Pages purgeable:                                   4.
Anonymous pages:                              561314.
Pages occupied by compressor:                1028222.
`

const core = (busy: number, idle: number) => ({
  times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
})

function readers(over: Partial<MachineReaders> = {}): MachineReaders {
  return {
    platform: 'darwin',
    cpus: () => [core(100, 900), core(100, 900)],
    loadavg: () => [1.5, 1, 0.5],
    totalmem: () => 32 * GB,
    freemem: () => 1 * GB,
    vmStat: async () => VM_STAT,
    volume: async (path) =>
      path.startsWith('/big')
        ? { dev: 1, room: { free: 500 * GB, total: 1000 * GB } }
        : path.startsWith('/small')
          ? { dev: 2, room: { free: 5 * GB, total: 100 * GB } }
          : null,
    ...over,
  }
}

describe('what the machine is doing', () => {
  it('counts memory used as a Mac does: what apps hold, wired, and the compressor', () => {
    expect(vmStatUsed(VM_STAT)).toBe((561314 - 4 + 374072 + 1028222) * 16384)
    // A macOS that prints something else says nothing rather than a wrong figure.
    expect(vmStatUsed('Pages free: 12.')).toBeNull()
    expect(vmStatUsed('Mach Virtual Memory Statistics: (page size of 4096 bytes)\n')).toBeNull()
  })

  it('works out the processors’ share between two looks, and says nothing of the first', () => {
    const before = cpuTotals([core(100, 900)])
    expect(cpuBusy(null, before)).toBeNull()
    expect(cpuBusy(before, cpuTotals([core(150, 950)]))).toBe(50)
    // No time between them is not an idle machine.
    expect(cpuBusy(before, before)).toBeNull()
  })

  it('names the tightest volume, by the share left, and how many there are', () => {
    expect(
      tightest([
        { free: 500 * GB, total: 1000 * GB },
        { free: 5 * GB, total: 100 * GB },
      ]),
    ).toEqual({ free: 5 * GB, total: 100 * GB, volumes: 2 })
    expect(tightest([])).toBeNull()
    expect(diskLow({ free: 5 * GB, total: 100 * GB })).toBe(true)
    expect(diskLow({ free: 11 * GB, total: 100 * GB })).toBe(false)
    expect(diskLow(null)).toBe(false)
  })

  it('looks at processors, load, memory and every distinct disk, unknown where it cannot say', async () => {
    let busy = 100
    const eye = new MachineEye(readers({ cpus: () => [core(busy, 900), core(busy, 900)] }))
    const first = await eye.look(['/big/home', '/big/project', '/small/project', '/gone'], 1)
    expect(first).toEqual({
      at: 1,
      cores: 2,
      cpu: null,
      load: 1.5,
      memory: { used: (561314 - 4 + 374072 + 1028222) * 16384, total: 32 * GB },
      disk: { free: 5 * GB, total: 100 * GB, volumes: 2 },
    })
    busy = 200
    const second = await eye.look(['/big/home'], 2)
    expect(second.cpu).toBeCloseTo(100)
    expect(second.disk).toEqual({ free: 500 * GB, total: 1000 * GB, volumes: 1 })

    // On Linux the kernel's own available; on macOS with no vm_stat, unknown.
    const linux = await new MachineEye(readers({ platform: 'linux' })).look([], 1)
    expect(linux.memory).toEqual({ used: 31 * GB, total: 32 * GB })
    expect(linux.disk).toBeNull()
    const blind = await new MachineEye(
      readers({ vmStat: async () => null, cpus: () => [], loadavg: () => [0] }),
    ).look([], 1)
    expect(blind.memory).toBeNull()
    expect(blind.cores).toBeNull()
    expect(blind.cpu).toBeNull()
    const windows = await new MachineEye(readers({ platform: 'win32' })).look([], 1)
    expect(windows.load).toBeNull()
    expect(windows.memory).toBeNull()
  })

  it('says the machine in a sentence, and what it cannot say as a dash', () => {
    expect(
      machineSaid({
        at: 0,
        cores: 8,
        cpu: 23,
        load: 2.5,
        memory: { used: 20 * GB, total: 32 * GB },
        disk: { free: 5 * GB, total: 100 * GB, volumes: 2 },
      }),
    ).toBe(
      '**This machine:** CPU 23% of 8 cores, load 2.50 · memory 20.0 GB of 32.0 GB · disk 5.0 GB free of 100 GB (the fullest of 2 volumes) — **running out**.',
    )
    expect(
      machineSaid({ at: 0, cores: null, cpu: null, load: null, memory: null, disk: null }),
    ).toBe('**This machine:** CPU — · memory — · disk —.')
    expect(room(1.5 * 1024 ** 4)).toBe('1.5 TB')
    expect(room(840 * 1024 ** 2)).toBe('840 MB')
  })
})

describe('the strip’s disk', () => {
  const table = '  100     1 120000   2.5 node /tade/packages/cli/src/bin.ts'
  const tade = {
    pid: 100,
    lanes: () => [],
    agents: () => [],
    startAgent: async () => ({ task: '', worktree: '' }),
  }
  const strip = async (machine: Partial<MachineReaders>) => {
    const extensions = await ExtensionHost.load({
      builtin: [resourcesExtension({ watch: new Watch({ readers: readers(machine) }) })],
      config: { extensions: {}, projects: { shop: { root: '/small/shop' } } },
      home: '/big/home',
      exec: async () => ({ code: 0, stdout: table, stderr: '' }),
    })
    const [status] = await extensions.statuses(tade)
    return status?.item
  }

  it('says the room left on the fullest disk the work is on, and warns under a tenth', async () => {
    expect(await strip({})).toEqual({ text: '2.5% · 117 MB · 5.0 GB free', tone: 'warning' })
    expect(
      await strip({ volume: async () => ({ dev: 1, room: { free: 50 * GB, total: 100 * GB } }) }),
    ).toEqual({ text: '2.5% · 117 MB · 50 GB free', tone: 'quiet' })
    // A disk that cannot be asked is left out, never drawn as nought.
    expect(await strip({ volume: async () => null })).toEqual({
      text: '2.5% · 117 MB',
      tone: 'quiet',
    })
  })

  it('is one ps for every reader at once, and the trail of the machine for a sparkline', async () => {
    let calls = 0
    const watch = new Watch({ readers: readers() })
    const ask = {
      every: 5_000,
      now: 0,
      window: null,
      lanes: [],
      paths: [],
      exec: async () => {
        calls++
        return { code: 0, stdout: table, stderr: '' }
      },
    }
    await Promise.all([watch.sample(ask), watch.sample(ask), watch.sample(ask)])
    expect(calls).toBe(1)
    await watch.sample({ ...ask, now: 4_000 })
    expect(calls).toBe(1)
    await watch.sample({ ...ask, now: 6_000 })
    expect(calls).toBe(2)
    const trail = watch.trail(30)
    expect(trail.cpu).toEqual([null, null])
    expect(trail.memory).toHaveLength(2)
    expect(trail.memory[0]).toBeCloseTo(93.6, 0)
  })
})

describe('what looking at the machine costs', () => {
  it('reads this machine’s processors, memory and disk in a few milliseconds', async () => {
    const eye = new MachineEye(machineReaders)
    await eye.look([tmpdir()], 0)
    const started = performance.now()
    const look = await eye.look([tmpdir(), process.cwd()], 1)
    const took = performance.now() - started
    // vm_stat is a spawn on macOS; everything else is a call into the kernel.
    expect(took).toBeLessThan(500)
    expect(look.cores).toBeGreaterThan(0)
    expect(look.disk?.total).toBeGreaterThan(0)
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(look.memory?.total).toBeGreaterThan(0)
      expect(look.memory?.used).toBeGreaterThan(0)
    }
  })
})
