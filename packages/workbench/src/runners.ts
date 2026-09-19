import type { Runner, RunnerOptions } from '@tade/checks-core'
import { makeLocalRunner } from '@tade/checks-local'
import { makeScriptedRunner } from '@tade/checks-scripted'

// The runners there are, by name: the one registry every call site goes
// through, so adding a runner that runs the workflow in containers is an
// implementation and a line here — never a `new` somewhere that assumed the
// commands always ran on this machine.
//
// `scripted` is registered and never chosen for anybody: a runner that
// answers from a table is what tests and demos use, and checks that always
// pass are worse than no checks at all, so whoever wants it names it.

export const RUNNERS: Readonly<Record<string, (opts: RunnerOptions) => Runner>> = {
  local: makeLocalRunner,
  scripted: makeScriptedRunner,
}

/** A runner by name, or the reason there is none called that. */
export function makeRunner(name: string, options: RunnerOptions = {}): Runner {
  const make = RUNNERS[name]
  if (!make) {
    throw new Error(
      `there is no runner called ${name} (there is ${Object.keys(RUNNERS).join(', ')})`,
    )
  }
  return make(options)
}
