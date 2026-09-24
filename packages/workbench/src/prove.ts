import { randomBytes } from 'node:crypto'
import type { LaneId, LaneProof } from '@tade/core'
import type { WorkspaceDriver } from '@tade/drivers-core'
import { drivers } from './registry.ts'

// The check that proves a setup: a lane opened with the driver Tade is
// configured to use, a command run in it, the output read, the lane closed.
//
// It exists because every other check is a reading of a file. Setting up can
// find git, find a model, write a config and say "all set" while the one thing
// an agent actually needs — a process, in a terminal Tade can read — fails on
// the first try with `posix_spawnp failed.` and nothing else. So this does the
// whole of it once, with the configured driver rather than a convenient one,
// because which driver it is, is the choice that can be wrong.
//
// Nothing is left behind: the lane is closed and the driver let go of on every
// path out, including the one where the command never finishes.

/** How long the whole thing may take before it is reported as not having worked. */
const DEADLINE_MS = 15_000

/**
 * What the lane is told to print.
 *
 * Assembled by the program rather than written out, so finding it cannot be a
 * driver echoing the command line back: the word that comes out is never a
 * word that went in.
 */
const SPELL = "process.stdout.write(['tade', 'lane', 'ok'].join('-'))"
const MARKER = 'tade-lane-ok'

export interface ProveOptions {
  /** The driver to prove, as `workspace.driver` names it. */
  driver: string
  /** Where Tade's own files are: a driver's lanes belong to a home. */
  home: string
  /** Where the lane runs. */
  cwd: string
  /** Injected by tests; the registry's own otherwise. */
  make?: (home: string) => WorkspaceDriver
  deadlineMs?: number
}

/**
 * Open a lane, run a command in it, close it — and say what happened.
 *
 * One sentence either way, because it is read on a checklist and in `tade
 * setup --check`. It never throws: a driver that cannot open a lane is the
 * thing being asked about, not an error in the asking.
 */
export async function proveALane(opts: ProveOptions): Promise<LaneProof> {
  const make = opts.make ?? drivers[opts.driver]
  if (!make) {
    const known = Object.keys(drivers).join(', ')
    return {
      ok: false,
      driver: opts.driver,
      says: `there is no driver called ${opts.driver}: workspace.driver takes one of ${known}`,
    }
  }
  const driver = make(opts.home)
  // Unique per run: an id that is taken is a lane that is already running, and
  // setting up must never stand on one of the window's.
  const id = `setup/proof-${randomBytes(4).toString('hex')}` as LaneId
  try {
    const can = await driver.available()
    if (!can.ok) return { ok: false, driver: driver.id, says: can.reason }

    const seen: string[] = []
    let ended: { code: number | null } | null = null
    let settle: (exit: { code: number | null }) => void = () => {}
    const exit = new Promise<{ code: number | null }>((resolve) => {
      settle = resolve
    })
    await driver.open({
      id,
      cwd: opts.cwd,
      command: process.execPath,
      args: ['-e', SPELL],
      cols: 80,
      rows: 24,
    })
    // Subscribed after the open and replayed, because a program this small can
    // be finished before anybody is listening.
    driver.onOutput(id, (chunk) => seen.push(Buffer.from(chunk).toString('utf8')), { replay: true })
    driver.onExit(id, settle)
    ended = await within(exit, opts.deadlineMs ?? DEADLINE_MS)

    const said = seen.join('')
    const tail = said.trim() ? `: ${firstLine(said)}` : ''
    if (ended === null) {
      return {
        ok: false,
        driver: driver.id,
        says: `a lane opened under ${driver.id} and the command in it never finished`,
      }
    }
    if (ended.code !== 0) {
      return {
        ok: false,
        driver: driver.id,
        says: `a lane opened under ${driver.id} and the command in it exited ${ended.code}${tail}`,
      }
    }
    // The screen as well as the bytes: a driver that renders into a terminal of
    // its own is read the way the window reads it.
    const screen = await driver.capture(id, { lines: 4 }).catch(() => '')
    if (!`${said}${screen}`.includes(MARKER)) {
      return {
        ok: false,
        driver: driver.id,
        says: `a lane opened under ${driver.id} and nothing it printed came back${tail}`,
      }
    }
    return {
      ok: true,
      driver: driver.id,
      says: `opened a lane under ${driver.id}, ran a command in it and read what it printed`,
    }
  } catch (err) {
    return {
      ok: false,
      driver: driver.id,
      says: `a lane could not be opened under ${driver.id}: ${firstLine(message(err))}`,
    }
  } finally {
    // This lane closed, then the driver let go of — `detach`, never
    // `shutdown`. Under tmux the lanes of one home share a session, and
    // shutting the driver down kills it: proving that a lane can open would
    // have ended every agent working in that checkout. Closing the one lane
    // this opened is what keeps nothing behind, and letting go is what keeps
    // everybody else's work running.
    await driver.close(id).catch(() => {})
    await driver.detach().catch(() => {})
  }
}

/** The answer, or null when it did not come in time. */
async function within<T>(work: Promise<T>, limit: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), limit)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}
