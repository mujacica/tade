import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import {
  type HistoryItem,
  type HistoryLine,
  historyIn,
  keptResult,
  NO_HISTORY,
  RESULT_KEPT,
} from '../src/history.ts'

// A record in the simplest shape a harness could keep one: a line per thing
// said, a tool call, or its answer. The real ones are each adapter's to read.
type Raw =
  | { sent: string; at: number }
  | { reply: string; at: number }
  | { call: string; at: number }
  | { answer: string; ok: boolean }

function read(text: string): HistoryLine | null {
  const raw = JSON.parse(text) as Raw
  if ('sent' in raw) {
    return {
      items: [{ kind: 'sent', text: raw.sent, images: [], at: raw.at }],
      results: [],
      opens: true,
    }
  }
  if ('reply' in raw) {
    return { items: [{ kind: 'reply', text: raw.reply, at: raw.at }], results: [], opens: false }
  }
  if ('call' in raw) {
    const item: HistoryItem = {
      kind: 'tool',
      id: raw.call,
      tool: 'look',
      input: {},
      ok: null,
      result: '',
      at: raw.at,
    }
    return { items: [item], results: [], opens: false }
  }
  return {
    items: [],
    results: [{ id: raw.answer, ok: raw.ok, result: raw.ok ? '' : 'no' }],
    opens: false,
  }
}

/** `exchanges` of: something sent, a tool and its answer, and a reply long enough to fill chunks. */
function record(exchanges: number, padding = 0): string {
  const lines: Raw[] = []
  for (let n = 0; n < exchanges; n++) {
    lines.push({ sent: `ask ${n}`, at: n })
    lines.push({ call: `call-${n}`, at: n })
    lines.push({ answer: `call-${n}`, ok: n % 2 === 0 })
    lines.push({ reply: `answer ${n} ${'x'.repeat(padding)}`, at: n })
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

function file(text: string): string {
  const path = join(tmp('tade-history-'), 'record.jsonl')
  writeFileSync(path, text)
  return path
}

const sentIn = (items: readonly HistoryItem[]) =>
  items.flatMap((item) => (item.kind === 'sent' ? [item.text] : []))

describe('a conversation read back from its end', () => {
  it('is the newest whole exchanges, oldest first, with each tool given its answer', async () => {
    const page = await historyIn(file(record(10)), { limit: 5 }, read)
    // Five items is two exchanges of three, so the page reaches back to the
    // start of the second-newest: a tool is never cut from what asked for it.
    expect(sentIn(page.items)).toEqual(['ask 8', 'ask 9'])
    expect(page.items.map((item) => item.kind)).toEqual([
      'sent',
      'tool',
      'reply',
      'sent',
      'tool',
      'reply',
    ])
    const tools = page.items.filter((item) => item.kind === 'tool')
    expect(tools.map((tool) => [tool.id, tool.ok, tool.result])).toEqual([
      ['call-8', true, ''],
      ['call-9', false, 'no'],
    ])
    expect(page.earlier).not.toBeNull()
  })

  it('pages back to the beginning without losing or repeating anything, across many chunks', async () => {
    // Each reply a kilobyte and a half, so the record is several of the
    // chunks it is read in and page edges land inside them.
    const path = file(record(400, 1_500))
    const seen: string[] = []
    let before: string | null = null
    let pages = 0
    do {
      const page = await historyIn(path, { limit: 30, before }, read)
      seen.unshift(...sentIn(page.items))
      for (const item of page.items) if (item.kind === 'tool') expect(item.ok).not.toBeNull()
      before = page.earlier
      pages++
    } while (before !== null && pages < 100)
    expect(seen).toEqual(Array.from({ length: 400 }, (_, n) => `ask ${n}`))
    expect(pages).toBeGreaterThan(10)
  })

  it('is all of a conversation shorter than a page, with nothing earlier', async () => {
    const page = await historyIn(file(record(2)), { limit: 50 }, read)
    expect(sentIn(page.items)).toEqual(['ask 0', 'ask 1'])
    expect(page.earlier).toBeNull()
  })

  it('leaves out a last line still being written, and lines its reader does not know', async () => {
    const text = `${record(1)}not json at all\n{"sent":"half`
    const page = await historyIn(file(text), { limit: 10 }, (line) => {
      try {
        return read(line)
      } catch {
        return null
      }
    })
    expect(sentIn(page.items)).toEqual(['ask 0'])
  })

  it('takes a reader that throws as a line it does not know', async () => {
    const page = await historyIn(file(`${record(1)}{"oops":1}\n`), { limit: 10 }, (line) => {
      if (line.includes('oops')) throw new Error('unrecognised')
      return read(line)
    })
    expect(sentIn(page.items)).toEqual(['ask 0'])
  })

  it('is empty, never an error, for no record, an empty one, or a cursor that does not fit it', async () => {
    expect(await historyIn(null, { limit: 5 }, read)).toEqual(NO_HISTORY)
    expect(await historyIn(join(tmp('tade-history-'), 'gone.jsonl'), { limit: 5 }, read)).toEqual(
      NO_HISTORY,
    )
    expect(await historyIn(file(''), { limit: 5 }, read)).toEqual(NO_HISTORY)
    const path = file(record(3))
    expect(await historyIn(path, { limit: 5, before: 'later' }, read)).toEqual(NO_HISTORY)
    expect(await historyIn(path, { limit: 5, before: '99999999' }, read)).toEqual(NO_HISTORY)
    expect(await historyIn(path, { limit: 5, before: '0' }, read)).toEqual(NO_HISTORY)
  })
})

describe('a record that is there and could not be read', () => {
  it('says so, rather than reading as a conversation with nothing in it', async () => {
    // A folder where the file should be: there, and not readable as one.
    await expect(historyIn(tmp('tade-history-'), { limit: 5 }, read)).rejects.toThrow(
      /could not read/,
    )
  })
})

describe("a tool's answer as a page keeps it", () => {
  it('is the whole of a short one, without what it ended on', () => {
    expect(keptResult('src/a.ts\nsrc/b.ts\n')).toBe('src/a.ts\nsrc/b.ts')
    expect(keptResult('')).toBe('')
  })

  it('is its first lines, and says how many more there were', () => {
    const lines = Array.from({ length: 100 }, (_, n) => `line ${n + 1}`)
    const kept = keptResult(lines.join('\n'))
    const shown = kept.split('\n')
    expect(shown.slice(0, -1)).toEqual(lines.slice(0, RESULT_KEPT.lines))
    const left = lines.slice(RESULT_KEPT.lines).join('\n').length + 1
    expect(shown.at(-1)).toBe(
      `… ${100 - RESULT_KEPT.lines} more lines (${left} characters) not kept`,
    )
  })

  it('is cut at its characters where its lines are long, and a megabyte keeps only that', () => {
    const megabyte = 'x'.repeat(1024 * 1024)
    const kept = keptResult(megabyte)
    expect(kept).toBe(
      `${'x'.repeat(RESULT_KEPT.chars)}\n… ${(megabyte.length - RESULT_KEPT.chars).toLocaleString('en-US')} more characters not kept`,
    )
    expect(kept.length).toBeLessThan(RESULT_KEPT.chars + 60)
    const one = keptResult(`${'y'.repeat(RESULT_KEPT.chars - 2)}\nz\nz`)
    expect(one.split('\n').at(-1)).toBe('… 1 more line (2 characters) not kept')
  })
})
