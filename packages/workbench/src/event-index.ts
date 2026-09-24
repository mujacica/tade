import { createRequire } from 'node:module'
import { type EventFilter, type TadeEvent, typeNames, URGENCY_RANK } from '@tade/core'

// A SQLite index over the event log. It is derived state: every row can be
// rebuilt from events.jsonl, so losing or corrupting the database is never
// data loss — and neither is deleting it on purpose, which is worth saying
// because it is the biggest file Tade has. It holds each event's whole JSON
// beside its columns and three indexes over them, so it runs to roughly twice
// the journal: 110 MB against 54 on the machine this was measured on. It is
// rebuilt whenever it disagrees with the file, so `rm events.jsonl.db*` costs
// one rebuild on the next open and nothing else. `tade logs --size` and the
// Journal settings group say so where somebody looking at a full disk will
// find it.

const require = createRequire(import.meta.url)

interface Statement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  transaction<T extends (...args: never[]) => unknown>(fn: T): T
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  urgency TEXT NOT NULL,
  rank INTEGER NOT NULL,
  task TEXT,
  lane TEXT,
  run TEXT,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task, seq);
CREATE INDEX IF NOT EXISTS events_type ON events(type, seq);
CREATE INDEX IF NOT EXISTS events_rank ON events(rank, seq);
`

export class EventIndex {
  private readonly db: Database
  private readonly insertStmt: Statement

  private constructor(db: Database) {
    this.db = db
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    this.insertStmt = this.db.prepare(
      'INSERT OR REPLACE INTO events (seq, ts, type, urgency, rank, task, lane, run, json)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
  }

  /** Returns null when SQLite is unavailable: the log still works without an index. */
  static open(path: string): EventIndex | null {
    try {
      const Ctor = require('better-sqlite3') as new (p: string) => Database
      return new EventIndex(new Ctor(path))
    } catch {
      return null
    }
  }

  insert(e: TadeEvent): void {
    this.insertStmt.run(
      e.seq,
      e.ts,
      e.type,
      e.urgency,
      URGENCY_RANK[e.urgency],
      e.task,
      e.lane,
      e.run,
      JSON.stringify(e),
    )
  }

  insertMany(events: Iterable<TadeEvent>): void {
    const run = this.db.transaction((list: TadeEvent[]) => {
      for (const e of list) this.insert(e)
    })
    run([...events])
  }

  maxSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM events').get() as { m: number | null }
    return row?.m ?? 0
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }
    return row.c
  }

  clear(): void {
    this.db.exec('DELETE FROM events')
  }

  query(filter: EventFilter): TadeEvent[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.since !== undefined) {
      where.push('seq > ?')
      params.push(filter.since)
    }
    if (filter.task !== undefined) {
      where.push('task = ?')
      params.push(filter.task)
    }
    if (filter.lane !== undefined) {
      where.push('lane = ?')
      params.push(filter.lane)
    }
    if (filter.types && filter.types.length > 0) {
      // By every name these were ever written under: the column holds the word
      // in the journal, and rows written before the rename still hold the old
      // one. An index built before the rename is never rebuilt for it.
      const names = typeNames(filter.types)
      where.push(`type IN (${names.map(() => '?').join(',')})`)
      params.push(...names)
    }
    if (filter.minUrgency) {
      where.push('rank <= ?')
      params.push(URGENCY_RANK[filter.minUrgency])
    }
    const sql =
      `SELECT json FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''}` +
      ` ORDER BY seq${filter.limit ? ' DESC LIMIT ?' : ''}`
    if (filter.limit) params.push(filter.limit)
    const rows = this.db.prepare(sql).all(...params) as Array<{ json: string }>
    const events = rows.map((r) => JSON.parse(r.json) as TadeEvent)
    return filter.limit ? events.reverse() : events
  }

  close(): void {
    this.db.close()
  }
}
