import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type HistoryAsk,
  type HistoryLine,
  type HistoryPage,
  historyIn,
  momentOf,
} from '@tade/harnesses-core'
import { sessionIdFor } from './adapter.ts'
import { modelOfMessage, spentBy } from './usage.ts'

// Reading what an agent did out of pi's own session, rather than out of what
// it told us at the time.
//
// It is the same information either way — the supervision extension reports
// each turn as it happens — but the extension can only report while Tade is
// listening, and under a driver whose lanes outlive the window that is not
// always. The session file is written by pi regardless, so it is the ledger
// that survives us being closed, and this is how the gap gets filled in.
//
// The format is pi's and private. Nothing here assumes more than "JSONL, one
// entry per line", priced the way `spentBy` says pi prices them, and anything
// else is skipped: a session we cannot read is a gap in the accounting, never
// an error.

/** Where pi keeps sessions, unless told otherwise. */
export function sessionsRoot(home = homedir()): string {
  return join(home, '.pi', 'agent', 'sessions')
}

export interface SessionUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  usd: number
  /** How many priced entries were counted, so "none yet" is distinguishable. */
  messages: number
  /** The model its last reply ran on, as `provider/id`. */
  model: string | null
}

export function noUsage(): SessionUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    usd: 0,
    messages: 0,
    model: null,
  }
}

/**
 * Find a task's session file.
 *
 * pi names the directory after the working directory, in an encoding that is
 * its own business and would be a liability to reimplement. The file, though,
 * ends in the session id — and that id is ours, and unique to the task — so
 * looking for the name is both simpler and harder to break.
 */
export async function sessionFileFor(
  task: string,
  opts: { root?: string } = {},
): Promise<string | null> {
  const root = opts.root ?? sessionsRoot()
  const suffix = `_${sessionIdFor(task)}.jsonl`
  const dirs = await readdir(root).catch(() => [] as string[])
  const found: string[] = []
  for (const dir of dirs) {
    const entries = await readdir(join(root, dir)).catch(() => [] as string[])
    for (const entry of entries) {
      if (entry.endsWith(suffix)) found.push(join(root, dir, entry))
    }
  }
  // The name starts with a timestamp, so the newest sorts last. More than one
  // means the task's worktree moved; the current one is what we want.
  return found.sort().at(-1) ?? null
}

/** What a session has cost so far: every entry pi priced, as its own totals count them. */
export async function usageOf(file: string): Promise<SessionUsage> {
  const total = noUsage()
  const text = await readFile(file, 'utf8').catch(() => '')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      // A half-written last line is what a live session looks like.
      continue
    }
    const spent = spentBy(entry)
    if (!spent) continue
    total.input += spent.input
    total.output += spent.output
    total.cacheRead += spent.cacheRead
    total.cacheWrite += spent.cacheWrite
    total.tokens += spent.tokens
    total.usd += spent.usd
    total.messages += 1
    total.model = modelOfMessage((entry as { message?: unknown }).message) ?? total.model
  }
  return total
}

/** What a task's agent has cost, from pi's own record. Zero if it has none. */
export async function usageOfTask(
  task: string,
  opts: { root?: string } = {},
): Promise<SessionUsage> {
  const file = await sessionFileFor(task, opts)
  return file ? usageOf(file) : noUsage()
}

/**
 * A page of a task's conversation, out of pi's own session (`historyIn`).
 *
 * A headless run keeps its session flat in `headless` (`--session-dir`), and
 * one in a lane where pi files it by working directory; the first found is it.
 */
export async function historyOfTask(
  task: string,
  ask: HistoryAsk,
  opts: { root?: string; headless?: string } = {},
): Promise<HistoryPage> {
  const suffix = `_${sessionIdFor(task)}.jsonl`
  const flat = opts.headless
    ? (await readdir(opts.headless).catch(() => [] as string[]))
        .filter((name) => name.endsWith(suffix))
        .sort()
        .map((name) => join(opts.headless ?? '', name))
    : []
  const file = flat.at(-1) ?? (await sessionFileFor(task, opts).catch(() => null))
  return historyIn(file, ask, historyLine)
}

/** What one session line says, or null for anything that is not a message of the conversation. */
export function historyLine(text: string): HistoryLine | null {
  let entry: unknown
  try {
    entry = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null) return null
  const { type, message, timestamp } = entry as Record<string, unknown>
  if (type !== 'message' || typeof message !== 'object' || message === null) return null
  const { role, content, toolCallId, isError } = message as Record<string, unknown>
  const at = momentOf(timestamp)
  const parts: Record<string, unknown>[] =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content.filter(
            (part): part is Record<string, unknown> => typeof part === 'object' && part !== null,
          )
        : []
  const words = parts.flatMap((part) =>
    part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
  )
  const line: HistoryLine = { items: [], results: [], opens: false }
  if (role === 'user') {
    const images = parts.filter((part) => part.type === 'image').map(() => 'picture')
    if (words.join('').trim() === '' && images.length === 0) return line
    line.items.push({ kind: 'sent', text: words.join('\n'), images, at })
    line.opens = true
  } else if (role === 'assistant') {
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        line.items.push({ kind: 'reply', text: part.text, at })
      } else if (part.type === 'toolCall' && typeof part.id === 'string') {
        line.items.push({
          kind: 'tool',
          id: part.id,
          tool: String(part.name ?? ''),
          input: part.arguments ?? {},
          ok: null,
          result: '',
          at,
        })
      }
    }
  } else if (role === 'toolResult' && typeof toolCallId === 'string') {
    const failed = isError === true
    line.results.push({
      id: toolCallId,
      ok: !failed,
      result: failed ? words.join('\n').slice(0, 300) : '',
    })
  } else {
    return null
  }
  return line
}
