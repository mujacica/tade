// The eight screens that are a list or a table: the queue, the checks, the
// reviews, the money, the findings, the notes, this device, and pairing one.
//
// Two of these are the ones that most have to not lie, and they are the reason
// this file is longer than it looks.
//
// **The money.** `usdOnPlan` goes below a rule and in **no** total, because a
// subscription paid a flat fee and nobody was charged those turns; `~` marks
// any bucket with an estimate in it; `≥` appears wherever some tokens had no
// rate, or wherever the snapshot left tasks out, because a sum over what
// arrived is a floor; and `—` is nobody wrote it down, never a nought. There are
// no period buttons on this page: the projection carries one figure per task
// and not a series, so *today* is a question this data cannot answer and a
// control offering it would be a lie with a tab on it.
//
// **The checks.** A rollup is what a run *here* adds up to, so `unknown` is
// first-class and is never folded into a pass. A check that cannot run here
// keeps its row.
//
// The tables are the only things in the design allowed to be wider than the
// viewport, each in its own `overflow-x` container, and each is a real `<table>`
// with a `<caption>` and `<th scope>`.

import { classOn, el, empty, into, keyed, textIn } from './dom.js'
import {
  ageSaid,
  count,
  money,
  onPlan,
  planBar,
  sinceSaid,
  tokensSaid,
  untilSaid,
} from './figures.js'
import { checkMark } from './glyphs.js'
import { MORE } from './routes.js'
import {
  createFindingRow,
  createNoteRow,
  createQueueRow,
  createReviewRow,
  dl,
  dlIn,
  fillFindingRow,
  fillNoteRow,
  fillQueueRow,
  fillReviewRow,
  sayIn,
  section,
} from './rows.js'
import {
  checksFold,
  checksWord,
  findingsOf,
  notesOf,
  omitted,
  plansOf,
  projectsOf,
  queueIn,
  reviewsOf,
  rowsOf,
  spendFold,
  spendSince,
  tasksIn,
} from './store.js'

/**
 * What an empty list says, which is **two different nothings**.
 *
 * A collection with no rows because there are none, and one with no rows
 * because this device was not granted them, are different facts — and the
 * second carries its count, because *there are forty-one notes and you may not
 * read them from here* is the honest shape of a read scope. A nought in its
 * place reads as "you have none", which is a page answering a question nobody
 * asked it.
 */
export function nothingSaid(may, total, nothing) {
  if (may) return nothing
  return total === 0
    ? 'not granted to this device'
    : `${total} here, and this device was not granted them`
}

/* ── the queue ─────────────────────────────────────────────────────────────── */

/**
 * Everything waiting, grouped by project, with **what each piece waits on drawn
 * as an indent and a connector**.
 *
 * Parked work stays in the list. A task with a `start` is queued work, and
 * hiding one because somebody parked it would leave them with nothing to pick
 * back up.
 */
export function queueScreen() {
  const node = el('div')
  const made = section('QUEUE', { top: true })
  const groups = el('div')
  const none = empty('nothing queued')
  into(made.body, groups, none)
  const left = el('p', { class: 'unknown' })
  into(node, made.node, left)

  return {
    node,
    update(view) {
      const rows = queueIn(view.store, null)
      textIn(made.figure, count(rows.length))
      made.figure.setAttribute('aria-label', `${rows.length} queued`)
      none.hidden = rows.length > 0
      const projects = [...new Set(rows.map((row) => row.project))].sort()
      keyed(
        groups,
        projects,
        (name) => name,
        createQueueGroup,
        (one, name) => fillQueueGroup(one, name, rows, view),
      )
      const n = omitted(view.store, 'queue')
      textIn(left, n === 0 ? '' : `${n} more pieces of queued work are not on this page`)
      left.hidden = n === 0
    },
  }
}

function createQueueGroup() {
  const node = el('div', { class: 'section' })
  const head = el('h3', { class: 'aside' })
  const list = el('ul', { class: 'queue' })
  const said = el('p', { class: 'unknown' })
  return into(node, head, list, said)
}

function fillQueueGroup(node, name, rows, view) {
  const [head, list, said] = node.children
  textIn(head, name)
  const mine = rows.filter((row) => row.project === name)
  keyed(
    list,
    mine,
    (row) => row.task,
    createQueueRow,
    (one, row) => fillQueueRow(one, row, { ...view, project: name }),
  )
  // A whole project held at once is a different fact from four rows that each
  // happen to be paused, and it is the one a person can undo in one act.
  const all = mine.every((row) => row.state.kind === 'paused' && row.state.all)
  textIn(said, all && mine.length > 0 ? 'this project’s queue is paused' : '')
  said.hidden = !(all && mine.length > 0)
}

/* ── the checks ────────────────────────────────────────────────────────────── */

export function checksScreen() {
  const node = el('div')
  const made = section('CHECKS', { top: true })
  // **A region that scrolls has to be reachable by a keyboard.** A table wider
  // than a phone is the one thing in this design allowed to scroll sideways,
  // and a container nobody can focus is one a keyboard cannot move.
  const wrap = el('div', {
    class: 'scrolls',
    attrs: { tabindex: '0', role: 'region', 'aria-label': 'Checks, scrollable' },
  })
  const table = el('table')
  const caption = el('caption', {
    text: 'What a run on this machine added up to, per task. A check nobody ran here is not a check that passed.',
  })
  const head = el('thead')
  const headRow = el('tr')
  for (const [name, klass] of [
    ['Project', ''],
    ['Task', ''],
    ['Checks', ''],
    ['Red', ''],
    ['Not run here', ''],
  ]) {
    into(headRow, el('th', { class: klass, text: name, attrs: { scope: 'col' } }))
  }
  into(head, headRow)
  const body = el('tbody')
  into(table, caption, head, body)
  into(wrap, table)
  const none = empty('no tasks to check')
  into(made.body, wrap, none)
  into(node, made.node)

  return {
    node,
    update(view) {
      const tasks = rowsOf(view.store, 'tasks')
      const fold = checksFold(tasks)
      const mark = checkMark(checksWord(fold))
      textIn(made.figure, mark.word)
      none.hidden = tasks.length > 0
      wrap.hidden = tasks.length === 0
      keyed(body, tasks, (task) => task.id, createCheckRow, fillCheckRow)
    },
  }
}

function createCheckRow() {
  const node = el('tr')
  for (let at = 0; at < 5; at += 1) into(node, el('td'))
  return node
}

function fillCheckRow(node, task) {
  const cells = node.children
  textIn(cells[0], task.project)
  textIn(cells[1], task.name)
  const mark = checkMark(task.checks.state)
  textIn(cells[2], `${mark.glyph} ${mark.word}${task.checks.overridden ? ' · overruled' : ''}`)
  cells[2].setAttribute('aria-label', mark.word)
  textIn(cells[3], task.checks.failed.join(', ') || '—')
  textIn(cells[4], task.checks.missing.join(', ') || '—')
}

/* ── the reviews ───────────────────────────────────────────────────────────── */

/**
 * Branches offered for merge, and then **the work that is finished and nobody
 * asked about** — which is the list worth having, and is invisible on a page
 * that shows only what a forge knows.
 *
 * Threads and comments are not here. Comments are attacker-controlled text, and
 * rendering them read-only on a phone is defensible and is still a scope
 * decision somebody has to take rather than one a convenient route takes for
 * them.
 */
export function reviewsScreen() {
  const node = el('div')
  const open = section('REVIEWS', { top: true })
  const openList = el('ul', { class: 'rows' })
  const noOpen = empty('nothing is offered for merge')
  into(open.body, openList, noOpen)
  const quiet = section('NO REVIEW')
  const quietList = el('ul', { class: 'rows' })
  const noQuiet = empty('nothing is waiting to be offered')
  into(quiet.body, quietList, noQuiet)
  // Without the grant the link to each review is withheld, so **every** task
  // reads as unoffered. Said before the lists rather than left to look like a
  // repository where nobody reviews anything.
  const scope = el('p', { class: 'caveat' })
  into(node, scope, open.node, quiet.node)

  return {
    node,
    update(view) {
      scope.hidden = view.may.reviews
      textIn(
        scope,
        view.may.reviews
          ? ''
          : 'This device was not granted the reviews, so nothing here can say whether a branch was offered for merge.',
      )
      const { offered, unoffered } = reviewsOf(view.store)
      textIn(open.figure, count(offered.length))
      open.figure.setAttribute('aria-label', `${offered.length} offered for merge`)
      noOpen.hidden = offered.length > 0
      keyed(
        openList,
        offered,
        (task) => task.id,
        createReviewRow,
        (one, task) => fillReviewRow(one, task, view),
      )
      textIn(quiet.figure, count(unoffered.length))
      quiet.figure.setAttribute('aria-label', `${unoffered.length} not offered`)
      noQuiet.hidden = unoffered.length > 0
      keyed(
        quietList,
        unoffered,
        (task) => task.id,
        createReviewRow,
        (one, task) => fillReviewRow(one, task, view),
      )
    },
  }
}

/* ── the money ─────────────────────────────────────────────────────────────── */

export function spendScreen() {
  const node = el('div')
  const made = section('SPEND', { top: true })
  const big = el('p', { class: 'big' })
  const under = el('p', { class: 'big-under' })
  const kinds = dl()
  const outside = el('div', { class: 'outside' })
  const planWhy = el('p', { class: 'aside' })
  const planSaid = el('p', { class: 'num big-under' })
  const planNot = el('p', {
    class: 'unknown',
    text: 'not in the total — a subscription already paid for these',
  })
  into(outside, planWhy, planSaid, planNot)
  // The caveats are built once and shown or hidden, so a figure somebody is
  // reading does not move down the page because a new one appeared under it.
  const scope = el('p', {
    class: 'caveat',
    text: 'This device was not granted what the work costs, so every figure here is a dash. What each device may read is decided at the machine, and the Devices screen lists what this one was given.',
  })
  const floor = el('p', {
    class: 'unknown',
    text: '— some tasks are not on this page, so this is a floor',
  })
  const noMoney = el('p', { class: 'unknown' })
  const unrated = el('p', {
    class: 'unknown',
    text: '— some of these tokens ran on a model no rate here knows',
  })
  // **The period, said rather than denied.** The sentence that used to be here
  // said this was not a figure for a day — and it is one: the window folds
  // spend from its own midnight, so without this a phone reads a dash on a
  // task that cost forty dollars yesterday as *not recorded*.
  const covers = el('p', { class: 'unknown' })
  const caveats = { scope, floor, noMoney, unrated, covers }
  into(made.body, big, under, kinds, outside, scope, floor, noMoney, unrated, covers)

  const plans = section('PLAN WINDOWS')
  const planList = el('ul', { class: 'rows' })
  const noPlans = empty('no harness here reported a plan window')
  into(plans.body, planList, noPlans)

  const by = section('BY PROJECT')
  const wrap = el('div', {
    class: 'scrolls',
    attrs: { tabindex: '0', role: 'region', 'aria-label': 'Spend by project, scrollable' },
  })
  const table = el('table')
  const caption = el('caption', { text: 'Folded over the tasks on this page.' })
  const headRow = el('tr')
  for (const [name, klass] of [
    ['Project', ''],
    ['Money', 'figure'],
    ['Tokens', 'figure'],
    ['On a plan', 'figure'],
  ]) {
    into(headRow, el('th', { class: klass, text: name, attrs: { scope: 'col' } }))
  }
  const body = el('tbody')
  into(table, caption, into(el('thead'), headRow), body)
  into(wrap, table)
  into(by.body, wrap)
  into(node, made.node, plans.node, by.node)

  return {
    node,
    update(view) {
      const tasks = rowsOf(view.store, 'tasks')
      const partial = omitted(view.store, 'tasks') > 0
      const fold = spendFold(tasks, partial)
      const paid = money(fold, view.may.spend)
      textIn(big, paid.said === '—' ? '—' : `${partial ? '≥' : ''}${paid.said}`)
      textIn(under, paid.said === '—' ? paid.why : 'billed')
      const tokens = tokensSaid(fold)
      dlIn(kinds, [
        ['exact', fold.usdExact > 0 ? `$${fold.usdExact.toFixed(2)}` : null],
        ['estimated', fold.usdEstimated > 0 ? `~$${fold.usdEstimated.toFixed(2)}` : null],
        ['tokens', tokens === null ? null : tokens.said],
        ['unpriced', tokens === null || tokens.unpriced === '' ? null : tokens.unpriced],
      ])
      planEquivalentIn({ outside, planWhy, planSaid, planNot }, fold)
      caveatsIn(caveats, fold, view.may.spend, spendSince(view.store))
      const rows = plansOf(view.store)
      textIn(plans.figure, count(rows.length))
      noPlans.hidden = rows.length > 0
      textIn(
        noPlans,
        nothingSaid(
          view.may.spend,
          omitted(view.store, 'plans'),
          'no harness here reported a plan window',
        ),
      )
      keyed(
        planList,
        rows,
        (row) => row.id,
        createPlanRow,
        (one, row) => fillPlanRow(one, row, view),
      )
      const names = projectsOf(view.store)
      keyed(
        body,
        names,
        (row) => row.name,
        createSpendRow,
        (one, row) => fillSpendRow(one, row, view),
      )
    },
  }
}

/**
 * What a subscription's turns would have cost at list — **below a rule, in no
 * total, and labelled as what it is.**
 *
 * `≥` whenever some of those tokens ran on a model no rate here knows, because
 * the figure is then a floor and drawing it as a total would simply be wrong.
 */
function planEquivalentIn(made, fold) {
  const plan = onPlan(fold)
  made.outside.hidden = plan === null
  if (plan === null) return
  textIn(made.planWhy, plan.why)
  textIn(made.planSaid, plan.said)
}

/**
 * Every way this figure is incomplete, said beside it rather than smoothed.
 *
 * Shown and hidden rather than built and thrown away, so a figure somebody is
 * reading does not move down the page because a caveat appeared under it.
 */
function caveatsIn(made, fold, granted, since) {
  // The sentence the two-word column cannot carry, said once where there is
  // room: a dash here is about this device's reach and not about the work.
  made.scope.hidden = granted
  for (const one of ['floor', 'noMoney', 'unrated', 'covers']) made[one].hidden = !granted
  if (!granted) return
  // Null where nothing has been folded yet, which is `unknown` and is said by
  // saying nothing rather than by naming a date in 1970.
  sayIn(made.covers, sinceSaid(since))
  made.floor.hidden = !fold.partial
  sayIn(
    made.noMoney,
    fold.unknown > 0 ? `— ${fold.unknown} tasks here reported no money at all` : null,
  )
  made.unrated.hidden = fold.tokensUnpriced === 0
}

function createPlanRow() {
  const node = el('li')
  const body = el('div')
  const name = el('span', { class: 'name' })
  const meter = el('span', { class: 'meter' })
  const under = el('span', { class: 'under' })
  into(body, el('span', { class: 'glyph', text: '' }), name, meter, under)
  return into(node, body)
}

/**
 * One account's plan windows.
 *
 * **A plan is not money**: what is drawn is the share of a window that is used
 * up, which is the service's own number, and `resets in` beside it. A harness
 * that said nothing says `cannot tell` in its own words — the projection
 * carries that sentence, so this does not invent one.
 */
function fillPlanRow(node, plan, view) {
  const [body] = node.children
  const [, name, meter, under] = body.children
  textIn(name, `${plan.harness}${plan.account === null ? '' : ` · ${plan.account.words}`}`)
  if (plan.cannotTell !== null && plan.cannotTell !== undefined) {
    textIn(meter, '—')
    textIn(under, plan.cannotTell)
    classOn(meter, 'is-fine', false)
    return
  }
  if (plan.pays === 'per-token') {
    textIn(meter, '')
    textIn(under, 'per-token — no window')
    return
  }
  const lines = []
  let worst = 'fine'
  for (const window of plan.windows) {
    const bar = planBar(window.used)
    if (bar.pressure === 'tight' || (bar.pressure === 'warm' && worst === 'fine')) {
      worst = bar.pressure
    }
    const resets = untilSaid(window.resetsAt, view.asOf)
    lines.push(
      `${window.label} ${bar.bar} ${bar.said}${resets === null ? ' · no reset said' : ` · resets in ${resets}`}`,
    )
  }
  textIn(meter, plan.windows.length === 0 ? '—' : '')
  textIn(under, lines.join('\n') || 'no window was reported')
  for (const one of ['is-fine', 'is-warm', 'is-tight']) classOn(under, one, one === `is-${worst}`)
  classOn(under, 'meter', lines.length > 0)
}

function createSpendRow() {
  const node = el('tr')
  for (let at = 0; at < 4; at += 1) {
    into(node, el('td', { class: at === 0 ? '' : 'figure' }))
  }
  return node
}

function fillSpendRow(node, project, view) {
  const cells = node.children
  const tasks = tasksIn(view.store, project.name)
  const fold = spendFold(tasks, omitted(view.store, 'tasks') > 0)
  const paid = money(fold, view.may.spend)
  textIn(cells[0], project.name)
  textIn(cells[1], paid.said === '—' ? '—' : `${fold.partial ? '≥' : ''}${paid.said}`)
  cells[1].setAttribute('aria-label', paid.said === '—' ? paid.why : paid.said)
  const tokens = tokensSaid(fold)
  textIn(cells[2], tokens === null ? '—' : tokens.said)
  const plan = onPlan(fold)
  textIn(cells[3], plan === null ? '—' : plan.said)
}

/* ── the findings ──────────────────────────────────────────────────────────── */

/**
 * Open findings, and whose move each one is.
 *
 * **A finding is material and not a verdict.** A probability is drawn beside the
 * question rather than as the answer to it, and no sentence here says a change
 * is wrong — it says a question was asked about it, who has answered, and
 * whether anybody has read it yet.
 */
export function findingsScreen() {
  const node = el('div')
  const made = section('FINDINGS', { top: true })
  const list = el('ul', { class: 'rows' })
  const none = empty('no findings')
  into(made.body, list, none)
  into(
    node,
    made.node,
    el('p', {
      class: 'caveat',
      text: 'A judge answers questions; it never decides. A probability is not a verdict, and the account under one is the agent’s own testimony.',
    }),
  )

  return {
    node,
    update(view) {
      const rows = findingsOf(view.store).sort(
        (a, b) => whose(a) - whose(b) || b.probability - a.probability,
      )
      textIn(made.figure, count(rows.length))
      made.figure.setAttribute('aria-label', `${rows.length} findings`)
      none.hidden = rows.length > 0
      textIn(none, nothingSaid(view.may.findings, omitted(view.store, 'findings'), 'no findings'))
      keyed(
        list,
        rows,
        (row) => row.key,
        createFindingRow,
        (one, row) => fillFindingRow(one, row, view),
      )
    },
  }
}

/** Waiting on a person first, then on an agent, then done with. */
function whose(finding) {
  if (finding.verdict !== null && finding.verdict !== undefined) return 2
  return finding.accounted ? 0 : 1
}

/* ── the notes ─────────────────────────────────────────────────────────────── */

/**
 * The notes, newest first and **verbatim**.
 *
 * Never lowercased, never reworded, never summarised. This is the one thing on
 * the page that Tade was *told* rather than derived, and it is rendered with
 * `textContent` and in the shape it was typed.
 */
export function notesScreen() {
  const node = el('div')
  const made = section('NOTES', { top: true })
  const list = el('ul', { class: 'rows' })
  const none = empty('nothing written down')
  into(made.body, list, none)
  const left = el('p', { class: 'unknown' })
  into(node, made.node, left)

  return {
    node,
    update(view) {
      const rows = notesOf(view.store)
      textIn(made.figure, count(rows.length))
      made.figure.setAttribute('aria-label', `${rows.length} notes`)
      none.hidden = rows.length > 0
      keyed(
        list,
        rows,
        (row) => row.id,
        createNoteRow,
        (one, row) => fillNoteRow(one, row, view),
      )
      textIn(
        none,
        nothingSaid(view.may.notes, omitted(view.store, 'notes'), 'nothing written down'),
      )
      const n = omitted(view.store, 'notes')
      textIn(left, n === 0 || !view.may.notes ? '' : `${n} older notes are not on this page`)
      left.hidden = n === 0 || !view.may.notes
    },
  }
}

/* ── this device, and the others ───────────────────────────────────────────── */

/**
 * What this browser's own credential is, and every device that has been let in.
 *
 * **The whole list is here on purpose.** Nothing on this machine is contained —
 * an agent runs as you and can append to the paired-device list — so seeing
 * every device there is, is the mitigation, and disconnecting one needs no
 * network at all. That is said here because this is the page somebody reads it
 * on, and it is the page's own sentence about its own list rather than a second
 * copy of the domain's.
 */
export function devicesScreen(ctx) {
  const node = el('div')
  const mine = section('THIS DEVICE', { top: true })
  const facts = dl()
  const noSession = el('p', { class: 'unknown' })
  const out = el('button', { class: 'press quietly', text: 'Sign this device out' })
  const said = el('p', { attrs: { role: 'status' } })
  into(mine.body, facts, noSession, out, said)

  const others = section('DEVICES')
  const list = el('ul', { class: 'rows' })
  const loading = el('p', { class: 'empty', text: 'asking…' })
  into(others.body, list, loading)
  // The device list is not on the stream — letting a phone in or disconnecting
  // one is not a projection change — so it is asked for when this screen
  // opens, which is the only moment anybody is reading it.
  void ctx.freshen()

  out.addEventListener('click', async () => {
    out.disabled = true
    const who = ctx.session()
    if (who === null) {
      textIn(said, 'this device has no session to sign out')
      out.disabled = false
      return
    }
    const answer = await ctx.ask('DELETE', `/api/devices/${encodeURIComponent(who.device)}`, {})
    if (answer.status === 200) {
      ctx.go('/pair', { replace: true })
      return
    }
    out.disabled = false
    textIn(said, ctx.sentence(answer))
  })

  into(
    node,
    mine.node,
    others.node,
    el('p', {
      class: 'caveat',
      text: 'Every device that has been let in is listed here, and disconnecting one is done at the machine and needs no network. Nothing running on that machine is contained: anything there runs as you.',
    }),
  )

  return {
    node,
    update(view) {
      const who = ctx.session()
      const until = who === null ? null : untilSaid(who.until, view.asOf)
      dlIn(facts, [
        ['this device', who === null ? null : who.label],
        ['may read', who === null ? null : readsSaid(who.reads)],
        ['may do', who === null ? null : who.scopes.join(', ')],
        ['session runs out', until === null ? null : `in ${until}`],
      ])
      sayIn(noSession, who === null ? '— could not read this device’s own session' : null)
      const rows = ctx.devices()
      loading.hidden = rows !== null
      keyed(
        list,
        rows ?? [],
        (one) => one.device,
        createDeviceRow,
        (one, row) => fillDeviceRow(one, row, view),
      )
      textIn(others.figure, rows === null ? '' : count(rows.length))
    },
  }
}

/** What a device was granted, in words, with the floor said rather than left blank. */
function readsSaid(reads) {
  return reads.length === 0 ? 'names and counts' : reads.join(', ')
}

function createDeviceRow() {
  const node = el('li')
  const body = el('div')
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  into(body, el('span', { class: 'glyph', text: '⌸' }), name, aside)
  return into(node, body)
}

function fillDeviceRow(node, device, view) {
  const [body] = node.children
  const [, name, aside] = body.children
  textIn(name, `${device.label}${device.you ? ' · this one' : ''}`)
  const age = ageSaid(device.pairedAt, view.asOf, view.frozen)
  textIn(aside, age === null ? '' : `paired ${age} ago`)
}

/* ── pairing ───────────────────────────────────────────────────────────────── */

/**
 * The four states a phone goes through: scanned, asking, paired, refused.
 *
 * **A typed address cannot pair.** The ticket is in the QR's fragment, which a
 * browser never sends to a server, so somebody who typed the address arrives
 * here with nothing to present — and is told to scan the code in the window
 * rather than left pressing a button that cannot work.
 *
 * The sentence under the name field is where somebody is deciding, so it says
 * what letting a device in actually means: everything, read-only, including
 * what they typed as they typed it.
 */
export function pairScreen(ctx) {
  const node = el('div', { class: 'column' })
  const title = el('h1', { text: 'Pair this device' })
  const why = el('p', {
    class: 'caveat',
    text: 'Tade will ask at the machine before this device is let in. It will be able to read every project, task, note, check and figure — including what you have typed into Tade, as you typed it — and to change nothing.',
  })
  const label = el('label', { text: 'Name it, so you can revoke it', attrs: { for: 'label' } })
  const field = el('input', {
    attrs: { id: 'label', type: 'text', maxlength: '40', autocomplete: 'off' },
  })
  const press = el('button', { class: 'press', text: 'Pair', attrs: { type: 'button' } })
  const said = el('p', { attrs: { role: 'status' } })
  into(node, title, why, label, field, press, said)

  const ticket = ctx.ticket()
  if (ticket === null) {
    press.disabled = true
    field.disabled = true
    textIn(said, 'Open the pairing panel in Tade and scan the code there.')
  } else {
    press.addEventListener('click', async () => {
      press.disabled = true
      textIn(said, 'Asking at the machine. Press the key in the window to let this device in.')
      const answer = await ctx.ask('POST', '/api/pair', { ticket, label: field.value })
      if (answer.status === 201) {
        ctx.go('/', { replace: true, reload: true })
        return
      }
      // One try per ticket, whatever the answer: it was burned the moment it
      // was presented, so there is nothing here to press again.
      textIn(said, `${ctx.sentence(answer)} Scan a new code in the window.`)
    })
  }

  return { node, update() {} }
}

/* ── More, and nowhere ─────────────────────────────────────────────────────── */

/** The weekly reads, as a screen rather than a menu under the thumb. */
export function moreScreen() {
  const node = el('div')
  const made = section('MORE', { top: true })
  const list = el('ul', { class: 'rows' })
  into(made.body, list)
  for (const one of MORE) {
    const row = el('li')
    const link = el('a', { attrs: { href: `/${one.view}` } })
    into(
      link,
      el('span', { class: 'glyph', text: one.mark, attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'name', text: one.label }),
      el('span', { class: 'aside', text: '›' }),
    )
    into(list, into(row, link))
  }
  into(node, made.node)
  return { node, update() {} }
}

/**
 * A path the server served the shell for and this page does not know.
 *
 * Said rather than drawn as the overview: a link that silently landed somewhere
 * else is the worst kind of broken, because it looks like it worked.
 */
export function nowhereScreen() {
  const node = el('div', { class: 'column' })
  into(
    node,
    el('h1', { text: 'Nothing here' }),
    el('p', {
      class: 'empty',
      text: 'This address is not one of Tade’s screens. It may belong to a newer version than this page.',
    }),
    el('a', { text: 'Go to Now', attrs: { href: '/' } }),
  )
  return { node, update() {} }
}
