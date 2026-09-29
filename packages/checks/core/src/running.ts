import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CheckState } from './port.ts'

// A run while it is still going, so a person can watch it.
//
// Nothing finished is written here — `checks.jsonl` is the record, and it only
// ever holds runs that ended. This is the other half of the same honesty: a
// suite takes minutes, and a page that says nothing for three minutes and then
// says `passed` is a progress bar that appears when it is over.
//
// It is a file rather than an event because the watcher and the runner are not
// always one process: an agent's `checks_run` goes through the window, but
// `tade check` in a terminal does not, and both are worth watching. The rule is
// the run lock's — **a record whose process is gone is not a run** — so a
// window that was killed mid-suite leaves nothing claiming anything is running.

/** One check of a run in flight. */
export interface RunningCheck {
  check: string
  state: CheckState
  /** When it started, as an ISO time; null while it is still queued. */
  startedAt: string | null
  finishedAt: string | null
}

/** A run going on in a worktree now. */
export interface RunningNow {
  /** Whose it is. A record whose process is gone is nobody's, and is not a run. */
  pid: number
  /** The commit it is about. */
  commit: string
  /** Who asked: a task, the orchestrator, you. */
  by: string
  /** When the run started, as an ISO time. */
  at: string
  checks: readonly RunningCheck[]
}

export function runningPath(records: string): string {
  return join(records, 'checks.running.json')
}

/** The token that says which run a record is, so one run never clears another's. */
function tokenOf(now: RunningNow): string {
  return `${now.pid}:${now.at}`
}

/**
 * Say what is running now. The last writer wins: two runs at once in one
 * worktree can only happen where neither needs the machine to itself, and a
 * watcher seeing one of the two is better than a file two writers merge into.
 */
export async function writeRunning(records: string, now: RunningNow): Promise<void> {
  const path = runningPath(records)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(now)}\n`, { mode: 0o600 })
  } catch {
    // Watching a run is not worth failing one over.
  }
}

/** Take it back when the run ends — but only if the record is still this run's. */
export async function clearRunning(records: string, now: RunningNow): Promise<void> {
  const held = await readRunning(records)
  if (held && tokenOf(held) !== tokenOf(now)) return
  await rm(runningPath(records), { force: true }).catch(() => {})
}

/**
 * What is running in this worktree, or null. A record whose process is gone is
 * taken as nothing running, and cleaned up on the way past: nobody is ever
 * shown a suite that has been "running" since yesterday.
 */
export async function runningIn(records: string): Promise<RunningNow | null> {
  const now = await readRunning(records)
  if (!now) return null
  if (!alive(now.pid)) {
    await rm(runningPath(records), { force: true }).catch(() => {})
    return null
  }
  return now
}

async function readRunning(records: string): Promise<RunningNow | null> {
  const text = await readFile(runningPath(records), 'utf8').catch(() => '')
  if (!text.trim()) return null
  // Hand-checked rather than schema-parsed, and null on any shape we do not
  // know: half a write is the normal way to read this file.
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  const pid = typeof raw.pid === 'number' ? raw.pid : 0
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (typeof raw.commit !== 'string' || raw.commit === '') return null
  if (!Array.isArray(raw.checks)) return null
  const checks: RunningCheck[] = []
  for (const one of raw.checks) {
    if (typeof one !== 'object' || one === null) return null
    const each = one as Record<string, unknown>
    if (typeof each.check !== 'string' || typeof each.state !== 'string') return null
    checks.push({
      check: each.check,
      state: each.state as CheckState,
      startedAt: typeof each.startedAt === 'string' ? each.startedAt : null,
      finishedAt: typeof each.finishedAt === 'string' ? each.finishedAt : null,
    })
  }
  return {
    pid,
    commit: raw.commit,
    by: typeof raw.by === 'string' ? raw.by : '',
    at: typeof raw.at === 'string' ? raw.at : '',
    checks,
  }
}

/** Whether a pid is still there. EPERM is somebody else's process, which counts. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
