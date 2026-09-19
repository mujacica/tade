import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { scrub } from '@tade/telemetry'
import type { Check, CheckLog, CheckRun } from './port.ts'
import { settled } from './port.ts'

// What ran here, kept because it cannot be recovered any other way.
//
// Re-running a check is not reading it, it is doing it again, and for a suite
// that is minutes. `tests.json` already made exactly this trade, with exactly
// the right rule: a record that does not name the commit that is checked out
// is worth no more than never having run them. This generalises the file, not
// the principle.
//
// An unfinished run writes nothing. In-flight state lives in the runner, which
// owns the process; a window that died leaves no file claiming something was
// running, because there was never one.

/** How many finished runs a worktree keeps a record of, unless the config says otherwise. */
export const DEFAULT_KEEP = 200

/** How much of a run's output is kept. A tail, never the whole log. */
export const DEFAULT_TAIL = 4_000

export function recordsPath(worktree: string): string {
  return join(worktree, '.tade', 'checks.jsonl')
}

/** Every finished run this worktree has a record of, oldest first. */
export async function readRuns(worktree: string): Promise<CheckLog[]> {
  let text: string
  try {
    text = await readFile(recordsPath(worktree), 'utf8')
  } catch {
    // Never run, or a file we cannot read: the same answer either way.
    return []
  }
  const out: CheckLog[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    // A line that will not parse is skipped rather than thrown over: one bad
    // write must not lose every run before it.
    const run = asRun(safeParse(line))
    if (run) out.push(run)
  }
  return out
}

/**
 * Write down a finished run, with its tail scrubbed of anything
 * credential-shaped and of where you live. A run that has not finished is not
 * written at all.
 */
export async function writeRun(
  worktree: string,
  run: CheckLog,
  opts: { keep?: number; home?: string } = {},
): Promise<void> {
  if (!settled(run.state)) return
  const path = recordsPath(worktree)
  const keep = Math.max(1, opts.keep ?? DEFAULT_KEEP)
  const line = JSON.stringify({
    ...run,
    tail: scrub(run.tail, opts.home ?? '').slice(-DEFAULT_TAIL),
  })
  const kept = [...(await readRuns(worktree))].slice(-(keep - 1)).map((one) => JSON.stringify(one))
  await mkdir(dirname(path), { recursive: true })
  // Rewritten rather than appended so the rotation is the write: a file that
  // grew until somebody noticed is the other way this goes.
  await writeFile(path, `${[...kept, line].join('\n')}\n`, { mode: 0o600 })
}

/** The newest run of each check at a commit: what "how does it stand" means. */
export function latestAt<T extends CheckRun>(runs: readonly T[], commit: string | null): T[] {
  if (!commit) return []
  const newest = new Map<string, T>()
  for (const run of runs) {
    if (run.commit !== commit) continue
    const key = `${run.check}:${run.where.kind === 'here' ? 'here' : `forge:${run.where.forge}:${run.where.job}`}`
    const already = newest.get(key)
    if (!already || order(run) >= order(already)) newest.set(key, run)
  }
  return [...newest.values()]
}

function order(run: CheckRun): number {
  return Date.parse(run.finishedAt ?? run.startedAt ?? '') || 0
}

/** What the required checks add up to at a commit. `unknown` when some have not run. */
export function rollup(
  checks: readonly Check[],
  runs: readonly CheckRun[],
  commit: string | null,
): { state: 'pass' | 'fail' | 'unknown'; failed: string[]; missing: string[] } {
  const required = checks.filter((check) => check.required)
  const here = latestAt(runs, commit).filter((run) => run.where.kind === 'here')
  const failed: string[] = []
  const missing: string[] = []
  for (const check of required) {
    const run = here.find((one) => one.check === check.id)
    if (!run) {
      missing.push(check.id)
      continue
    }
    if (run.state === 'failed' || run.state === 'timed out') failed.push(check.id)
    // A check that was queued, running, skipped or cancelled says nothing:
    // absent is not fine, and this is the bug that draws a red thing green.
    else if (run.state !== 'passed') missing.push(check.id)
  }
  if (failed.length > 0) return { state: 'fail', failed, missing }
  if (required.length > 0 && missing.length === 0) return { state: 'pass', failed, missing }
  return { state: 'unknown', failed, missing }
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** Hand-checked rather than schema-parsed: null on any shape we do not know. */
function asRun(value: unknown): CheckLog | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const where = raw.where as Record<string, unknown> | undefined
  if (typeof raw.id !== 'string' || typeof raw.check !== 'string') return null
  if (typeof raw.commit !== 'string' || raw.commit === '') return null
  if (typeof raw.state !== 'string') return null
  const place =
    where?.kind === 'here'
      ? {
          kind: 'here' as const,
          runner: String(where.runner ?? ''),
          host: String(where.host ?? ''),
        }
      : where?.kind === 'forge'
        ? {
            kind: 'forge' as const,
            forge: String(where.forge ?? ''),
            job: String(where.job ?? ''),
            url: typeof where.url === 'string' ? where.url : null,
          }
        : null
  if (!place) return null
  return {
    id: raw.id,
    check: raw.check,
    commit: raw.commit,
    state: raw.state as CheckLog['state'],
    where: place,
    required: raw.required !== false,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    code: typeof raw.code === 'number' ? raw.code : null,
    summary: typeof raw.summary === 'string' ? raw.summary : null,
    by: typeof raw.by === 'string' ? raw.by : null,
    tail: typeof raw.tail === 'string' ? raw.tail : '',
  }
}
