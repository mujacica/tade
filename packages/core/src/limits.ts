// How much of a subscription's plan has been used, and when it starts over.
//
// A subscription has no price per turn, so dollars say nothing about it: what
// is being used up is a share of a rolling window, and the number that matters
// is how much is left and when it comes back. None of it is ever added to
// money — `Spend` holds what was charged and this holds what was consumed, and
// the two are different currencies with no rate between them.
//
// Nothing here counts anything. Every figure is what a harness was told by the
// service it talks to, and this only decides whether that figure is still true
// and, when it is not, what to say instead. `cannotTell` is a first-class
// answer: a window that has started over since the harness last spoke is a
// number nobody knows, and an estimate dressed as a measurement is worse than
// saying so.

/**
 * What a harness can say about how much of a plan is used.
 *
 * - `anytime`: it can be asked whenever, so there is always an answer.
 * - `while-working`: its agents report it as they run, so there is nothing to
 *   show until one of them has.
 * - `none`: it cannot say at all.
 */
export const LIMITS_SUPPORT = ['anytime', 'while-working', 'none'] as const
export type LimitsSupport = (typeof LIMITS_SUPPORT)[number]

/** One of a plan's rolling windows, as the harness itself reported it. */
export interface PlanWindow {
  /** What it covers, in the words a person reads: `5h`, `7d`. */
  label: string
  /** How much of it is used, 0 to 100. The service's own number, never a count of ours. */
  used: number
  /** When it starts over. Zero when the harness did not say. */
  resetsAt: number
}

/** The last thing one account said about its plan. */
export interface PlanSaid {
  /** When it said it. */
  at: number
  windows: readonly PlanWindow[]
}

/** An account whose plan standing is being read, and what it is able to say. */
export interface PlanSource {
  harness: string
  /** Null for the harness's own sign-in. */
  account: string | null
  can: LimitsSupport
  /** Its own sentence for what it cannot do. Null when it is not short of full. */
  why: string | null
  /** The last thing it said, when it has said anything. */
  said: PlanSaid | null
}

/** How one account's plan stands: what is used of it, or why nobody can say. */
export interface PlanStanding {
  harness: string
  account: string | null
  /** The windows still running, in the order the harness named them. Empty when nothing is known. */
  windows: readonly PlanWindow[]
  /** When the harness said it. Null when nothing is known. */
  at: number | null
  /** Why there is nothing to show, in words. Null when there is something. */
  cannotTell: string | null
}

const SAYS_NOTHING = 'does not say how much of a plan is used'
const HAS_NOT_SAID = 'has not said how much of the plan is used yet'
const STARTED_OVER =
  'every window it named has started over since it last said, so what is used of the new one has not been reported'

/**
 * What each account's plan standing is now.
 *
 * Reads what harnesses already hold and asks nobody anything: this is drawn
 * on the window's own beat, and a figure that cost a network call would be a
 * figure nobody could afford to look at.
 */
export function planStandings(sources: readonly PlanSource[], now: number): PlanStanding[] {
  return sources.map((source) => {
    const where = { harness: source.harness, account: source.account }
    const nothing = (why: string): PlanStanding => ({
      ...where,
      windows: [],
      at: null,
      cannotTell: why,
    })
    if (source.can === 'none') return nothing(source.why ?? SAYS_NOTHING)
    if (!source.said) return nothing(source.why ?? HAS_NOT_SAID)
    // A window whose reset has gone by started over, and what has been used of
    // the new one was never reported. Keeping the old percentage would be the
    // one thing worse than an empty row: a number that is wrong and looks
    // exactly like a number that is right.
    const windows = source.said.windows.filter((window) => running(window, now))
    if (windows.length === 0) return nothing(STARTED_OVER)
    return { ...where, windows, at: source.said.at, cannotTell: null }
  })
}

/** Whether a window is one the reported figure is still about. */
function running(window: PlanWindow, now: number): boolean {
  if (!Number.isFinite(window.used) || window.used < 0) return false
  // No reset time at all is a figure with no expiry: kept, because the harness
  // reported it and only the harness knows what it covers.
  if (!Number.isFinite(window.resetsAt) || window.resetsAt <= 0) return true
  return window.resetsAt > now
}

/** One window of one account: what a single line about a plan says. */
export interface TightestWindow {
  harness: string
  account: string | null
  window: PlanWindow
  /** When the harness said it. */
  at: number
}

/**
 * The window closest to full across every account that could say — the one
 * about to stop somebody working, which is the only one worth a line in a
 * strip that has room for one.
 */
export function tightestWindow(standings: readonly PlanStanding[]): TightestWindow | null {
  let worst: TightestWindow | null = null
  for (const standing of standings) {
    if (standing.at === null) continue
    for (const window of standing.windows) {
      const one = {
        harness: standing.harness,
        account: standing.account,
        window,
        at: standing.at,
      }
      if (
        worst === null ||
        window.used > worst.window.used ||
        (window.used === worst.window.used && resetFirst(window, worst.window))
      ) {
        worst = one
      }
    }
  }
  return worst
}

/** Of two windows as full as each other, the one that comes back sooner is the lesser worry. */
function resetFirst(window: PlanWindow, than: PlanWindow): boolean {
  if (window.resetsAt <= 0) return false
  if (than.resetsAt <= 0) return true
  return window.resetsAt < than.resetsAt
}

/** How long until a window starts over, or null where the harness did not say. */
export function resetsIn(window: PlanWindow, now: number): number | null {
  if (!Number.isFinite(window.resetsAt) || window.resetsAt <= 0) return null
  return Math.max(0, window.resetsAt - now)
}

/** Who an account is, as a line about it is labelled: `claude-code`, `codex @work`. */
export function planLabel(of: { harness: string; account: string | null }): string {
  return of.account ? `${of.harness} @${of.account}` : of.harness
}
