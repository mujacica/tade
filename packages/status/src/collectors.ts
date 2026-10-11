import { lookHere, type StatusCollector } from './collector.ts'
import { type ChildOptions, lookInChild } from './forked.ts'

// The status collectors there are, by name: the one registry every caller goes
// through, so where a look happens is a line here and never a `new` somewhere
// that assumed it was this process.

/**
 * Every collector, by name. A window asks for `child`; nothing else needs to,
 * and nothing `new`s one of these anywhere else.
 */
export const COLLECTORS: Readonly<Record<string, (opts?: ChildOptions) => StatusCollector>> = {
  here: () => lookHere(),
  child: (opts) => lookInChild(opts),
}

/** A collector by name, or the reason there is none called that. */
export function makeCollector(name: string, opts?: ChildOptions): StatusCollector {
  const make = COLLECTORS[name]
  if (!make) {
    throw new Error(
      `there is no status collector called ${name} (there is ${Object.keys(COLLECTORS).join(', ')})`,
    )
  }
  return make(opts)
}
