import { join } from 'node:path'
import { producesPath, taskDir } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { logged, setup, taskProducing, until } from './workers-harness.ts'

// The line that says a research task finished, and the document on it.
//
// Its own file rather than another corner of the supervisor's: what is under
// test is the mechanism a task made to plan, audit or research runs on, and
// the supervisor is only the commonest of the five ways such a task ends.
//
// The rest of the mechanism is tested where it lives — the path rule and the
// fold in `@tade/core`, what the orchestrator hears in the app and the
// briefing, and the other ways a task is finished in `tasks-api`.

describe('an agent finishing a task that produces a document', () => {
  let close: (() => Promise<void>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it("puts the path in the task's own folder on the line the journal keeps", async () => {
    // The journal is the only thing that remembers: the task's folder goes
    // when the task does, and somebody reads the document before then.
    const where = taskProducing('notes/scope-audit.md')
    const { log, adapter } = await setup('bypass', undefined, undefined, where)
    close = () => log.close()
    adapter.emit('r1', { type: 'done', summary: 'Four call sites take the token twice.' })
    await until(async () => (await logged(log, 'task_done')).length > 0)
    const path = producesPath(where.home, 'app/refunds', 'notes/scope-audit.md')
    expect(path).toBe(join(taskDir(where.home, 'app/refunds'), 'notes', 'scope-audit.md'))
    expect((await logged(log, 'task_done'))[0]?.detail).toMatchObject({
      by: 'agent',
      summary: 'Four call sites take the token twice.',
      produces: path,
    })
    // Not marked missing: the file is there, so nobody is sent to one that is not.
    expect((await logged(log, 'task_done'))[0]?.detail.missing).toBeUndefined()
  })

  it('says a task named a document and did not write one', async () => {
    const where = taskProducing('notes/scope-audit.md', false)
    const { log, adapter } = await setup('bypass', undefined, undefined, where)
    close = () => log.close()
    adapter.emit('r1', { type: 'done', summary: 'ran out of time' })
    await until(async () => (await logged(log, 'task_done')).length > 0)
    expect((await logged(log, 'task_done'))[0]?.detail).toMatchObject({
      produces: producesPath(where.home, 'app/refunds', 'notes/scope-audit.md'),
      missing: true,
    })
  })

  it('says nothing at all about a task that produces no document', async () => {
    const { log, adapter } = await setup('bypass')
    close = () => log.close()
    adapter.emit('r1', { type: 'done', summary: 'refunds charge once' })
    await until(async () => (await logged(log, 'task_done')).length > 0)
    const detail = (await logged(log, 'task_done'))[0]?.detail
    expect(detail?.produces).toBeUndefined()
    expect(detail?.missing).toBeUndefined()
  })
})
