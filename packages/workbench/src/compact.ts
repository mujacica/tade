import { createReadStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { isSample, type JournalPolicy, sampledThatFit, type TadeEvent } from '@tade/core'

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

/** What a compaction did, for the line that says it happened. */
export interface Compaction {
  /** Lines the file had. */
  read: number
  /** Lines dropped: the oldest sampled byte counts, and nothing else. */
  dropped: number
  bytesBefore: number
  bytesAfter: number
  /**
   * Why the file is still over its ceiling, when it is — in a sentence, for
   * the warning. Null when it fits, which is the ordinary outcome.
   */
  stillOver: string | null
}

/**
 * Compact `path` in place, if it is over the ceiling and has anything to drop.
 *
 * Returns null when nothing was done, which is the common case and costs one
 * `stat`. The caller must hold the home lock: this rewrites the file that is
 * the truth, and two writers would interleave.
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

  // First pass: what is in there, and how many of the samples there is room
  // for. A journal whose weight is all record has nothing for this to do, and
  // finding that out must not cost a rewrite of it — so the write only
  // happens once there is a reason for one.
  const survey = await weigh(path)
  const fit = sampledThatFit(survey.recordBytes, survey.sampled, policy.maxBytes)
  const dropped = survey.sampled.length - fit
  const read = survey.records + survey.sampled.length
  if (dropped === 0) {
    return {
      read,
      dropped: 0,
      bytesBefore: before.size,
      bytesAfter: before.size,
      stillOver: tooBig(before.size, policy, survey.records),
    }
  }

  const tmp = `${path}.compacting`
  let after = 0
  try {
    after = await rewrite(path, tmp, dropped)
    await rename(tmp, path)
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => {})
    throw cause
  }
  return {
    read,
    dropped,
    bytesBefore: before.size,
    bytesAfter: after,
    stillOver: after > policy.maxBytes ? tooBig(after, policy, survey.records) : null,
  }
}

function tooBig(bytes: number, policy: JournalPolicy, records: number): string {
  return (
    `events.jsonl is ${mb(bytes)} MB, over the ${mb(policy.maxBytes)} MB it may be, and nothing` +
    ` left in it may be dropped: those ${records} lines are the only record there is of a` +
    ' commit, a check, a turn or something you said. Raise journal.max_mb if this is the size' +
    ' it is.'
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
}

async function weigh(path: string): Promise<Survey> {
  const survey: Survey = { records: 0, recordBytes: 0, sampled: [] }
  for await (const line of lines(path)) {
    const bytes = Buffer.byteLength(line) + 1
    if (sampling(line)) survey.sampled.push(bytes)
    else {
      survey.records++
      survey.recordBytes += bytes
    }
  }
  return survey
}

/**
 * Write the file again without its `drop` oldest samples. Returns its size.
 *
 * The second pass counts sampled lines the same way the first did and drops
 * the first `drop` of them, so the two agree by construction rather than by
 * both being handed a timestamp to compare against.
 */
async function rewrite(path: string, tmp: string, drop: number): Promise<number> {
  const fh = await open(tmp, 'w')
  let written = 0
  let seen = 0
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
      if (sampling(line)) {
        seen++
        if (seen <= drop) continue
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
  return written
}

/**
 * Whether one raw line is a sample, and so droppable.
 *
 * A line that will not parse is not one, like everywhere else that reads this
 * file: a torn write after a crash is something to step over, never a reason
 * to throw somebody's journal away.
 */
function sampling(line: string): boolean {
  try {
    return isSample(JSON.parse(line) as TadeEvent)
  } catch {
    return false
  }
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
  /** Of those, the ones there is no room for: what the next open drops. */
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
  const droppable = survey.sampled.slice(0, survey.sampled.length - fit)
  return {
    path,
    bytes: (await stat(path).catch(() => null))?.size ?? 0,
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
