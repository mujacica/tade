import { type MachineReaders, Watch } from '@tade/extension-resources'
import { HostSchema } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { figuresOf, HereFigures } from '../../src/wire/host-figures.ts'

// This machine's own figures for the away view and the machines it links to:
// out of the one watch, never waited on, and cheap enough to be asked on every
// beat for every device looking.

const GB = 1024 ** 3
const PS = '  100     1 120000   2.5 node /tade/packages/cli/src/bin.ts'

function readers(over: Partial<MachineReaders> = {}): MachineReaders {
  let busy = 100
  return {
    platform: 'linux',
    cpus: () => {
      busy += 50
      return [{ times: { user: busy, nice: 0, sys: 0, idle: 1000 + busy, irq: 0 } }]
    },
    loadavg: () => [0.5, 0.4, 0.3],
    totalmem: () => 16 * GB,
    freemem: () => 4 * GB,
    vmStat: async () => null,
    volume: async () => ({ dev: 1, room: { free: 40 * GB, total: 500 * GB } }),
    ...over,
  }
}

function here(opts: {
  now: () => number
  exec?: () => Promise<{ code: number; stdout: string; stderr: string }>
}) {
  const said: string[] = []
  let asked = 0
  const watch = new Watch({ readers: readers() })
  const figures = new HereFigures({
    watch,
    ask: () => ({
      every: 5_000,
      now: opts.now(),
      window: 100,
      lanes: [],
      paths: ['/home'],
      exec: async () => {
        asked++
        return (await opts.exec?.()) ?? { code: 0, stdout: PS, stderr: '' }
      },
    }),
    say: (one) => said.push(one),
  })
  return { figures, said, asked: () => asked, watch }
}

const settle = () => new Promise((done) => setTimeout(done, 10))

describe('this machine’s own figures', () => {
  it('are none before the first look, which the first ask starts and never waits on', async () => {
    let now = 0
    const { figures, asked } = here({ now: () => now })
    expect(figures.now()).toBeNull()
    await settle()
    const first = figures.now()
    expect(HostSchema.parse(first)).toEqual(first)
    expect(first).toMatchObject({
      cores: 1,
      cpu: null,
      load: 0.5,
      memory: { used: 12 * GB, total: 16 * GB },
      tade: { cpu: 2.5, memory: 120000 * 1024, processes: 1 },
      disk: { free: 40 * GB, total: 500 * GB, volumes: 1 },
      trail: { cpu: [null], memory: [75] },
    })
    // Fresh, it is handed back as it is: the same object, and no second `ps`.
    expect(figures.now()).toBe(first)
    expect(asked()).toBe(1)
    now = 6_000
    expect(figures.now()).toBe(first)
    await settle()
    const second = figures.now()
    expect(asked()).toBe(2)
    expect(second?.cpu).not.toBeNull()
    expect(second?.trail.cpu).toHaveLength(2)
  })

  it('moves on the wire once an interval, however often the strip looks in between', async () => {
    let now = 0
    const { figures, watch } = here({ now: () => now })
    figures.now()
    await settle()
    const first = figures.now()
    // The strip's own look, two seconds on: the watch has it, the wire does not yet.
    now = 2_000
    await watch.sample({ every: 1_000, now, window: 100, lanes: [], paths: [] })
    expect(watch.latest()?.at).toBe(2_000)
    expect(figures.now()).toBe(first)
    now = 5_000
    await watch.sample({ every: 1_000, now, window: 100, lanes: [], paths: [] })
    expect(figures.now()).not.toBe(first)
  })

  it('says once where a look failed, and keeps the last figures it had', async () => {
    let now = 0
    let fail = false
    const { figures, said } = here({
      now: () => now,
      exec: async () =>
        fail ? { code: 1, stdout: '', stderr: 'ps: gone' } : { code: 0, stdout: PS, stderr: '' },
    })
    figures.now()
    await settle()
    const had = figures.now()
    fail = true
    for (const at of [6_000, 12_000, 18_000]) {
      now = at
      expect(figures.now()).toBe(had)
      await settle()
    }
    expect(said).toEqual([
      'this machine’s figures could not be read: Error: ps could not be read: ps: gone',
    ])
  })

  it('turns a look into the protocol’s figures, the processors bounded to the whole machine', () => {
    const host = figuresOf(
      {
        at: 0,
        took: 1,
        groups: [],
        total: { cpu: 340, rss: GB, processes: 9 },
        machine: { at: 0, cores: 4, cpu: 100.4, load: 3, memory: null, disk: null },
      },
      { cpu: Array(50).fill(1), memory: [] },
    )
    expect(host.cpu).toBe(100)
    expect(host.tade).toEqual({ cpu: 340, memory: GB, processes: 9 })
    expect(host.trail.cpu).toHaveLength(36)
    expect(HostSchema.parse(host)).toEqual(host)
  })
})

describe('what asking costs', () => {
  it('is a few microseconds an ask while the look is fresh, however many devices ask each beat', async () => {
    const now = 0
    const { figures } = here({ now: () => now })
    figures.now()
    await settle()
    const started = performance.now()
    for (let at = 0; at < 20_000; at++) figures.now()
    const each = (performance.now() - started) / 20_000
    expect(each).toBeLessThan(0.05)
  })
})
