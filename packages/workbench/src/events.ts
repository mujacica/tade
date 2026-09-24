import { createReadStream } from 'node:fs'
import { type FileHandle, mkdir, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  DEFAULT_URGENCY,
  type EventFilter,
  type EventInput,
  type JournalPolicy,
  matchesFilter,
  type TadeEvent,
  URGENCY_RANK,
  type Urgency,
} from '@tade/core'
import { type Compaction, compactJournal } from './compact.ts'
import { EventIndex } from './event-index.ts'

// events.jsonl is the truth: append-only, one JSON object per line. The SQLite
// index is derived and rebuilt whenever it disagrees with the file.

/**
 * What a closed journal answers an append with.
 *
 * The window has ended and the file with it, so there is nowhere left to
 * write and nowhere to say so either — the journal is where saying so would
 * go. Named, so that whoever is handed it can tell this apart from a disk
 * that filled up, which is a thing to act on.
 */
export class EventLogClosedError extends Error {
  readonly path: string
  /** The kind of event that had nowhere to go. */
  readonly event: string

  constructor(path: string, event: string) {
    super(`the journal at ${path} is closed: ${event} was not written`)
    this.name = 'EventLogClosedError'
    this.path = path
    this.event = event
  }
}

/** Events at least this urgent are fsync'd before `append` resolves. */
const FSYNC_AT: Urgency = 'notable'

export interface EventLogOptions {
  path: string
  /** Index database path. `null` disables the index (scan-only reads). */
  indexPath?: string | null
  /** Queue depth per subscriber before dropping starts. */
  subscriberQueue?: number
  /**
   * What the journal keeps. Absent, nothing is ever dropped — which is the
   * right answer for a test's journal and for anything opening this file
   * without a config to read the numbers from.
   */
  journal?: JournalPolicy
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
  /** Closed: the window is over, and the file behind this is no longer open. */
  private shut = false
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
    const indexPath = opts.indexPath === undefined ? `${opts.path}.db` : opts.indexPath
    // Before the file is opened for appending and before the index is looked
    // at, because both are answers about a file this may be about to rewrite.
    // The caller holds the home lock, which is what makes one writer true.
    // A compaction that went wrong must not be what stops the window opening,
    // and must not be silent either: the journal is where the trouble goes,
    // and the journal is about to exist. Nothing was renamed, so what is on
    // the disk is the journal exactly as it was.
    let trouble: string | null = null
    const compacted = opts.journal
      ? await compactJournal(opts.path, opts.journal).catch((cause: unknown) => {
          trouble = `could not compact ${opts.path}, which is unchanged: ${String(cause)}`
          return null
        })
      : null
    if (compacted && compacted.dropped > 0 && indexPath) {
      // The index is derived, and after a compaction it holds rows for lines
      // that are no longer in the file. Its `maxSeq` still matches — the
      // newest line is always kept — so nothing below would rebuild it, and
      // the 110 MB it had grown to would stay on the disk answering questions
      // about events that have gone. Deleting it is what a derived file is
      // for, and rebuilding it from the compacted journal is the next few
      // lines. `-wal` and `-shm` go with it: a database file without them is
      // not a smaller database, it is a database missing its last writes.
      await Promise.all(
        ['', '-wal', '-shm'].map((suffix) =>
          rm(`${indexPath}${suffix}`, { force: true }).catch(() => {}),
        ),
      )
    }
    const fh = await open(opts.path, 'a')
    const { lastSeq, corrupt } = await scanTail(opts.path)

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
    if (trouble) await log.append({ type: 'warning', detail: { message: trouble } })
    if (compacted) await log.recordCompaction(compacted)
    return log
  }

  /**
   * Say what compaction did, in the journal it did it to.
   *
   * Only when something was actually dropped: a look that found nothing to
   * drop is not news, and a line per window open saying so is the journal
   * growing to record that it is not growing. What is still too big is a
   * warning either way, because that one is a thing to act on.
   */
  private async recordCompaction(done: Compaction): Promise<void> {
    if (done.dropped > 0) {
      await this.append({
        type: 'journal_compacted',
        detail: {
          dropped: done.dropped,
          kept: done.read - done.dropped,
          was_mb: Number((done.bytesBefore / 1_048_576).toFixed(1)),
          now_mb: Number((done.bytesAfter / 1_048_576).toFixed(1)),
          what: 'the oldest sampled lane output, to fit the ceiling; nothing else is ever dropped',
        },
      }).catch(() => {})
    }
    if (done.stillOver) {
      await this.append({ type: 'warning', detail: { message: done.stillOver } }).catch(() => {})
    }
  }

  async append(input: EventInput): Promise<TadeEvent> {
    // A closed log is closed, said here rather than found at the file
    // descriptor. Anything begun before `close` is already in `writes`, which
    // `close` drains, so the only append that can reach a shut file is one
    // that started after — and that came back as `EBADF`, an unhandled
    // rejection raised by the operating system in the middle of a teardown,
    // with nothing in it to say which event was lost. Refused by name, and
    // before `seq`, so a refusal leaves no gap in the numbering either.
    if (this.shut) throw new EventLogClosedError(this.path, input.type)
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
    // Before the drain, not after: an append that arrives while the queue is
    // being emptied must be refused rather than joining the queue behind the
    // close, which is the race this whole flag is about.
    this.shut = true
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

/** What a read got to, so the next one can start there. */
export interface JournalRead {
  events: TadeEvent[]
  /** Where this read actually started, which is 0 when it started over. */
  readFrom: number
  /**
   * Bytes consumed, which is always a line boundary: a torn last line is left
   * for the read that finds its newline.
   */
  readTo: number
}

/**
 * Read the part of the journal nobody has read yet.
 *
 * The journal only ever grows, so a second read of it is the part that is
 * new — and anything asking on a beat is asking the same question of the same
 * bytes over and over. A status bar item that folded the whole file every ten
 * seconds cost 204 ms and 313 MB of garbage to find 101 events among 232,000,
 * and got slower every hour the window stayed open; read from where it left
 * off it costs a `stat` and a fifth of a millisecond.
 *
 * `from` is what the last read's `readTo` said. A file shorter than that was
 * rotated or truncated rather than appended to, so it is read again from the
 * start — and `readFrom` says so, rather than leaving the caller to infer it
 * from an offset that went backwards. Append what comes back where `readFrom`
 * is where you were; take it in place of what you had where it is not.
 *
 * `limit` is not honoured here: the last N of a delta is not the last N of a
 * journal, and a caller keeping its own events already knows how many it wants.
 *
 * Nothing here throws, for the reason nothing else that reads the journal does:
 * this is read on the window's beat by things that must degrade to a partial
 * answer rather than take a frame down. A read that could not happen is no new
 * events and the offset it was given, which is the one answer that cannot
 * silently lose what the caller already had — a journal that has gone is read
 * from the start when it comes back, by the rule above.
 */
export async function readJournalSince(
  home: string,
  filter: Omit<EventFilter, 'limit'> = {},
  from = 0,
): Promise<JournalRead> {
  const nothing = { events: [], readFrom: from, readTo: from }
  const path = join(home, 'events.jsonl')
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch {
    // No journal yet is an empty journal, not a failure.
    return nothing
  }
  try {
    const { size } = await handle.stat()
    // Shorter than what we read means it is not the file we read.
    const start = size < from ? 0 : from
    if (size <= start) return { events: [], readFrom: start, readTo: start }
    const buf = Buffer.alloc(size - start)
    const { bytesRead } = await handle.read(buf, 0, buf.length, start)
    // Shorter than the stat said means it shrank under us: nothing to consume,
    // and the next read finds it shorter than `from` and starts over.
    if (bytesRead === 0) return { events: [], readFrom: start, readTo: start }
    // Only whole lines are consumed. A newline never appears inside a
    // multi-byte character, so cutting there is also safe to decode.
    const end = buf.lastIndexOf(0x0a, bytesRead - 1)
    if (end < 0) return { events: [], readFrom: start, readTo: start }
    const events: TadeEvent[] = []
    for (const line of buf.toString('utf8', 0, end).split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as TadeEvent
        if (matchesFilter(event, filter)) events.push(event)
      } catch {
        // A line that will not parse is skipped, never thrown over.
      }
    }
    return { events, readFrom: start, readTo: start + end + 1 }
  } catch {
    return nothing
  } finally {
    await handle.close().catch(() => {})
  }
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
