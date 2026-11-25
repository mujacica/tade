import { mkdirSync } from 'node:fs'
import {
  ConfigSchema,
  GRACE_MS,
  HANDING_MS,
  LEASE_MS,
  type MachineSeen,
  machineLabel,
  projectDir,
  RENEW_MS,
  STAND_IN_MS,
  type Watched,
} from '@tade/core'
import type { Answer } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { mkrepo, runGit } from '../../../../test/fixtures/mkrepo.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { FleetDuties } from '../../src/wire/duties.ts'
import { seenName } from '../../src/wire/machines-seen.ts'

// The window's and the heart's half of whose each duty is (`duties.ts`), two
// machines in one process: the Mac asks the hub over a link that can be cut,
// the hub answers through its own door, each request through JSON as the
// wire carries it, and one clock both read. The rule is core's, tested there;
// what is held here is what the person asked for of the two together — one
// machine looking at every moment, never two, the Mac taking its watch back
// only once the hub has let go of it and with what it found, and the hub
// taking it over within LEASE_MS of the Mac going quiet.

const REMOTE = {
  ssh: 'north',
  tade: 'tade',
  device: '0123456789abcdef',
  session: '0123456789abcdef.abcdefghijklmnopqrstuvwx',
  csrf: 'abcdefghijklmnopqrstuvwx',
  host: 'localhost:7654',
}

let made = 0

interface Side {
  duties: FleetDuties
  seen: MachineSeen[]
  said: string[]
  id: string
}

/** One machine with the project, its origin the shared repository, and the window's half over a wiring. */
function side(clock: { now: number }, remotes: Record<string, unknown>, watches?: 'here'): Side {
  const repo = mkrepo()
  repo.commit('first')
  runGit(repo.root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git')
  mkdirSync(projectDir(repo.home, 'app'), { recursive: true })
  const id = `00000000-0000-4000-8000-${String(++made).padStart(12, '0')}`
  const seen: MachineSeen[] = []
  const said: string[] = []
  const wire = {
    opts: {
      home: repo.home,
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root, ...(watches ? { watches } : {}) } },
        remotes,
      }),
      client: { machine: { id } },
    },
    now: () => clock.now,
    note: () => {},
  } as unknown as Wiring
  return {
    duties: new FleetDuties(wire, { seen: () => seen, say: (one) => said.push(one) }),
    seen,
    said,
    id,
  }
}

/** The Mac's link to the hub: through the hub's own door, as JSON, while the cable is in. */
function cable(hub: Side): {
  reach: Parameters<FleetDuties['withReach']>[0]
  cut(on: boolean): void
} {
  let cut = false
  return {
    cut: (on) => {
      cut = on
    },
    reach: (name) => ({
      live: !cut,
      remote: { name } as never,
      link: {
        request: async (_name: string, path: string, body: unknown): Promise<Answer> => {
          expect(path).toBe('/api/duties')
          if (cut) throw new Error('the link is down')
          const answer = await hub.duties.door()(JSON.parse(JSON.stringify(body)))
          return { status: 200, body: JSON.parse(JSON.stringify(answer)) }
        },
      } as never,
    }),
  }
}

/** A watch that has looked: where it got to, and the keys it acted on. */
function watched(since: string, keys: readonly string[]): Watched {
  return {
    since,
    seen: new Set(keys),
    looks: [],
    findings: keys.map((key) => ({
      at: 0,
      key,
      title: key,
      task: null,
      told: null,
      problem: null,
    })),
  }
}

const WATCH = {
  id: 'review-branch-checks-app',
  project: 'app',
  watch: 'review.branch-checks',
  input: {},
}
const idle = { wake: () => {}, looking: () => false }

/** Whose the watch is on one side, asked the way the schedules ask it. */
function looks(one: Side, keys: readonly string[] = [], since = 'c0') {
  return one.duties.watch(WATCH, watched(since, keys), true, idle)
}

/** The microtasks a request through the fake link takes, run. */
async function settle(): Promise<void> {
  for (let n = 0; n < 20; n++) await new Promise((done) => setImmediate(done))
}

/** Both sides read which repository their project is: git, asked once. */
async function named(...sides: Side[]): Promise<void> {
  await Promise.all(sides.map((one) => one.duties.begin()))
}

/** One beat on each side, the Mac's request answered. */
async function beat(clock: { now: number }, ms: number, ...sides: Side[]): Promise<void> {
  clock.now += ms
  for (const one of sides) {
    one.duties.beat()
    await settle()
  }
}

describe('whose each duty is, between a Mac and its hub', () => {
  it('has exactly one look, gives the Mac its watch back once the hub lets go, and with what it found', async () => {
    const clock = { now: 1_000_000 }
    const hub = side(clock, {})
    // The Mac has linked here before, so the hub shares its duties.
    hub.seen.push({
      machine: seenName(machineLabel()),
      way: 'from',
      state: 'up',
      at: 0,
      since: null,
    })
    const mac = side(clock, { ipax: REMOTE }, 'here')
    const link = cable(hub)
    mac.duties.withReach(link.reach)
    link.cut(true)
    await named(hub, mac)

    // The hub alone, just started: nothing for GRACE_MS in case somebody is standing in.
    expect(looks(hub, ['k1'], 'c-hub')?.here).toBe(false)
    clock.now += GRACE_MS
    expect(looks(hub, ['k1'], 'c-hub')?.here).toBe(true)
    hub.duties.began(looks(hub)?.duty ?? '')

    // The Mac comes back, ranked first by its setting: asked, and not given it from under the hub.
    link.cut(false)
    // Not answered yet: the older rule's evidence answers meanwhile (`watchWhere`).
    expect(looks(mac)).toBeNull()
    await beat(clock, 1, mac)
    expect(looks(mac)?.here).toBe(false)
    expect(looks(hub, ['k1'], 'c-hub')?.here).toBe(true)
    // The hub lets go on its beat, nothing being mid-look; the Mac is granted at its next ask.
    await beat(clock, 1, hub)
    expect(looks(hub, ['k1'], 'c-hub')?.here).toBe(false)
    await beat(clock, HANDING_MS, mac)
    const back = looks(mac)
    expect(back?.here).toBe(true)
    expect(back?.hand).toMatchObject({ found: ['k1'], since: 'c-hub' })
    expect(looks(hub)?.here).toBe(false)
  })

  it('has the hub take it over within LEASE_MS of the Mac’s cable being cut, and the Mac stop first', async () => {
    const clock = { now: 2_000_000 }
    const hub = side(clock, {})
    hub.seen.push({
      machine: seenName(machineLabel()),
      way: 'from',
      state: 'up',
      at: 0,
      since: null,
    })
    const mac = side(clock, { ipax: REMOTE }, 'here')
    const link = cable(hub)
    mac.duties.withReach(link.reach)
    await named(hub, mac)
    clock.now += GRACE_MS
    looks(mac, ['m1'], 'c-mac')
    await beat(clock, 1, mac)
    expect(looks(mac, ['m1'], 'c-mac')?.here).toBe(true)
    mac.duties.began(looks(mac, ['m1'], 'c-mac')?.duty ?? '')
    await beat(clock, 1, mac)
    expect(looks(hub)?.here).toBe(false)

    // The cable cut: every moment after, at most one of them looks.
    link.cut(true)
    let hubTook: number | null = null
    let macStopped: number | null = null
    const cutAt = clock.now
    for (let at = 0; at <= LEASE_MS + 5_000; at += 1_000) {
      await beat(clock, 1_000, mac, hub)
      const m = looks(mac, ['m1'], 'c-mac')?.here === true
      const h = looks(hub)?.here === true
      expect(m && h).toBe(false)
      if (!m && macStopped === null) macStopped = clock.now - cutAt
      if (h && hubTook === null) hubTook = clock.now - cutAt
    }
    expect(macStopped).not.toBeNull()
    expect(hubTook).not.toBeNull()
    expect(hubTook ?? 0).toBeLessThanOrEqual(LEASE_MS + 1_000)
    expect(macStopped ?? 0).toBeLessThan(hubTook ?? 0)
    // And what the Mac found came with it.
    expect(looks(hub)?.hand).toMatchObject({ found: ['m1'], since: 'c-mac' })
    // Silent rather than gone, the Mac does nothing by itself for STAND_IN_MS.
    expect((looks(mac) as { said?: string } | null)?.said).toContain('silent with no goodbye')
  })

  it('gives the Mac’s watch to the hub at once when the Mac says goodbye', async () => {
    const clock = { now: 3_000_000 }
    const hub = side(clock, {})
    hub.seen.push({
      machine: seenName(machineLabel()),
      way: 'from',
      state: 'up',
      at: 0,
      since: null,
    })
    const mac = side(clock, { ipax: REMOTE }, 'here')
    mac.duties.withReach(cable(hub).reach)
    await named(hub, mac)
    clock.now += GRACE_MS
    looks(mac)
    await beat(clock, 1, mac)
    expect(looks(hub)?.here).toBe(false)
    hub.seen.push({
      machine: seenName(machineLabel()),
      way: 'from',
      state: 'closed',
      at: clock.now,
      since: null,
    })
    await beat(clock, 1, hub)
    expect(looks(hub)?.here).toBe(true)
  })

  it('stands in when the hub said goodbye, and leaves a hub never heard from to the older rule', async () => {
    const clock = { now: 4_000_000 }
    const hub = side(clock, {})
    const link = cable(hub)
    link.cut(true)
    // Never answered — the link still coming up — the older rule's evidence answers.
    const mac = side(clock, { ipax: REMOTE })
    mac.duties.withReach(link.reach)
    await named(mac)
    expect(looks(mac)).toBeNull()
    clock.now += STAND_IN_MS
    expect(looks(mac)).toBeNull()
    // Said goodbye, it is not doing anything: this machine does it until it is back.
    const other = side(clock, { ipax: REMOTE })
    other.seen.push({ machine: 'ipax', way: 'to', state: 'closed', at: clock.now, since: null })
    other.duties.withReach(link.reach)
    await named(other)
    expect(looks(other)?.here).toBe(true)
  })

  it('runs a batch at one commit once between them, on the hub, and the other is told whose it was', async () => {
    const clock = { now: 5_000_000 }
    const hub = side(clock, {})
    hub.seen.push({
      machine: seenName(machineLabel()),
      way: 'from',
      state: 'up',
      at: 0,
      since: null,
    })
    const mac = side(clock, { ipax: REMOTE }, 'here')
    mac.duties.withReach(cable(hub).reach)
    await named(hub, mac)
    clock.now += GRACE_MS
    const head = 'a'.repeat(40)
    // The Mac says watches: here, and asks first: the batch is still the hub's.
    mac.duties.batch('app', head)
    await beat(clock, 1, mac)
    const first = hub.duties.batch('app', head)
    expect(first?.mine).toBe(true)
    hub.duties.began(first?.duty ?? '')
    mac.duties.batch('app', head)
    await beat(clock, 1, mac)
    expect(mac.duties.batch('app', head)?.mine).toBe(false)
    hub.duties.done(first?.duty ?? '')
    await beat(clock, RENEW_MS, mac)
    const after = mac.duties.batch('app', head)
    expect(after?.mine).toBe(false)
    expect(after?.said).toContain('done already')
  })
})
