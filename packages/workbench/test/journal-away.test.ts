import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { EventLog } from '../src/events.ts'
import { readBeforeAway } from '../src/journal-away.ts'

// One task's lines from before a number, read on a thread of its own: what an
// agent's timeline on a phone reads as somebody scrolls past what the window
// holds. **The same answer out of the index and out of the file**, because the
// journal is the truth and the index only a faster way of asking it.

const TASK = 'app/migration'

async function journal(indexPath: string | null | undefined = undefined) {
  const dir = tmp('tade-journal-away-')
  const path = join(dir, 'events.jsonl')
  const log = await EventLog.open({ path, ...(indexPath !== undefined && { indexPath }) })
  await log.append({ type: 'task_created', task: TASK })
  for (let n = 0; n < 300; n += 1) {
    await log.append({
      type: 'tool_call',
      task: n % 3 === 0 ? TASK : 'app/other',
      detail: { tool: 'Edit' },
    })
    await log.append({ type: 'output', task: TASK, detail: { bytes: n } })
  }
  return { log, path }
}

describe('a task’s lines from before a number', () => {
  it('are its newest of the asked types below the number, newest first, out of the index', async () => {
    const { log } = await journal()
    expect(log.index).not.toBeNull()
    const read = await log.readBefore({
      task: TASK,
      types: ['tool_call', 'task_created'],
      before: 100,
      most: 5,
    })
    expect(read.map((one) => one.seq)).toEqual([98, 92, 86, 80, 74])
    expect(read.every((one) => one.task === TASK && one.type === 'tool_call')).toBe(true)
    await log.close()
  })

  it('reach its making, and nothing before it', async () => {
    const { log } = await journal()
    const read = await log.readBefore({
      task: TASK,
      types: ['tool_call', 'task_created'],
      before: 10,
      most: 50,
    })
    expect(read.map((one) => [one.seq, one.type])).toEqual([
      [8, 'tool_call'],
      [2, 'tool_call'],
      [1, 'task_created'],
    ])
    await log.close()
  })

  it('are the same read out of the file where there is no index', async () => {
    const indexed = await journal()
    const bare = await journal(null)
    expect(bare.log.index).toBeNull()
    const ask = { task: TASK, types: ['tool_call', 'task_created'] as const, before: 400, most: 7 }
    const fromFile = await bare.log.readBefore({ ...ask, types: [...ask.types] })
    expect(fromFile.map((one) => one.seq)).toEqual(
      (await indexed.log.readBefore({ ...ask, types: [...ask.types] })).map((one) => one.seq),
    )
    expect(fromFile).toHaveLength(7)
    await indexed.log.close()
    await bare.log.close()
  })

  it('skip a torn line in the file rather than throwing over it', async () => {
    const { log, path } = await journal(null)
    appendFileSync(path, '{"seq": 9999, "task": "app/migration", "ty\n')
    const read = await log.readBefore({ task: TASK, types: ['tool_call'], before: 10_000, most: 1 })
    expect(read.map((one) => one.seq)).toEqual([596])
    await log.close()
  })

  it('are read out of the file where the index cannot be asked, and say why', async () => {
    const { log, path } = await journal(null)
    const broken = join(tmp('tade-journal-away-broken-'), 'events.jsonl.db')
    writeFileSync(broken, 'not a database')
    const read = await readBeforeAway(
      { path, index: broken },
      { task: TASK, types: ['tool_call'], before: 10, most: 5 },
    )
    expect(read.events.map((one) => one.seq)).toEqual([8, 2])
    expect(read.trouble).toMatch(
      /could not ask the index of .*events\.jsonl, so it was read through/,
    )
    await log.close()
  })

  it('throw, naming what, where the thread could not read — never an empty answer', async () => {
    const dir = tmp('tade-journal-away-gone-')
    await expect(
      readBeforeAway(
        { path: join(dir, 'nothing.jsonl'), index: null },
        { task: TASK, types: ['tool_call'], before: 10, most: 5 },
      ),
    ).rejects.toThrow(/app\/migration's journal before line 10/)
  })
})
