import { open } from 'node:fs/promises'
import type { HistoryLine } from './history.ts'

// One tool call's answer, whole, out of a harness's own record.
//
// A page of history holds the start of each answer and no more (`headOf`), so
// a conversation of a hundred test runs is a few kilobytes held rather than a
// hundred megabytes; the whole of one is read again from the record when
// somebody opens that call, and never cut. The record is the harness's, so
// this is only the part every one of them shares — finding the line, from the
// newest end, that answers one call — and each adapter reads its own lines.

/** One call's answer as the record kept it: whole, and whether it worked where it says. */
export interface ToolAnswer {
  ok: boolean | null
  result: string
}

/** How much is read from the file at a time, going back. */
const CHUNK = 256 * 1024

/**
 * What the record says a call answered: its words, whole, and whether it
 * worked where the record says — or null where no answer to it was recorded.
 *
 * A file that is not there is null: nothing was recorded. A file that is there
 * and could not be read throws, saying which — that is an answer that could
 * not be looked at, not one nobody kept.
 */
export async function answerIn(
  file: string | null,
  id: string,
  read: (line: string) => HistoryLine | null,
): Promise<ToolAnswer | null> {
  if (!file || id === '') return null
  const handle = await open(file, 'r').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw new Error(`could not read ${file}: ${err.message}`)
  })
  if (!handle) return null
  try {
    let end = (await handle.stat()).size
    // The start of a line the chunk after it began in the middle of.
    let rest = Buffer.alloc(0)
    const needle = Buffer.from(id)
    while (end > 0) {
      const from = Math.max(0, end - CHUNK)
      const chunk = Buffer.alloc(end - from)
      await handle.read(chunk, 0, chunk.length, from)
      const bytes = Buffer.concat([chunk, rest])
      let cut = bytes.length
      while (cut > 0) {
        const at = bytes.lastIndexOf(0x0a, cut - 1)
        if (at < 0 && from > 0) break
        const line = bytes.subarray(at + 1, cut)
        cut = Math.max(0, at)
        // Only a line that names the call is parsed: a record is mostly
        // other calls' answers, and parsing every one is the cost of the file.
        if (line.indexOf(needle) < 0) continue
        const found = safely(read, line.toString('utf8'))?.results.find((one) => one.id === id)
        if (found) return { ok: found.ok, result: found.result.trimEnd() }
      }
      rest = bytes.subarray(0, cut)
      end = from
    }
    return null
  } catch (err) {
    throw new Error(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await handle.close().catch(() => {})
  }
}

function safely(read: (line: string) => HistoryLine | null, text: string): HistoryLine | null {
  try {
    return read(text)
  } catch {
    return null
  }
}
