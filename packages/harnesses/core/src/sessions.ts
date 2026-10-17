import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskId } from '@tade/core'
import type { HistoryLine } from './history.ts'

// The conversations a harness keeps for a folder, as a person picking one up
// again sees them: when each was last written to and the first thing said in
// it. Every adapter reads its own record (`WorkerAdapter.sessions`); this is
// only the part they share — reading the head of a file rather than the whole
// of it, and listing a folder's newest files — so a home directory with a
// thousand conversations in it costs the newest few and their first lines.

/** A conversation a harness keeps, as `WorkerAdapter.sessions` lists one. */
export interface HarnessSession {
  /** The harness's own id for it: what `carrySession` is handed back. */
  id: string
  /** When it was last written to. */
  at: number
  /** The first thing said in it, on one line; empty where nothing was. */
  first: string
  /**
   * Which of the tasks it was asked about this is the conversation of, or
   * null for one no task of Tade's has. How a task's conversation is named is
   * the harness's own business (`conversationKey`), so it says.
   */
  task: TaskId | null
}

/** How many of a folder's conversations are listed: the ones a person would look for. */
export const SESSIONS_LISTED = 30

/** How far into a record its first line is looked for: a long opening instruction fits. */
const HEAD = 256 * 1024

/** How much of a first line is kept: a row's worth, and the rest is in the conversation. */
const FIRST = 200

/**
 * The first thing said in a JSONL record, on one line, read by the harness's
 * own reader (`historyLine`) out of the head of the file. Empty where nothing
 * was said in that much of it; null where the file is not there.
 */
export async function firstSaidIn(
  file: string,
  read: (line: string) => HistoryLine | null,
): Promise<string | null> {
  const handle = await open(file, 'r').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw new Error(`could not read ${file}: ${err.message}`)
  })
  if (!handle) return null
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.allocUnsafe(HEAD), 0, HEAD, 0)
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n')
    // The last is cut wherever the head ended, unless the file ended there.
    if (bytesRead === HEAD) lines.pop()
    for (const text of lines) {
      // A harness's reader answers null for a line it does not know (`historyLine`).
      const sent = text.trim() ? read(text)?.items.find((item) => item.kind === 'sent') : undefined
      if (sent?.kind === 'sent') return oneLine(sent.text)
    }
    return ''
  } finally {
    await handle.close()
  }
}

/**
 * The handler for a look at the disk that may find nothing there: a file or
 * folder that is not there answers `answer`, and anything else that went
 * wrong is thrown — a look that failed is not a look that found nothing.
 */
export function ifMissing<T>(answer: T): (problem: unknown) => T {
  return (problem) => {
    const code = (problem as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return answer
    throw problem
  }
}

/** A line of a record as JSON, or null for one that is not: a half-written last line is what a live record ends in. */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (problem) {
    if (problem instanceof SyntaxError) return null
    throw problem
  }
}

/** Words as one line of a list: the first line that says anything, cut to a row's worth. */
export function oneLine(text: string): string {
  const said = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  if (!said) return ''
  return said.length > FIRST ? `${said.slice(0, FIRST - 1)}…` : said
}

/**
 * A folder's files whose names `keep` says yes to, newest first by when each
 * was last written, at most `limit` of them. A folder that is not there holds
 * none; one that is there and could not be read throws, because that is a
 * look that failed rather than one that found nothing.
 */
export async function newestIn(
  dir: string,
  keep: (name: string) => boolean,
  limit = SESSIONS_LISTED,
): Promise<{ file: string; name: string; at: number }[]> {
  const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [] as string[]
    throw new Error(`could not read ${dir}: ${err.message}`)
  })
  const found = await Promise.all(
    names.filter(keep).map(async (name) => {
      const file = join(dir, name)
      const said = await stat(file).catch(ifMissing(null))
      return said?.isFile() ? { file, name, at: said.mtimeMs } : null
    }),
  )
  return found
    .filter((one): one is { file: string; name: string; at: number } => one !== null)
    .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
    .slice(0, limit)
}
