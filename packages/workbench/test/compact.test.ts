import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { EventType, type JournalPolicy, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { compactJournal, LEAST_GAIN, weighJournal } from '../src/compact.ts'
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

describe('what compaction declines', () => {
  /** A journal of `records` and `samples`, and a ceiling it is over by `over` of itself. */
  function overBy(over: number, records: string[], samples: string[]) {
    const path = journal([...records, ...samples])
    const size = statSync(path).size
    return { path, policy: { maxBytes: Math.floor(size * (1 - over)) } }
  }

  it('leaves a journal over its ceiling by less than LEAST_GAIN alone, and says nothing', async () => {
    // Rewriting 54 MB to reclaim half a megabyte was most window opens on the
    // machine this was measured on. The record fits under the ceiling here, so
    // what is over is a crumb of sampled output — the tolerance, not news.
    const { path, policy } = overBy(LEAST_GAIN / 3, record(100), sampled(300))
    const before = readFileSync(path, 'utf8')
    expect(await compactJournal(path, policy)).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('compacts once there is LEAST_GAIN of the file to take', async () => {
    const { path, policy } = overBy(LEAST_GAIN * 2, record(100), sampled(300))
    const done = await compactJournal(path, policy)
    expect(done?.dropped).toBeGreaterThan(0)
    expect(statSync(path).size).toBeLessThanOrEqual(policy.maxBytes)
  })

  it('keeps the samples of a journal that is all record until they are worth dropping', async () => {
    // The record alone is over the ceiling, so no compaction ever gets under
    // it, and every sample is droppable. A few of them is not worth the file.
    const path = journal([...record(400), ...sampled(4)])
    const before = readFileSync(path, 'utf8')
    const first = await compactJournal(path, POLICY)
    expect(first?.dropped).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(before)
    // Still over, which is still the person's to act on — said without a
    // count that would be the file's as it was rather than as it is.
    expect(first?.stillOver).toContain('what sampled output there is')
    expect(first?.stillOver).toContain('journal.max_mb')

    // Enough of them, and they all go at once.
    appendFileSync(path, sampled(20).join(''))
    const second = await compactJournal(path, POLICY)
    expect(second?.dropped).toBe(24)
    expect(typesIn(path).every((type) => type === 'usage')).toBe(true)
  })
})

describe('what is remembered of a look', () => {
  /**
   * Exactly `size` bytes of nothing but samples: a journal any read of would
   * compact to almost nothing.
   */
  function samplesOf(size: number): string {
    const lines: string[] = []
    let written = 0
    const one = line()
    while (size - written >= one.length * 2) {
      const next = line()
      lines.push(next)
      written += next.length
    }
    const last = line({ detail: { bytes: 1, pad: '' } })
    lines.push(line({ detail: { bytes: 1, pad: 'x'.repeat(size - written - last.length) } }))
    const text = lines.join('')
    expect(text.length).toBe(size)
    return text
  }

  /**
   * Write `path` again in place — the same file, the same length — as nothing
   * but samples. Only a decision made without reading it leaves it as it is.
   */
  function allSamplesInPlace(path: string): string {
    const text = samplesOf(statSync(path).size)
    writeFileSync(path, text)
    return text
  }

  it('declines from the last look while the file has not grown by enough to matter', async () => {
    const path = journal([...record(400), ...sampled(4)])
    expect((await compactJournal(path, POLICY))?.dropped).toBe(0)
    const text = allSamplesInPlace(path)
    // The same file, no longer: a look that was remembered and not taken
    // again is the half second a window open no longer waits through.
    expect((await compactJournal(path, POLICY))?.dropped).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  it('does not read a journal just over its ceiling on every open', async () => {
    // The ordinary home: the record fits, the samples fill the rest, and the
    // file creeps past the ceiling between compactions. Whether it is worth
    // compacting is known from how far over it is, so the file is not read —
    // which is only visible from a file that cannot be.
    const path = journal([...record(100), ...sampled(300)])
    const policy = { maxBytes: Math.floor(statSync(path).size * (1 - LEAST_GAIN / 3)) }
    expect(await compactJournal(path, policy)).toBeNull()
    chmodSync(path, 0o200)
    try {
      expect(await compactJournal(path, policy)).toBeNull()
      // And it is the look that was remembered that spared it: without one,
      // the same call reads the file and fails on it.
      rmSync(`${path}.survey`)
      if (process.getuid?.() !== 0) await expect(compactJournal(path, policy)).rejects.toThrow()
    } finally {
      chmodSync(path, 0o644)
    }
  })

  it('remembers what a compaction left, so the next open need not read it either', async () => {
    const path = journal([...record(400), ...sampled(400)])
    expect((await compactJournal(path, POLICY))?.dropped).toBe(400)
    const text = allSamplesInPlace(path)
    expect((await compactJournal(path, POLICY))?.dropped).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  it('reads the file again when it is not the file that was looked at', async () => {
    // Each differs from the file that was looked at in the one way it names,
    // and is otherwise the in-place rewrite above, which is declined.
    for (const unlike of ['forgotten', 'garbled', 'replaced', 'shorter'] as const) {
      const path = journal([...record(400), ...sampled(4)])
      expect((await compactJournal(path, POLICY))?.dropped).toBe(0)
      const size = statSync(path).size
      if (unlike === 'forgotten') {
        // Derived, and as safe to delete as the index.
        rmSync(`${path}.survey`)
        writeFileSync(path, samplesOf(size))
      } else if (unlike === 'garbled') {
        // Torn by a crash, or written by something else: not a look at all.
        writeFileSync(`${path}.survey`, JSON.stringify({ bytes: 'all of it', samples: 0 }))
        writeFileSync(path, samplesOf(size))
      } else if (unlike === 'replaced') {
        // A new file renamed into place, as a compaction does.
        writeFileSync(`${path}.new`, samplesOf(size))
        renameSync(`${path}.new`, path)
      } else {
        writeFileSync(path, samplesOf(size - 1_000))
      }
      expect((await compactJournal(path, POLICY))?.dropped, unlike).toBeGreaterThan(300)
    }
  })

  it('reads the file again once what was appended could be worth dropping', async () => {
    const path = journal([...record(400), ...sampled(4)])
    expect((await compactJournal(path, POLICY))?.dropped).toBe(0)
    appendFileSync(path, sampled(40).join(''))
    expect((await compactJournal(path, POLICY))?.dropped).toBe(44)
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

  it('says nothing goes when what could is not worth a compaction', async () => {
    // What the next open does, which declines a crumb: saying those lines go
    // would be saying something no open is about to do.
    const path = journal([...record(400), ...sampled(4)])
    const weight = await weighJournal(path, POLICY)
    expect(weight.sampled).toBe(4)
    expect(weight.droppable).toBe(0)
    expect(weight.droppableBytes).toBe(0)
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

  /** A journal over POLICY and an index of every line of it, as a window that closed left them. */
  function indexed(lines: string[]) {
    const dir = tmp('tade-compact-index-')
    const path = join(dir, 'events.jsonl')
    const indexPath = join(dir, 'events.jsonl.db')
    writeFileSync(path, lines.join(''))
    const events = lines.map((l) => JSON.parse(l) as TadeEvent)
    return { path, indexPath, events }
  }

  it('takes the lines it dropped out of the index, instead of answering about lines that have gone', async () => {
    const { path, indexPath, events } = indexed([
      ...sampled(400),
      line({ type: 'check_ran', urgency: 'routine', detail: { check: 'types' } }),
    ])
    const kept = EventIndex.open(indexPath)
    kept?.insertMany(events)
    // A row the file says differently, which only building the index again
    // from the file would rewrite: it is how this test can see that the index
    // was taken from rather than thrown away and built again — seven seconds
    // of a window open, on the journal this was measured on, to reclaim 1%.
    const check = events.at(-1) as TadeEvent
    kept?.insert({ ...check, detail: { check: 'as the index had it' } })
    expect(kept?.count()).toBe(401)
    kept?.close()

    const log = await EventLog.open({ path, indexPath, journal: POLICY })
    try {
      // `maxSeq` still matched — the newest line is always kept — so that
      // alone would have left it answering about lines no longer in the file.
      const lines = readFileSync(path, 'utf8').trim().split('\n').length
      expect(log.index?.count()).toBe(lines)
      const checks = await log.read({ types: ['check_ran'] })
      expect(checks.map((e) => e.detail.check)).toEqual(['as the index had it'])
    } finally {
      await log.close()
    }
  })

  it('builds the index again when what is left of it does not line up with the file', async () => {
    const { path, indexPath, events } = indexed([
      ...sampled(400),
      line({ type: 'check_ran', urgency: 'routine', detail: { check: 'types' } }),
    ])
    // Behind the file by its last line, as a crash between the two writes
    // leaves it: taking rows out cannot make that right, so it is built again.
    const behind = EventIndex.open(indexPath)
    behind?.insertMany(events.slice(0, -1))
    behind?.close()

    const log = await EventLog.open({ path, indexPath, journal: POLICY })
    try {
      const lines = readFileSync(path, 'utf8').trim().split('\n').length
      expect(log.index?.count()).toBe(lines)
      expect((await log.read({ types: ['check_ran'] })).map((e) => e.detail.check)).toEqual([
        'types',
      ])
    } finally {
      await log.close()
    }
  })
})
