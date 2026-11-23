import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHAIN_START,
  chainNext,
  feedDir,
  PeerRoom,
  peersBytes,
  stateHash,
  syncStateOf,
  travels,
} from '@tade/core'
import type { Answer } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { compactJournal } from '../src/compact.ts'
import { EventLog } from '../src/events.ts'
import {
  answerFeeds,
  Feeds,
  type FeedsAsk,
  type Forked,
  GIVE_BYTES,
  readFeeds,
  shareFeeds,
} from '../src/feeds.ts'
import { ensureMachine, type MachineFile, mintEpoch, readMachine } from '../src/machine-file.ts'

// Every machine's journal on every other machine of the person's: real homes
// on disk, each with its journal written by the real `EventLog`, and the far
// half answered in-process with every request and answer through JSON as the
// wire carries them. The route is `@tade/web`'s test, the cadence the window's,
// and two real `tade serve` over sshd the rehearsal's.

const EXTRAS = { notes: 'n', settings: {}, pinned: [] }
const extras = async () => EXTRAS
const EXTRAS_SUMMARY = { feeds: [], ...EXTRAS }

interface Machine {
  name: string
  home: string
  file: MachineFile
  log: EventLog
  feeds: Feeds
}

let clock = Date.parse('2026-11-22T10:00:00Z')
const now = () => {
  clock += 1_000
  return clock
}

async function machine(name: string): Promise<Machine> {
  const home = tmp(`tade-feeds-${name}-`)
  const opened = await ensureMachine(home, now())
  const log = await EventLog.open({ path: join(home, 'events.jsonl'), indexPath: null })
  const feeds = await Feeds.open(home, { ...opened.file, name })
  return { name, home, file: opened.file, log, feeds }
}

/** The far side, as the wire carries it; `drop` makes the nth request fail as a link that went down. */
function wire(far: Machine, drop?: { after: number }) {
  let asked = 0
  const forks: Forked[] = []
  const call = async (ask: FeedsAsk): Promise<Answer> => {
    asked++
    if (drop !== undefined && asked > drop.after) throw new Error('the link went down')
    const body = await answerFeeds(far.feeds, JSON.parse(JSON.stringify(ask)) as FeedsAsk, {
      extras,
      now: now(),
      forked: async (fork) => {
        forks.push(fork)
      },
    })
    return { status: 200, body: JSON.parse(JSON.stringify(body)) }
  }
  return { call, asked: () => asked, forks }
}

function exchange(near: Machine, far: Machine, drop?: { after: number }) {
  const link = wire(far, drop)
  return {
    done: shareFeeds(near.feeds, link.call, { name: far.name, extras, now }),
    link,
  }
}

const KINDS = [
  'task_created',
  'turn_done',
  'usage',
  'output',
  'said',
  'check_ran',
  'input',
] as const

async function write(one: Machine, n: number, pick: () => number = Math.random): Promise<void> {
  for (let i = 0; i < n; i++) {
    const type = KINDS[Math.floor(pick() * KINDS.length)] ?? 'said'
    await one.log.append({
      type,
      task: `p/t${Math.floor(pick() * 5)}`,
      detail: { text: `${one.name} ${i}` },
    })
  }
}

/** The lines of a machine's own journal that travel, exactly as written. */
function travelling(one: Machine): string[] {
  return readFileSync(join(one.home, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '' && travels((JSON.parse(line) as { type: string }).type))
}

/** The lines another machine holds of this one's journal. */
function copyOf(holder: Machine, of: Machine): string[] {
  const path = join(feedDir(holder.home, of.file.id), 'events.jsonl')
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : []
}

describe('this machine’s own journal, as it is served', () => {
  it('is the lines that travel and nothing else, chained in order', async () => {
    const mac = await machine('mac')
    await write(mac, 30)
    const [own] = await mac.feeds.summaries()
    const lines = travelling(mac)
    let h = CHAIN_START
    for (const line of lines) h = chainNext(h, line)
    expect(own).toMatchObject({ machine: mac.file.id, n: lines.length, h, epoch: mac.file.epoch })
    expect(lines.some((line) => line.includes('"type":"output"'))).toBe(false)
    await mac.log.close()
  })
})

describe('one exchange', () => {
  it('leaves both holding each other’s journal line for line, in step', async () => {
    const mac = await machine('mac')
    const vps = await machine('vps')
    await write(mac, 40)
    await write(vps, 25)
    const { done } = exchange(mac, vps)
    const shared = await done
    expect(copyOf(vps, mac)).toEqual(travelling(mac))
    expect(copyOf(mac, vps)).toEqual(travelling(vps))
    expect(shared.took).toBe(travelling(vps).length)
    expect(shared.gave).toBe(travelling(mac).length)
    const state = syncStateOf(shared.here, shared.thereSummary, { forks: 0, conflicts: 0, at: 0 })
    expect(state.word).toBe('in step')
    // And again: one request to look and one to close, and nothing moves.
    const again = exchange(mac, vps)
    const quiet = await again.done
    expect(quiet).toMatchObject({ took: 0, gave: 0, left: 0 })
    expect(again.link.asked()).toBe(2)
    await mac.log.close()
    await vps.log.close()
  })

  it('says on its closing request what the asker calls the far side, which keeps it through a dial the other way', async () => {
    const mac = await machine('mac')
    const vps = await machine('vps')
    const told: (string | undefined)[] = []
    const call = async (ask: FeedsAsk): Promise<Answer> => {
      const body = await answerFeeds(vps.feeds, JSON.parse(JSON.stringify(ask)) as FeedsAsk, {
        extras,
        now: now(),
        synced: async (_peer, here, there, calls) => {
          told.push(calls)
          return syncStateOf(here, there, { forks: 0, conflicts: 0, at: now() })
        },
      })
      return { status: 200, body: JSON.parse(JSON.stringify(body)) }
    }
    await shareFeeds(mac.feeds, call, { name: 'hub', extras, now })
    expect(told).toEqual(['hub'])
    const peer = { id: mac.file.id, name: 'mac' }
    const state = syncStateOf(EXTRAS_SUMMARY, EXTRAS_SUMMARY, { forks: 0, conflicts: 0, at: 0 })
    const kept = () =>
      JSON.parse(readFileSync(join(feedDir(vps.home, mac.file.id), 'sync.json'), 'utf8'))
    await vps.feeds.keepSync(peer, { id: peer.id, name: 'mac', calls: 'hub', way: 'from', state })
    // vps dials the Mac in turn, which says nothing of what the Mac calls vps.
    await vps.feeds.keepSync(peer, { id: peer.id, name: 'mac', called: 'laptop', way: 'to', state })
    expect(kept()).toMatchObject({ called: 'laptop', calls: 'hub', way: 'to' })
    await mac.log.close()
    await vps.log.close()
  })

  it('relays: a laptop that only ever dials the hub holds the Mac’s journal, checked by its chain', async () => {
    const mac = await machine('mac')
    const hub = await machine('hub')
    const laptop = await machine('laptop')
    await write(mac, 20)
    await write(laptop, 10)
    await hub.log.append({ type: 'said', detail: { text: 'on the hub' } })
    await exchange(mac, hub).done
    await exchange(laptop, hub).done
    await exchange(mac, hub).done
    expect(copyOf(laptop, mac)).toEqual(travelling(mac))
    expect(copyOf(mac, laptop)).toEqual(travelling(laptop))
    const relayed = await readFeeds(laptop.home)
    expect(relayed.map((one) => one.name).sort()).toEqual(['hub', 'mac'])
    expect(
      relayed.find((one) => one.name === 'mac')?.events.every((one) => one.machine === 'mac'),
    ).toBe(true)
    for (const one of [mac, hub, laptop]) await one.log.close()
  })

  it('gives a line too long for one request in pieces, and the far side takes it whole', async () => {
    const mac = await machine('mac')
    const vps = await machine('vps')
    await mac.log.append({ type: 'said', detail: { text: 'x'.repeat(GIVE_BYTES * 3) } })
    await write(mac, 3)
    await exchange(mac, vps).done
    expect(copyOf(vps, mac)).toEqual(travelling(mac))
    await mac.log.close()
    await vps.log.close()
  })

  it('refuses a line that does not go on from the copy, a kind that does not travel, and a number that goes back', async () => {
    const mac = await machine('mac')
    const vps = await machine('vps')
    await write(mac, 5)
    await exchange(mac, vps).done
    const [own] = await mac.feeds.summaries()
    if (own === undefined) throw new Error('no summary')
    const given = { machine: own.machine, name: 'mac', epoch: own.epoch, after: own.seq, h: own.h }
    const sample = JSON.stringify({ seq: own.seq + 1, ts: 'x', type: 'output', detail: {} })
    const behind = JSON.stringify({ seq: 1, ts: 'x', type: 'said', detail: {} })
    const at = copyOf(vps, mac).length
    await vps.feeds.take({ ...given, lines: [sample] }, { id: own.machine, name: 'mac' }, now())
    await vps.feeds.take({ ...given, lines: [behind] }, { id: own.machine, name: 'mac' }, now())
    const gap = await vps.feeds.take(
      { ...given, after: own.seq + 50, lines: [] },
      { id: own.machine, name: 'mac' },
      now(),
    )
    expect(gap.took.refused).toBe('from the start')
    expect(copyOf(vps, mac)).toHaveLength(at)
    await mac.log.close()
    await vps.log.close()
  })
})

describe('what other machines may fill this disk with', () => {
  it('stops at one ceiling for all of them together, however many machine ids are made up, and says why', async () => {
    const vps = await machine('vps')
    // A ceiling a few lines wide, walked at every take, so the test counts bytes.
    const room = new PeerRoom(vps.home, { most: 4_096, every: 0 })
    vps.feeds = await Feeds.open(vps.home, { ...vps.file, name: 'vps' }, { room })
    const epoch = vps.file.epoch
    const lineOf = (seq: number) =>
      JSON.stringify({ seq, ts: 'x', type: 'said', detail: { text: 'y'.repeat(400) } })
    const refused: string[] = []
    // Whoever controls one machine hands this one a journal per invented id.
    for (let n = 0; n < 40; n++) {
      const id = `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
      const given = {
        machine: id,
        name: `made-up-${n}`,
        epoch,
        after: 0,
        h: CHAIN_START,
        lines: [lineOf(1), lineOf(2)],
      }
      const took = await vps.feeds.take(given, { id, name: `made-up-${n}` }, now())
      if (took.took.refused !== undefined) refused.push(took.took.refused)
    }
    expect(await peersBytes(vps.home)).toBeLessThanOrEqual(4_096 + 1_024)
    expect(refused.length).toBeGreaterThan(30)
    expect(refused[0]).toBe(room.says())
    expect(room.says()).toContain('safe to delete')
    await vps.log.close()
  })
})

describe('forks', () => {
  it('a restore begins a new life: the copy of the old one is kept beside it and said', async () => {
    const vps = await machine('vps')
    const mac = await machine('mac')
    await write(vps, 10)
    const backup = join(vps.home, 'backup.jsonl')
    copyFileSync(join(vps.home, 'events.jsonl'), backup)
    await write(vps, 10)
    await exchange(mac, vps).done
    const before = copyOf(mac, vps)
    // `tade host restore`: the journal put back as it was, and a new epoch.
    await vps.log.close()
    copyFileSync(backup, join(vps.home, 'events.jsonl'))
    const restored = await mintEpoch(vps.home, now())
    expect(restored.id).toBe(vps.file.id)
    vps.file = restored
    vps.log = await EventLog.open({ path: join(vps.home, 'events.jsonl'), indexPath: null })
    vps.feeds = await Feeds.open(vps.home, { ...restored, name: 'vps' })
    await write(vps, 4)
    const shared = await exchange(mac, vps).done
    expect(shared.forks).toEqual([
      expect.objectContaining({
        machine: vps.file.id,
        why: 'epoch',
        from: 'vps',
        kept: expect.stringContaining('.jsonl'),
      }),
    ])
    const kept = shared.forks[0]?.kept ?? ''
    expect(
      readFileSync(kept, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
    ).toEqual(before)
    expect(copyOf(mac, vps)).toEqual(travelling(vps))
    await vps.log.close()
    await mac.log.close()
  })

  it('the same numbers with another history: the origin’s word is taken and the old copy kept; a relay’s is refused and said', async () => {
    const vps = await machine('vps')
    const mac = await machine('mac')
    const hub = await machine('hub')
    await write(vps, 6)
    await exchange(hub, vps).done
    await exchange(mac, hub).done
    // The journal put back by hand with its epoch kept: the same numbers, other lines.
    await vps.log.close()
    writeFileSync(join(vps.home, 'events.jsonl'), '')
    vps.log = await EventLog.open({ path: join(vps.home, 'events.jsonl'), indexPath: null })
    vps.feeds = await Feeds.open(vps.home, { ...vps.file, name: 'vps' })
    for (let i = 0; i < 8; i++)
      await vps.log.append({ type: 'said', detail: { text: `other ${i}` } })
    const fromOrigin = await exchange(hub, vps).done
    expect(fromOrigin.forks).toEqual([
      expect.objectContaining({ why: 'chain', from: 'vps', kept: expect.any(String) }),
    ])
    expect(copyOf(hub, vps)).toEqual(travelling(vps))
    // The Mac still holds the old history; the hub, a relay, offers the new one.
    const fromRelay = await exchange(mac, hub).done
    expect(fromRelay.forks).toEqual([
      expect.objectContaining({ why: 'chain', from: 'hub', kept: null }),
    ])
    expect(fromRelay.refused.join(' ')).toContain('different history')
    await vps.log.close()
    await mac.log.close()
    await hub.log.close()
  })
})

describe('the origin’s compaction', () => {
  it('never breaks a copy’s cursor: what it drops was never served', async () => {
    const mac = await machine('mac')
    const vps = await machine('vps')
    for (let i = 0; i < 40; i++) {
      await mac.log.append({ type: 'output', lane: 'l', detail: { bytes: 4096 + i } })
      if (i % 4 === 0) await mac.log.append({ type: 'said', detail: { text: `kept ${i}` } })
    }
    await exchange(mac, vps).done
    const held = copyOf(vps, mac)
    await mac.log.close()
    const done = await compactJournal(join(mac.home, 'events.jsonl'), { maxBytes: 1_500 })
    expect(done?.dropped ?? 0).toBeGreaterThan(0)
    mac.log = await EventLog.open({ path: join(mac.home, 'events.jsonl'), indexPath: null })
    mac.feeds = await Feeds.open(mac.home, { ...mac.file, name: 'mac' })
    await mac.log.append({ type: 'said', detail: { text: 'after' } })
    const shared = await exchange(mac, vps).done
    expect(shared.forks).toEqual([])
    expect(shared.gave).toBe(1)
    expect(copyOf(vps, mac)).toEqual([...held, travelling(mac).at(-1)])
    await mac.log.close()
    await vps.log.close()
  })
})

/** A small seeded generator, so a failing partition can be run again. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('partitions', () => {
  // Random lines on three machines, random exchanges between the laptops and
  // the hub, each liable to drop part-way, and one machine restored from a
  // backup somewhere in the middle. Once every link holds again, every
  // machine holds every other's journal, each line exactly once, and every
  // pair's state hashes agree.
  it.each([1, 2, 3, 4, 5, 6])(
    'end in step whatever was dropped (seed %i)',
    async (seed) => {
      const pick = seeded(seed)
      const all = [await machine('mac'), await machine('hub'), await machine('laptop')]
      const [mac, hub, laptop] = all as [Machine, Machine, Machine]
      const pairs: [Machine, Machine][] = [
        [mac, hub],
        [laptop, hub],
      ]
      const restoring = all[Math.floor(pick() * 3)] as Machine
      const backup = join(restoring.home, 'backup.jsonl')
      const restoreAt = 2 + Math.floor(pick() * 4)
      for (let step = 0; step < 8; step++) {
        for (const one of all) await write(one, Math.floor(pick() * 8), pick)
        if (step === 1) copyFileSync(join(restoring.home, 'events.jsonl'), backup)
        if (step === restoreAt) {
          await restoring.log.close()
          copyFileSync(backup, join(restoring.home, 'events.jsonl'))
          restoring.file = await mintEpoch(restoring.home, now())
          restoring.log = await EventLog.open({
            path: join(restoring.home, 'events.jsonl'),
            indexPath: null,
          })
          restoring.feeds = await Feeds.open(restoring.home, {
            ...restoring.file,
            name: restoring.name,
          })
        }
        const [near, far] = pairs[Math.floor(pick() * pairs.length)] as [Machine, Machine]
        const drop = pick() < 0.4 ? { after: 1 + Math.floor(pick() * 3) } : undefined
        await exchange(near, far, drop).done.catch(() => null)
      }
      // Every link holds again: exchanged until nothing moves.
      for (let round = 0; round < 6; round++) {
        let moved = 0
        for (const [near, far] of pairs) {
          const shared = await exchange(near, far).done
          moved += shared.took + shared.gave
        }
        if (moved === 0) break
      }
      for (const holder of all) {
        for (const origin of all) {
          if (holder === origin) continue
          expect(copyOf(holder, origin), `${holder.name}'s copy of ${origin.name}`).toEqual(
            travelling(origin),
          )
        }
      }
      const summaries = await Promise.all(
        all.map(async (one) => ({ feeds: await one.feeds.summaries(), ...EXTRAS })),
      )
      const hashes = summaries.map((one) => stateHash(one))
      expect(new Set(hashes).size).toBe(1)
      for (const one of all) await one.log.close()
    },
    60_000,
  )
})

describe('who this machine is', () => {
  it('is minted once, keeps its id, and begins a new epoch when its journal begins from nothing or is restored', async () => {
    const home = tmp('tade-machine-file-')
    const first = await ensureMachine(home, Date.parse('2026-11-22T10:00:00Z'))
    expect(first).toMatchObject({ minted: true, newEpoch: null })
    writeFileSync(join(home, 'events.jsonl'), '{"seq":1}\n')
    const again = await ensureMachine(home, Date.parse('2026-11-22T11:00:00Z'))
    expect(again).toEqual({ file: first.file, minted: false, newEpoch: null })
    writeFileSync(join(home, 'events.jsonl'), '')
    const emptied = await ensureMachine(home, Date.parse('2026-11-22T12:00:00Z'))
    expect(emptied.file.id).toBe(first.file.id)
    expect(emptied.file.epoch.id).not.toBe(first.file.epoch.id)
    expect(emptied.newEpoch).toContain('begins from nothing')
    const restored = await mintEpoch(home, Date.parse('2026-11-22T13:00:00Z'))
    expect(restored.id).toBe(first.file.id)
    expect(await readMachine(home)).toEqual(restored)
    // One that will not read is set aside, never thrown over.
    writeFileSync(join(home, 'machine.json'), 'not json')
    writeFileSync(join(home, 'events.jsonl'), '{"seq":1}\n')
    const unreadable = await ensureMachine(home, Date.parse('2026-11-22T14:00:00Z'))
    expect(unreadable.minted).toBe(true)
    expect(unreadable.newEpoch).toContain('could not be read')
  })
})

describe('what it costs', () => {
  // Paced by the work and not a clock where the work can be counted: a quiet
  // exchange is two requests whatever the journals weigh, and a fold over
  // every feed reads each line once. The ceilings are for the one thing that
  // is time — reading journals of 20,000 lines — and are twenty times what
  // this laptop takes (about 20 ms to open one, 100 ms to open and fold all
  // four), so a regression shows and a busy machine does not.
  it('opens a journal of 20,000 lines in under half a second, folds four in two, and a quiet exchange is two requests', async () => {
    const hub = await machine('hub')
    const others = [await machine('a'), await machine('b'), await machine('c'), await machine('d')]
    for (const one of others) {
      const lines: string[] = []
      for (let seq = 1; seq <= 20_000; seq++) {
        lines.push(
          JSON.stringify({
            seq,
            ts: '2026-11-22T10:00:00.000Z',
            type: 'turn_done',
            urgency: 'notable',
            task: 'p/t',
            lane: null,
            run: null,
            detail: { n: seq },
          }),
        )
      }
      await one.log.close()
      writeFileSync(join(one.home, 'events.jsonl'), `${lines.join('\n')}\n`)
      one.log = await EventLog.open({ path: join(one.home, 'events.jsonl'), indexPath: null })
      const started = performance.now()
      one.feeds = await Feeds.open(one.home, { ...one.file, name: one.name })
      expect(performance.now() - started).toBeLessThan(500)
      for (let round = 0; round < 40; round++) {
        const shared = await exchange(one, hub).done
        if (shared.left === 0) break
      }
    }
    const started = performance.now()
    const reopened = await Feeds.open(hub.home, { ...hub.file, name: 'hub' })
    const folded = await readFeeds(hub.home, { types: ['task_created'] })
    expect(performance.now() - started).toBeLessThan(2_000)
    expect((await reopened.summaries()).filter((one) => one.n === 20_000)).toHaveLength(4)
    expect(folded.map((one) => one.events.length)).toEqual([0, 0, 0, 0])
    // The first machine takes the other three from the hub, and then nothing moves.
    for (let round = 0; round < 40; round++) {
      const shared = await exchange(others[0] as Machine, hub).done
      if (shared.left === 0 && shared.took === 0) break
    }
    const quiet = exchange(others[0] as Machine, hub)
    expect(await quiet.done).toMatchObject({ took: 0, gave: 0 })
    expect(quiet.link.asked()).toBe(2)
    for (const one of [hub, ...others]) await one.log.close()
  }, 120_000)
})
