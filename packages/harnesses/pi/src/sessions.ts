import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
