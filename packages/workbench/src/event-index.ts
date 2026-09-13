import { createRequire } from 'node:module'
import { type EventFilter, URGENCY_RANK, type WilcoEvent } from '@wilco/core'

// A SQLite index over the event log. It is derived state: every row can be
// rebuilt from events.jsonl, so losing or corrupting the database is never
// data loss.

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

  insert(e: WilcoEvent): void {
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

  insertMany(events: Iterable<WilcoEvent>): void {
    const run = this.db.transaction((list: WilcoEvent[]) => {
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

  query(filter: EventFilter): WilcoEvent[] {
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
      where.push(`type IN (${filter.types.map(() => '?').join(',')})`)
      params.push(...filter.types)
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
    const events = rows.map((r) => JSON.parse(r.json) as WilcoEvent)
    return filter.limit ? events.reverse() : events
  }

  close(): void {
    this.db.close()
  }
}
