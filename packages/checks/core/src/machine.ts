import { readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { claim, holderAt, type LockHolder, type RunLock } from './lock.ts'

// How many suites this machine runs at once, whoever started them.
//
// The worktree lock (`lock.ts`) stops two runs in one checkout. It never
// stopped six worktrees running six suites, and that is what took a laptop to
// sixty-seven vitest processes: each run took its own worktree's lock, found it
// free, and started a suite beside five others — every one of which needed the
// machine to itself (`Check.alone`) and none of which had it. So a run that
// needs the machine also takes one of the machine's slots, kept in Tade's own
// home rather than in any project, and `checks.suites` says how many there are.
//
// They are claimed the way the worktree lock is (`claim`): a file each, made
// exclusively, holding the pid that has it, so a slot whose process is gone is
// taken over rather than waited on, and a crash never locks the machine.
//
// The same slots bound a suite nobody started through Tade. A project can take
// one from its own test runner (Tade's does, in `test/one-suite.ts`), and a run
// Tade started tells its commands which slot it already holds (`SLOT_ENV`), so
// the suite inside it goes straight through rather than queueing behind
// itself.

/** The environment variable a run's commands are handed: the path of the slot their run holds. */
export const SLOT_ENV = 'TADE_CHECKS_SLOT'

/** Where the machine's slots are: Tade's own home, never a project. */
export function slotsDir(home: string): string {
  return join(home, 'checks')
}

/** A slot this process holds, and the file that says so. */
export interface MachineSlot extends RunLock {
  path: string
}

/** What somebody waiting is told: who has the machine, so they can say so. */
export type Holders = readonly LockHolder[]

/**
 * Take one of `most` slots, or say who has them.
 *
 * Every live holder is counted first, including one in a slot above `most`:
 * lowering the setting while two suites run must not let a third in because
 * the second is in a slot that is no longer offered. Then the slots under
 * `most` are tried in order, each exclusively, so two takers racing for the
 * last one cannot both have it.
 */
export async function takeMachineSlot(
  home: string,
  most: number,
  holder: { what: string; where: string },
  now: () => number = Date.now,
): Promise<MachineSlot | { held: Holders }> {
  const slots = Math.max(1, Math.floor(most))
  const busy = await slotHolders(home)
  if (busy.length >= slots) return { held: busy }
  for (let slot = 0; slot < slots; slot++) {
    const path = join(slotsDir(home), `slot-${slot}.lock`)
    const got = await claim(path, holder, now)
    if (!('held' in got)) return { ...got, path }
  }
  return { held: await slotHolders(home) }
}

/** Everybody holding a slot on this machine now. A dead pid is nobody. */
export async function slotHolders(home: string): Promise<LockHolder[]> {
  const names = await readdir(slotsDir(home)).catch(() => [] as string[])
  const held = await Promise.all(
    names
      .filter((name) => /^slot-\d+\.lock$/.test(name))
      .sort()
      .map((name) => holderAt(join(slotsDir(home), name))),
  )
  return held.filter((one): one is LockHolder => one !== null)
}

/**
 * Wait for a slot, up to `waitMs`, and then say who has them. `onWait` is told
 * each time who is ahead changes — once at the start of a wait, and again when
 * one finishes and another takes its place — so a wait is never silence.
 */
export async function waitForMachineSlot(
  home: string,
  most: number,
  holder: { what: string; where: string },
  opts: {
    waitMs?: number
    everyMs?: number
    now?: () => number
    onWait?: (ahead: Holders) => void
    /** Stops the wait: whoever asked has gone, and is answered with who still has it. */
    signal?: AbortSignal
  } = {},
): Promise<MachineSlot | { held: Holders }> {
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.waitMs ?? 0)
  let said = ''
  for (;;) {
    const got = await takeMachineSlot(home, most, holder, now)
    if (!('held' in got)) return got
    if (now() >= deadline || opts.signal?.aborted) return got
    const ahead = got.held.map((one) => `${one.pid}:${one.at}`).join(' ')
    if (ahead !== said) {
      said = ahead
      opts.onWait?.(got.held)
    }
    // A timer that holds the process open, unlike the worktree lock's: a
    // process with nothing else left to do is waiting for exactly this, and an
    // unref'd one let vitest's main process end mid-wait with exit code 0 and
    // no tests run — a suite that looked like it passed.
    await new Promise((done) => setTimeout(done, opts.everyMs ?? 250))
  }
}

/**
 * Whether the environment names a slot somebody alive holds — which is what a
 * run Tade started hands its commands, so the suite inside it does not wait
 * for the slot its own run is holding. A slot that is gone, or held by nobody,
 * is no pass: a variable left in a shell's environment after its run ended
 * must not let a second suite in.
 */
export async function insideHeldSlot(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const path = env[SLOT_ENV]
  if (!path?.startsWith(`${slotsDir(home)}${sep}`)) return false
  return (await holderAt(path)) !== null
}

/** Who has the machine, as a sentence somebody waiting can act on. */
export function holdersSaid(ahead: Holders, home?: string): string {
  if (ahead.length === 0) return 'somebody'
  return ahead
    .map((one) => {
      const where = one.where ? ` in ${tilde(one.where, home)}` : ''
      const since = one.at ? ` since ${one.at}` : ''
      return `${one.what || 'checks'}${where} (pid ${one.pid}${since})`
    })
    .join('; ')
}

function tilde(path: string, home: string | undefined): string {
  return home && (path === home || path.startsWith(`${home}${sep}`))
    ? `~${path.slice(home.length)}`
    : path
}
