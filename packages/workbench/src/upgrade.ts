import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseVersion, runProgram } from '@tade/core'
import { readJournal, readJournalSince } from './events.ts'

// What `tade host upgrade` asks of this machine besides what Tade is
// (`lookAtTade`): which Tade the process holding the home is, and whether the
// Tade now on disk starts at all — both before anything is restarted onto it.

/** How far back from the end of the journal a window's opening is looked for first. */
const TAIL = 8 * 1024 * 1024

/** What a Tade said of itself as it opened: which one, and how many lanes it took up. */
export interface Opened {
  version: string | null
  lanes: number | null
}

/**
 * What the Tade with this pid said as it opened, out of the journal's
 * `tade_opened` lines — the newest one with that pid — or null where none
 * says. A running process cannot be asked which files it was started from,
 * and the files on disk are already the new ones after an upgrade, so this is
 * the one place the answer is. An older Tade wrote no version: `version` null.
 */
export async function openedAs(home: string, pid: number): Promise<Opened | null> {
  const size = await stat(join(home, 'events.jsonl')).then(
    (one) => one.size,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return 0
      throw err
    },
  )
  const mine = (one: { detail: Record<string, unknown> }) => one.detail.pid === pid
  const tail = await readJournalSince(home, { types: ['tade_opened'] }, Math.max(0, size - TAIL))
  // A window open since longer ago than the tail reaches: the whole journal, once.
  const found =
    tail.events.findLast(mine) ??
    (size > TAIL ? (await readJournal(home, { types: ['tade_opened'] })).findLast(mine) : undefined)
  if (!found) return null
  const version = found.detail.version
  const lanes = found.detail.lanes
  return {
    version: typeof version === 'string' ? version : null,
    lanes: typeof lanes === 'number' ? lanes : null,
  }
}

/**
 * Whether the Tade a start would run starts: `--version` of exactly that
 * command, answered with the version it printed, or why it did not. Run
 * before a restart, because a service restarted onto a Tade that will not
 * load is a service that is down until somebody logs in.
 */
export async function startsAs(
  command: readonly string[],
): Promise<{ version: string; said: null } | { version: null; said: string }> {
  const [program = '', ...args] = command
  const ran = await runProgram(program, [...args, '--version'], { timeoutMs: 60_000 })
  const version = parseVersion(ran.stdout)
  if (ran.code === 0 && version !== null) return { version, said: null }
  const said =
    ran.stderr.trim().split('\n').filter(Boolean).slice(0, 3).join(' ') ||
    (ran.timedOut ? 'it did not answer within a minute' : `it exited ${ran.code}`)
  return { version: null, said }
}
