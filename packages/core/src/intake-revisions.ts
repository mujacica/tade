import type { IntakeSource } from './intake.ts'

// How each source says which version of a request this is, and the one rule
// about moving a cursor past something a look did not finish.
//
// Its own file for the reason `intake-setup.ts` is one: this table grows by an
// entry per source, while `intake.ts` is the rule and must not. Pure — no
// `node:`, no clock, no zod — so the whole cross-product of a source's
// revisions is a table in a test.
//
// **The third answer is the point.** Two revisions that cannot be compared are
// not "the same" and not "newer": they are a hold and a sentence, because a
// source that reorders, renumbers or hands back something unparseable is a
// source nobody should start work on a guess about.

/**
 * How each source's revisions compare. **Per source, in code, with a test
 * each**, because the three values the trackers use are an ISO timestamp, an
 * epoch with decimals and an opaque id, and none of them is safely compared as
 * a string: `"10"` sorts before `"9"`, and `"2026-1-2"` before `"2026-01-03"`.
 *
 * `null` means *these two cannot be compared*, which is a third answer and the
 * one that keeps this honest. A source that reorders, renumbers or hands back
 * something unparseable gets a hold and a sentence, never a guess.
 */
const REVISIONS: Readonly<Record<IntakeSource, (a: string, b: string) => number | null>> = {
  // A decimal counter the local door assigns, compared as a number. Anything
  // that is not one — a hand-edited spool file — is not comparable.
  cli: (a, b) => {
    const left = /^\d+$/.test(a) ? Number(a) : Number.NaN
    const right = /^\d+$/.test(b) ? Number(b) : Number.NaN
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null
    return left === right ? 0 : left > right ? 1 : -1
  },
  // An issue's `updated_at`, which GitHub documents as an ISO 8601 timestamp
  // (`YYYY-MM-DDTHH:MM:SSZ`), parsed to a time. Compared as text it is right
  // until one carries an offset — `09:00+02:00` is `07:00Z`, which is earlier
  // than `08:00Z` and sorts later as a string — or until the same moment
  // arrives written two ways. Anything that will not parse is not comparable,
  // which holds rather than guessing an order.
  //
  // **GitHub moves `updated_at` for a comment as well as for an edit**, so a
  // comment on something already taken reads as a new revision and re-parks a
  // proposal a person had approved. That is the direction this is allowed to be
  // wrong in — the hash written down beside it says whether the words actually
  // moved — and it is why the whole of a request is read again rather than
  // trusted.
  github: isoOrder,
  // A Linear issue's `updatedAt`, which Linear's own schema documents as
  // "the last time at which the entity was meaningfully updated", in ISO 8601
  // — so the same arithmetic as GitHub's, and deliberately its own entry
  // rather than an alias: what the table says is that two sources agreed about
  // a format today, not that one may be read as the other tomorrow.
  //
  // **Whether a comment moves it is not documented**, and nothing here guesses:
  // Linear says "meaningfully updated" and says no more. So this is read in the
  // same direction GitHub's is allowed to be wrong in — a revision that moved
  // holds the work and a person looks — and the hash written down beside it
  // says whether the words themselves actually moved. Linear is also a source
  // Tade cannot write to at all (`linear.ts` implements no `reply`), so a moved
  // revision is never Tade's own doing.
  //
  // Linear's `DateTime` scalar is wider than an instant: it "accepts shortcuts
  // like `2021`" and ISO 8601 *durations* relative to now, so `-P2W1D` is a
  // date rather than a thing that will not parse. `Date.parse` rejects those,
  // which is the answer this wants — a duration is not a revision — and it is
  // why a cursor is checked against this before it is sent as a filter.
  linear: isoOrder,
  // A Slack `ts` — `1727442000.123456`, seconds and microseconds — compared as
  // **two integers and never as one number**, which is the whole reason this
  // has a line of its own rather than reusing the decimal counter above.
  // `Number('1727442000.123456')` is sixteen significant digits put through a
  // double whose spacing at that magnitude is about a quarter of a microsecond,
  // so two messages a microsecond apart are a rounding error away from
  // comparing equal — and will be exactly equal once the seconds gain a digit.
  // As text it is worse: `.9` sorts after `.10`.
  //
  // Anything that is not a Slack ts is not comparable, which holds rather than
  // guessing an order.
  slack: (a, b) => {
    const left = slackTs(a)
    const right = slackTs(b)
    if (!left || !right) return null
    if (left.seconds !== right.seconds) return left.seconds > right.seconds ? 1 : -1
    return left.micros === right.micros ? 0 : left.micros > right.micros ? 1 : -1
  },
}

/**
 * A Slack `ts` pulled apart into whole seconds and whole microseconds, or null
 * where it is not one.
 *
 * Exported because a connector has the same two things to do with one — order
 * two of them, and say when the thing happened — and a second parser of a
 * source's own id format is a second answer about which message is newer.
 */
export function slackTs(ts: string): { seconds: number; micros: number } | null {
  const found = /^(\d{1,12})\.(\d{1,6})$/.exec(ts)
  if (!found?.[1] || !found[2]) return null
  // Padded, so `.9` is nine hundred thousand microseconds and not nine: Slack
  // writes six digits, and a hand-written or truncated one must not sort as if
  // the missing digits were leading zeroes.
  return { seconds: Number(found[1]), micros: Number(found[2].padEnd(6, '0')) }
}

/**
 * Whether `a` is a later revision than `b`, by that source's own semantics:
 * `1` later, `0` the same, `-1` earlier, `null` not comparable.
 */
export function newerRevision(source: IntakeSource, a: string, b: string): number | null {
  return REVISIONS[source](a, b)
}

/** The sentence said about a pair nobody can order, which is a hold and not a start. */
export function revisionUncomparable(source: IntakeSource, a: string, b: string): string {
  return `${source} said this is revision ${a} and the one already taken is ${b}, and ${source} revisions cannot be ordered from those: somebody has to say which is newer`
}

/**
 * Two ISO 8601 instants, as an order rather than as text.
 *
 * One implementation for the two sources that write one, because the
 * arithmetic has one right answer and two copies of it are two chances to get
 * the offset case wrong. Compared as text it is right until one carries an
 * offset — `09:00+02:00` is `07:00Z`, which is earlier than `08:00Z` and sorts
 * later as a string — or until the same moment arrives written two ways
 * (`08:00:00Z` and `08:00:00.000Z`).
 *
 * Anything that will not parse is **not comparable**, which holds rather than
 * guessing an order.
 */
function isoOrder(a: string, b: string): number | null {
  const left = Date.parse(a)
  const right = Date.parse(b)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null
  return left === right ? 0 : left > right ? 1 : -1
}

/**
 * Where a polled source's next look starts: the newest mark everything below
 * which this look actually dealt with.
 *
 * **Not simply the newest thing read**, and that is the whole of it. A bounded
 * look leaves requests behind — past its ceiling, or with material it could not
 * finish — and a cursor past one of those is a request that vanished with
 * nothing written down. So the cursor stops **below the oldest deferred one**,
 * and a sweep that did not reach the bottom of its own window does not move at
 * all: re-reading what it already has costs one request and no agent, because
 * Tade knows which keys it has seen.
 *
 * Here rather than in each connector because it is the same rule for every
 * source that carries a *time or sequence* cursor — Slack's `ts`, Linear's
 * `updatedAt` — and it is the rule whose two call sites must not drift: one of
 * them silently losing a request is exactly the failure nobody would see. A
 * source whose cursor is a validator rather than a mark (GitHub's `ETag`) has
 * nothing to order and does not use this.
 *
 * A mark this source cannot compare with itself is not a mark of this source
 * and is skipped, rather than sorting as whatever `null` happens to coerce to.
 */
export function advanceCursor(
  source: IntakeSource,
  marks: readonly string[],
  held: readonly string[],
  oldest: string,
  drained: boolean,
): string {
  if (!drained) return oldest
  let stop = ''
  for (const mark of held) {
    if (!stop || (newerRevision(source, mark, stop) ?? 0) < 0) stop = mark
  }
  let since = oldest
  for (const mark of marks) {
    if (newerRevision(source, mark, mark) === null) continue
    if (stop && (newerRevision(source, mark, stop) ?? 0) >= 0) continue
    if ((newerRevision(source, mark, since) ?? 0) > 0) since = mark
  }
  return since
}
