import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { feedDir, TAKEN_OUT } from '@tade/core'
import type { Answer } from '@tade/remotes-core'
import { EventLog } from '@tade/workbench/events'
import { ensureMachine, type MachineFile, mintEpoch } from '@tade/workbench/machine-file'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { FleetFeeds } from '../../src/wire/feeds.ts'

// The window's half of every machine's journal on every other (`feeds.ts`):
// the near half run for a machine it links to and the far half the heart
// answers, two real homes with real journals and the request between them
// through JSON as the wire carries it. What is under test is what the window
// adds to the exchange — where two machines stand written down only when the
// word changes, kept for `tade machines`, and a fork written down and said
// once — and not the exchange, which is `@tade/workbench`'s.

const closing: EventLog[] = []
afterEach(async () => {
  for (const log of closing.splice(0)) await log.close()
})

interface Side {
  name: string
  home: string
  file: MachineFile
  log: EventLog
  said: string[]
  feeds: FleetFeeds
}

let clock = Date.parse('2026-11-22T10:00:00Z')

/** What the near side's link paired as on the far side's door, which need not be its name. */
const PAIRED = 'Amir’s laptop'

async function side(name: string): Promise<Side> {
  const home = tmp(`tade-fleet-${name}-`)
  const file = (await ensureMachine(home, clock)).file
  const log = await EventLog.open({ path: join(home, 'events.jsonl'), indexPath: null })
  closing.push(log)
  const one: Side = { name, home, file, log, said: [], feeds: null as never }
  one.feeds = fleetOf(one)
  return one
}

/** The window's half over one side's home, as a window opened on it now would make it. */
function fleetOf(one: Side): FleetFeeds {
  return new FleetFeeds({
    home: one.home,
    configPath: () => join(one.home, 'config.yaml'),
    machine: () => one.file,
    name: () => one.name,
    notes: () => [],
    secrets: () => new Set(),
    lines: (types) => one.log.read({ types }),
    log: async (line) => {
      await one.log.append(line)
    },
    say: (text) => one.said.push(text),
    draw: () => {},
    now: () => {
      clock += 1_000
      return clock
    },
  })
}

/** How the near side reaches the far one: its door, answered by the far side's heart. */
function reach(far: Side) {
  return () => ({
    link: {
      request: async (_name: string, _path: string, body: unknown): Promise<Answer> => ({
        status: 200,
        body: JSON.parse(
          JSON.stringify(
            await far.feeds.web()(JSON.parse(JSON.stringify(body)), 'd1', ` ${PAIRED} `),
          ),
        ),
      }),
    } as never,
    remote: { name: far.name } as never,
    live: true,
  })
}

const synced = async (one: Side) =>
  (await one.log.read({ types: ['remote_synced'] })).map((line) => line.detail)

describe('where this machine and another stand', () => {
  it('is written down on both when the word changes, and only then, and kept for `tade machines`', async () => {
    const mac = await side('mac')
    const vps = await side('vps')
    await mac.log.append({ type: 'said', detail: { text: 'hello' } })
    await vps.log.append({ type: 'task_created', task: 'p/one', detail: {} })
    expect(await mac.feeds.share('vps', reach(vps))).toMatchObject({ took: 1, gave: 1 })
    expect(await synced(mac)).toEqual([
      expect.objectContaining({
        with: 'vps',
        id: vps.file.id,
        way: 'to',
        word: 'in step',
        took: 1,
        gave: 1,
      }),
    ])
    expect(await synced(vps)).toEqual([
      expect.objectContaining({ with: 'mac', id: mac.file.id, way: 'from', word: 'in step' }),
    ])
    expect(mac.feeds.syncedWith('vps')?.said).toBe('in step')
    const kept = JSON.parse(readFileSync(join(feedDir(mac.home, vps.file.id), 'sync.json'), 'utf8'))
    expect(kept).toMatchObject({
      id: vps.file.id,
      called: 'vps',
      way: 'to',
      state: { word: 'in step' },
    })
    // The far side keeps the near one under what it paired as, which its
    // `machine_seen` lines name it by — not what it calls itself.
    const there = JSON.parse(
      readFileSync(join(feedDir(vps.home, mac.file.id), 'sync.json'), 'utf8'),
    )
    expect(there).toMatchObject({ name: 'mac', label: PAIRED, calls: 'vps', way: 'from' })
    // The same word again writes nothing; a new line that crossed is still in step.
    await vps.log.append({ type: 'task_done', task: 'p/one', detail: {} })
    await mac.feeds.share('vps', reach(vps))
    expect(await synced(mac)).toHaveLength(1)
    expect(await synced(vps)).toHaveLength(1)
  })

  it('keeps what the near side calls it as text, with what was taken out marked, and nothing where that is blank', async () => {
    const mac = await side('mac')
    const vps = await side('vps')
    const there = () =>
      JSON.parse(readFileSync(join(feedDir(vps.home, mac.file.id), 'sync.json'), 'utf8'))
    await mac.feeds.share(' \u001b[2Jbox\u0007 ', reach(vps))
    expect(there().calls).toBe(`${TAKEN_OUT}box${TAKEN_OUT}`)
    // A later share that says nothing usable keeps the name already kept.
    await mac.log.append({ type: 'said', detail: { text: 'again' } })
    await mac.feeds.share(' ', reach(vps))
    expect(there().calls).toBe(`${TAKEN_OUT}box${TAKEN_OUT}`)
  })

  it('writes a fork down and says it once', async () => {
    const mac = await side('mac')
    const vps = await side('vps')
    await vps.log.append({ type: 'said', detail: { text: 'one' } })
    const backup = join(vps.home, 'backup.jsonl')
    copyFileSync(join(vps.home, 'events.jsonl'), backup)
    await vps.log.append({ type: 'said', detail: { text: 'two' } })
    await mac.feeds.share('vps', reach(vps))
    // `tade host restore` on the VPS: its journal put back and a new epoch.
    await vps.log.close()
    copyFileSync(backup, join(vps.home, 'events.jsonl'))
    clock += 1_000
    vps.file = await mintEpoch(vps.home, clock)
    vps.log = await EventLog.open({ path: join(vps.home, 'events.jsonl'), indexPath: null })
    closing.push(vps.log)
    vps.feeds = fleetOf(vps)
    await mac.feeds.share('vps', reach(vps))
    await mac.feeds.share('vps', reach(vps))
    const forks = await mac.log.read({ types: ['feed_forked'] })
    expect(forks.map((one) => one.detail)).toEqual([
      expect.objectContaining({ machine: vps.file.id, why: 'epoch', from: 'vps' }),
    ])
    expect(existsSync(String(forks[0]?.detail.kept))).toBe(true)
    expect(mac.said.filter((one) => one.includes('began a new life'))).toHaveLength(1)
  })
})
