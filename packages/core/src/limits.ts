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

/**
 * What pays for an account's turns, as its harness declares it (`spend.usd`).
 *
 * `plan` is a subscription: nobody is charged per turn, which is the only kind
 * of thing a rolling window can be used up of. `per-token` is money — an API
 * key, a router — where there is no window to fill and a bill instead.
 *
 * It rides here because it is the one field that says whether an account is a
 * way *around* a plan that is full, and because the alternative is reading it
 * out of a name.
 */
export type PlanPays = 'plan' | 'per-token'

/** An account whose plan standing is being read, and what it is able to say. */
export interface PlanSource {
  harness: string
  /** Null for the harness's own sign-in. */
  account: string | null
  can: LimitsSupport
  pays: PlanPays
  /** Its own sentence for what it cannot do. Null when it is not short of full. */
  why: string | null
  /** The last thing it said, when it has said anything. */
  said: PlanSaid | null
}

/** How one account's plan stands: what is used of it, or why nobody can say. */
export interface PlanStanding {
  harness: string
  account: string | null
  pays: PlanPays
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
    const where = { harness: source.harness, account: source.account, pays: source.pays }
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

/**
 * One account's plan as a strip draws it: every window it named that is still
 * running, and which of them is closest to full.
 *
 * One account and not the fullest window of each, because a session window of
 * one sign-in beside the week of another is two answers to one question. The
 * account is the one with the fullest window anywhere — the one about to stop
 * somebody working — and the windows are in the order the harness named them,
 * which is the session first and the longer one after it.
 */
export interface TightestPlan {
  harness: string
  account: string | null
  /** Its running windows, in the harness's own order. Never empty. */
  windows: readonly PlanWindow[]
  /** The fullest of them: the one kept where there is only room for one. */
  tightest: PlanWindow
  /** When the harness said it. */
  at: number
}

/** The account closest to running out, and everything it said about itself. */
export function tightestPlan(standings: readonly PlanStanding[]): TightestPlan | null {
  // One search over one shape, so which window is tightest and whose plan it
  // is can never be two different answers.
  let worst: TightestPlan | null = null
  for (const standing of standings) {
    const plan = planOf(standing)
    if (plan === null) continue
    if (worst === null || fuller(plan.tightest, worst.tightest)) worst = plan
  }
  return worst
}

/**
 * One account's plan as a surface with room for one draws it: its running
 * windows, and the fullest of them.
 *
 * Null where it has nothing true to draw — a harness that cannot say, one that
 * has not yet, or one whose every window has started over. That null is what
 * makes both `tightestPlan` and the toggle beside it skip an account without
 * either of them having its own idea of what "has something to say" means.
 */
function planOf(standing: PlanStanding): TightestPlan | null {
  const at = standing.at
  if (at === null) return null
  let tightest: PlanWindow | null = null
  for (const window of standing.windows) {
    if (tightest === null || fuller(window, tightest)) tightest = window
  }
  if (tightest === null) return null
  return {
    harness: standing.harness,
    account: standing.account,
    windows: standing.windows,
    tightest,
    at,
  }
}

/** Whether a window is the greater worry: fuller, or as full and back sooner. */
function fuller(window: PlanWindow, than: PlanWindow): boolean {
  if (window.used !== than.used) return window.used > than.used
  return resetFirst(window, than)
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

/** One sign-in, as a surface that shows one at a time names the one it is showing. */
export interface PlanChoice {
  harness: string
  account: string | null
}

/** Whether a standing is the sign-in a choice names. */
function isChosen(standing: PlanStanding, chosen: PlanChoice): boolean {
  return standing.harness === chosen.harness && standing.account === chosen.account
}

/**
 * The account a surface with room for one is showing: the one somebody moved
 * to, while it still has something true to say, and the tightest otherwise.
 *
 * Falling back is the whole of it. A chosen sign-in whose every window has
 * started over has nothing true to draw, and the tightest is the answer that
 * cannot be a stale figure — so a choice heals itself rather than pinning a
 * surface to an account that has gone quiet. The default is the tightest
 * because it is the one about to stop somebody working.
 */
export function planShown(
  standings: readonly PlanStanding[],
  chosen: PlanChoice | null,
): TightestPlan | null {
  const found = chosen ? standings.find((one) => isChosen(one, chosen)) : undefined
  return (found ? planOf(found) : null) ?? tightestPlan(standings)
}

/**
 * The sign-in to show after the one showing now: the accounts that have
 * something to say, in the order they were gathered, round and round.
 *
 * Null where fewer than two of them can say anything, which is how a surface
 * knows not to draw the control at all: one that moves between a single thing
 * is a control that lies about there being somewhere to go.
 */
export function nextPlan(
  standings: readonly PlanStanding[],
  chosen: PlanChoice | null,
): PlanChoice | null {
  const speaking = standings.filter((one) => planOf(one) !== null)
  if (speaking.length < 2) return null
  const showing = planShown(standings, chosen)
  const at = showing === null ? -1 : speaking.findIndex((one) => isChosen(one, showing))
  const next = speaking[(at + 1) % speaking.length]
  return next ? { harness: next.harness, account: next.account } : null
}

/** How much of a window is gone, as anything that draws one decides what to say about it. */
export type PlanPressure = 'fine' | 'warm' | 'tight'

/**
 * Where a window stops being ordinary, and where it is about to stop somebody
 * working.
 *
 * One rule in one place. The strip's colours and the Spend page's colours each
 * held these two numbers as literals, with a comment on one of them saying
 * they must not disagree; what a plan is worth telling somebody about is now a
 * third reader, and three copies of a threshold is how the day one of them
 * moves arrives.
 */
export const PLAN_WARM = 75
export const PLAN_TIGHT = 90

/** How worrying a share of a window is. */
export function planPressure(used: number): PlanPressure {
  if (used >= PLAN_TIGHT) return 'tight'
  if (used >= PLAN_WARM) return 'warm'
  return 'fine'
}

/** One of a plan's windows, as somebody who is being told about it reads it. */
export interface PlanWindowSaid {
  /** What it covers: `5h`, `7d`. */
  label: string
  /** What is used of it, the service's own number. */
  used: number
  /** What is left of it — the other side of that number, and never money. */
  left: number
  /** How long until it starts over, or null where the harness did not say. */
  resetsIn: number | null
  pressure: PlanPressure
}

/** Where one sign-in stands: who it is, what it said, and why it could not. */
export interface PlanStandingSaid {
  /** Who it is, as every surface labels it: `claude-code`, `codex @work`. */
  label: string
  harness: string
  account: string | null
  pays: PlanPays
  /** Its running windows, in the harness's own order. Empty where it could not say. */
  windows: readonly PlanWindowSaid[]
  /**
   * The fullest window's pressure, which is the one that stops somebody
   * working. Null where nothing could be said — never `fine`, which would read
   * as a plan somebody had looked at.
   */
  pressure: PlanPressure | null
  /** Why there is nothing to show, in the harness's own words. Null where there is something. */
  cannotTell: string | null
  /** How long ago the harness said it. Null where it never has. */
  saidAgo: number | null
}

/**
 * Where every sign-in stands, and what else there is if one of them runs out.
 *
 * A fold and nothing else: it asks nobody anything and decides nothing. Which
 * sign-in agents run as is a person's — whose money and whose permissions the
 * work runs with — so the most this can ever be is what somebody needs in
 * order to say something useful about it.
 */
export interface PlanReport {
  /** Every sign-in there is, in the order they were gathered. */
  signIns: readonly PlanStandingSaid[]
  /** The ones at or past `PLAN_TIGHT`, fullest first. Empty when none is. */
  pressed: readonly PlanStandingSaid[]
  /**
   * What else agents could run as, for a plan that is nearly gone: the ones
   * with room, least used first; then the ones nothing can be said about, a
   * sign-in paid per token ahead of the rest of those, because one that is not
   * paid for by a plan has no window to fill.
   *
   * Ordered by what is known and never by a guess — "cannot tell" is not the
   * same answer as "has room", and an order that mixed them would make it one.
   */
  instead: readonly PlanStandingSaid[]
}

/** Where each sign-in stands, for somebody deciding what to do about one of them. */
export function planReport(sources: readonly PlanSource[], now: number): PlanReport {
  const signIns = planStandings(sources, now).map((standing) => standingSaid(standing, now))
  const fullestOf = (one: PlanStandingSaid) =>
    one.windows.reduce((most, window) => Math.max(most, window.used), 0)
  const quiet = signIns.filter((one) => one.pressure === null)
  return {
    signIns,
    pressed: signIns
      .filter((one) => one.pressure === 'tight')
      .sort((a, b) => fullestOf(b) - fullestOf(a)),
    instead: [
      ...signIns
        .filter((one) => one.pressure !== null && one.pressure !== 'tight')
        .sort((a, b) => fullestOf(a) - fullestOf(b)),
      ...quiet.filter((one) => one.pays === 'per-token'),
      ...quiet.filter((one) => one.pays === 'plan'),
    ],
  }
}

/** One standing in the words and lengths of time somebody reads. */
function standingSaid(standing: PlanStanding, now: number): PlanStandingSaid {
  const windows = standing.windows.map((window) => ({
    label: window.label,
    used: window.used,
    left: Math.max(0, 100 - window.used),
    resetsIn: resetsIn(window, now),
    pressure: planPressure(window.used),
  }))
  const tightest = planOf(standing)?.tightest ?? null
  return {
    label: planLabel(standing),
    harness: standing.harness,
    account: standing.account,
    pays: standing.pays,
    windows,
    pressure: tightest === null ? null : planPressure(tightest.used),
    cannotTell: standing.cannotTell,
    saidAgo: standing.at === null ? null : Math.max(0, now - standing.at),
  }
}
