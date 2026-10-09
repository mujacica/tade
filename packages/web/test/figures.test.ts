import {
  duration as durationHere,
  noSpend,
  onPlanOf as onPlanHere,
  planPressure as pressureHere,
  pricedOf as pricedHere,
  type Spend,
  PLAN_TIGHT as TIGHT,
  PLAN_WARM as WARM,
} from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  ageSaid,
  clockOf,
  count,
  duration,
  money,
  onPlan,
  onPlanOf,
  PLAN_TIGHT,
  PLAN_WARM,
  planBar,
  planPressure,
  pricedOf,
  SEGMENTS,
  shortClockOf,
  sinceSaid,
  tokens,
  tokensSaid,
  untilSaid,
} from '../src/assets/figures.js'

// Every way a figure on this page could be wrong rather than merely ugly.
//
// Half of this file is the **agreement** half: four of the rules in
// `figures.js` are `@tade/core`'s, copied because a browser cannot import a
// `.ts` file and this repository has no build step. The same table runs through
// both copies here, so neither can be changed without the other — the pattern
// `client.test.ts` already uses for the connection states.
//
// The other half is the drawing, and the assertions that matter are the ones
// about what the page must **not** say: never `$0.00` for a figure nobody
// recorded, never a total with a plan's equivalent added into it, never a
// figure made of some priced turns drawn as though it were complete, and never
// an age counting up against a snapshot that cannot be refreshed.

const NOW = Date.parse('2026-10-08T14:30:00.000Z')

const spend = (over: Partial<Spend> = {}): Spend => ({ ...noSpend(), ...over })

describe('the rules that are the domain’s', () => {
  it('says a span of time the way the window says it, in both copies', () => {
    for (const ms of [
      0, 999, 1000, 59_000, 60_000, 61_000, 3_600_000, 3_660_000, 86_400_000, 90_000_000,
      172_800_000,
    ]) {
      expect(duration(ms), String(ms)).toBe(durationHere(ms))
    }
    expect(duration(8 * 60_000)).toBe('8m')
    expect(duration(72 * 60_000)).toBe('1h 12m')
  })

  it('names which kind of money a figure is, in both copies', () => {
    const table: Spend[] = [
      spend(),
      spend({ usdExact: 1 }),
      spend({ usdEstimated: 1 }),
      spend({ usdListed: 1 }),
      spend({ usdExact: 1, usdEstimated: 1 }),
    ]
    for (const one of table) expect(pricedOf(one)).toBe(pricedHere(one))
    expect(pricedOf(spend({ usdExact: 1, usdEstimated: 1 }))).toBe('mixed')
  })

  it('names what a plan’s own estimate is worth, in both copies', () => {
    for (const one of [
      spend(),
      spend({ usdOnPlan: 2.8 }),
      spend({ usdOnPlan: 2.8, tokensOnPlanUnrated: 100 }),
    ]) {
      expect(onPlanOf(one)).toBe(onPlanHere(one))
    }
  })

  it('holds the plan thresholds and the pressure rule in both copies', () => {
    expect([PLAN_WARM, PLAN_TIGHT]).toEqual([WARM, TIGHT])
    for (const used of [0, 10, 74, 75, 89, 90, 100, 140]) {
      expect(planPressure(used), String(used)).toBe(pressureHere(used))
    }
  })
})

describe('money', () => {
  it('is a dash and a word where nobody wrote anything down, never a nought', () => {
    // `UNRECORDED` and `$0.00` are different mornings: one is *nobody said*
    // and the other is *it was free*.
    const said = money(spend({ hasCost: false, usd: 0 }))
    expect(said.said).toBe('—')
    expect(said.why).toBe('not recorded')
    expect(said.said).not.toContain('0.00')
  })

  it('is a dash for no spend row at all', () => {
    expect(money(null).said).toBe('—')
    expect(money(undefined).said).toBe('—')
  })

  it('tells a figure nobody recorded from one this device may not read', () => {
    // **Three dashes, not one.** A page that drew *not granted* as *not
    // recorded* would tell somebody their work cost nothing, when what
    // happened is that their phone was never allowed to ask.
    expect(money(spend({ hasCost: true, usd: 4.12 }), false).said).toBe('—')
    expect(money(spend({ hasCost: true, usd: 4.12 }), false).why).toBe('not granted')
    expect(money(spend({ hasCost: false }), true).why).toBe('not recorded')
    expect(money(spend({ hasCost: false }), true).why).not.toBe(
      money(spend({ hasCost: false }), false).why,
    )
  })

  it('is marked wherever any part of it was estimated', () => {
    expect(money(spend({ hasCost: true, usd: 4.12, usdExact: 4.12 })).said).toBe('$4.12')
    expect(money(spend({ hasCost: true, usd: 4.12, usdEstimated: 0.41 })).said).toBe('~$4.12')
    expect(money(spend({ hasCost: true, usd: 4.12, usdEstimated: 0.41 })).mark).toBe('~')
  })

  it('tells free apart from unpriced, which is what `hasCost` is for', () => {
    // A harness that charges nothing reported nought and said so; one that
    // reported nothing said nothing. The first is a figure.
    expect(money(spend({ hasCost: true, usd: 0 })).said).toBe('$0.00')
    expect(money(spend({ hasCost: false, usd: 0 })).said).toBe('—')
  })
})

describe('a plan’s equivalent, which is in no total', () => {
  it('is nothing to say where no plan ran', () => {
    expect(onPlan(spend())).toBeNull()
    expect(onPlan(null)).toBeNull()
  })

  it('is a floor whenever some of those tokens had no rate', () => {
    const partly = onPlan(spend({ usdOnPlan: 2.8, tokensOnPlanUnrated: 880_000 }))
    expect(partly?.said).toBe('≥$2.80')
    expect(partly?.floor).toBe(true)
    const listed = onPlan(spend({ usdOnPlan: 2.8 }))
    expect(listed?.said).toBe('$2.80')
    expect(listed?.floor).toBe(false)
  })

  it('carries the sentence that keeps it out of the total', () => {
    // A subscription paid a flat fee, so nobody was charged these. The label
    // is the thing that stops somebody adding the two figures up.
    expect(onPlan(spend({ usdOnPlan: 1 }))?.why).toContain('not in the total')
  })
})

describe('tokens', () => {
  it('shortens without rounding up to a lie', () => {
    expect(tokens(420)).toBe('420')
    expect(tokens(880_000)).toBe('880k')
    expect(tokens(1_900_000)).toBe('1.9M')
  })

  it('says what no dollar figure covers beside the total, never folded in', () => {
    const said = tokensSaid(spend({ tokens: 1_900_000, tokensUnpriced: 880_000 }))
    expect(said?.said).toBe('1.9M')
    expect(said?.unpriced).toBe('880k unpriced')
  })

  it('is nothing at all where no tokens were reported', () => {
    expect(tokensSaid(spend())).toBeNull()
  })
})

describe('a plan window', () => {
  it('is ten segments, so one segment is one tenth', () => {
    expect(SEGMENTS).toBe(10)
    const bar = planBar(74)
    expect(bar.bar).toHaveLength(10)
    expect(bar.bar).toBe('▰▰▰▰▰▰▰▱▱▱')
    expect(bar.said).toBe('74%')
    expect(bar.pressure).toBe('fine')
  })

  it('draws a window over its own ceiling as full and still says the real figure', () => {
    // The share is the service's own number and the bar is ours: clamping the
    // drawing is fine, clamping the figure would be editing what they said.
    const bar = planBar(104)
    expect(bar.bar).toBe('▰▰▰▰▰▰▰▰▰▰')
    expect(bar.said).toBe('104%')
    expect(bar.pressure).toBe('tight')
  })

  it('is never a negative bar', () => {
    expect(planBar(-5).bar).toBe('▱▱▱▱▱▱▱▱▱▱')
  })
})

describe('a count in a column', () => {
  it('is a middle dot for nought, because a column of zeroes is noise', () => {
    expect(count(0)).toBe('·')
    expect(count(5)).toBe('5')
  })
})

describe('an age', () => {
  it('is nothing at all for a moment that never happened', () => {
    // `0s` would be a claim that it moved just now.
    expect(ageSaid(null, NOW)).toBeNull()
    expect(ageSaid('', NOW)).toBeNull()
    expect(ageSaid('not a date', NOW)).toBeNull()
  })

  it('counts against the clock it is handed', () => {
    expect(ageSaid(new Date(NOW - 8 * 60_000).toISOString(), NOW)).toBe('8m')
  })

  it('freezes and says when it was last true', () => {
    // **The lie this whole rule exists to prevent**: an age counting up against
    // a snapshot nothing can refresh. Frozen, it is the age at the server's own
    // last word, and it carries that moment so the reader can see it is not now.
    const moved = new Date(NOW - 8 * 60_000).toISOString()
    const frozen = ageSaid(moved, NOW, true)
    expect(frozen).toContain('8m at ')
    expect(frozen).toMatch(/8m at \d\d:\d\d:\d\d/)
    // And the same input ten minutes later, against the same frozen clock, is
    // the same words: nothing about it moves while nothing can be asked.
    expect(ageSaid(moved, NOW, true)).toBe(frozen)
  })

  it('is never negative for a moment in the future', () => {
    expect(ageSaid(new Date(NOW + 60_000).toISOString(), NOW)).toBe('0s')
  })
})

describe('a clock', () => {
  it('is the server’s own instant, read in the reader’s own zone', () => {
    const at = '2026-10-08T14:30:00.000Z'
    const when = new Date(at)
    const two = (n: number) => String(n).padStart(2, '0')
    expect(clockOf(at)).toBe(
      `${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}`,
    )
    expect(shortClockOf(at)).toBe(clockOf(at).slice(0, 5))
  })

  it('is a dash for something that is not a moment', () => {
    expect(clockOf('not a date')).toBe('—')
  })

  it('counts to a moment, and says `now` for one that has passed', () => {
    expect(untilSaid(new Date(NOW + 134 * 60_000).toISOString(), NOW)).toBe('2h 14m')
    expect(untilSaid(new Date(NOW - 1).toISOString(), NOW)).toBe('now')
    expect(untilSaid(null, NOW)).toBeNull()
  })
})

describe('the period every money figure covers', () => {
  it('names the instant the fold starts at, in the reader’s own clock', () => {
    // The window folds from **its** midnight, so a task that cost forty
    // dollars yesterday and nothing since arrives with no cost at all and is
    // drawn as a dash whose word is *not recorded*. Said, the dash reads as
    // what it is. The instant is rendered where the reader is, like every
    // other moment on the page: a phone in another zone is looking at the
    // same instant and should see its own clock for it.
    const at = '2026-10-08T07:00:00.000Z'
    expect(sinceSaid(at)).toBe(
      `— these figures are what has been spent since ${shortClockOf(at)}, and nothing before it`,
    )
  })

  it('says nothing at all where nothing has been folded yet', () => {
    // `unknown` is first-class: a window that has had no beat has no period,
    // and naming one would be a claim about a fold that has not happened.
    expect(sinceSaid(null)).toBeNull()
    expect(sinceSaid('')).toBeNull()
    expect(sinceSaid('not a date')).toBeNull()
  })
})
