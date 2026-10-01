import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { forgetRead, recordOf } from '../src/record.ts'
import { NOW } from './harness.ts'

// What the status bar costs to say how the watches are doing.
//
// Jev keeps a line in the status bar, and the window asks every few seconds
// whether anybody is looking or not. That line is folded out of the journal —
// which is right, because status is a query — and folding it meant reading and
// parsing the whole file: 204 ms and 313 MB of garbage over 232,000 events to
// find the hundred that were watches, every ten to fifteen seconds, for as long
// as the window stayed open. A moment's cache made it happen less often without
// making it cost less, and the cost grew with the journal, so it got worse every
// hour — which is what a periodic spike nobody could place turned out to be.
//
// The journal only ever grows, so a second read of it is the part that is new.
// That is what is asserted here, and it is asserted as a ratio rather than as a
// rate the machine has to hit: a slow machine makes both numbers bigger and the
// probe still means the same thing.

/** How many repeat reads to make the beat's cost out of. */
const REPEATS = 20

/**
 * What the repeats may cost, measured in whole reads.
 *
 * Twenty reads of the whole file would be twenty. Twenty reads of nothing is
 * somewhere near zero, and two is the slack that leaves for a `stat`, the
 * schedules file and a machine under load. It means this again now that the
 * baseline is a journal the process has not seen: measured against a reader
 * already at the end of its file, two was a number nothing could meet.
 */
const BUDGET = 2

function bigJournal(home: string, events: number): void {
  const lines: string[] = []
  for (let seq = 1; seq <= events; seq++) {
    // Output events are what a real journal is mostly made of, and they are the
    // big ones: 78% of the bytes in the journal this was found in.
    lines.push(
      JSON.stringify({
        seq,
        ts: new Date(NOW - (events - seq) * 1000).toISOString(),
        type: 'output',
        urgency: 'trace',
        lane: 'some-task/agent',
        detail: { bytes: 4096, sample: 'x'.repeat(160) },
      }),
    )
  }
  writeFileSync(join(home, 'events.jsonl'), `${lines.join('\n')}\n`)
}

function watchLine(seq: number, key: string): string {
  return `${JSON.stringify({
    seq,
    ts: new Date(NOW).toISOString(),
    type: 'watch_found',
    urgency: 'routine',
    detail: { schedule: 'jev-verdicts', key, summary: `finding ${key}` },
  })}\n`
}

function schedule(home: string): void {
  writeFileSync(
    join(home, 'schedules.jsonl'),
    `${JSON.stringify({
      op: 'set',
      by: 'you',
      at: new Date(NOW).toISOString(),
      schedule: {
        id: 'jev-verdicts',
        name: 'Findings nobody judged',
        project: 'tade',
        said: '',
        when: { every: '1h' },
        does: { kind: 'watch', watch: 'jev.verdicts', input: {}, found: 'ask', most: 3 },
        missed: 'once',
        by: 'you',
        created: new Date(NOW).toISOString(),
      },
    })}\n`,
  )
}

function context(home: string): ExtensionContext {
  return {
    extension: 'jev',
    settings: {},
    projects: [],
    project: () => {
      throw new Error('no projects here')
    },
    env: {},
    secret: () => null,
    fetch: async () => {
      throw new Error('it reached the network')
    },
    exec: async () => ({ ok: false, code: 1, stdout: '', stderr: 'nothing runs here' }),
    home,
    now: () => NOW,
  }
}

async function millis(fn: () => Promise<unknown>): Promise<number> {
  const at = performance.now()
  await fn()
  return performance.now() - at
}

describe('what the status bar costs to keep', () => {
  it('reads the journal once, and after that only what was appended', async () => {
    // A journal this process has not seen, every time one is wanted.
    //
    // The baseline has to be a *whole* read, and a reader that has reached the
    // end of a file never reads the whole of it again — which is the very
    // thing under test. Measured twice on one journal, the second measurement
    // is already the fast path, so the only genuinely cold read in a process
    // is its first. That is what this used to measure, and it measured V8 with
    // it: interpreted, that first read was 102ms; compiled, the same read is
    // under one. The margin was all skew, the probe said nothing about the
    // cache, and a loaded runner that moved either number turned it red.
    const fresh = (): ReturnType<typeof context> => {
      const home = mkdtempSync(join(tmpdir(), 'tade-jev-probe-'))
      bigJournal(home, 40_000)
      appendFileSync(join(home, 'events.jsonl'), watchLine(40_001, 'one'))
      schedule(home)
      return context(home)
    }

    // Compile the path before timing anything on it.
    forgetRead()
    await recordOf(fresh())

    // The quickest of a few goes, each on a journal of its own: noise only
    // ever adds time, so the best round is the one about the reading.
    let cold = Number.POSITIVE_INFINITY
    for (let round = 0; round < 3; round++) {
      const ctx = fresh()
      forgetRead()
      cold = Math.min(cold, await millis(() => recordOf(ctx)))
    }

    // And the appends, against a journal already read to its end.
    const ctx = fresh()
    forgetRead()
    await recordOf(ctx)
    let warm = Number.POSITIVE_INFINITY
    for (let round = 0; round < 3; round++) {
      warm = Math.min(
        warm,
        await millis(async () => {
          for (let i = 0; i < REPEATS; i++) {
            // The moment's cache is not what is under test: without it, every
            // one of these used to read the whole file again.
            forgetRead()
            await recordOf(ctx)
          }
        }),
      )
    }

    expect(
      warm,
      `${REPEATS} appends cost ${warm.toFixed(1)}ms, one whole read ${cold.toFixed(1)}ms`,
    ).toBeLessThan(cold * BUDGET)
  })

  it('finds what was appended since, and nothing twice', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tade-jev-probe-'))
    bigJournal(home, 2_000)
    appendFileSync(join(home, 'events.jsonl'), watchLine(2_001, 'one'))
    schedule(home)
    const ctx = context(home)

    forgetRead()
    const first = await recordOf(ctx)
    expect(first.findings.map((one) => one.key)).toEqual(['one'])

    appendFileSync(join(home, 'events.jsonl'), watchLine(2_002, 'two'))
    forgetRead()
    const second = await recordOf(ctx)
    expect(second.findings.map((one) => one.key)).toEqual(['two', 'one'])

    // A read with nothing appended is the same answer, not a shorter one.
    forgetRead()
    const third = await recordOf(ctx)
    expect(third.findings.map((one) => one.key)).toEqual(['two', 'one'])
  })

  it('reads a half-written line when the rest of it arrives, and not before', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tade-jev-probe-'))
    bigJournal(home, 100)
    appendFileSync(join(home, 'events.jsonl'), watchLine(101, 'one'))
    schedule(home)
    const ctx = context(home)

    forgetRead()
    expect((await recordOf(ctx)).findings.map((one) => one.key)).toEqual(['one'])

    // A line still being appended has no newline yet: it is nobody's event
    // until it does, rather than a parse failure counted as one.
    const torn = watchLine(102, 'two')
    appendFileSync(join(home, 'events.jsonl'), torn.slice(0, 40))
    forgetRead()
    expect((await recordOf(ctx)).findings.map((one) => one.key)).toEqual(['one'])

    appendFileSync(join(home, 'events.jsonl'), torn.slice(40))
    forgetRead()
    expect((await recordOf(ctx)).findings.map((one) => one.key)).toEqual(['two', 'one'])
  })

  it('keeps what it read when the journal cannot be read at all', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tade-jev-probe-'))
    bigJournal(home, 100)
    appendFileSync(join(home, 'events.jsonl'), watchLine(101, 'one'))
    schedule(home)
    const ctx = context(home)

    forgetRead()
    expect((await recordOf(ctx)).findings.map((one) => one.key)).toEqual(['one'])

    // A journal that is not there right now is not a journal that said there
    // were no findings. Blanking the line because a read failed is the silent
    // failure here: the status bar would say the watches found nothing, which
    // is a different sentence from "could not look".
    rmSync(join(home, 'events.jsonl'))
    forgetRead()
    expect((await recordOf(ctx)).findings.map((one) => one.key)).toEqual(['one'])

    // And when it comes back shorter than what was read, it is read again from
    // the start rather than counted on top.
    writeFileSync(join(home, 'events.jsonl'), watchLine(1, 'two'))
    forgetRead()
    expect((await recordOf(ctx)).findings.map((one) => one.key)).toEqual(['two'])
  })

  it('starts over when the journal is shorter than what it read', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tade-jev-probe-'))
    bigJournal(home, 500)
    appendFileSync(join(home, 'events.jsonl'), watchLine(501, 'one'))
    appendFileSync(join(home, 'events.jsonl'), watchLine(502, 'two'))
    schedule(home)
    const ctx = context(home)

    forgetRead()
    expect((await recordOf(ctx)).findings.map((one) => one.key)).toEqual(['two', 'one'])

    // Rotated: a shorter file is not the file that was read, so what was held
    // of it goes rather than being counted on top of what is there now.
    writeFileSync(join(home, 'events.jsonl'), watchLine(1, 'three'))
    forgetRead()
    expect((await recordOf(ctx)).findings.map((one) => one.key)).toEqual(['three'])
  })
})
