import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, taskDir } from '@tade/core'
import { collectStatus } from '@tade/status'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { createTask, setParked } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

// Parking is the one task state nothing can derive: only you know that a task
// is deliberately set aside rather than merely idle.

const INTENT = "the migration keeps failing on the same constraint, I'll look tonight"

describe('setParked', () => {
  it('sets a task aside and picks it back up, keeping everything else', async () => {
    const repo = mkrepo()
    const task = await createTask({
      home: repo.home,
      project: 'app',
      root: repo.root,
      slug: 'migration',
      intent: INTENT,
      worktreeRoot: tmp('tade-park-'),
    })
    const file = join(taskDir(repo.home, task.id), 'task.yaml')

    expect(await setParked(repo.home, task.id, true)).toEqual({
      task: 'app/migration',
      parked: true,
    })
    const parked = parse(readFileSync(file, 'utf8'))
    expect(parked.parked).toBe(true)
    // What you said survives the round trip untouched.
    expect(parked.intent_spoken).toBe(INTENT)
    expect(parked.base).toBe(repo.head())

    await setParked(repo.home, task.id, false)
    expect(parse(readFileSync(file, 'utf8')).parked).toBe(false)
  })

  it('says so plainly when there is no task there', async () => {
    await expect(setParked(tmp('tade-empty-'), 'app/nothing', true)).rejects.toThrow(
      /no task file for/,
    )
  })
})

describe('task/park over the socket', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-park-rpc-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('a parked task reads as parked in status, and speaks for itself in the log', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'migration',
      intent: INTENT,
    })

    const config = ConfigSchema.parse({ projects: { app: { root: repo.root } } })
    const before = await collectStatus({
      config,
      now: Date.now(),
      home: tmp('tade-park-home-'),
      tadeHome: home,
      pr: false,
      processes: async () => ({ processes: [], warnings: [] }),
    })
    expect(before.projects[0]?.tasks[0]).toMatchObject({ id: 'app/migration', state: 'queued' })

    expect(await client.parkTask(task.id, true)).toEqual({
      task: 'app/migration',
      parked: true,
    })

    const after = await collectStatus({
      config,
      now: Date.now(),
      home: tmp('tade-park-home-'),
      tadeHome: home,
      pr: false,
      processes: async () => ({ processes: [], warnings: [] }),
    })
    expect(after.projects[0]?.tasks[0]).toMatchObject({
      id: 'app/migration',
      state: 'parked',
      reason: 'parked by you',
    })

    const [event] = await client.events({ types: ['state_change'] })
    expect(event?.detail).toMatchObject({ state: 'parked', by: 'you' })
  })

  it('picking it back up makes it ordinary again', async () => {
    const task = await client.createTask({ project: 'app', slug: 'migration', intent: INTENT })
    await client.parkTask(task.id, true)
    expect(await client.parkTask(task.id, false)).toMatchObject({ parked: false })

    const status = await collectStatus({
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      now: Date.now(),
      home: tmp('tade-park-home-'),
      tadeHome: home,
      pr: false,
      processes: async () => ({ processes: [], warnings: [] }),
    })
    expect(status.projects[0]?.tasks[0]?.state).toBe('queued')
  })
})
