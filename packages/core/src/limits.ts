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
 * - `anytime`: it can be asked whenever, without any work running
 *   (`askLimits`), so whoever needs an answer can have one before spending.
 * - `while-working`: its agents report it as they run, so there is nothing to
 *   show until one of them has.
 * - `none`: it cannot say at all.
 */
export const LIMITS_SUPPORT = ['anytime', 'while-working', 'none'] as const
export type LimitsSupport = (typeof LIMITS_SUPPORT)[number]

/** One of a plan's rolling windows, as the harness itself reported it. */
export interface PlanWindow {
  /** What it covers, in the words a person reads: `5h`, `7d`, `30d` (`windowLabel`). */
  label: string
  /** How much of it is used, 0 to 100. The service's own number, never a count of ours. */
  used: number
  /** When it starts over. Zero when the harness did not say. */
  resetsAt: number
}

/**
 * What a window covers, by how long it is: `5h`, `7d`, `30d`.
 *
 * By its length, and never by which of two slots a harness filed it under.
 * Codex names its windows in minutes, and the ChatGPT free plan has one of
 * 43,200 — thirty days — which, filed as the short window, was drawn as `5h`
 * everywhere a plan is. A length nobody said is `—`, never a guess.
 */
export function windowLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—'
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${Math.round(minutes)}m`
}

/** How much of one window is used, as a list of sign-ins says it beside each: `34% of 5h`. */
export function windowUsed(window: { minutes: number; used: number }): string {
  return `${Math.round(window.used)}% of ${windowLabel(window.minutes)}`
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

/**
 * One sign-in: a harness, and the account in it — null for its own. What a
 * surface that shows one at a time names the one it is showing by, and what a
 * start names the one it would spend by (`planTooTight`).
 */
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

/**
 * What one start of work nobody here asked for comes to, where it is not
 * simply "go": the plan's answer (`planTooTight`), and for a request from
 * outside the grant's and the source's as well (`intakeStands`).
 *
 * - `held`: not until somebody answers — a window seen nearly full, a grant
 *   taken back, a source that says no or could not be asked.
 * - `waits`: not yet, and nobody has to answer: the one start an unknown plan
 *   lets through is still running, and the next look decides again.
 * - `probe`: let through as that one start, and `because` is said wherever its
 *   starting is, since nothing else would say why it went.
 */
export interface StartSays {
  kind: 'held' | 'waits' | 'probe'
  because: string
}

/**
 * What a subscription says about starting work nobody here asked for
 * (`StartSays`), or null where it says nothing.
 *
 * **Two kinds of work, asked separately.** A start whose request came from
 * outside (`outside`, always), where the trade is plainest: spending what is
 * left of a five-hour window on somebody else's ticket at three in the morning
 * is a person's call, not a rule's. And work a schedule or a watch made
 * (`scheduled`), where `queue.hold_scheduled` says so — on by default
 * (REMOTE-TADE.md §5.2, decision 15): a night of `deps` and `sentry` watches on
 * a machine with nobody there stops before the morning's window is gone,
 * rather than being found to have spent it. Work somebody asked for here is
 * never held by this: it is theirs to spend on. A window seen nearly full holds
 * both, whatever else is unknown.
 *
 * **`unknown` is not zero**, which is the whole of why this reads `PlanStanding`
 * rather than a number. An account on a plan that cannot say how full it is, or
 * has not said yet, or whose every window has started over since it last said,
 * is *unknown* — and treating unknown as 0% used is how a backlog burns a
 * window that was already full.
 *
 * **For outside work, unknown lets one start through at a time, and says so.**
 * It held every one, and on the machine this rule is for that never ended:
 * after a restart nothing reports a plan until an agent has run, and on a VPS
 * whose only work comes from outside no agent ran until the plan was known. So
 * while it is unknown, one request from outside runs (`probe`, `because`
 * saying that is why it went) and any other waits for it (`waits`, with
 * `probing` the one running) — a wait and not a hold, because it needs no
 * answer: once the plan is known the ordinary rule decides, and if the one
 * running finishes with nothing known, the next is let through. Unknown is
 * still never room: one agent is what seeing the window costs, never a backlog
 * spent on a guess. A harness that can be asked without running anything
 * (`anytime`) is asked first, by the window, and its answer preferred.
 *
 * **For scheduled work, unknown does not hold, and that is deliberate.** Both
 * subscription harnesses say how full a plan is only as their agents run
 * (`while-working`), so after every restart nobody can say — and on a machine
 * whose only work is what its schedules make, a rule that held on unknown
 * would hold the very start that would make it known, every time, for good.
 * That is a setting accepted and ignored, which is worse than none. A window
 * that has been seen nearly full is what holds it; the first agent after a
 * restart is the price of being able to see one. Outside work pays that price
 * one start at a time rather than all at once, because what it spends the
 * window on is somebody else's request and not the person's own standing rule.
 *
 * **Only the sign-in the start would spend** (`spends`: the harness its route
 * resolves to, and the account it runs as there). It read every sign-in there
 * is, and every machine lists Codex's own, which Codex's declaration makes a
 * plan: on a box that never runs Codex — not installed, or never signed in —
 * that plan stayed unknown for good, so requests from outside ran one at a time
 * for good; and a window nearly full on one sign-in held work that would run on
 * another. A sign-in this start would not run as is no plan of its.
 *
 * **A sign-in that is not on a plan is not pressure.** `pays: 'per-token'` is
 * money with a bill and no window to fill, and money is `checkBudget`'s.
 *
 * **It never suggests another account.** Which sign-in agents run as is a
 * person's decision, and a rule that moved work to a less full plan would be
 * that decision taken by a rule.
 *
 * `probing` is a request from outside running now, where one is — only the
 * window knows what runs, so it is always said and never assumed. `spends` is
 * null where nobody could say which sign-in it is: then this says nothing,
 * since the start asks the same question and fails, saying why, on the same
 * answer.
 */
export function planTooTight(
  standings: readonly PlanStanding[],
  spends: PlanChoice | null,
  of: 'outside' | 'scheduled',
  probing: string | null,
): StartSays | null {
  const spent = spends ? standings.find((one) => isChosen(one, spends)) : undefined
  if (spent?.pays !== 'plan') return null
  const worst = planOf(spent)
  if (worst && planPressure(worst.tightest.used) === 'tight') {
    const used = `${planLabel(worst)} has used ${Math.round(worst.tightest.used)}% of its ${worst.tightest.label} window`
    return {
      kind: 'held',
      because:
        of === 'outside'
          ? `${used}, and what is left of it is not a rule's to spend on a request from outside`
          : `${used}, and what is left of it is not a schedule's to spend while queue.hold_scheduled is on`,
    }
  }
  if (of !== 'outside' || spent.cannotTell === null) return null
  const said = `${planLabel(spent)} ${spent.cannotTell}`
  return probing === null
    ? {
        kind: 'probe',
        because: `${said}, so this was let through as the one request from outside that runs until its agent makes the plan known — what is unknown is not nothing, and anything else from outside waits for it`,
      }
    : {
        kind: 'waits',
        because: `${said}, and one request from outside runs at a time until it is known: this waits for ${probing}, and is looked at again, with nobody doing anything, once the plan is known or that has finished`,
      }
}

/** One of a plan's windows, as somebody who is being told about it reads it. */
export interface PlanWindowSaid {
  /** What it covers: `5h`, `7d`, `30d`. */
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
