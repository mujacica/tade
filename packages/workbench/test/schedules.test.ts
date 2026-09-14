import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Schedule } from '@wilco/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { foldSchedules, readSchedules } from '../src/schedules.ts'
import { Workbench } from '../src/workbench.ts'

const deps = (over: Partial<Schedule> = {}): Schedule => ({
  id: 'deps-weekly',
  name: 'deps weekly',
  project: 'app',
  said: 'every monday morning update our dependencies',
  when: { every: 'week', on: ['mon'], times: ['09:00'] },
  does: { kind: 'agent', prompt: 'Update dependencies within their major versions.' },
  missed: 'once',
  by: 'orchestrator',
  created: '2026-09-15T08:00:00.000Z',
  ...over,
})

describe('schedules', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('wilco-schedules-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home, version: '9.9.9' })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('keeps every change as a line of its own, with who made it', async () => {
    await client.setSchedule(deps(), 'orchestrator')
    await client.changeSchedule({ id: 'deps-weekly', change: 'rename', name: 'Mondays', by: 'you' })
    await client.changeSchedule({ id: 'deps-weekly', change: 'pause', by: 'you' })
    expect(client.schedules()).toMatchObject([{ id: 'deps-weekly', name: 'Mondays', paused: true }])

    // A change to what it does keeps it paused and keeps its new name: both were somebody's choice.
    await client.setSchedule(deps({ does: { kind: 'ask', prompt: 'Anything to update?' } }), 'you')
    expect(client.schedules()[0]).toMatchObject({
      name: 'Mondays',
      paused: true,
      does: { kind: 'ask' },
    })

    const lines = readFileSync(join(home, 'schedules.jsonl'), 'utf8').trim().split('\n')
    expect(lines.map((line) => JSON.parse(line).op)).toEqual(['set', 'rename', 'pause', 'set'])
    expect(lines.map((line) => JSON.parse(line).by)).toEqual(['orchestrator', 'you', 'you', 'you'])
    expect(statSync(join(home, 'schedules.jsonl')).mode & 0o777).toBe(0o600)
    // Read without the window, for anything that only asks.
    expect(readSchedules(home).map((one) => one.name)).toEqual(['Mondays'])

    await client.changeSchedule({ id: 'deps-weekly', change: 'remove', by: 'you' })
    expect(client.schedules()).toEqual([])
    const changes = await client.events({ types: ['schedule_changed'] })
    expect(changes.map((event) => event.detail.change)).toEqual([
      'set',
      'rename',
      'pause',
      'set',
      'remove',
    ])
  })

  it('skips a line it cannot read rather than losing the rest', () => {
    const good = JSON.stringify({
      op: 'set',
      schedule: deps(),
      by: 'you',
      at: '2026-09-15T08:00:00Z',
    })
    expect(foldSchedules(`${good}\n{"op":"set","schedule":{}\nnot json\n`)).toHaveLength(1)
  })

  it('refuses a rule it could not keep, and a project it does not know', async () => {
    await expect(client.setSchedule(deps({ when: { every: 'fortnight' } }), 'you')).rejects.toThrow(
      /is neither a length/,
    )
    await expect(client.setSchedule(deps({ project: 'nope' }), 'you')).rejects.toThrow(
      /unknown project/,
    )
    await expect(
      client.changeSchedule({ id: 'ghost', change: 'pause', by: 'you' }),
    ).rejects.toThrow(/no schedule called ghost/)
  })

  it('makes queued work each time it runs, named for it and the day, never the same name twice', async () => {
    await client.setSchedule(deps(), 'orchestrator')
    const now = Date.parse('2026-09-21T09:00:30Z')
    const first = await client.fireSchedule(
      'deps-weekly',
      { run: true, due: now - 30_000, missed: 0 },
      now,
    )
    const second = await client.fireSchedule('deps-weekly', { run: true, due: now, missed: 0 }, now)
    expect([first.task, second.task]).toEqual(['app/deps-weekly-0921', 'app/deps-weekly-0921-2'])
    const file = readFileSync(
      join(repo.root, '.wilco', 'tasks', 'deps-weekly-0921', 'task.yaml'),
      'utf8',
    )
    expect(file).toContain('by: schedule:deps-weekly')
    expect(file).toContain('prompt: Update dependencies within their major versions.')
    const fired = await client.events({ types: ['schedule_fired'] })
    expect(fired[0]).toMatchObject({
      task: 'app/deps-weekly-0921',
      detail: { schedule: 'deps-weekly', ran: true, missed: 0 },
    })

    // Missed while closed and told to skip: written down, and nothing made.
    const skipped = await client.fireSchedule(
      'deps-weekly',
      { run: false, due: now, missed: 3 },
      now,
    )
    expect(skipped.task).toBeNull()
    expect((await client.events({ types: ['schedule_fired'] })).at(-1)?.detail).toMatchObject({
      ran: false,
      missed: 3,
    })
  })
})
