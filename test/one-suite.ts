import { type Holders, holdersSaid, insideHeldSlot, waitForMachineSlot } from '@tade/checks-core'
import type { TestProject } from 'vitest/node'
import { endWhatItStarted, onEnding, ownTmp } from './own-tmp.ts'

// One suite at a time on this machine, however it was started.
//
// Tade's own runs take a machine slot (`checks.suites`, `machine.ts`). That
// bounds what goes through Tade and nothing else, and what agents actually do
// is type `pnpm test`, `pnpm check` or `vitest run` into a shell — which is how
// six worktrees came to run sixty-seven vitest processes at once while every
// lock Tade had was free. A sentence in a prompt asking them not to is a
// sentence an agent can skip. This cannot be skipped: it is the suite's own
// `globalSetup`, so every way of starting vitest in this repository goes
// through it — a package script, `pnpm exec`, `npx`, `scripts/coverage.ts`, a
// `--reporter` of somebody's choosing — and a full suite waits here for the
// same turn a run of `checks_run` waits for.
//
// Three runs go straight through, and each is a decision:
//
// - **A narrow one** (`NARROW` files or fewer): one file while fixing one test,
//   one package, the smoke tests the commit hook runs. Cheap, and queueing
//   them behind a two-minute suite would make every commit wait two minutes —
//   which is how a hook comes to be passed `--no-verify`.
// - **One inside a run Tade started**, which already holds its slot and says
//   which (`SLOT_ENV`, checked to be held by somebody alive, so a variable left
//   in a shell is no pass).
// - **Watch mode**, which is a person at a terminal and never ends: holding the
//   machine for it would hold it all afternoon.

/**
 * The most files a run may have and still not wait. The smoke tests are 94,
 * the whole suite is 750-odd and the window's own package alone is 240 — so
 * this lets the hook's run and most packages through and makes anything the
 * size of the suite take its turn.
 */
export const NARROW = 100

/** How long a suite waits for its turn before giving up and saying who has the machine. */
export const MOST_WAIT_MS = 60 * 60_000

/** What a suite does about the machine, given what this run is. */
export async function takeTurn(opts: {
  /** How many test files this run has. */
  files: number
  watch: boolean
  /** Where the suite is running, so whoever waits behind it is told. */
  root: string
  env: NodeJS.ProcessEnv
  say: (line: string) => void
  waitMs?: number
  everyMs?: number
}): Promise<() => Promise<void>> {
  const free = async () => {}
  if (opts.watch || opts.files <= NARROW) return free
  // Only once it is decided to matter: a one-file run should not pay for
  // reading the config.
  const { defaultConfigPath, tadeHome } = await import('../packages/core/src/home.ts')
  const { loadConfig } = await import('../packages/core/src/config-file.ts')
  const home = tadeHome(opts.env)
  if (await insideHeldSlot(home, opts.env)) return free
  const loaded = await loadConfig(defaultConfigPath(opts.env))
  const most = loaded.ok ? loaded.config.checks.suites : 1
  const what = `vitest, ${opts.files} files`
  const turns = most === 1 ? 'one suite' : `${most} suites`
  // A guard may only ever add a wait. Where Tade's home cannot be written —
  // a read-only one, a sandbox — there is no turn to take, and that is said
  // rather than made the reason the suite cannot run at all.
  const got = await waitForMachineSlot(
    home,
    most,
    { what, where: opts.root },
    {
      waitMs: opts.waitMs ?? MOST_WAIT_MS,
      ...(opts.everyMs ? { everyMs: opts.everyMs } : {}),
      onWait: (ahead: Holders) =>
        opts.say(
          `\nWaiting for this machine: it runs ${turns} at a time (checks.suites), and ${holdersSaid(ahead, opts.env.HOME)} ${ahead.length === 1 ? 'has' : 'have'} it. ` +
            `This starts when that finishes. One file does not wait — vitest run <file> — and checks_run takes the same turn and records what it found.\n`,
        ),
    },
  ).catch((err: unknown) => {
    opts.say(
      `\nCould not take this machine's turn (${err instanceof Error ? err.message : String(err)}), so this suite runs without waiting for one.\n`,
    )
    return null
  })
  if (got === null) return free
  if ('held' in got) {
    throw new Error(
      `This machine runs ${turns} at a time (checks.suites), and ${holdersSaid(got.held, opts.env.HOME)} still had it when this stopped waiting. Run one file, or try again when it is done.`,
    )
  }
  return () => got.release()
}

/**
 * The suite's `globalSetup`: wait for the machine, give the run a temp root of
 * its own (`own-tmp.ts`), and at teardown hand both back — and fail a full run
 * that left anything in the machine's temp folder. A run ended by a signal
 * takes its root away as it goes.
 */
export default async function oneSuite(project: TestProject): Promise<() => Promise<void>> {
  const { vitest } = project
  const files = vitest.state.getPaths().length
  const watch = vitest.config.watch
  const say = (line: string) => process.stderr.write(line)
  const release = await takeTurn({ files, watch, root: vitest.config.root, env: process.env, say })
  // After the turn, so what the guard remembers of the temp folder is from
  // when this run starts and not from before the one it waited behind.
  const tmp = await ownTmp({ env: process.env, guard: !watch && files > NARROW, say }).catch(
    async (err: unknown) => {
      await release()
      throw err
    },
  )
  // A run ended by a signal never reaches the teardown below.
  const listening = onEnding(() => {
    try {
      endWhatItStarted()
    } catch (err) {
      say(
        `\nCould not end what this suite started, so its temp root goes with it running: ${String(err)}\n`,
      )
    }
    tmp.abandon()
  })
  return async () => {
    listening()
    await release()
    // Last: vitest runs no teardown after one that throws, and this one
    // throws when a full run left something behind.
    await tmp.done()
  }
}
