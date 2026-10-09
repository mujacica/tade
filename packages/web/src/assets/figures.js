// Drawing a figure honestly: the rules that keep this page from lying with a
// number, and the arithmetic behind each one.
//
// **Nothing here touches the DOM**, so the offline suite imports it and runs
// the whole table (`test/figures.test.ts`). The browser cannot import a `.ts`
// file and this repository has no build step, so four of these rules exist in
// `@tade/core` for everything that reasons about them and here for the page;
// the test runs the same table through both and asserts they agree, which is
// the pattern `client.test.ts` already uses for the connection states. Two
// copies held to agreeing, rather than a bundler for five functions.
//
// The four rules that are the domain's, not this file's:
//
//   `duration`      `@tade/core`'s, from `runtime.ts`
//   `pricedOf`      `@tade/core`'s, from `spend.ts`
//   `onPlanOf`      the same
//   `planPressure`  `@tade/core`'s, from `limits.ts`, with its two thresholds
//
// And the rules that are this file's, each of which is a way a figure could be
// wrong rather than merely ugly:
//
// - **`—` is not `$0.00`.** `UNRECORDED` means nobody said, and a nought says
//   *it was free*. They are different mornings.
// - **`~` wherever any part of a figure was estimated**, so a total made of one
//   priced run and one guessed one is marked rather than averaged into
//   confidence.
// - **`≥` wherever some of the tokens had no rate**, because a figure made of
//   the turns that could be priced is a floor and drawn as a total it is simply
//   wrong.
// - **A plan is not money.** `usdOnPlan` is what a subscription's turns would
//   have cost at list; nobody was charged it, so it is in no total and is drawn
//   below a rule with the sentence that says so.
// - **An age freezes when nothing can be asked.** An age counting up against a
//   snapshot that cannot be refreshed is the one lie this page exists to
//   prevent, so `ageSaid` takes the moment it is counting *from* and, when the
//   page is not live, that moment is the server's own last word and the age
//   carries it (`8m at 11:04`).

/** Where a window stops being ordinary, and where it is about to stop somebody. */
export const PLAN_WARM = 75
export const PLAN_TIGHT = 90

/** How worrying a share of a plan window is. `@tade/core`'s `planPressure`. */
export function planPressure(used) {
  if (used >= PLAN_TIGHT) return 'tight'
  if (used >= PLAN_WARM) return 'warm'
  return 'fine'
}

/**
 * A span of time the way people say it: `4s`, `12m`, `1h 20m`, `2d 3h`.
 *
 * Two units at most, because the third is never what you were asking.
 * `@tade/core`'s `duration`.
 */
export function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

/** Which kind of money this is. `@tade/core`'s `pricedOf`. */
export function pricedOf(spend) {
  const kinds = []
  if (spend.usdExact > 0) kinds.push('exact')
  if (spend.usdEstimated > 0) kinds.push('estimate')
  if (spend.usdListed > 0) kinds.push('listed')
  if (kinds.length > 1) return 'mixed'
  return kinds[0] ?? 'none'
}

/** What a plan's own estimate is worth. `@tade/core`'s `onPlanOf`. */
export function onPlanOf(spend) {
  if (spend.usdOnPlan <= 0) return 'none'
  return spend.tokensOnPlanUnrated > 0 ? 'partly' : 'listed'
}

/**
 * Money, as it is drawn.
 *
 * `{ said, mark, why }`: the figure, the mark that qualifies it, and the word a
 * reader needs when the figure is a dash. `hasCost` is what tells *free* apart
 * from *nobody wrote it down*, and it is the whole reason this returns a word
 * for the dash rather than an empty string.
 *
 * `why` is **two words**, because it goes in a column beside a figure at 360px.
 * What *not granted* means is a sentence, and it is said once on the page that
 * can hold one — never repeated down a column until it is the column.
 */
export function money(spend, granted = true) {
  // **Three dashes, not one.** Not granted to this device, nobody wrote it
  // down, and nought are three different mornings, and a page that drew the
  // first two the same way would tell somebody their work cost nothing when
  // what happened is that their phone was never allowed to ask.
  if (!granted) return { said: '—', mark: '', why: 'not granted' }
  if (spend === null || spend === undefined || !spend.hasCost) {
    return { said: '—', mark: '', why: 'not recorded' }
  }
  const mark = spend.usdEstimated > 0 ? '~' : ''
  return { said: `${mark}$${spend.usd.toFixed(2)}`, mark, why: '' }
}

/**
 * What a subscription's turns would have cost at list, or null for nothing to
 * say.
 *
 * **In no total**, which is the caller's job to honour and `away.css`'s
 * `.outside` to draw: it goes below a rule with the sentence. `≥` whenever some
 * of those tokens ran on a model no rate here knows, because the figure is then
 * a floor.
 */
export function onPlan(spend) {
  if (spend === null || spend === undefined) return null
  const kind = onPlanOf(spend)
  if (kind === 'none') return null
  const floor = kind === 'partly'
  return {
    said: `${floor ? '≥' : ''}$${spend.usdOnPlan.toFixed(2)}`,
    floor,
    why: 'on a plan · not in the total',
  }
}

/** A count of tokens: `1.9M`, `880k`, `420`. Never rounded up to a lie. */
export function tokens(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

/**
 * The tokens, and what no dollar figure covers — said beside it rather than
 * folded in.
 *
 * "A figure missing an agent is worse than one marked incomplete": a total of
 * 1.9M tokens of which 880k had no rate is two facts, and collapsing them to
 * one is how a page claims to have priced work it could not price.
 */
export function tokensSaid(spend) {
  if (spend === null || spend === undefined || spend.tokens === 0) return null
  const unpriced = spend.tokensUnpriced > 0 ? `${tokens(spend.tokensUnpriced)} unpriced` : ''
  return { said: tokens(spend.tokens), unpriced }
}

/** How many segments of ten a share fills. Ten, so one segment is one tenth. */
export const SEGMENTS = 10

/**
 * A plan window as a bar: `▰▰▰▰▰▰▰▱▱▱ 74%`.
 *
 * The share is the service's own number and is clamped for drawing only — a
 * window a harness reports at 104% is drawn full and said as 104%, because the
 * figure is the service's and the bar is ours.
 */
export function planBar(used) {
  const share = Math.max(0, Math.min(100, used))
  const full = Math.round((share / 100) * SEGMENTS)
  return {
    bar: '▰'.repeat(full) + '▱'.repeat(SEGMENTS - full),
    said: `${Math.round(used)}%`,
    pressure: planPressure(used),
  }
}

/**
 * A count in a column: `·` for nought.
 *
 * A column of zeroes is noise, and the one thing a reader wants from a count
 * column is where the numbers are. The screen-reader word is the caller's —
 * `5` alone is read aloud as "five" with no noun.
 */
export function count(n) {
  return n === 0 ? '·' : String(n)
}

/**
 * The age of a moment, and **the moment it is an age at**.
 *
 * `asOf` is the clock to count against: the device's own while the stream is
 * live, and **the server's last word when it is not**. So an unreachable page
 * draws `8m at 11:04` and keeps drawing it, instead of counting a dead
 * snapshot up towards an hour.
 *
 * Null in, null out: a task that has never moved has no age, and `0s` would be
 * a claim that it moved just now.
 */
export function ageSaid(at, asOf, frozen = false) {
  if (at === null || at === undefined || at === '') return null
  const was = Date.parse(at)
  if (Number.isNaN(was)) return null
  const said = duration(Math.max(0, asOf - was))
  return frozen ? `${said} at ${clockOf(new Date(asOf).toISOString())}` : said
}

/**
 * The time of day out of an ISO moment, in the reader's own zone.
 *
 * **The instant is the server's** — it came off the snapshot — so a phone with
 * a wrong clock still shows the right time here, and only the parenthesis in
 * the freshness line is computed from the device's own clock. A phone in
 * another timezone shows that instant as its own wall clock, which is the
 * correct reading of the same moment.
 */
export function clockOf(at) {
  const when = new Date(at)
  if (Number.isNaN(when.getTime())) return '—'
  const two = (n) => String(n).padStart(2, '0')
  return `${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}`
}

/** The same, to the minute, for a row that has no room for seconds. */
export function shortClockOf(at) {
  return clockOf(at).slice(0, 5)
}

/** How long until a moment, or null where there is no moment to count to. */
export function untilSaid(at, now) {
  if (at === null || at === undefined || at === '') return null
  const when = Date.parse(at)
  if (Number.isNaN(when)) return null
  return when <= now ? 'now' : duration(when - now)
}
