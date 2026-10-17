import { existsSync } from 'node:fs'
import { type InstallersHere, type RequiredProgram, resolveCommand, stringEnv } from '@tade/core'
import type { WorkerAdapter } from '@tade/harnesses-core'

// What this machine installs with, and whether a declared program is on it:
// a PATH lookup each and nothing spawned. Its own file so that what only
// reads — `tade accounts`, `tade voice` — can say this machine's install line
// without loading the driver stack `machine.ts` stands on.

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
    root: process.getuid?.() === 0,
  }
}

/** Whether a declared program is on this machine: where it says it is, or on PATH. */
export function programHere(
  program: RequiredProgram,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (program.at) return existsSync(program.at)
  return resolveCommand(program.command, stringEnv(env)) !== null
}

/**
 * The program that *is* a harness, out of what it declares. An id is Tade's
 * name for a harness (`claude-code`) and a command is the program's own
 * (`claude`), so the two need not match: where a harness declares exactly one
 * program, that program is the harness.
 */
export function harnessProgram(adapter: WorkerAdapter, id: string): RequiredProgram | undefined {
  const declarations = adapter.programs ?? []
  return (
    declarations.find((one) => one.command === id) ??
    (declarations.length === 1 ? declarations[0] : undefined)
  )
}
