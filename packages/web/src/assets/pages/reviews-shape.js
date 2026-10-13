// The reviews page's pure half: every branch offered for merge, in the order a
// person wants them — what holds each one, and what is free to merge — then the
// finished work nobody offered, then what is settled.
//
// **What holds a review is read off three facts the wire already carries**,
// and nothing here decides a state: whether its agent wants the person (the
// window's own `wantsYou`), what its required checks add up to at its head
// (the rollup, `task.checks`), and what its forge says it is (`review.state`).
// The first of them that applies is its hold, in `HOLDS`' order.
//
// **A green here is the rollup's green**, and only that: a check is drawn
// passing only where the rollup says every required check passed at the head.
// The rollup names what failed and what never ran and never names what
// passed, so a review whose checks went green is one cell that says so rather
// than a row of passes this page would have had to guess the names of — and a
// check nobody ran is hatched, never green.
//
// **Unanswered threads are not on the wire**: the window asks a forge one
// question per poll — the review's state — and a thread is a stranger's words
// besides. So the page says the threads were not read rather than drawing a
// review with none.

import { ageSaid, shortClockOf } from '../figures.js'
import { reviewMark, rowMark } from '../glyphs.js'
import { safeHref, taskPath } from '../routes.js'
import { TROUBLES } from '../trouble.js'

/**
 * What holds an open review, in the order the page says them: the first that
 * applies is its hold. Only `you` is the person's to answer in Tade; `ready`
 * is the person's to merge, on the forge.
 */
export const HOLDS = {
  you: { label: 'waiting on you', glyph: '◆', word: 'Waiting on you', tone: 'wants' },
  red: { label: 'checks failing', glyph: '✕', word: 'Checks failing', tone: 'failed' },
  draft: { label: 'draft', glyph: '◌', word: 'Still a draft', tone: 'quiet' },
  unchecked: { label: 'not checked', glyph: '—', word: 'Not checked here', tone: 'unknown' },
  ready: { label: 'ready to merge', glyph: '✓', word: 'Ready to merge', tone: 'done' },
}

/** One cell of a review's checks: a required check by name, or the rollup's one word. */
export const CELLS = {
  fail: { glyph: '✕', word: 'failing', tone: 'failed' },
  none: { glyph: '—', word: 'not run here', tone: 'unknown' },
  pass: { glyph: '✓', word: 'green', tone: 'done' },
  unread: { glyph: '—', word: 'not checked here', tone: 'unknown' },
}

/** A text tone for a chart tone: `unknown` has no colour of its own as text. */
const TEXT = { wants: 't-wants', failed: 't-failed', done: 't-done', working: 't-working' }
export const textTone = (tone) => TEXT[tone] ?? 't-quiet'

const NO_CHECKS = { state: 'unknown', failed: [], missing: [], overridden: false }
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * What holds a review, or `settled` once it is merged or closed, or null where
 * nothing was offered.
 *
 * A draft with a red check is held by the red — the red is real whatever the
 * draft says — and a draft whose checks never ran is held by being a draft,
 * since it is not asking for anything yet.
 */
export function holdOf(task) {
  const review = task.review
  if (review === null || review === undefined) return null
  if (review.state === 'merged' || review.state === 'closed') return 'settled'
  if (task.wantsYou === true) return 'you'
  const checks = task.checks ?? NO_CHECKS
  if (checks.state === 'fail') return 'red'
  if (review.state === 'draft') return 'draft'
  if (checks.state !== 'pass') return 'unchecked'
  return 'ready'
}

/**
 * A review's checks at its head, as a row of cells: every failing check by its
 * name, then every one that never ran; one green cell where all of them
 * passed; one hatched cell where nothing could say. With the line under it in
 * words and the sentence a screen reader hears instead of the cells.
 */
export function checksRowOf(checks) {
  const held = checks ?? NO_CHECKS
  const failed = held.failed ?? []
  const missing = held.missing ?? []
  const cells = [
    ...failed.map((name) => ({ key: `fail:${name}`, name, ...CELLS.fail })),
    ...missing.map((name) => ({ key: `none:${name}`, name, ...CELLS.none })),
  ]
  // A red rollup that named nothing is still red: one cell for it, unnamed.
  if (held.state === 'fail' && failed.length === 0) {
    cells.unshift({ key: 'fail:', name: 'a required check', ...CELLS.fail })
  }
  if (held.state === 'pass' && cells.length === 0) {
    cells.push({ key: 'pass', name: 'every required check', ...CELLS.pass })
  }
  if (cells.length === 0) cells.push({ key: 'unread', name: 'nothing ran', ...CELLS.unread })
  const nFailed = Math.max(failed.length, held.state === 'fail' ? 1 : 0)
  const parts = [
    nFailed > 0 ? `${nFailed} failing` : null,
    missing.length > 0 ? `${missing.length} not run here` : null,
  ].filter(Boolean)
  const line =
    parts.length > 0
      ? parts.join(' · ')
      : held.state === 'pass'
        ? 'green at its head'
        : 'nothing ran at its head here'
  const sentence = [
    failed.length > 0 ? `${failed.join(', ')} failing` : nFailed > 0 ? 'a check failing' : null,
    missing.length > 0 ? `${missing.join(', ')} not run here` : null,
    held.state === 'pass' && parts.length === 0 ? 'every required check green at its head' : null,
  ].filter(Boolean)
  return {
    state: held.state,
    cells,
    line,
    said: `Checks: ${sentence.length > 0 ? sentence.join('; ') : 'none ran at its head here'}${held.overridden ? '; a failing check was overruled' : ''}.`,
    overruled: held.overridden === true,
  }
}

/**
 * Where a review is on its forge, as the press says it: its number where the
 * URL ends in one (`/pull/412`, `/merge_requests/12`), and the safe link — or
 * null where there is no `https:` link to give (`safeHref`), which is also
 * every device not granted the links.
 */
export function forgeOf(review) {
  const href = safeHref(review?.url ?? null)
  if (href === null) return null
  const last = new URL(href).pathname.split('/').filter(Boolean).at(-1) ?? ''
  const number = /^\d+$/.test(last) ? `#${last}` : null
  return {
    href,
    number,
    // The press shows the number alone; this is what it is, for anybody listening.
    said: `Open ${number === null ? 'the review' : `review ${number}`} on its forge, in a new tab`,
  }
}

/**
 * What follows a hold's word: why it waits on you, in `deriveState`'s own
 * clause — a second wording of it would be a second state machine — and
 * otherwise what its agent is doing, which is the difference between a red
 * check somebody is on and one nobody is.
 */
function becauseOf(hold, task) {
  if (hold === 'you') return task.reason || 'its agent is waiting on you'
  return `agent ${rowMark(task).word}`
}

/** Since when the person has been waited on, or the agent last moved. */
function sinceOf(hold, task) {
  const at = hold === 'you' ? (task.approval?.since ?? task.movedAt) : task.movedAt
  return at === null || at === undefined || Number.isNaN(Date.parse(at)) ? null : at
}

/** How far a branch is from its base, in words; null where git could not say. */
export function aheadSaid(ahead, behind) {
  const parts = [
    typeof ahead === 'number' ? `${ahead} ahead` : null,
    typeof behind === 'number' && behind > 0 ? `${behind} behind` : null,
  ].filter(Boolean)
  return parts.length === 0 ? null : parts.join(' · ')
}

/**
 * One review, as a card draws it: whose and what, what holds it and why, its
 * checks as cells, its branch, how long it has waited — counted against the
 * page's clock, which is the server's last word while the stream is not live —
 * and where it is on its forge.
 */
export function reviewOf(task, asOf, frozen = false) {
  const hold = holdOf(task)
  const checks = checksRowOf(task.checks)
  const since = sinceOf(hold, task)
  const waitedSaid = ageSaid(since, asOf, frozen)
  const kind = HOLDS[hold] ?? null
  return {
    id: task.id,
    project: task.project,
    name: task.name,
    href: taskPath(task.id),
    words: task.title?.words ?? null,
    hold,
    holdMark:
      kind === null ? reviewMark(task.review?.state ?? '') : { ...kind, tone: textTone(kind.tone) },
    because: becauseOf(hold, task),
    review: task.review?.state ?? null,
    reviewMark: reviewMark(task.review?.state ?? ''),
    forge: forgeOf(task.review),
    agent: rowMark(task),
    checks,
    branch: task.branch ?? null,
    distance: aheadSaid(task.ahead ?? null, task.behind ?? null),
    since,
    waited: since === null ? null : Math.max(0, asOf - Date.parse(since)),
    waitedSaid,
    // How long, as it is heard: a wait on you is a wait, anything else a move.
    ageLabel: waitedSaid === null ? null : `${hold === 'you' ? 'waiting' : 'moved'} ${waitedSaid}`,
    asksYou: hold === 'you',
  }
}

/** Longest wait first, and a name to break a tie, so the order never shuffles under a thumb. */
const longestFirst = (a, b) => (b.waited ?? -1) - (a.waited ?? -1) || byText(a.id, b.id)
/** Newest first, for what is settled. */
const newestFirst = (a, b) => (a.waited ?? Infinity) - (b.waited ?? Infinity) || byText(a.id, b.id)

const BLOCKED = ['red', 'draft', 'unchecked']

/**
 * The whole page: the open reviews by what holds them, each group longest
 * wait first; the finished work nobody offered; what is merged or closed; and
 * the figures the lead draws.
 */
export function reviewsPage(offered, unoffered, asOf, frozen = false) {
  const made = offered.map((task) => reviewOf(task, asOf, frozen))
  const of = (hold) => made.filter((one) => one.hold === hold).sort(longestFirst)
  const you = of('you')
  const blocked = BLOCKED.flatMap(of)
  const ready = of('ready')
  const settled = made.filter((one) => one.hold === 'settled').sort(newestFirst)
  const quiet = unoffered.map((task) => reviewOf(task, asOf, frozen)).sort(longestFirst)
  const counts = Object.fromEntries(Object.keys(HOLDS).map((key) => [key, of(key).length]))
  const open = you.length + blocked.length + ready.length
  const merged = settled.filter((one) => one.review === 'merged').length
  return {
    total: made.length + quiet.length,
    open,
    counts,
    parts: Object.entries(HOLDS).map(([key, one]) => ({
      key,
      label: one.label,
      tone: one.tone,
      n: counts[key],
    })),
    held: open - ready.length,
    you,
    blocked,
    ready,
    unoffered: quiet,
    settled,
    merged,
    closed: settled.length - merged,
  }
}

/**
 * The bar's word: what most wants the person — what waits on them, in violet;
 * else what is held, in red where a check is; else what is free to merge.
 */
export function figureSaid(page) {
  if (page === null || page.total === 0) return { word: '', tone: null }
  if (page.counts.you > 0) return { word: `${page.counts.you} waiting on you`, tone: 't-wants' }
  if (page.counts.red > 0) return { word: `${page.counts.red} failing`, tone: 't-failed' }
  if (page.counts.ready > 0) return { word: `${page.counts.ready} ready`, tone: 't-done' }
  if (page.open > 0) return { word: `${page.open} open`, tone: null }
  const quiet = page.unoffered.length
  return { word: quiet > 0 ? `${quiet} not offered` : '', tone: null }
}

/** The lead's sentence for the stack, read instead of the bar. */
export function leadSaid(page) {
  if (page.open === 0) return 'Nothing is open for review.'
  const parts = page.parts.filter((one) => one.n > 0).map((one) => `${one.n} ${one.label}`)
  return `${plural(page.open, 'open review')}: ${parts.join(', ')}.`
}

/** The lead's line under the hero: how many are held, or that none are. */
export function heldSaid(page) {
  if (page.open === 0) return 'nothing is offered for merge'
  if (page.held === 0) return 'nothing holds any of them'
  return `${page.held} held · ${page.counts.ready} free to merge`
}

/** The two stages either side of open: what was never offered, and what is settled. */
export function stagesOf(page) {
  return {
    before: { n: page.unoffered.length, under: 'commits, no review' },
    after: {
      n: page.merged,
      under: page.closed > 0 ? `${page.closed} closed` : 'merged',
    },
  }
}

/** A quiet row's line: the branch, how far ahead, and its checks in words. */
export function rowLine(one) {
  return [one.branch, one.distance, `checks ${one.checks.line}`].filter(Boolean).join(' · ')
}

/** The fold's press: what is folded, and that pressing shows it. */
export function settledSaid(n, open) {
  return `${open ? 'Hide' : 'Show'} ${plural(n, 'merged or closed review', 'merged or closed reviews')}`
}

/** What this device was not sent of the tasks, said rather than cut in silence; null where nothing. */
export function omittedSaid(omitted) {
  if (!(omitted > 0)) return null
  return `${plural(omitted, 'task')} not sent to this device, so any review of ${omitted === 1 ? 'it' : 'theirs'} is not here`
}

/** A region's state, as `stateBoxIn` takes it, with this page's mark unless it says. */
function stateOf(kind, title, line, icon = 'reviews') {
  return { kind, icon, title, line }
}

/**
 * The page's own state, where there is nothing else to draw: nothing yet
 * while the first snapshot is coming (a skeleton says that), could not reach
 * the machine before one ever came, or nothing offered and nothing waiting to
 * be — four answers, and never a blank. Null where the page has reviews.
 */
export function wholeOf(had, shut, page) {
  if (!had) {
    return shut ? stateOf('error', TROUBLES.offline.title, TROUBLES.offline.fix, 'alert') : null
  }
  if (page !== null && page.total > 0) return null
  return stateOf(
    'empty',
    'No reviews',
    'When an agent offers its branch for merge, it is drawn here with what holds it.',
  )
}

/**
 * The line under the lead: the moment a page that is not live was true at,
 * and what this device was not sent — or null where it has nothing to say.
 */
export function leftSaid(frozen, asOf, omitted) {
  const parts = [
    frozen ? `as of ${shortClockOf(new Date(asOf).toISOString())}` : null,
    omittedSaid(omitted),
  ].filter(Boolean)
  return parts.length === 0 ? null : parts.join(' · ')
}
