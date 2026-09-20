// What an agent has been doing, counted — before anybody is asked to read it.
//
// A judge cannot count, so everything countable about a loop is counted here:
// how many times the same call came round, how many of those failed, how many
// turns ended badly. What is left for a reading is the only part nobody can
// derive — whether doing the same thing again is a loop or a method.
//
// Pure, and deliberately mean about what counts as going round: an agent that
// has been working for two hours is working, and an agent that ran the tests
// five times while they passed is running the tests.

/** One thing an agent did, as the window watched it happen. */
export interface Did {
  at: number
  tool: string
  about: string
  ok: boolean | null
}

/** How one of its turns ended. */
export interface Ended {
  at: number
  status: 'ok' | 'error' | 'aborted'
}

/** The same call, however many times it was made. */
export function signatureOf(did: { tool: string; about: string }): string {
  return `${did.tool} ${did.about}`
}

/** What it did, in order, with the same thing counted rather than listed again. */
export interface Step {
  tool: string
  about: string
  times: number
  failed: number
}

export interface Circling {
  /** What it keeps doing: what the finding is about, and what it is known by. */
  signature: string
  times: number
  failed: number
  /** How many of its last turns ended badly, counting back from the newest. */
  badTurns: number
  /** Everything it did, oldest first, for whoever reads it. */
  steps: Step[]
}

/**
 * What is going round in what an agent did, or null for nothing worth asking
 * about.
 *
 * Two things bring an agent here, and neither is an opinion: the same call
 * made `least` times with at least one of them failing — a repeat where
 * nothing ever failed is a method, not a loop — or `badTurns` turns in a row
 * that ended badly, which is an agent that cannot get through a turn at all.
 */
export function circlingIn(
  did: readonly Did[],
  ends: readonly Ended[],
  least: number,
  badLeast: number,
): Circling | null {
  const steps: Step[] = []
  const by = new Map<string, Step>()
  for (const one of did) {
    const key = signatureOf(one)
    const already = by.get(key)
    const step = already ?? { tool: one.tool, about: one.about, times: 0, failed: 0 }
    step.times += 1
    if (one.ok === false) step.failed += 1
    if (!already) {
      by.set(key, step)
      steps.push(step)
    }
  }
  let badTurns = 0
  for (let at = ends.length - 1; at >= 0; at--) {
    if (ends[at]?.status !== 'error') break
    badTurns += 1
  }
  const worst = [...by.entries()].sort(
    ([, a], [, b]) => b.times - a.times || b.failed - a.failed,
  )[0]
  const repeating = worst && worst[1].times >= least && worst[1].failed > 0 ? worst : null
  if (!repeating && badTurns < badLeast) return null
  const last = did.at(-1)
  const [key, step] = repeating ?? [last ? signatureOf(last) : 'nothing', null]
  return {
    signature: key,
    times: step?.times ?? 0,
    failed: step?.failed ?? 0,
    badTurns,
    steps,
  }
}
