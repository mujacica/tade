import { createReadStream, type Stats } from 'node:fs'
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { isSample, type JournalPolicy, sampledThatFit, type TadeEvent } from '@tade/core'
import type { IndexedRow } from './event-index.ts'

// Compacting the journal: dropping the lines that were only ever a sample of
// something still sitting where it was, and keeping every line that is the
// only record there is of itself.
//
// Why this and not a roll. Rolling bounds the file and not the fold, and every
// statistic here is a fold over all of history — `spendFrom`, `runtimeFrom`,
// `statsFrom`, `commit_seen`, `check_ran`. So a roll leaves two choices and
// both are worse: readers that do not follow it, and every total silently gets
// smaller on the day it happens, which is the one failure this codebase names
// as worse than no statistic at all; or readers that do, and the fold is
// exactly as long as it was, the roll having bought a second file to forget.
// Dropping the samples buys the same smaller file with neither cost, and
// leaves one replayable sequence behind rather than a sequence split across
// files that `seq`, `scanTail` and the index rebuild would all have to learn.
//
// What this does not bound is the part nobody may delete. After the samples
// are gone the journal is commits, checks, turns, what they cost and what you
// said, and it grows with the work — about a megabyte a day on the machine
// this was measured on. That is said out loud when the file is still over its
// ceiling with nothing droppable left in it, rather than met by deleting a
// record to hit a number.
//
// And what it does not do is compact for a crumb. A journal whose record alone
// is over the ceiling can never get under it, so before this every open that
// found any new sample at all dropped it: 14 of 26 window opens on the machine
// this was measured on, the last taking 54.4 MB to 53.9 MB, each a rewrite of
// the whole file and — until the index learned to forget rows — a rebuild of
// the index, seven seconds before the window drew anything. So a compaction
// has to be worth `LEAST_GAIN` of the file, and the look that decides it is
// remembered (`events.jsonl.survey`), so that deciding not to costs a `stat`
// and not a read of every line.

/** What a compaction did, for the line that says it happened. */
export interface Compaction {
  /**
   * Lines the file had — when nothing was dropped, as of the last time it was
   * read through, which a compaction that declined may not have done.
   */
  read: number
  /** Lines dropped: the oldest sampled byte counts, and nothing else. */
  dropped: number
  /**
   * The lines dropped, by number and by the word each was written as: what
   * the index takes out, rather than being thrown away and built again.
   */
  gone: IndexedRow[]
  bytesBefore: number
  bytesAfter: number
  /**
   * Why the file is still over its ceiling, when it is — in a sentence, for
   * the warning. Null when it fits, which is the ordinary outcome.
   */
  stillOver: string | null
  /**
   * The highest `seq` the file held **before** anything was dropped.
   *
   * Compaction keeps the newest samples first, so the file ordinarily still
   * ends where it did and the tail recovers the same number. Where the record
   * alone is over the ceiling there is room for no sample at all and every
   * one goes, the last line included — and then the tail reaches lower than
   * the file once did, and the next window hands numbers that have been used
   * to different events. So the mark is measured here, where every line is
   * read anyway, and the caller carries the numbering on from it instead of
   * from whatever happened to survive. Nothing is kept to hold a number and
   * no line is rewritten: the number is a reading of what was there.
   */
  seqHigh: number
}

/**
 * The least a compaction must take out, as a share of the file, to be done.
 *
 * Rewriting the file is a read and a write of all of it — half a second on a
 * 54 MB journal, on a window open somebody is waiting through — and what a
 * crumb buys is nothing anybody can see: the file is the size it was, give or
 * take, and every fold over it costs what it did. So the ceiling is met to
 * within this much, and a journal whose record alone is over the ceiling
 * keeps its samples until they are this much of it, then loses them all at
 * once. Three percent of a 16 MB journal is half a megabyte.
 */
export const LEAST_GAIN = 0.03

/**
 * Compact `path` in place, if it is over the ceiling and has enough to drop.
 *
 * Returns null when nothing was done and there is nothing to say, which is the
 * common case and costs a `stat` — two, over the ceiling, and a small read of
 * what the last look found. The caller must hold the home lock: this rewrites
 * the file that is the truth, and two writers would interleave.
 *
 * Nothing is destroyed until a whole, fsync'd copy exists beside it: the kept
 * lines are written to a temp file, flushed to the disk and only then renamed
 * over the journal. A crash anywhere before the rename leaves the journal
 * exactly as it was, plus a temp file the next compaction overwrites.
 */
export async function compactJournal(
  path: string,
  policy: JournalPolicy,
): Promise<Compaction | null> {
  const before = await stat(path).catch(() => null)
  if (!before?.isFile() || before.size <= policy.maxBytes) return null
  const least = before.size * LEAST_GAIN

  // What the last look found, if it was a look at this file. Every byte since
  // could be a sample, and fitting never takes out more than the file is over
  // by and one line more, so the most this could drop is the smaller of the
  // two — and under `least`, the file need not be read to know the answer.
  const known = await recall(path, before)
  if (known && mostDroppable(known, before.size, policy) < least) {
    return declined(known, before.size, policy)
  }

  // First pass: what is in there, and how many of the samples there is room
  // for. A journal whose weight is all record has nothing for this to do, and
  // finding that out must not cost a rewrite of it — so the write only
  // happens once there is a reason for one.
  const survey = await weigh(path)
  const fit = sampledThatFit(survey.recordBytes, survey.sampled, policy.maxBytes)
  const dropped = survey.sampled.length - fit
  const gain = survey.sampled.slice(0, dropped).reduce((a, b) => a + b, 0)
  if (dropped === 0 || gain < least) {
    const looked = weighed(survey, before.size)
    await remember(path, before, looked)
    return declined(looked, before.size, policy)
  }

  const tmp = `${path}.compacting`
  let wrote: Rewritten
  try {
    wrote = await rewrite(path, tmp, dropped)
    await rename(tmp, path)
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => {})
    throw cause
  }
  // What is in the file now is known without reading it: the same record,
  // and the samples that fitted.
  const after = await stat(path).catch(() => null)
  if (after) {
    await remember(
      path,
      after,
      weighed({ ...survey, sampled: survey.sampled.slice(dropped) }, after.size),
    )
  }
  return {
    read: survey.records + survey.sampled.length,
    dropped,
    gone: wrote.gone,
    bytesBefore: before.size,
    bytesAfter: wrote.bytes,
    stillOver: wrote.bytes > policy.maxBytes ? tooBig(wrote.bytes, policy, survey.records) : null,
    seqHigh: survey.seqHigh,
  }
}

/**
 * Nothing dropped, and whether that needs saying.
 *
 * Over the ceiling with the record alone over it too, it does: that is the
 * person's to act on, every open, as it always was. Otherwise the file is
 * over by less than `LEAST_GAIN` and that is the tolerance, not news.
 */
function declined(known: Weighed, bytes: number, policy: JournalPolicy): Compaction | null {
  if (known.recordBytes <= policy.maxBytes) return null
  // The count is said only where it is this file's own: a look with no
  // samples in it, at the file as it is now.
  const exact = known.samples === 0 && known.bytes === bytes
  return {
    read: known.records + known.samples,
    dropped: 0,
    gone: [],
    bytesBefore: bytes,
    bytesAfter: bytes,
    stillOver: tooBig(bytes, policy, exact ? known.records : null),
    seqHigh: known.seqHigh,
  }
}

/**
 * The most a compaction of a file `bytes` long could drop, from an older look
 * at it.
 *
 * Every byte appended since could be a sample. And fitting never takes out
 * more than the file is over by and one line more — `sampledThatFit` stops at
 * the first sample with no room — where the line is the longest the look saw,
 * so a longer one since makes this low by the difference: a decline of a
 * compaction a few hundred bytes past `LEAST_GAIN`, which the next open does.
 */
function mostDroppable(known: Weighed, bytes: number, policy: JournalPolicy): number {
  const samples = known.sampledBytes + (bytes - known.bytes)
  const fitting = bytes - policy.maxBytes + known.longest
  return Math.min(samples, Math.max(0, fitting))
}

/**
 * Why the file is still over its ceiling, for the warning.
 *
 * `records` is null where the look it is from is older than the file, which
 * is every decline made without reading it: then no number is said, because
 * the one there is would be the file's as it was.
 */
function tooBig(bytes: number, policy: JournalPolicy, records: number | null): string {
  const left =
    records === null
      ? ` but what sampled output there is, under ${LEAST_GAIN * 100}% of it and not worth` +
        ' rewriting it for: the rest is the only record there is of a'
      : `: those ${records} lines are the only record there is of a`
  return (
    `events.jsonl is ${mb(bytes)} MB, over the ${mb(policy.maxBytes)} MB it may be, and nothing` +
    ` left in it may be dropped${left} commit, a check, a turn or something you said. Raise` +
    ' journal.max_mb if this is the size it is.'
  )
}

function mb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1)
}

/** What the file holds, in the two weights the rule needs. */
interface Survey {
  /** Lines that are the only record there is of themselves. */
  records: number
  recordBytes: number
  /** The byte length of each sampled line, oldest first. */
  sampled: number[]
  /**
   * The highest `seq` in the file, whether its line survives or not, and
   * whatever order the numbers are in — a journal is appended in order, but a
   * `max` costs the same as reading the last one and is right either way.
   * A line that will not parse has no number, like everywhere else.
   */
  seqHigh: number
  /** The longest sampled line, which is how far past the ceiling fitting can reach. */
  longest: number
}

async function weigh(path: string): Promise<Survey> {
  const survey: Survey = { records: 0, recordBytes: 0, sampled: [], seqHigh: 0, longest: 0 }
  for await (const line of lines(path)) {
    const bytes = Buffer.byteLength(line) + 1
    const event = parsed(line)
    if (event && typeof event.seq === 'number' && event.seq > survey.seqHigh) {
      survey.seqHigh = event.seq
    }
    if (event && isSample(event)) {
      survey.sampled.push(bytes)
      if (bytes > survey.longest) survey.longest = bytes
    } else {
      survey.records++
      survey.recordBytes += bytes
    }
  }
  return survey
}

/**
 * What a look found, in the sums a decision needs, and how long the file was.
 *
 * Sums and not the survey, because the survey holds a length per sample —
 * 232,324 of them on the journal this was written for — and what is kept of
 * a look is read on every open over the ceiling.
 */
interface Weighed {
  /** The file's size when it was looked at. */
  bytes: number
  records: number
  recordBytes: number
  samples: number
  sampledBytes: number
  seqHigh: number
  longest: number
}

function weighed(survey: Survey, bytes: number): Weighed {
  return {
    bytes,
    records: survey.records,
    recordBytes: survey.recordBytes,
    samples: survey.sampled.length,
    sampledBytes: survey.sampled.reduce((a, b) => a + b, 0),
    seqHigh: survey.seqHigh,
    longest: survey.longest,
  }
}

/**
 * A look, and which file it was of.
 *
 * Kept beside the journal in `events.jsonl.survey`, derived like the index and
 * as safe to delete: without it the next compaction over the ceiling reads the
 * file again. Keyed on the file's size and identity rather than its contents,
 * because the journal is appended to and never edited — the same file, at
 * least as long as it was, is the file that was looked at with something
 * added — and a compaction renames a new file into place, which is a new
 * identity.
 */
interface Remembered extends Weighed {
  dev: number
  ino: number
}

const surveyPath = (path: string): string => `${path}.survey`

/** The last look at this file, or null when there was none or it was of another one. */
async function recall(path: string, now: Stats): Promise<Remembered | null> {
  try {
    const kept = JSON.parse(await readFile(surveyPath(path), 'utf8')) as Record<string, unknown>
    const keys = [
      'bytes',
      'records',
      'recordBytes',
      'samples',
      'sampledBytes',
      'seqHigh',
      'longest',
    ]
    if (![...keys, 'dev', 'ino'].every((key) => Number.isFinite(kept[key]))) return null
    if (kept.dev !== now.dev || kept.ino !== now.ino) return null
    // Shorter than when it was looked at is not this file appended to.
    if ((kept.bytes as number) > now.size) return null
    return kept as unknown as Remembered
  } catch {
    return null
  }
}

/**
 * Remember a look at the file as it was at `at`.
 *
 * A write that fails is a read of the file next time and nothing else, so it
 * is not worth a word in the journal it is about.
 */
async function remember(path: string, at: Stats, looked: Weighed): Promise<void> {
  const kept: Remembered = { ...looked, dev: at.dev, ino: at.ino }
  await writeFile(surveyPath(path), JSON.stringify(kept)).catch(() => {})
}

/** What a rewrite wrote, and what it left out. */
interface Rewritten {
  bytes: number
  gone: IndexedRow[]
}

/**
 * Write the file again without its `drop` oldest samples.
 *
 * The second pass counts sampled lines the same way the first did and drops
 * the first `drop` of them, so the two agree by construction rather than by
 * both being handed a timestamp to compare against.
 */
async function rewrite(path: string, tmp: string, drop: number): Promise<Rewritten> {
  const fh = await open(tmp, 'w')
  let written = 0
  let seen = 0
  const gone: IndexedRow[] = []
  try {
    // Batched rather than a write per line: 38,000 of those is 38,000 syscalls
    // for a file that is read in one.
    let batch: string[] = []
    let pending = 0
    const flush = async () => {
      if (pending === 0) return
      const text = batch.join('')
      batch = []
      pending = 0
      await fh.write(text)
      written += Buffer.byteLength(text)
    }
    for await (const line of lines(path)) {
      const sample = sampling(line)
      if (sample) {
        seen++
        if (seen <= drop) {
          // A line with no number was never indexed under one.
          if (typeof sample.seq === 'number') gone.push({ seq: sample.seq, type: sample.type })
          continue
        }
      }
      batch.push(line, '\n')
      pending += line.length + 1
      if (pending >= 1_048_576) await flush()
    }
    await flush()
    // The journal is about to be replaced by this file. It exists on the disk
    // before that happens, or the rename never runs.
    await fh.sync()
  } finally {
    await fh.close()
  }
  return { bytes: written, gone }
}

/**
 * One raw line as an event, or null where it will not parse.
 *
 * A line that will not parse is not a sample and has no sequence number, like
 * everywhere else that reads this file: a torn write after a crash is
 * something to step over, never a reason to throw somebody's journal away.
 */
function parsed(line: string): TadeEvent | null {
  try {
    return JSON.parse(line) as TadeEvent
  } catch {
    return null
  }
}

/** One raw line as a sample, and so droppable; null when it is anything else. */
function sampling(line: string): TadeEvent | null {
  const event = parsed(line)
  return event !== null && isSample(event) ? event : null
}

/** Every non-blank line of the file, as it was written. */
async function* lines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (line.trim()) yield line
    }
  } finally {
    stream.destroy()
  }
}

/** What the journal weighs, and what the next open would take out of it. */
export interface JournalWeight {
  path: string
  bytes: number
  lines: number
  /** Lines that were only ever a sample of bytes still in a lane's scrollback. */
  sampled: number
  sampledBytes: number
  /**
   * Of those, the ones there is no room for: what the next open drops — which
   * is none while they come to less than `LEAST_GAIN` of the file.
   */
  droppable: number
  droppableBytes: number
  /** The derived index beside it, with its write-ahead log. `0` when there is none. */
  indexPath: string
  indexBytes: number
}

/**
 * Read what the journal costs, for somebody who came looking because a folder
 * got big.
 *
 * It reads the whole file, which is the point: `stat` says 54 MB and says
 * nothing about what any of it is. The answer somebody needs is which part of
 * that is a byte count nothing reads and which part is the only record there
 * is of their work — and, beside it, that the index is derived and deleting it
 * is always safe, which is the one thing nothing anywhere said.
 */
export async function weighJournal(path: string, policy: JournalPolicy): Promise<JournalWeight> {
  const indexPath = `${path}.db`
  const survey = await weigh(path)
  const sampledBytes = survey.sampled.reduce((a, b) => a + b, 0)
  const fit = sampledThatFit(survey.recordBytes, survey.sampled, policy.maxBytes)
  const bytes = (await stat(path).catch(() => null))?.size ?? 0
  const over = survey.sampled.slice(0, survey.sampled.length - fit)
  const droppable = over.reduce((a, b) => a + b, 0) < bytes * LEAST_GAIN ? [] : over
  return {
    path,
    bytes,
    lines: survey.records + survey.sampled.length,
    sampled: survey.sampled.length,
    sampledBytes,
    droppable: droppable.length,
    droppableBytes: droppable.reduce((a, b) => a + b, 0),
    indexPath,
    // The write-ahead log is part of what it costs on the disk, and on a
    // journal this size it is megabytes of its own.
    indexBytes: (
      await Promise.all(
        ['', '-wal', '-shm'].map((suffix) =>
          stat(`${indexPath}${suffix}`)
            .then((s) => s.size)
            .catch(() => 0),
        ),
      )
    ).reduce((a, b) => a + b, 0),
  }
}
