import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { JOURNAL_CHUNK, type JournalFile, readJournalSince } from '../src/events.ts'

// A journal of any size opens. Node takes a read's length only as a 32-bit
// integer and asserts — a core dump, not a throw — on a longer one, and a
// journal read from the start was read in one: on 26 Nov ipax's passed 2^31
// bytes and its service died at every start (`readJournalSince`). So it is
// read a chunk at a time, and a journal that big is handed in through the
// reader's own seam rather than written to disk.

const INT32 = 2 ** 31 - 1

const line = (seq: number, type = 'note') =>
  `${JSON.stringify({ seq, ts: '2026-11-26T06:00:00.000Z', type, urgency: 'routine', detail: {} })}\n`

/** A file of `size` bytes whose last `tail` bytes are `tail`, recording every read asked of it. */
function huge(
  size: number,
  tail: string,
  reads: { position: number; length: number }[],
): JournalFile {
  const bytes = Buffer.from(tail)
  const tailAt = size - bytes.length
  return {
    stat: async () => ({ size }),
    read: async (buffer, offset, length, position) => {
      reads.push({ position, length })
      // Node's own rule, which is what took ipax down.
      if (!Number.isInteger(length) || length > INT32) throw new Error('args[3]->IsInt32()')
      // Before the tail there is nothing this test wants read: it is as if it shrank.
      if (position < tailAt) return { bytesRead: 0 }
      const got = bytes.copy(buffer, offset, position - tailAt, position - tailAt + length)
      return { bytesRead: got }
    },
    close: async () => {},
  }
}

describe('a journal of any size', () => {
  it('reads past 2 GiB of offset in chunks, whole lines only, and says where it got to', async () => {
    const tail = `${line(1)}${line(2, 'warning')}${line(3)}{"seq":4,"torn`
    const size = 2 ** 31 + 4096
    const from = size - Buffer.byteLength(tail)
    const reads: { position: number; length: number }[] = []
    const read = await readJournalSince(tmp(), {}, from, {
      open: async () => huge(size, tail, reads),
      chunk: 64,
    })
    expect(read.events.map((one) => one.seq)).toEqual([1, 2, 3])
    expect(read.readFrom).toBe(from)
    // The torn line is left for the read that finds its newline.
    expect(read.readTo).toBe(size - '{"seq":4,"torn'.length)
    expect(reads.length).toBeGreaterThan(1)
    expect(reads.every((one) => one.length <= 64 && one.position > INT32)).toBe(true)
    // Each read starts where the last ended.
    expect(reads.slice(1).map((one, i) => one.position - (reads[i]?.position ?? 0))).toEqual(
      reads.slice(1).map(() => 64),
    )
  })

  it('never asks one read for more than Node takes, from the start of a journal past 2^31 bytes', async () => {
    const reads: { position: number; length: number }[] = []
    const read = await readJournalSince(tmp(), {}, 0, {
      open: async () => huge(2 ** 31 + 4096, line(1), reads),
    })
    expect(reads[0]).toEqual({ position: 0, length: JOURNAL_CHUNK })
    expect(JOURNAL_CHUNK).toBeLessThanOrEqual(INT32)
    expect(read.events).toEqual([])
    expect(read.readTo).toBe(0)
  })

  it('reads a real file the same in chunks of a few bytes as in one, lines across chunks included', async () => {
    const home = tmp()
    const text = `${line(1)}${line(2, 'warning')}${'x'.repeat(5)}\n${line(3)}{"seq":4`
    writeFileSync(join(home, 'events.jsonl'), text)
    const whole = await readJournalSince(home)
    const small = await readJournalSince(home, {}, 0, { chunk: 7 })
    expect(small).toEqual(whole)
    expect(small.events.map((one) => one.seq)).toEqual([1, 2, 3])
    expect(small.readTo).toBe(text.length - '{"seq":4'.length)
    // And a filter, and a second read from where the first got to.
    const warnings = await readJournalSince(home, { types: ['warning'] }, 0, { chunk: 5 })
    expect(warnings.events.map((one) => one.seq)).toEqual([2])
    const again = await readJournalSince(home, {}, small.readTo, { chunk: 3 })
    expect(again).toEqual({ events: [], readFrom: small.readTo, readTo: small.readTo })
  })
})
