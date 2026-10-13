import { open } from 'node:fs/promises'

// A conversation read back out of a harness's own record, a page at a time.
//
// The record is the harness's and so is its format: each adapter reads its own
// lines (`HistoryLine`), and this is only the part every one of them shares —
// reading a file that may be megabytes long from its end, a page of whole
// exchanges at a time, so opening the window costs the last page and never the
// whole conversation.
//
// Nothing here is Tade's own record of anything. What was said lives where the
// harness wrote it, and is read there each time it is asked for: never copied
// into the journal, which is not a transcript.

/** One thing in a conversation, in words a surface can draw. */
export type HistoryItem =
  /**
   * What the harness was sent, verbatim — Tade's own framing included, since
   * which part was the person's is the surface's to read (it wrote the framing).
   * `images` is a line for each picture that went with it: the file it was
   * given as, where the record names one, and `picture` where it kept only
   * the bytes — which are not history.
   */
  | { kind: 'sent'; text: string; images: string[]; at: number }
  /** What the agent said back. */
  | { kind: 'reply'; text: string; at: number }
  /**
   * A tool it reached for. `ok` is null when no answer to it was recorded —
   * a turn cut short, or a process that died with the call in the air.
   */
  | {
      kind: 'tool'
      id: string
      tool: string
      input: unknown
      ok: boolean | null
      /** What it answered, when that is worth saying: the reason it failed. */
      result: string
      at: number
    }

export interface HistoryPage {
  /** Oldest first. */
  items: HistoryItem[]
  /**
   * Where the page before this one ends, to be handed back as `before`; null
   * when this page reaches the beginning of the conversation. Opaque.
   */
  earlier: string | null
}

export interface HistoryAsk {
  /** At least this many items, unless the conversation has fewer. */
  limit: number
  /** A page's `earlier`, for the page before it. Absent for the newest. */
  before?: string | null
}

export const NO_HISTORY: HistoryPage = { items: [], earlier: null }

/**
 * What one line of a harness's record holds. A line may carry several items
 * (a reply and the tools it called) and the answers to earlier tool calls.
 */
export interface HistoryLine {
  items: HistoryItem[]
  /** Answers to tool calls, matched to them by id. */
  results: { id: string; ok: boolean; result: string }[]
  /**
   * Whether an exchange starts here — something was sent to it. A page starts
   * on one, so a tool and its answer are never split across two pages.
   */
  opens: boolean
}

/** How much is read from the file at a time, going back. */
const CHUNK = 256 * 1024
/**
 * How far a page may reach back looking for the start of an exchange before
 * it settles for a line boundary: one turn of a hundred tool calls is long,
 * and a page has to end somewhere.
 */
const REACH = 8 * 1024 * 1024

/**
 * A page of a JSONL record, read from its end: at least `limit` items, back to
 * the start of an exchange, ending before `before`.
 *
 * Never throws. A file that is not there, a cursor that does not fit it and a
 * line the harness's reader does not recognise are all a shorter answer — a
 * conversation that cannot be read is a gap, never an error.
 */
export async function historyIn(
  file: string | null,
  ask: HistoryAsk,
  read: (line: string) => HistoryLine | null,
): Promise<HistoryPage> {
  if (!file) return NO_HISTORY
  const handle = await open(file, 'r').catch(() => null)
  if (!handle) return NO_HISTORY
  try {
    const size = (await handle.stat()).size
    const before = ask.before === undefined || ask.before === null ? size : Number(ask.before)
    if (!Number.isInteger(before) || before < 0 || before > size) return NO_HISTORY
    // Newest first while reading back; each with where its line starts.
    const lines: { at: number; line: HistoryLine }[] = []
    let count = 0
    let end = before
    // The start of a line the chunk after it began in the middle of.
    let rest = Buffer.alloc(0)
    let start = 0
    while (end > 0) {
      const from = Math.max(0, end - CHUNK)
      const chunk = Buffer.alloc(end - from)
      await handle.read(chunk, 0, chunk.length, from)
      const bytes = Buffer.concat([chunk, rest])
      // Every line that is whole, newest first. The first in the buffer is
      // whole only at the start of the file; otherwise it waits for the next
      // chunk back. (`lastIndexOf` reads a negative offset from the end, so
      // the start of the buffer is said rather than searched from.)
      let cut = bytes.length
      while (cut > 0) {
        const at = bytes.lastIndexOf(0x0a, cut - 1)
        if (at < 0 && from > 0) break
        const text = bytes.subarray(at + 1, cut).toString('utf8')
        const offset = from + at + 1
        cut = Math.max(0, at)
        const line = text.trim() ? safely(read, text) : null
        if (!line) continue
        lines.push({ at: offset, line })
        count += line.items.length
        if ((count >= ask.limit && line.opens) || (before - offset > REACH && count > 0)) {
          start = offset
          end = 0
          break
        }
      }
      if (end === 0) break
      rest = bytes.subarray(0, cut)
      end = from
    }
    const items = paired(lines.reverse().map((one) => one.line))
    return { items, earlier: start > 0 ? String(start) : null }
  } catch {
    return NO_HISTORY
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

/** Each tool given the answer recorded for it, oldest first; an answer to nothing here is dropped. */
function paired(lines: readonly HistoryLine[]): HistoryItem[] {
  const answers = new Map<string, { ok: boolean; result: string }>()
  for (const line of lines) for (const one of line.results) answers.set(one.id, one)
  return lines.flatMap((line) =>
    line.items.map((item) => {
      if (item.kind !== 'tool') return item
      const answer = answers.get(item.id)
      return answer ? { ...item, ok: answer.ok, result: answer.result } : item
    }),
  )
}

/** A timestamp as a record writes it, or the moment it could not say. */
export function momentOf(value: unknown, otherwise = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return otherwise
  const at = Date.parse(value)
  return Number.isNaN(at) ? otherwise : at
}
