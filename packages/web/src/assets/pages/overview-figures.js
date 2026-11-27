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

import {
  defaultsSaid,
  money,
  planPressure,
  shortClockOf,
  signInLabel,
  tokensSaid,
  untilSaid,
} from '../figures.js'
import { projectShape } from '../glance.js'
import { storesDrawn } from '../machines.js'
import { pathOf } from '../routes.js'
import {
  checksFold,
  copiesOf,
  intakeWaiting,
  omitted,
  plansOf,
  projectsOf,
  queuedHere,
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
 *
 * Counted over the machines the chips pick (`storesDrawn`), as the badges are:
 * what wants you and what works only where a machine is up, since a machine
 * that is not up said them at its last word; the queue and the checks as
 * their pages draw every machine's.
 */
export function boardOf(store, picked = null) {
  const drawn = storesDrawn(store, picked)
  const live = drawn.filter((one) => one.up)
  const tasks = drawn.flatMap((one) => rowsOf(one.store, 'tasks'))

  const wanting = live.flatMap((one) => wantsYou(one.store))
  const approvals = wanting.filter((task) => task.approval !== null && task.approval !== undefined)
  const questions = wanting.filter((task) => !approvals.includes(task) && task.question === true)
  const deciding = wanting.length - approvals.length - questions.length
  const requests = live.reduce((n, one) => n + intakeWaiting(one.store).length, 0)

  const working = live
    .flatMap((one) => rowsOf(one.store, 'tasks'))
    .filter((task) => task.state === 'working')
  const stalled = working.filter((task) => task.stalled).length
  const running = working.length - stalled

  const queue = drawn.flatMap((one) => queuedHere(one.store))
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
      n: queue.length,
      ready: kinds.ready,
      under: partsSaid(...QUEUE_KINDS.map((kind) => [kinds[kind], kind])) || 'empty',
      // Ready to start is a filled mark; anything still waiting on something is hollow.
      dots: dotsOf([
        { n: kinds.ready, tone: 'queued' },
        { n: queue.length - kinds.ready, tone: 'queued', hollow: true },
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
 * `value` is null where there is no figure — nobody wrote it down — and
 * `under` then says so (`money`'s two words). A sum over a
 * snapshot that left tasks out is a floor and says `≥`.
 */
export function moneyOf(store) {
  const partial = omitted(store, 'tasks') > 0
  const fold = spendFold(rowsOf(store, 'tasks'), partial)
  const paid = money(fold)
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
  const top = projectsOf(store)
    .map((row) => {
      const spent = spendFold(tasksIn(store, row.name), row.counts.shown < row.counts.tasks)
      const said = money(spent).said
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
 * Each is named by its sign-in (`signInLabel`), never by its harness alone:
 * four gauges that all said `claude-code` were four answers nobody could tell
 * apart. Who runs as it by default rides beside it (`defaultsSaid`), as the
 * window's Spend page marks it.
 *
 * *None reported* and *cannot tell* are two dashes with two words, and never a
 * gauge at nought. An account that pays per token has no
 * window to run out of and is not drawn.
 */
export function gaugesOf(store, now) {
  const out = []
  const rows = plansOf(store)
  for (const row of rows) {
    const who = signInLabel(row, rows)
    const marks = defaultsSaid(row.uses)
    // The harness, then the account on a line of its own: a gauge is narrower
    // than `claude-code @personal`, and a line broken anywhere else breaks the
    // name — at its hyphen, or through the account.
    const at = who.indexOf(' ')
    const named = at === -1 ? who : `${who.slice(0, at)}\n${who.slice(at + 1)}`
    if ((row.windows ?? []).length === 0) {
      if (row.pays === 'per-token') continue
      // Its line on a phone says the name and the dash's word in one.
      out.push({
        ...unread(`${who} · cannot tell`),
        key: row.id,
        label: `${who} plan`,
        marks,
        under: [`${named} · cannot tell`, marks].filter((line) => line !== '').join('\n'),
      })
      continue
    }
    for (const window of row.windows) {
      const until = untilSaid(window.resetsAt, now)
      out.push({
        key: `${row.id}:${window.label}`,
        label: `${who} ${window.label} window`,
        window: window.label,
        who,
        marks,
        share: window.used,
        said: `${Math.round(window.used)}%`,
        // Which window first, then whose, then who runs as it, then when it
        // starts over: a line each under a gauge (`overview.css`).
        under: [
          `${window.label} · ${named}`,
          marks,
          until === null ? '' : `resets ${until === 'now' ? 'now' : `in ${until}`}`,
        ]
          .filter((line) => line !== '')
          .join('\n'),
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
    marks: '',
    share: null,
    said: null,
    under: why,
    pressure: null,
  }
}

/* ── the projects ──────────────────────────────────────────────────────────── */

/**
 * A row of the grid per open project, busiest first, and under each another
 * machine's of the same name: one repository, one group.
 *
 * The counts are `ProjectRow.counts`, which count every task whether or not it
 * fitted on this page; the checks and the money are folds over the tasks that
 * did, so the money says `≥` when some did not.
 */
export function projectRowsOf(store) {
  const here = linesOf(store, null)
  const there = copiesOf(store).flatMap(({ machine, copy }) => linesOf(copy, machine))
  return [
    ...here.flatMap((line) => [line, ...there.filter((one) => one.name === line.name)]),
    ...there.filter((one) => !here.some((line) => line.name === one.name)),
  ]
}

function linesOf(store, machine) {
  return projectsOf(store)
    .sort(busiest)
    .map((row) => {
      const tasks = tasksIn(store, row.name)
      const fold = checksFold(tasks)
      const total = fold.pass + fold.fail + fold.unknown
      const spent = spendFold(tasks, row.counts.shown < row.counts.tasks)
      const paid = money(spent)
      return {
        name: row.name,
        machine,
        key: `${machine ?? ''}\u0000${row.name}`,
        href: pathOf({ view: 'project', project: row.name, machine }),
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
