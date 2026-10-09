import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, taskDir } from '@tade/core'
import { collectStatus } from '@tade/status'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { NotYours } from '../src/parked.ts'
import { createTask, NoTaskFile, ParkMovedOn, setParked } from '../src/tasks.ts'
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
      // What the file said before, which is what a caller's `was` is checked
      // against — and what makes `did` honest rather than always true.
      was: false,
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
      processes: async () => ({ processes: [], servers: { looked: true, alive: 0 }, warnings: [] }),
    })
    expect(before.projects[0]?.tasks[0]).toMatchObject({ id: 'app/migration', state: 'queued' })

    expect(await client.parkTask(task.id, true)).toEqual({
      task: 'app/migration',
      parked: true,
      was: false,
    })

    const after = await collectStatus({
      config,
      now: Date.now(),
      home: tmp('tade-park-home-'),
      tadeHome: home,
      pr: false,
      processes: async () => ({ processes: [], servers: { looked: true, alive: 0 }, warnings: [] }),
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
      processes: async () => ({ processes: [], servers: { looked: true, alive: 0 }, warnings: [] }),
    })
    expect(status.projects[0]?.tasks[0]?.state).toBe('queued')
  })
})

describe('a park expressed against the state it expects', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-park-was-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  async function made(): Promise<string> {
    const task = await client.createTask({ project: 'app', slug: 'migration', intent: INTENT })
    return task.id
  }

  it('goes through when the file still says what the caller saw', async () => {
    const id = await made()
    expect(await client.parkTask(id, true, { was: false })).toMatchObject({
      parked: true,
      was: false,
    })
  })

  it('refuses, and says what is true now, when it does not', async () => {
    // **The stale screen, at the file.** Somebody parked it at the keyboard
    // between the draw and the tap, so a request asking to park it *from not
    // parked* is not a request about the world as it is. Refused with the
    // value, so whoever asked can draw the truth rather than a message about
    // it.
    const id = await made()
    await client.parkTask(id, true)
    const refused = client.parkTask(id, false, { was: false })
    await expect(refused).rejects.toThrow(ParkMovedOn)
    await refused.catch((err: unknown) => {
      expect(err).toBeInstanceOf(ParkMovedOn)
      if (err instanceof ParkMovedOn) expect(err.parked).toBe(true)
    })
    // And nothing moved: a refusal writes no file and no journal line.
    const file = parse(readFileSync(join(taskDir(home, id), 'task.yaml'), 'utf8'))
    expect(file.parked).toBe(true)
  })

  it('refuses a replay of the act that already happened', async () => {
    // **The guarantee the idempotency key is only a fast path for**
    // (DECISIONS §4.6): the same request sent twice meets a target that has
    // moved on, whatever the key store remembers — so a captured `POST`
    // replayed after a restart, or after its key fell out of the window, is a
    // refusal rather than a second act.
    const id = await made()
    await client.parkTask(id, true, { was: false })
    await expect(client.parkTask(id, true, { was: false })).rejects.toThrow(ParkMovedOn)
  })

  it('is one read and one write, so a local park in between is not lost', async () => {
    // **The local race.** Two parks asked for at once, each saying what it
    // saw: one of them is working from a world that no longer exists, and the
    // compare-and-set is what makes it the one that is refused rather than the
    // one that wins.
    const id = await made()
    const answers = await Promise.allSettled([
      client.parkTask(id, true, { was: false }),
      client.parkTask(id, true, { was: false }),
    ])
    const went = answers.filter((one) => one.status === 'fulfilled')
    const refused = answers.filter((one) => one.status === 'rejected')
    expect(went).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(parse(readFileSync(join(taskDir(home, id), 'task.yaml'), 'utf8')).parked).toBe(true)
  })

  it('says plainly, as its own kind of error, when there is no task there', async () => {
    await expect(setParked(tmp('tade-none-'), 'app/nothing', true, false)).rejects.toThrow(
      NoTaskFile,
    )
  })
})

describe('who asked for a park', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-park-by-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('is `you` at the keyboard, and the device\u2019s own id from away', async () => {
    // **Provenance at the act, not in a prompt** (DECISIONS §4.5). A remote
    // park recorded as `you` would make `historyFrom` count it as the person's
    // own doing, and would put a line nobody said in front of anything that
    // reads the journal for what the person asked for.
    const task = await client.createTask({ project: 'app', slug: 'migration', intent: INTENT })
    await client.parkTask(task.id, true)
    await client.parkTask(task.id, false, { by: 'device 00112233445566aa' })
    const changes = await client.events({ types: ['state_change'] })
    expect(changes.map((one) => one.detail.by)).toEqual(['you', 'device 00112233445566aa'])
    expect(changes.map((one) => one.detail.state)).toEqual(['parked', 'resumed'])
  })

  it('is never written as a line the person said', async () => {
    const task = await client.createTask({ project: 'app', slug: 'migration', intent: INTENT })
    await client.parkTask(task.id, true, { by: 'device 00112233445566aa' })
    expect(await client.events({ types: ['said'] })).toEqual([])
  })
})

describe('work that came from outside this machine', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-park-intake-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  async function fromATicket(): Promise<string> {
    const task = await client.createTask({
      project: 'app',
      slug: 'from-a-ticket',
      intent: 'a ticket somebody else filed',
      by: 'intake:github',
    })
    await client.parkTask(task.id, true)
    return task.id
  }

  it('is not picked up again by a request from off the machine', async () => {
    // **A proposed intake is a parked task**, so lifting one is approving it —
    // DESIGN §9.1's *accept work from an outside source*, which is never
    // remote, and whose `answer`-tier cousin needs two re-checks nothing has
    // built. The verb does not reach it until something does.
    const id = await fromATicket()
    await expect(client.parkTask(id, false, { by: 'device 00112233445566aa' })).rejects.toThrow(
      NotYours,
    )
    // Refused before the write, so nothing moved and no line claims it did.
    expect(parse(readFileSync(join(taskDir(home, id), 'task.yaml'), 'utf8')).parked).toBe(true)
    const changes = await client.events({ types: ['state_change'] })
    expect(changes.map((one) => one.detail.state)).toEqual(['parked'])
  })

  it('is set aside from away perfectly well, because a hold is always safe', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'from-a-ticket',
      intent: 'a ticket somebody else filed',
      by: 'intake:github',
    })
    await expect(
      client.parkTask(task.id, true, { by: 'device 00112233445566aa' }),
    ).resolves.toMatchObject({ parked: true })
  })

  it('is picked up at the keyboard as it always was', async () => {
    // The local door is untouched, which matters: approving a proposal *is*
    // this call, so a rule that had caught it would have broken intake.
    const id = await fromATicket()
    await expect(client.parkTask(id, false)).resolves.toMatchObject({ parked: false })
    await expect(client.parkTask(id, true, { by: 'you' })).resolves.toMatchObject({ parked: true })
  })

  it('leaves ordinary work alone, whoever asked', async () => {
    const task = await client.createTask({ project: 'app', slug: 'migration', intent: INTENT })
    await client.parkTask(task.id, true)
    await expect(
      client.parkTask(task.id, false, { by: 'device 00112233445566aa' }),
    ).resolves.toMatchObject({ parked: false })
  })
})
