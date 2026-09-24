import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  type Config,
  type InstallCommand,
  type InstallersHere,
  installWith,
  type MissingProgram,
  resolveCommand,
  stringEnv,
} from '@tade/core'
import type { LaunchSpec } from '@tade/harnesses-core'
import { HARNESS_ADAPTERS } from './harnesses.ts'
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

/** The package managers Tade knows how to offer, in the order `installWith` prefers them. */
const MANAGERS = ['brew', 'apt-get', 'dnf', 'npm']

/**
 * What this machine can install with.
 *
 * One PATH lookup per manager, which is what makes the offer honest: a `brew
 * install` on a machine with no Homebrew is a command that fails in a terminal
 * somebody is watching.
 */
export function installersHere(env: NodeJS.ProcessEnv = process.env): InstallersHere {
  const strings = stringEnv(env)
  return {
    platform: process.platform,
    managers: MANAGERS.filter((command) => resolveCommand(command, strings) !== null),
  }
}

/**
 * What is needed here and not installed, with the exact command for each.
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
  return looks
    .filter((look) => look.install === null)
    .map((look) => ({
      command: look.need.command,
      title: look.need.title,
      why: look.need.needed.map((one) => one.why).join('; '),
      optional: look.need.optional || !look.need.inUse,
      install: installWith(look.need.install, machine),
    }))
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
        adapter.account().catch((err: unknown) => ({
          signedIn: false,
          who: null,
          plan: null,
          method: null,
          problem: err instanceof Error ? err.message : String(err),
        })),
      ])
      // Its own declaration, so the install offered is the one whoever wrote
      // the harness vouches for. An id is Tade's name for a harness
      // (`claude-code`) and a command is the program's own (`claude`), so the
      // two need not match: where a harness declares exactly one program,
      // that program is the harness.
      const declarations = adapter.programs ?? []
      const declared =
        declarations.find((one) => one.command === id) ??
        (declarations.length === 1 ? declarations[0] : undefined)
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
        // Offered wherever the program is here, which is exactly where it is
        // not signed in: a sign-in for something that is not installed is a
        // lane that fails, and one for something installed and signed out is
        // the whole point.
        signIn: installed ? adapter.signIn() : null,
        install: installWith(declared?.install, machine),
      }
    }),
  )
}
