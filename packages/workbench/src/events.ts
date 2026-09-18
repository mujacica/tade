import { createReadStream } from 'node:fs'
import { type FileHandle, mkdir, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  DEFAULT_URGENCY,
  type EventFilter,
  type EventInput,
  matchesFilter,
  type TadeEvent,
  URGENCY_RANK,
  type Urgency,
} from '@tade/core'
import { EventIndex } from './event-index.ts'

// events.jsonl is the truth: append-only, one JSON object per line. The SQLite
// index is derived and rebuilt whenever it disagrees with the file.

/** Events at least this urgent are fsync'd before `append` resolves. */
const FSYNC_AT: Urgency = 'notable'

export interface EventLogOptions {
  path: string
  /** Index database path. `null` disables the index (scan-only reads). */
  indexPath?: string | null
  /** Queue depth per subscriber before dropping starts. */
  subscriberQueue?: number
}

export type EventListener = (e: TadeEvent) => void

interface Subscriber {
  fn: EventListener
  filter: EventFilter
  queue: TadeEvent[]
  draining: boolean
  dropped: number
}

export class EventLog {
  private readonly fh: FileHandle
  private readonly subs = new Set<Subscriber>()
  private readonly queueLimit: number
  private writes: Promise<unknown> = Promise.resolve()
  private seq: number
  readonly path: string
  readonly index: EventIndex | null

  private constructor(
    path: string,
    fh: FileHandle,
    seq: number,
    index: EventIndex | null,
    queueLimit: number,
  ) {
    this.path = path
    this.fh = fh
    this.seq = seq
    this.index = index
    this.queueLimit = queueLimit
  }

  static async open(opts: EventLogOptions): Promise<EventLog> {
    await mkdir(dirname(opts.path), { recursive: true })
    const fh = await open(opts.path, 'a')
    const { lastSeq, corrupt } = await scanTail(opts.path)

    const indexPath = opts.indexPath === undefined ? `${opts.path}.db` : opts.indexPath
    let index = indexPath === null ? null : EventIndex.open(indexPath)
    if (index && index.maxSeq() !== lastSeq) {
      // The index disagrees with the log (crash, deletion, manual edit): rebuild.
      try {
        index.clear()
        index.insertMany(await readAll(opts.path))
      } catch {
        index.close()
        if (indexPath) await rm(indexPath, { force: true })
        index = indexPath === null ? null : EventIndex.open(indexPath)
      }
    }
    const log = new EventLog(opts.path, fh, lastSeq, index, opts.subscriberQueue ?? 1_000)
    if (corrupt > 0) {
      await log.append({
        type: 'warning',
        detail: { message: `${corrupt} unparseable line(s) in ${opts.path}` },
      })
    }
    return log
  }

  async append(input: EventInput): Promise<TadeEvent> {
    const urgency = input.urgency ?? DEFAULT_URGENCY[input.type]
    // seq is assigned synchronously, so ordering never depends on I/O timing.
    const event: TadeEvent = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      type: input.type,
      urgency,
      task: input.task ?? null,
      lane: input.lane ?? null,
      run: input.run ?? null,
      detail: input.detail ?? {},
    }
    const durable = URGENCY_RANK[urgency] <= URGENCY_RANK[FSYNC_AT]
    const write = this.writes.then(async () => {
      await this.fh.write(`${JSON.stringify(event)}\n`)
      if (durable) await this.fh.sync()
      this.index?.insert(event)
    })
    this.writes = write.catch(() => {})
    await write
    this.publish(event)
    return event
  }

  /**
   * Subscribe to live events. Each subscriber has a bounded queue: under
   * pressure the least urgent events are dropped first, and `blocking` events
   * are never dropped.
   */
  subscribe(fn: EventListener, filter: EventFilter = {}): () => void {
    const sub: Subscriber = { fn, filter, queue: [], draining: false, dropped: 0 }
    this.subs.add(sub)
    return () => this.subs.delete(sub)
  }

  /** Events dropped so far, summed over live subscribers. Test/telemetry hook. */
  get dropped(): number {
    let n = 0
    for (const s of this.subs) n += s.dropped
    return n
  }

  async read(filter: EventFilter = {}): Promise<TadeEvent[]> {
    if (this.index) return this.index.query(filter)
    const all = (await readAll(this.path)).filter((e) => matchesFilter(e, filter))
    return filter.limit ? all.slice(-filter.limit) : all
  }

  async close(): Promise<void> {
    await this.writes
    this.subs.clear()
    this.index?.close()
    await this.fh.close()
  }

  private publish(event: TadeEvent): void {
    for (const sub of this.subs) {
      if (!matchesFilter(event, sub.filter)) continue
      if (sub.queue.length >= this.queueLimit) {
        const room = evictLeastUrgent(sub.queue, event)
        if (room === 'rejected') {
          sub.dropped++
          continue
        }
        if (room === 'evicted') sub.dropped++
      }
      sub.queue.push(event)
      if (!sub.draining) drain(sub)
    }
  }
}

export type EvictionResult = 'evicted' | 'overflow' | 'rejected'

/**
 * Make room in a full subscriber queue by dropping the least urgent event
 * (trace first). A `blocking` event is never dropped: if the whole queue is
 * blocking, it is allowed to grow instead.
 */
export function evictLeastUrgent(queue: TadeEvent[], incoming: TadeEvent): EvictionResult {
  for (const urgency of ['trace', 'routine', 'notable'] as const) {
    if (URGENCY_RANK[urgency] <= URGENCY_RANK[incoming.urgency]) break
    const i = queue.findLastIndex((e) => e.urgency === urgency)
    if (i >= 0) {
      queue.splice(i, 1)
      return 'evicted'
    }
  }
  return incoming.urgency === 'blocking' ? 'overflow' : 'rejected'
}

function drain(sub: Subscriber): void {
  sub.draining = true
  queueMicrotask(() => {
    while (sub.queue.length > 0) {
      const e = sub.queue.shift()!
      try {
        sub.fn(e)
      } catch {
        // A broken subscriber must never stall the log.
      }
    }
    sub.draining = false
  })
}

/** Read the tail to find the last sequence number without loading the file. */
async function scanTail(path: string): Promise<{ lastSeq: number; corrupt: number }> {
  let lastSeq = 0
  let corrupt = 0
  for await (const e of iterate(path)) {
    if (e === null) corrupt++
    else if (e.seq > lastSeq) lastSeq = e.seq
  }
  return { lastSeq, corrupt }
}

/**
 * Read the journal without taking the workbench.
 *
 * For anyone who only wants to know what happened — `tade brief`, `tade
 * logs`, a script — and must not have to wait on, or disturb, an open window
 * to find out. Unparseable lines are skipped, never thrown over.
 */
export async function readJournal(home: string, filter: EventFilter = {}): Promise<TadeEvent[]> {
  const all = (await readAll(join(home, 'events.jsonl'))).filter((e) => matchesFilter(e, filter))
  return filter.limit ? all.slice(-filter.limit) : all
}

async function readAll(path: string): Promise<TadeEvent[]> {
  const out: TadeEvent[] = []
  for await (const e of iterate(path)) if (e) out.push(e)
  return out
}

/** Yields every parseable event, and `null` for each unparseable line. */
async function* iterate(path: string): AsyncGenerator<TadeEvent | null> {
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(path, { encoding: 'utf8' })
  } catch {
    return
  }
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.trim()) continue
      try {
        yield JSON.parse(line) as TadeEvent
      } catch {
        // A torn last line after a crash is expected, not fatal.
        yield null
      }
    }
  } catch {
    return
  } finally {
    stream.destroy()
  }
}
