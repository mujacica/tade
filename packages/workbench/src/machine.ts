import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  type Config,
  type InstallCommand,
  type InstallersHere,
  installWith,
  type MissingProgram,
  runProgram,
  SERVICE,
  type Unattended,
  upgradeWith,
} from '@tade/core'
import { type AccountStatus, type LaunchSpec, signInHere } from '@tade/harnesses-core'
import { HARNESS_ADAPTERS } from './harnesses.ts'
import { harnessProgram, installersHere } from './installers.ts'
import type { ProgramLook } from './programs.ts'
import { drivers } from './registry.ts'

// What this machine can actually run, for whoever is setting it up: which
// programs are missing and what would install each, and which harness is
// signed in.
//
// Neither list is written here. The programs come from what every driver,
// harness and forge declared (`programsNeeded`, next door) and the install
// commands from the same declarations; the harnesses come from the registry
// and each answers for itself — whether it is installed, who it is signed in
// as, and what to run to sign in. So a new harness arrives with its own
// sign-in and its own install and this file does not change.

// Where it always was, for everything that asks it here.
export { installersHere } from './installers.ts'

/** Where the user unit that runs Tade goes: the user's own systemd folder. */
export function serviceUnitPath(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME || homedir(),
): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user', SERVICE)
}

/** Whether systemd is this machine's init: the directory it makes, which is how `sd_booted` asks. */
export function systemdHere(root = '/'): boolean {
  return existsSync(join(root, 'run', 'systemd', 'system'))
}

/** What `unattendedHere` reads, and where: the real machine unless a test says otherwise. */
export interface HostLook {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** The filesystem's root, for a test to build a machine in. */
  root?: string
  user?: string
  home?: string
}

/**
 * Whether this is a server whose own service manager could keep Tade running
 * with nobody logged in — Linux, under systemd, with no screen — and whether
 * it will: linger on, and the unit written. Null anywhere else, so a Mac or a
 * Linux desktop is never asked about either.
 *
 * Three files, and no process: `/run/systemd/system` is how systemd says it
 * is the init (`sd_booted`), and linger is a file per user under
 * `/var/lib/systemd/linger`, which is all `loginctl enable-linger` writes.
 */
export function unattendedHere(look: HostLook = {}): Unattended | null {
  const env = look.env ?? process.env
  const platform = look.platform ?? process.platform
  const root = look.root ?? '/'
  if (platform !== 'linux' || signInHere(env, platform).browser) return null
  if (!systemdHere(root)) return null
  const user = look.user ?? userInfo().username
  const unit = serviceUnitPath(env, look.home)
  return {
    user,
    linger: existsSync(join(root, 'var', 'lib', 'systemd', 'linger', user)),
    unit: existsSync(unit) ? unit : null,
    root: process.getuid?.() === 0,
  }
}

/**
 * The service manager keeping a window open on this machine, asked from a
 * shell it did not start — `tade web status` over SSH, which has no
 * `INVOCATION_ID` for `keptByService` to read. Only where both halves hold:
 * linger on, so the user's manager runs with nobody logged in, and the unit
 * `tade host service` wrote active now. Anything less, a `systemctl` that
 * would not answer included, claims nothing, which is the safe direction.
 */
export async function keptByServiceHere(look: HostLook = {}): Promise<'systemd' | null> {
  const box = unattendedHere(look)
  if (!box?.linger || box.unit === null) return null
  const env = look.env ?? process.env
  const active = await runProgram('systemctl', ['--user', 'is-active', '--quiet', SERVICE], {
    env,
    timeoutMs: 5_000,
  })
  return active.code === 0 ? 'systemd' : null
}

/**
 * What is needed here and not installed, or installed and older than the
 * oldest that works, with the exact command for each.
 *
 * A program only something unused needs is still listed, marked optional: a
 * person switching to tmux wants to know whether tmux is there before they
 * switch. Optional is also what keeps it from being installed behind their
 * back — nothing here installs anything, and only what something in use
 * requires is ever a reason to stop.
 */
export function missingFrom(
  looks: readonly ProgramLook[],
  machine: InstallersHere,
): MissingProgram[] {
  return looks.flatMap((look): MissingProgram[] => {
    const about = {
      command: look.need.command,
      title: look.need.title,
      why: look.need.needed.map((one) => one.why).join('; '),
      optional: look.need.optional || !look.need.inUse,
    }
    if (look.install === null) {
      return [{ ...about, install: installWith(look.need.install, machine) }]
    }
    // Here and older than whatever needs it can use is as missing as not here
    // at all — ticking it beside a step that says it is too old is the
    // contradiction — and its line is the one that brings it up to date.
    const have = look.version ?? look.install.version
    if (look.tooOld && have && look.need.oldest) {
      return [
        {
          ...about,
          tooOld: { have, needs: look.need.oldest },
          install: upgradeWith(look.install, look.need.install, machine),
        },
      ]
    }
    return []
  })
}

/**
 * A native binary of Tade's own that cannot be used here.
 *
 * Asked where each dependency is declared, which is this package: a `require`
 * from anywhere else resolves against a package that does not depend on it and
 * reports it missing on a machine that has it — which is a wizard telling
 * somebody to fix something that is not broken.
 */
export interface NativeProblem {
  module: string
  /** Whether Tade works at all like this. */
  blocking: boolean
  /** What it costs, as a clause: whoever found it out is who can say. */
  clause: string
  /** What is wrong, in whatever words there already are. */
  said: string
  /** The error itself, where a loader threw one, so advice can be made of it. */
  error?: unknown
}

/**
 * The two native modules Tade is built on, and whether they can be used.
 *
 * node-pty is asked of the pty driver — which is not a driver choice: node-pty
 * is what Tade opens every lane with whichever driver is configured, and the
 * driver is the one thing that can say whether its helper can actually be run.
 * better-sqlite3 is only loaded, because loading is all it has to do; the
 * journal is a file and works without the index it builds.
 */
export async function nativeProblems(home: string): Promise<NativeProblem[]> {
  const found: NativeProblem[] = []
  const made = drivers.pty?.(home)
  if (made) {
    const can = await made
      .available()
      .catch((err: unknown) => ({ ok: false as const, reason: message(err) }))
    await made.detach().catch(() => {})
    if (!can.ok) {
      found.push({
        module: 'node-pty',
        blocking: true,
        clause: 'node-pty cannot spawn, so no lane can open',
        said: can.reason,
      })
    }
  }
  try {
    createRequire(import.meta.url)('better-sqlite3')
  } catch (err) {
    found.push({
      module: 'better-sqlite3',
      blocking: false,
      clause: 'better-sqlite3 did not load, so the journal has no index',
      said: message(err),
      error: err,
    })
  }
  return found
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One harness, as this machine has it: whether it runs, and who it is signed in as. */
export interface HarnessHere {
  /** As the registry names it: `pi`, `claude`, `codex`. */
  id: string
  /** Whether Tade is set up to run anything in it. */
  inUse: boolean
  /**
   * Whether the program is here at all, which is the version question and not
   * the sign-in one: two of the three harnesses answer `probe()` with `ok:
   * false` when they are installed and not signed in, and reading that as “not
   * installed” is how somebody gets offered an `npm install` for a program
   * that just told Tade its version.
   */
  installed: boolean
  /** Whether it says it can actually run work here, which includes being signed in. */
  canRun: boolean
  version: string | null
  /** What is wrong with running it, in its own words. */
  problems: readonly string[]
  signedIn: boolean
  /** Who it says it is signed in as. */
  who: string | null
  /** What it says is missing, where it is not signed in. */
  problem: string | null
  /** When the sign-in runs out, where the harness wrote it down: null is "cannot tell". */
  until: number | null
  /**
   * Its own sign-in, when it has one: what to run in a terminal a person can
   * see, and what they are about to be asked, in the harness's words. No
   * credential passes through Tade either way.
   */
  signIn: { launch: LaunchSpec; how: string } | null
  /** The exact command that would install it here, or why there is none. */
  install: InstallCommand
}

/**
 * Every harness there is, and where each one stands.
 *
 * All of them, not only the one in use: "which of these am I signed in to?" is
 * the question somebody has before they choose, and an answer about one
 * harness is no answer at all. Each is asked rather than guessed at —
 * `probe()` for whether it runs, `account()` for the sign-in — and neither
 * throws by contract, so one harness that is not installed never costs the
 * others their answer.
 */
export async function lookAtHarnesses(
  config: Config,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessHere[]> {
  const machine = installersHere(env)
  const here = signInHere(env)
  const inUse = new Set<string>([config.orchestrator.harness])
  for (const route of Object.values(config.workers.routes)) {
    inUse.add(route.harness)
    for (const named of Object.keys(route.harnesses ?? {})) inUse.add(named)
  }

  return Promise.all(
    Object.entries(HARNESS_ADAPTERS).map(async ([id, make]): Promise<HarnessHere> => {
      // The directories a launch would use, and nothing is launched: a
      // constructor does no I/O.
      const adapter = make({
        runDir: join(home, 'runs'),
        socketDir: join(home, 'runs'),
        approvals: 'bypass',
      })
      const [probe, account] = await Promise.all([
        adapter.probe().catch(() => ({ ok: false, version: null, problems: ['it would not say'] })),
        adapter.account().catch(
          (err: unknown): AccountStatus => ({
            signedIn: false,
            who: null,
            plan: null,
            method: null,
            problem: err instanceof Error ? err.message : String(err),
          }),
        ),
      ])
      // Its own declaration, so the install offered is the one whoever wrote
      // the harness vouches for.
      const declared = harnessProgram(adapter, id)
      const installed = probe.version !== null || probe.ok
      return {
        id,
        inUse: inUse.has(id),
        installed,
        canRun: probe.ok,
        version: probe.version,
        problems: probe.problems,
        signedIn: account.signedIn,
        who: account.who,
        problem: account.problem,
        until: account.until ?? null,
        // Offered wherever the program is here, which is exactly where it is
        // not signed in: a sign-in for something that is not installed is a
        // lane that fails, and one for something installed and signed out is
        // the whole point.
        // The one this machine can use: a server has no browser to open.
        signIn: installed ? adapter.signIn(here) : null,
        install: installWith(declared?.install, machine),
      }
    }),
  )
}
