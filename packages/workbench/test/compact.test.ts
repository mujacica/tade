import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventType, type JournalPolicy, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { compactJournal, weighJournal } from '../src/compact.ts'
import { EventIndex } from '../src/event-index.ts'
import { EventLog, readJournal } from '../src/events.ts'

// What the journal keeps, and what it costs to read afterwards.
//
// The file measured on the machine this was written for was 54 MB and 270,784
// lines after eleven days, 232,324 of them a byte count per lane that nothing
// anywhere reads back. Everything folds over all of it, so that was what every
// statistic cost.

/** Small enough that a few hundred made-up lines are over it. */
const POLICY: JournalPolicy = { maxBytes: 8 * 1024 }
/** Big enough that nothing in these tests is near it. */
const NEVER_FULL: JournalPolicy = { maxBytes: 1 << 30 }

let seq = 0
function line(over: Partial<TadeEvent> = {}): string {
  const event: TadeEvent = {
    seq: ++seq,
    ts: '2026-09-24T12:00:00.000Z',
    type: 'output',
    urgency: 'trace',
    task: null,
    lane: 'app/refunds/agent',
    run: null,
    detail: { bytes: 4_096 },
    ...over,
  }
  return `${JSON.stringify(event)}\n`
}

function journal(lines: string[]): string {
  const path = join(tmp('tade-compact-'), 'events.jsonl')
  writeFileSync(path, lines.join(''))
  return path
}

const sampled = (n: number, over: Partial<TadeEvent> = {}): string[] =>
  Array.from({ length: n }, () => line(over))

const record = (n: number, over: Partial<TadeEvent> = {}): string[] =>
  Array.from({ length: n }, () => line({ type: 'usage', urgency: 'routine', ...over }))

const typesIn = (path: string): string[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => (JSON.parse(l) as TadeEvent).type)

describe('what compaction drops', () => {
  it('leaves a journal under its ceiling completely alone', async () => {
    const path = journal(sampled(10))
    const before = readFileSync(path, 'utf8')
    expect(await compactJournal(path, POLICY)).toBeNull()
    // Byte for byte: under the ceiling nothing is read and nothing is written,
    // which is what makes this cost one `stat` on every window open.
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('drops the oldest sampled lines until the file fits, and keeps the newest', async () => {
    const path = journal([...sampled(400), line({ detail: { bytes: 7 } })])
    const done = await compactJournal(path, POLICY)
    expect(done?.bytesAfter).toBe(statSync(path).size)
    expect(done?.bytesAfter).toBeLessThanOrEqual(POLICY.maxBytes)
    expect(done?.dropped).toBe(401 - typesIn(path).length)
    // The last line written is the one anybody would look at, so it is the
    // one that is still there.
    const left = readFileSync(path, 'utf8').trim().split('\n')
    expect((JSON.parse(left.at(-1) as string) as TadeEvent).detail.bytes).toBe(7)
  })

  it('keeps every kind of event that is the only record there is of itself', async () => {
    // The whole risk of this change in one test. `commit_seen` and `check_ran`
    // are written once precisely because `git log` and `checks.jsonl` cannot
    // answer again later; `reflected` is `trace` like the byte counts and is
    // what stops a finished task being looked back over twice; `usage` is
    // every dollar anybody ever spent. The journal is far over its ceiling, so
    // everything droppable has gone.
    const samples = ['output', 'input']
    const path = journal([
      ...EventType.options.map((type) => line({ type, urgency: 'trace' })),
      ...sampled(400),
    ])
    // A ceiling the record alone cannot fit under, so there is no room left
    // for a single sample and everything droppable has to go.
    const done = await compactJournal(path, { maxBytes: 1_024 })
    expect(done?.dropped).toBe(400 + samples.length)
    expect(typesIn(path).sort()).toEqual(
      EventType.options.filter((t) => !samples.includes(t)).sort(),
    )
    expect(done?.stillOver).toContain('nothing left in it may be dropped')
  })

  // The sequence number is assigned on append and recovered at open by
  // reading the file's tail. Compaction keeps the newest samples first, so in
  // the ordinary case the file still ends where it did and the numbering
  // carries on. When the record alone is over the ceiling there is room for no
  // sample at all, every one of them goes, and if the last line of the file
  // was one the tail no longer reaches as high as the file once did — so
  // without a guard the next window hands the same numbers to different
  // events. Nothing in Tade reads events back by `seq` across a restart
  // today, which is why this was a hazard and not a fire; the guard is here
  // because the first reader to do it would have no way of telling.
  it('does not lower the sequence it reached, even when every sample has to go', async () => {
    // A ceiling the record alone cannot fit under, and a sample as the last
    // line: the one shape where `sampledThatFit` keeps nothing.
    const path = journal([...record(60), ...sampled(4)])
    const was = seq
    const done = await compactJournal(path, { maxBytes: 1_024 })
    expect(done?.dropped).toBe(4)
    // Every sample has gone, which is correct: they are the only lines that
    // may go, and there was room for none of them.
    expect(typesIn(path).every((type) => type === 'usage')).toBe(true)
    // And the high-water mark is reported, so what carries the numbering on is
    // a measurement of what the file held and not a guess from what survived.
    expect(done?.seqHigh).toBe(was)
  })

  it('steps over a line it cannot read rather than throwing it away', async () => {
    // A torn last line after a crash is expected everywhere else that reads
    // this file. It must not be the one thing compaction is willing to delete.
    const path = journal(sampled(400))
    appendFileSync(path, '{"seq":999,"ts":"2020-01-01T00:00:00.000Z","ty\n')
    await compactJournal(path, POLICY)
    expect(readFileSync(path, 'utf8')).toContain('{"seq":999,"ts":"2020-01-01T00:00:00.000Z","ty')
  })

  it('reads a journal that is all record as nothing to do, and says why', async () => {
    const path = journal(record(400))
    const before = readFileSync(path, 'utf8')
    const done = await compactJournal(path, POLICY)
    expect(done?.dropped).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(before)
    // Not silence, and not a record deleted to hit a number.
    expect(done?.stillOver).toContain('nothing left in it may be dropped')
    expect(done?.stillOver).toContain('journal.max_mb')
  })
})

describe('what the fold costs afterwards', () => {
  /** A journal shaped like a real one: some record, a lot of sampled output. */
  function shaped(records: number, samples: number): string {
    // The same records in both, down to their sequence numbers, so what is
    // left afterwards can be compared byte for byte.
    seq = 0
    return journal([...record(records), ...sampled(samples)])
  }

  it('is the same whether the trace was twenty thousand lines or two hundred thousand', async () => {
    // The bound, stated as a rule rather than as a number off a clock — a
    // number over a stretch of wall clock is a number about the runner. The
    // fold is linear in the file, so what has to be shown is that the file
    // does not grow with the thing that was growing it: ten times the output
    // leaves the same journal behind, byte for byte.
    const policy: JournalPolicy = { maxBytes: 1_048_576 }
    const small = shaped(2_000, 20_000)
    const large = shaped(2_000, 200_000)
    expect(statSync(large).size).toBeGreaterThan(statSync(small).size * 5)

    for (const path of [small, large]) {
      expect((await compactJournal(path, policy))?.bytesAfter).toBeLessThanOrEqual(policy.maxBytes)
    }
    // The same journal, give or take the width of a sequence number.
    expect(Math.abs(statSync(large).size - statSync(small).size)).toBeLessThan(
      policy.maxBytes / 100,
    )

    // And what a fold over each now reads holds every record either had.
    const read = {
      small: await readJournal(join(small, '..')),
      large: await readJournal(join(large, '..')),
    }
    for (const events of [read.small, read.large]) {
      expect(events.filter((e) => e.type === 'usage')).toHaveLength(2_000)
    }
    expect(read.large.length).toBeLessThan(read.small.length * 1.01)
  })

  it('says what the journal weighs, and what of it is worth keeping', async () => {
    const path = journal([...record(100), ...sampled(400)])
    const weight = await weighJournal(path, POLICY)
    expect(weight.lines).toBe(500)
    expect(weight.sampled).toBe(400)
    expect(weight.bytes).toBe(statSync(path).size)
    // Everything over the ceiling, and it is all sampled: what goes next open.
    expect(weight.droppable).toBeGreaterThan(300)
    expect(weight.droppable).toBeLessThanOrEqual(400)
    // Nothing has been written, so an index that is not there weighs nothing.
    expect(weight.indexBytes).toBe(0)
  })
})

describe('the journal Tade opens', () => {
  it('compacts on open, says so in the journal, and keeps counting where it was', async () => {
    const path = journal([
      ...sampled(400),
      line({ type: 'commit_seen', urgency: 'routine', detail: { sha: 'abc' } }),
    ])
    const lastSeq = seq
    const log = await EventLog.open({ path, indexPath: null, journal: POLICY })
    try {
      const events = await log.read()
      expect(events.map((e) => e.type).filter((t) => t !== 'output')).toEqual([
        'commit_seen',
        'journal_compacted',
      ])
      expect(events.at(-1)?.detail).toMatchObject({ what: expect.any(String) })
      expect(Number(events.at(-1)?.detail.dropped)).toBeGreaterThan(300)
      // The sequence is the file's and the file still ends where it did, so
      // the numbering carries on rather than starting over on top of itself.
      expect((await log.append({ type: 'said' })).seq).toBe(lastSeq + 2)
    } finally {
      await log.close()
    }
  })

  it('carries the numbering on when compaction dropped the line it ended with', async () => {
    // The same shape as the compaction test above, through the door that
    // actually assigns sequence numbers. Without the guard `scanTail` reads
    // the highest surviving record and the next append reuses a number a
    // dropped sample already had.
    const path = journal([...record(60), ...sampled(4)])
    const was = seq
    const log = await EventLog.open({ path, indexPath: null, journal: { maxBytes: 1_024 } })
    try {
      // `journal_compacted` is a record, so it is written at the number after
      // the highest the file ever reached — never on top of a dropped one.
      // (A journal still over its ceiling says so in a `warning` after it,
      // which is this file: the record alone does not fit.)
      const said = (await log.read()).find((e) => e.type === 'journal_compacted')
      expect(said?.seq).toBe(was + 1)
      expect(Number(said?.detail.seq_high)).toBe(was)
      expect((await log.append({ type: 'said' })).seq).toBeGreaterThan(was + 1)
    } finally {
      await log.close()
    }
  })

  it('reads the high-water mark back out of the journal after a crash', async () => {
    // The one window the guard above cannot close on its own: a crash between
    // the rename and the line that says what happened. The compacted file is
    // on the disk and nothing has been appended to it, so the tail is all
    // there is — and the tail is what compaction just lowered. The mark is in
    // the line compaction writes, so the next open reads it rather than
    // starting again on top of numbers that have been used.
    const path = journal([
      line({ type: 'usage', urgency: 'routine', seq: 11 }),
      line({
        type: 'journal_compacted',
        urgency: 'routine',
        seq: 12,
        detail: { dropped: 4, kept: 1, seq_high: 600 },
      }),
    ])
    const log = await EventLog.open({ path, indexPath: null, journal: NEVER_FULL })
    try {
      expect((await log.append({ type: 'said' })).seq).toBe(601)
    } finally {
      await log.close()
    }
  })

  it('says nothing at all when there was nothing to drop', async () => {
    const path = journal(sampled(4))
    const log = await EventLog.open({ path, indexPath: null, journal: NEVER_FULL })
    try {
      // A line per window open saying nothing was dropped is the journal
      // growing in order to record that it is not growing.
      expect((await log.read()).map((e) => e.type)).toEqual([
        'output',
        'output',
        'output',
        'output',
      ])
    } finally {
      await log.close()
    }
  })

  it('says a compaction it could not do, and leaves the journal exactly as it was', async () => {
    // Nothing goes wrong silently, and this one goes wrong over the file that
    // is the truth — so it must not be what stops the window opening either.
    const path = journal(sampled(400))
    const before = readFileSync(path, 'utf8')
    // A directory where the temp file wants to be: `open(tmp, 'w')` throws,
    // which is what a disk that filled up or a permission would do.
    mkdirSync(`${path}.compacting`)
    const log = await EventLog.open({ path, indexPath: null, journal: POLICY })
    try {
      const warnings = await log.read({ types: ['warning'] })
      expect(String(warnings.at(-1)?.detail.message)).toContain('could not compact')
      expect(String(warnings.at(-1)?.detail.message)).toContain('unchanged')
      expect((await log.read({ types: ['journal_compacted'] })).length).toBe(0)
      expect(readFileSync(path, 'utf8').startsWith(before)).toBe(true)
    } finally {
      await log.close()
    }
  })

  it('rebuilds the index from what the file became, instead of answering about lines that have gone', async () => {
    const dir = tmp('tade-compact-index-')
    const path = join(dir, 'events.jsonl')
    const indexPath = join(dir, 'events.jsonl.db')
    writeFileSync(
      path,
      [
        ...sampled(400),
        line({ type: 'check_ran', urgency: 'routine', detail: { check: 'types' } }),
      ].join(''),
    )
    // An index of the journal as it was, which is what a window that closed
    // before any of this left behind.
    const stale = EventIndex.open(indexPath)
    stale?.insertMany(
      readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as TadeEvent),
    )
    expect(stale?.count()).toBe(401)
    stale?.close()

    const log = await EventLog.open({ path, indexPath, journal: POLICY })
    try {
      // `maxSeq` still matched — the newest line is always kept — so nothing
      // would have rebuilt it, and it would have gone on answering about lines
      // that are no longer in the file.
      const lines = readFileSync(path, 'utf8').trim().split('\n').length
      expect(log.index?.count()).toBe(lines)
      expect((await log.read({ types: ['check_ran'] })).length).toBe(1)
    } finally {
      await log.close()
    }
  })
})
