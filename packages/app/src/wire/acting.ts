import { AsyncLocalStorage } from 'node:async_hooks'

// The person's words an act from another machine of theirs carries, while it
// runs here (`acts.ts`).
//
// A setting in the `asked` tier needs a line of the person's naming it
// (`namedBy`), and with one conversation on every machine the person may
// have typed it on another: the turn ran where they typed, and its act runs
// here. So the act carries that machine's `said` lines — the person's own,
// read out of its journal there and never anything a model wrote — and while
// it runs, `saidLately` reads them beside this machine's own, and what it
// changes is written down as the orchestrator's *via* that machine.
//
// Held per act (`AsyncLocalStorage`), never in a field: this machine's own
// orchestrator may be asking for something at the same moment, and its words
// are only its own.

interface Acting {
  /** The person's own lines on the machine the act came from. */
  quoted: readonly string[]
  /** That machine, as this one names it. */
  via: string
}

const acting = new AsyncLocalStorage<Acting>()

/** Run `act` with the words it carried from `via`. */
export function actingFor<T>(
  quoted: readonly string[],
  via: string,
  act: () => Promise<T>,
): Promise<T> {
  return acting.run({ quoted, via }, act)
}

/** The person's lines an act from another machine carried; none outside one. */
export function quotedWords(): readonly string[] {
  return acting.getStore()?.quoted ?? []
}

/** Who a change is written down as: `orchestrator via vps` for an act that came from there. */
export function byActing(by: string): string {
  const via = acting.getStore()?.via
  return via ? `${by} via ${via}` : by
}
