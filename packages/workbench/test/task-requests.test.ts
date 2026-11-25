import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskRequestsSpool } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  answerFor,
  awaitTask,
  requestTask,
  takeTaskRequests,
  withdrawTask,
} from '../src/task-requests.ts'
import { readTaskFile } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

// A task asked for from a terminal while a window holds the journal — `tade
// task create` beside a running `tade serve` — made by that window, through its
// own `createTask`, so the `task_created` line is numbered by the one writer
// there is, and answered back to the terminal.

const INTENT = 'say hello from the server, in the README'
const QUICK = { takeMs: 200, makeMs: 200, everyMs: 10 }

describe('a task asked for while a window holds the home', () => {
  let home: string
  let client: Workbench

  beforeEach(async () => {
    const repo = mkrepo()
    home = tmp('tade-task-requests-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home })
  })

  afterEach(async () => {
    await client.close()
  })

  const take = () => takeTaskRequests(home, (request) => client.createTask(request))
  const spooled = () =>
    existsSync(taskRequestsSpool(home)) ? readdirSync(taskRequestsSpool(home)) : []

  it('is made by the window, journalled by it as yours, and answered', async () => {
    const id = await requestTask(home, { project: 'app', slug: 'hello', intent: INTENT })
    expect(await answerFor(home, id)).toBeNull()
    expect(await take()).toEqual({ taken: 1, trouble: null })

    const answer = await answerFor(home, id)
    expect(answer).toMatchObject({ ok: true, id: 'app/hello' })
    const [created] = await client.events({ types: ['task_created'] })
    expect(created?.task).toBe('app/hello')
    expect(created?.detail).toMatchObject({ intent_spoken: INTENT, by: 'you' })
    // Read once, then gone: the spool holds nothing nobody is waiting on.
    expect(await answerFor(home, id)).toBeNull()
    expect(spooled()).toEqual([])
  })

  it('made to start, is queued work ready now, told its own words', async () => {
    const id = await requestTask(home, {
      project: 'app',
      slug: 'hello',
      intent: INTENT,
      start: true,
    })
    await take()
    expect(await answerFor(home, id)).toMatchObject({ ok: true })
    const file = await readTaskFile(home, 'app/hello')
    expect(file?.start).toMatchObject({ after: [], prompt: INTENT })
  })

  it('answers why where the window would not make it, and makes nothing', async () => {
    await client.createTask({ project: 'app', slug: 'hello', intent: INTENT })
    const id = await requestTask(home, { project: 'app', slug: 'hello', intent: 'again' })
    await take()
    const answer = await answerFor(home, id)
    expect(answer?.ok).toBe(false)
    expect(await client.events({ types: ['task_created'] })).toHaveLength(1)
  })

  it('is never made once the terminal has taken it back', async () => {
    const id = await requestTask(home, { project: 'app', slug: 'hello', intent: INTENT })
    expect(await withdrawTask(home, id)).toBe(true)
    expect(await take()).toEqual({ taken: 0, trouble: null })
    expect(await client.events({ types: ['task_created'] })).toEqual([])
  })

  it('cannot be taken back once the window has it', async () => {
    const id = await requestTask(home, { project: 'app', slug: 'hello', intent: INTENT })
    await take()
    expect(await withdrawTask(home, id)).toBe(false)
  })

  it('reads nothing but what `tade task create` takes', async () => {
    const dir = taskRequestsSpool(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '1-1-odd.json'),
      JSON.stringify({ project: 'app', slug: 'hello', intent: INTENT, by: 'orchestrator' }),
    )
    writeFileSync(join(dir, '2-1-broken.json'), '{ not json')
    await take()
    const [created] = await client.events({ types: ['task_created'] })
    // Who asked is never the request's to say.
    expect(created?.detail.by).toBe('you')
    expect(JSON.parse(readFileSync(join(dir, '2-1-broken.answer.json'), 'utf8'))).toMatchObject({
      ok: false,
    })
  })

  it('costs one look at a directory where nothing was asked', async () => {
    expect(await take()).toEqual({ taken: 0, trouble: null })
    expect(existsSync(taskRequestsSpool(home))).toBe(false)
  })
})

describe('waiting on a task asked of a window', () => {
  it('takes the request back where no window took it, so nothing is made later', async () => {
    const home = tmp('tade-task-requests-')
    const id = await requestTask(home, { project: 'app', slug: 'hello', intent: INTENT })
    expect(await awaitTask(home, id, QUICK)).toBe('untaken')
    expect(readdirSync(taskRequestsSpool(home))).toEqual([])
  })

  it('says it is being made where a window took it and has not answered', async () => {
    const home = tmp('tade-task-requests-')
    const id = await requestTask(home, { project: 'app', slug: 'hello', intent: INTENT })
    // Claimed as a window claims one, and never answered.
    const file = join(taskRequestsSpool(home), `${id}.json`)
    writeFileSync(`${file}.taking`, readFileSync(file))
    await withdrawTask(home, id)
    expect(await awaitTask(home, id, QUICK)).toBe('making')
  })

  it('hands back the answer as soon as there is one', async () => {
    const home = tmp('tade-task-requests-')
    const id = await requestTask(home, { project: 'app', slug: 'hello', intent: INTENT })
    const waited = awaitTask(home, id, { ...QUICK, takeMs: 60_000 })
    await takeTaskRequests(home, async () => {
      throw new Error('no such project')
    })
    expect(await waited).toEqual({ ok: false, error: 'no such project' })
  })
})
