// The overview's figures: what the board, the money, the plan windows and the
// projects say, as pure folds over the store — so every count and every word
// on the landing screen is a test rather than a picture (`test/overview.test.ts`).
//
// **Nothing here derives a state.** A task wants you because the window's
// `markOf` said so (`wantsYou`), it is working because `deriveState` said so,
// queued work stands where `queueStateOf` put it, and a plan window's pressure
// is `planPressure`'s. This only counts what came off the wire, groups it the
// way the board draws it, and words it — with a dash and *which* dash wherever
// a figure could not be read, never a nought.
//
// Nothing here touches the DOM.

import { mayFor } from '../access.js'
import { money, planPressure, shortClockOf, tokensSaid, untilSaid } from '../figures.js'
import { projectShape } from '../glance.js'
import { pathOf } from '../routes.js'
import {
  checksFold,
  intakeWaiting,
  omitted,
  plansOf,
  projectsOf,
  queueIn,
  rowsOf,
  spendFold,
  spendSince,
  tasksIn,
  wantsYou,
} from '../store.js'

/** The most marks a cell draws one by one; past it the last place says how many more. */
export const DOTS = 10

/** How many projects the money names, largest first: the rest are a row each under Projects. */
export const TOP = 3

/* ── the board: what wants you, what works, what waits, and the checks ────── */

/**
 * The four cells across the top, each a figure, the marks under it and the
 * line that breaks it down.
 *
 * `wants` is the window's *needs you* and nothing wider, so the figure here is
 * the badge on the menu's Overview entry; what else is waiting on a person —
 * a request in the inbox — is said in its line, not added to its figure.
 */
export function boardOf(store) {
  const tasks = rowsOf(store, 'tasks')

  const wanting = wantsYou(store)
  const approvals = wanting.filter((task) => task.approval !== null && task.approval !== undefined)
  const questions = wanting.filter((task) => !approvals.includes(task) && task.question === true)
  const deciding = wanting.length - approvals.length - questions.length
  const requests = intakeWaiting(store).length

  const working = tasks.filter((task) => task.state === 'working')
  const stalled = working.filter((task) => task.stalled).length
  const running = working.length - stalled

  const queue = queueIn(store, null)
  const away = omitted(store, 'queue')
  const kinds = Object.fromEntries(QUEUE_KINDS.map((kind) => [kind, 0]))
  for (const row of queue) {
    const kind = row.state?.kind
    if (kind in kinds) kinds[kind] += 1
  }

  const checks = checksFold(tasks)
  const ran = checks.pass + checks.fail + checks.unknown

  return {
    wants: {
      n: wanting.length,
      approvals: approvals.length,
      questions: questions.length,
      deciding,
      requests,
      under:
        partsSaid(
          [approvals.length, 'approval', 'approvals'],
          [questions.length, 'question', 'questions'],
          [deciding, 'to decide'],
          [requests, 'request', 'requests'],
        ) || 'nothing waiting',
      dots: dotsOf([{ n: wanting.length, tone: 'wants' }]),
    },
    working: {
      n: running,
      stalled,
      under: stalled > 0 ? `${stalled} stalled` : running > 0 ? 'running' : 'idle',
      // A stalled agent is still one of the working, gone quiet: a hollow mark.
      dots: dotsOf([
        { n: running, tone: 'working' },
        { n: stalled, tone: 'working', hollow: true },
      ]),
    },
    queue: {
      n: queue.length + away,
      ready: kinds.ready,
      under:
        partsSaid(...QUEUE_KINDS.map((kind) => [kinds[kind], kind]), [away, 'not on this page']) ||
        'empty',
      // Ready to start is a filled mark; anything still waiting on something is hollow.
      dots: dotsOf([
        { n: kinds.ready, tone: 'queued' },
        { n: queue.length - kinds.ready + away, tone: 'queued', hollow: true },
      ]),
    },
    checks: {
      n: checks.fail,
      pass: checks.pass,
      unknown: checks.unknown,
      under:
        ran === 0
          ? 'no work'
          : checks.fail === 0 && checks.unknown === 0
            ? 'all green'
            : partsSaid([checks.pass, 'green'], [checks.unknown, 'not run']) || 'none green',
      dots: dotsOf([
        { n: checks.fail, tone: 'failed' },
        { n: checks.pass, tone: 'done' },
        { n: checks.unknown, tone: 'unknown' },
      ]),
    },
  }
}

/** Queued work's standings, in the order a reader asks about them. */
const QUEUE_KINDS = ['ready', 'waiting', 'held', 'scheduled', 'paused']

/**
 * One mark per thing, in the order the parts are given, and how many did not
 * fit: `{ dots: [{ tone, hollow }], more }`.
 *
 * Past `most` the last place is the count of the rest rather than a mark, so a
 * cell never grows a second line of dots and never pretends twelve is all.
 */
export function dotsOf(parts, most = DOTS) {
  const all = []
  for (const part of parts) {
    const n = Number.isFinite(part.n) ? Math.max(0, part.n) : 0
    for (let at = 0; at < n; at += 1) all.push({ tone: part.tone, hollow: part.hollow === true })
  }
  if (all.length <= most) return { dots: all, more: 0 }
  return { dots: all.slice(0, most - 1), more: all.length - (most - 1) }
}

/** `2 approvals · 1 question`, leaving out what is nought. */
function partsSaid(...parts) {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : (many ?? one)}`)
    .join(' · ')
}

/* ── the money ─────────────────────────────────────────────────────────────── */

/**
 * What the work cost, since when, and where most of it went.
 *
 * `value` is null where there is no figure — not granted, or nobody wrote it
 * down — and `under` then carries which (`money`'s two words). A sum over a
 * snapshot that left tasks out is a floor and says `≥`.
 */
export function moneyOf(store) {
  const granted = mayFor(store, 'tasks.spend')
  const partial = omitted(store, 'tasks') > 0
  const fold = spendFold(rowsOf(store, 'tasks'), partial)
  const paid = money(fold, granted)
  const known = paid.said !== '—'
  const since = spendSince(store)
  const toks = tokensSaid(fold)
  const under = known
    ? [
        since === null ? null : `since ${shortClockOf(since)}`,
        toks === null ? null : `${toks.said} tokens`,
      ]
        .filter(Boolean)
        .join(' · ')
    : paid.why
  const top = granted
    ? projectsOf(store)
        .map((row) => {
          const spent = spendFold(tasksIn(store, row.name), row.counts.shown < row.counts.tasks)
          const said = money(spent, granted).said
          return {
            key: row.name,
            label: row.name,
            value: spent.hasCost && spent.usd > 0 ? spent.usd : null,
            said: `${spent.partial ? '≥' : ''}${said}`,
            href: pathOf({ view: 'project', project: row.name }),
            // Money is not a state: a quiet bar, never one in Tade's own amber.
            tone: 'queued',
          }
        })
        .filter((one) => one.value !== null)
        .sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : 1))
        .slice(0, TOP)
    : []
  return {
    value: known ? `${partial ? '≥' : ''}${paid.said}` : null,
    under,
    top,
  }
}

/* ── the plan windows ──────────────────────────────────────────────────────── */

/**
 * Every plan window any account reported, fullest first — the one that runs
 * out first is the one that stops the work — each as a gauge's figures.
 *
 * *Not granted*, *none reported* and *cannot tell* are three dashes with three
 * words, and never a gauge at nought. An account that pays per token has no
 * window to run out of and is not drawn.
 */
export function gaugesOf(store, now) {
  if (!mayFor(store, 'plans')) return [unread('not granted to this device')]
  const out = []
  for (const row of plansOf(store)) {
    if ((row.windows ?? []).length === 0) {
      if (row.pays === 'per-token') continue
      out.push({
        ...unread(`${row.harness} · cannot tell`),
        key: row.id,
        label: `${row.harness} plan`,
        window: null,
        who: row.harness,
      })
      continue
    }
    for (const window of row.windows) {
      const until = untilSaid(window.resetsAt, now)
      out.push({
        key: `${row.id}:${window.label}`,
        label: `${row.harness} ${window.label} window`,
        window: window.label,
        who: row.harness,
        share: window.used,
        said: `${Math.round(window.used)}%`,
        // Which window first, then whose, then when it starts over: two lines
        // under a gauge (`overview.css`), so no gauge's words wrap differently.
        under: `${window.label} · ${row.harness}${until === null ? '' : `\nresets ${until === 'now' ? 'now' : `in ${until}`}`}`,
        pressure: planPressure(window.used),
      })
    }
  }
  out.sort((a, b) => (b.share ?? -1) - (a.share ?? -1))
  return out.length > 0 ? out : [unread('none reported')]
}

/**
 * A gauge with nothing in it, and the words for why. A phone's line names a
 * window by `window` and `who`; with no window, `who` is the why.
 */
function unread(why) {
  return {
    key: 'unread',
    label: 'Plan',
    window: null,
    who: why,
    share: null,
    said: null,
    under: why,
    pressure: null,
  }
}

/* ── the projects ──────────────────────────────────────────────────────────── */

/**
 * Every open project as one row of the grid, busiest first: the shape of its
 * work, its three counts, its checks and its money.
 *
 * The counts are `ProjectRow.counts`, which count every task whether or not it
 * fitted on this page; the checks and the money are folds over the tasks that
 * did, so the money says `≥` when some did not.
 */
export function projectRowsOf(store) {
  const granted = mayFor(store, 'tasks.spend')
  return projectsOf(store)
    .sort(busiest)
    .map((row) => {
      const tasks = tasksIn(store, row.name)
      const fold = checksFold(tasks)
      const total = fold.pass + fold.fail + fold.unknown
      const spent = spendFold(tasks, row.counts.shown < row.counts.tasks)
      const paid = money(spent, granted)
      return {
        name: row.name,
        href: pathOf({ view: 'project', project: row.name }),
        shape: projectShape(row.counts),
        wants: row.counts.wantsYou,
        working: row.counts.working,
        queued: row.counts.queued,
        checks: {
          parts: [fold.pass, fold.fail, fold.unknown],
          said:
            total === 0
              ? 'no work'
              : fold.fail > 0
                ? `${fold.fail} red`
                : fold.unknown === 0
                  ? 'all green'
                  : `${fold.pass}/${total} green`,
          tone: fold.fail > 0 ? 't-failed' : total > 0 && fold.unknown === 0 ? 't-done' : '',
        },
        spend: paid.said === '—' ? null : `${spent.partial ? '≥' : ''}${paid.said}`,
        spendWhy: paid.said === '—' ? paid.why : '',
      }
    })
}

/** What wants you, then what works, then by name. */
const busiest = (a, b) =>
  b.counts.wantsYou - a.counts.wantsYou ||
  b.counts.working - a.counts.working ||
  (a.name < b.name ? -1 : 1)

/** The tasks whose agent failed: the window's own mark, red, and somebody's to look at. */
export function failedOf(store) {
  return rowsOf(store, 'tasks').filter((task) => task.mark === 'failed')
}

/** The tasks at work, for the list a phone has instead of the side. */
export function workingOf(store) {
  return rowsOf(store, 'tasks').filter((task) => task.state === 'working')
}
