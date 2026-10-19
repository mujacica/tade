import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { parentPort, workerData } from 'node:worker_threads'
import type { TadeEvent } from '@tade/core'
import type { BeforeJob, BeforeRead } from './journal-away.ts'

// The thread one task's older lines are read on (`journal-away.ts`): out of
// the index where there is one, which answers by the task and the number in
// milliseconds, else by reading the file through — the journal is the truth
// and the index only ever a faster way of asking it. Said back, and gone.

const job = workerData as BeforeJob

interface Statement {
  all(...params: unknown[]): unknown[]
}
interface Database {
  prepare(sql: string): Statement
  close(): void
}

/** Why the index could not be asked, which goes back with the answer to be said. */
let trouble: string | null = null

/** Out of the index, newest first; null where it could not be asked, and `trouble` says why. */
function fromIndex(path: string): TadeEvent[] | null {
  let db: Database | null = null
  try {
    const Ctor = createRequire(import.meta.url)('better-sqlite3') as new (
      p: string,
      o: object,
    ) => Database
    db = new Ctor(path, { readonly: true, fileMustExist: true })
    const rows = db
      .prepare(
        `SELECT json FROM events WHERE task = ? AND seq < ? AND type IN (${job.names.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT ?`,
      )
      .all(job.task, job.before, ...job.names, job.most) as Array<{ json: string }>
    return rows.map((row) => JSON.parse(row.json) as TadeEvent)
  } catch (err) {
    trouble = `could not ask the index of ${job.path}, so it was read through: ${err instanceof Error ? err.message : String(err)}`
    return null
  } finally {
    db?.close()
  }
}

/** Out of the file, every line through, keeping the newest `most` before the number. */
async function fromFile(path: string): Promise<TadeEvent[]> {
  const names = new Set(job.names)
  const needle = JSON.stringify(job.task)
  const kept: TadeEvent[] = []
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (!line.includes(needle)) continue
    let event: TadeEvent
    try {
      event = JSON.parse(line) as TadeEvent
    } catch (err) {
      // A torn line after a crash, as every reader of the journal skips it.
      if (err instanceof SyntaxError) continue
      throw err
    }
    if (event.task !== job.task || event.seq >= job.before || !names.has(event.type)) continue
    kept.push(event)
    if (kept.length > job.most) kept.shift()
  }
  return kept.reverse()
}

const events = (job.index === null ? null : fromIndex(job.index)) ?? (await fromFile(job.path))
parentPort?.postMessage({ events, trouble } satisfies BeforeRead)
