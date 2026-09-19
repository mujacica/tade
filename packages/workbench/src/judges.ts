import { makeJevJudge } from '@tade/judge-jev'
import { makeScriptedJudge } from '@tade/judge-scripted'
import type { Judge, JudgeOptions, MakeJudge } from '@tade/judges-core'

// The judges there are, by name: the one registry every call site goes
// through, so adding a judge is an implementation and a line here — never a
// `new` somewhere that assumed there was only ever Jev.
//
// `scripted` is here on purpose and is never chosen for anybody: a judge that
// answers from a table is what tests, demos and `--safe` use, and a review
// that always passes is worse than no review at all, so whoever wants it names
// it.

export const JUDGES: Readonly<Record<string, MakeJudge>> = {
  jev: makeJevJudge,
  scripted: makeScriptedJudge,
}

/** A judge by name, or the reason there is none called that. */
export function makeJudge(name: string, options: JudgeOptions): Judge {
  const make = JUDGES[name]
  if (!make) {
    throw new Error(`there is no judge called ${name} (there is ${Object.keys(JUDGES).join(', ')})`)
  }
  return make(options)
}
