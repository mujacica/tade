import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { feedDir, machineLabel } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { FleetWaits } from '../src/fleet-waits.ts'
import { readTaskFile } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

// What a wait on another machine is settled by, read out of the copies of the
// others' journals kept under a home, and the person dropping a wait on one
// gone quiet — against real task files and a real journal.

const VPS = '11111111-2222-4333-8444-555555555555'
const DAY = 86_400_000

let seq = 0
function line(type: string, task: string, at: number, detail: Record<string, unknown> = {}) {
  seq++
  return JSON.stringify({
    seq,
    ts: new Date(at).toISOString(),
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: null,
    detail,
  })
}

/** A copy of vps's journal as the exchange keeps one: its meta, its lines, where the two last stood. */
function copyOfVps(home: string, lines: string[], synced: number | null = null): void {
  const dir = feedDir(home, VPS)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'feed.json'),
    JSON.stringify({
      machine: VPS,
      name: 'ipax',
      epoch: { id: '0123456789abcdef', at: '2026-11-01T00:00:00.000Z' },
      forks: [],
    }),
  )
  writeFileSync(join(dir, 'events.jsonl'), lines.map((one) => `${one}\n`).join(''))
  if (synced !== null) {
    writeFileSync(
      join(dir, 'sync.json'),
      JSON.stringify({ id: VPS, name: 'ipax', called: 'vps', way: 'to', state: { at: synced } }),
    )
  }
}

describe('the other machines, as a wait reads them', () => {
  it('reads each copy’s task lines, what it calls itself and what this machine calls it, and when it was last heard', async () => {
    const home = tmp('tade-fleet-')
    const at = Date.parse('2026-11-20T10:00:00Z')
    copyOfVps(
      home,
      [
        line('task_created', 'api/a', at),
        line('output', 'api/a', at + 5),
        line('task_done', 'api/a', at + 9),
      ],
      at + 60_000,
    )
    const fleet = await new FleetWaits(home).read('mac')
    expect(fleet.self).toBe('mac')
    expect(fleet.machines).toHaveLength(1)
    const [vps] = fleet.machines
    expect(vps).toMatchObject({ name: 'ipax', called: 'vps', heardAt: at + 60_000 })
    expect(vps?.lines.map((one) => one.type)).toEqual(['task_created', 'task_done'])
    expect(vps?.lines.every((one) => (one as { machine?: string }).machine === 'ipax')).toBe(true)
  })

  it('reads a copy again only when it moved, and says nothing kept where nothing is', async () => {
    const home = tmp('tade-fleet-')
    const waits = new FleetWaits(home)
    expect((await waits.read('mac')).machines).toEqual([])
    const at = Date.parse('2026-11-20T10:00:00Z')
    copyOfVps(home, [line('task_created', 'api/a', at)])
    const first = await waits.read('mac')
    expect(first.machines[0]?.heardAt).toBe(at)
    // Unchanged on disk: the same reading, not a second read.
    expect((await waits.read('mac')).machines[0]).toBe(first.machines[0])
    copyOfVps(home, [line('task_created', 'api/a', at), line('task_done', 'api/a', at + DAY)])
    expect((await waits.read('mac')).machines[0]?.lines).toHaveLength(2)
  })

  it('reads what a machine that links here calls this one, kept beside its copy', async () => {
    const home = tmp('tade-fleet-')
    const at = Date.parse('2026-11-20T10:00:00Z')
    copyOfVps(home, [line('task_created', 'api/a', at)])
    expect((await new FleetWaits(home).read('mac')).machines[0]?.calls).toBeUndefined()
    writeFileSync(
      join(feedDir(home, VPS), 'sync.json'),
      JSON.stringify({ id: VPS, name: 'ipax', calls: 'laptop', way: 'from', state: { at } }),
    )
    expect((await new FleetWaits(home).read('mac')).machines[0]).toMatchObject({
      name: 'ipax',
      calls: 'laptop',
    })
  })
})

describe('dropping a wait on a machine gone quiet', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-drop-')
    writeFileSync(
      join(home, 'config.yaml'),
      `agents:\n  workspace: checkout\nprojects:\n  app:\n    root: ${repo.root}\n`,
    )
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    await client.createTask({
      project: 'app',
      slug: 'b',
      intent: 'b',
      by: 'you',
      start: {
        after: [
          { task: 'vps:api/a', why: 'the migration' },
          { task: 'app/c', why: 'its own' },
        ],
        prompt: 'do b',
        touches: [],
      },
    })
  })

  afterEach(async () => {
    await client.close()
  })

  it('drops only the waits on a machine silent for days, written down with what went', async () => {
    copyOfVps(home, [line('task_created', 'api/a', Date.now() - 4 * DAY)], Date.now() - 4 * DAY)
    expect(await client.dropSilentWaits('app/b', 'you')).toEqual(['vps:api/a'])
    expect((await readTaskFile(home, 'app/b'))?.start?.after).toEqual([
      { task: 'app/c', why: 'its own' },
    ])
    const [changed] = await client.log.read({ types: ['queue_changed'], task: 'app/b' })
    expect(changed?.detail).toMatchObject({
      change: 'after',
      by: 'you',
      replace: true,
      was: ['vps:api/a', 'app/c'],
      dropped: ['vps:api/a'],
    })
  })

  it('refuses where the machine was heard lately, and refuses the orchestrator always', async () => {
    copyOfVps(home, [line('task_created', 'api/a', Date.now() - 3_600_000)], Date.now())
    await expect(client.dropSilentWaits('app/b', 'you')).rejects.toThrow(
      'app/b waits on no machine that has been silent for days',
    )
    await expect(client.dropSilentWaits('app/b', 'orchestrator')).rejects.toThrow(
      'A wait on a machine gone quiet is dropped only by the person',
    )
    expect((await readTaskFile(home, 'app/b'))?.start?.after).toHaveLength(2)
  })

  it('takes a wait on another machine through changeQueued, and refuses one on a machine whose journal is not kept here', async () => {
    copyOfVps(home, [line('task_created', 'api/x', Date.now())], Date.now())
    await client.changeQueued({
      task: 'app/b',
      change: 'after',
      after: [{ task: 'vps:api/x', why: 'also that' }],
      by: 'you',
    })
    expect((await readTaskFile(home, 'app/b'))?.start?.after.map((one) => one.task)).toEqual([
      'vps:api/a',
      'app/c',
      'vps:api/x',
    ])
    await expect(
      client.changeQueued({
        task: 'app/b',
        change: 'after',
        after: [{ task: 'nas:api/x', why: '' }],
        by: 'you',
      }),
    ).rejects.toThrow('no machine called nas has its journal kept here (the ones kept are vps)')
  })

  it('refuses a wait on work on another machine that already waits on this one', async () => {
    copyOfVps(
      home,
      [line('task_created', 'api/x', Date.now(), { after: [`${machineLabel()}:app/b`] })],
      Date.now(),
    )
    await expect(
      client.changeQueued({
        task: 'app/b',
        change: 'after',
        after: [{ task: 'vps:api/x', why: 'its endpoint' }],
        by: 'you',
      }),
    ).rejects.toThrow(
      'app/b cannot wait on vps:api/x: vps:api/x already waits on app/b, so neither could start',
    )
    expect((await readTaskFile(home, 'app/b'))?.start?.after).toHaveLength(2)
  })
})
