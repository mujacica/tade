// The money: what the work cost, what a plan's windows hold, and by project.
//
// The screen that most has to not lie. `usdOnPlan` goes below a rule and in
// **no** total, because a subscription paid a flat fee and nobody was charged
// those turns; `~` marks any bucket with an estimate in it; `≥` appears
// wherever some tokens had no rate, or wherever the snapshot left tasks out,
// because a sum over what arrived is a floor; and `—` is nobody wrote it down,
// never a nought. There are no period buttons on this page: the projection
// carries one figure per task and not a series, so *today* is a question this
// data cannot answer and a control offering it would be a lie with a tab on it.

import { mayFor } from './access.js'
import { ringOf, shareIn } from './charts.js'
import { el, empty, foldOf, into, keyed, textIn } from './dom.js'
import { count, money, onPlan, planBar, sinceSaid, tokensSaid, untilSaid } from './figures.js'
import { nothingSaid } from './pages.js'
import { dl, dlIn, sayIn, section } from './rows.js'
import { omitted, plansOf, projectsOf, rowsOf, spendFold, spendSince, tasksIn } from './store.js'
import { callout, meter, meterIn, panel } from './ui.js'

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
  // `plan.why` already says *not in the total*; nothing more on the page.
  into(outside, planWhy, planSaid)
  // The caveats are built once and shown or hidden, so a figure somebody is
  // reading does not move down the page because a new one appeared under it.
  const scope = callout(
    'This device was not granted what the work costs, so every figure here is a dash. What each device may read is decided at the machine, and the Devices screen lists what this one was given.',
  )
  const floor = el('p', { class: 'unknown', text: '≥ some tasks are not on this page' })
  const noMoney = el('p', { class: 'unknown' })
  const unrated = el('p', {
    class: 'unknown',
    text: '~ some tokens ran on a model with no known rate',
  })
  // **The period, said rather than denied.** The sentence that used to be here
  // said this was not a figure for a day — and it is one: the window folds
  // spend from its own midnight, so without this a phone reads a dash on a
  // task that cost forty dollars yesterday as *not recorded*.
  const covers = el('p', { class: 'unknown' })
  const caveats = { scope, floor, noMoney, unrated, covers }
  // **The figure, its marks, and the sentences one `?` away.** `≥`, `~` and
  // the dash's own word stay on the figures; what each of them means, and
  // which period this is, is folded under the press beside the total.
  const about = foldOf('About these figures')
  const head = el('div', { class: 'big-head' })
  into(head, big, about.press)
  into(about.body, scope, floor, noMoney, unrated, covers)
  kinds.classList.add('minis')
  into(made.body, head, under, about.body, kinds, outside)

  const plans = quotasSection()

  const by = section('BY PROJECT')
  const wrap = el('div', {
    class: 'scrolls ui-panel',
    attrs: { tabindex: '0', role: 'region', 'aria-label': 'Spend by project, scrollable' },
  })
  const table = el('table')
  const caption = el('caption', { class: 'sr-only', text: 'Folded over the tasks on this page.' })
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
      const paid = money(fold, mayFor(view.store, 'tasks.spend'))
      textIn(big, paid.said === '—' ? '—' : `${partial ? '≥' : ''}${paid.said}`)
      textIn(under, paid.said === '—' ? paid.why : 'billed')
      const tokens = tokensSaid(fold)
      dlIn(kinds, [
        ['exact', fold.usdExact > 0 ? `$${fold.usdExact.toFixed(2)}` : null],
        ['estimated', fold.usdEstimated > 0 ? `~$${fold.usdEstimated.toFixed(2)}` : null],
        ['tokens', tokens === null ? null : tokens.said],
        [
          'unpriced',
          tokens === null || tokens.unpriced === ''
            ? null
            : tokens.unpriced.replace(/ unpriced$/, ''),
        ],
      ])
      planEquivalentIn({ outside, planWhy, planSaid }, fold)
      caveatsIn(caveats, fold, mayFor(view.store, 'tasks.spend'), spendSince(view.store))
      plans.update(view)
      const names = projectsOf(view.store)
      // The largest project's money is the full width of every bar, so the
      // bars compare the projects with each other and nothing else.
      const most = Math.max(0, ...names.map((row) => spendFold(tasksIn(view.store, row.name)).usd))
      keyed(
        body,
        names,
        (row) => row.name,
        createSpendRow,
        (one, row) => fillSpendRow(one, row, view, most),
      )
    },
  }
}

/**
 * Quotas: every account's plan windows — the 5 hours, the week — each a bar
 * of how much of it is used and when it starts over, as the harness reported
 * them. The Spend screen and the overview draw the same section.
 */
export function quotasSection() {
  const made = section('QUOTAS')
  const list = panel('ul', 'rows quotas')
  const none = empty('no account reported a quota')
  into(made.body, list, none)
  return {
    node: made.node,
    update(view) {
      const rows = plansOf(view.store)
      textIn(made.figure, count(rows.length))
      none.hidden = rows.length > 0
      textIn(
        none,
        nothingSaid(
          mayFor(view.store, 'plans'),
          omitted(view.store, 'plans'),
          'no account reported a quota',
        ),
      )
      keyed(
        list,
        rows,
        (row) => row.id,
        createPlanRow,
        (one, row) => fillPlanRow(one, row, view),
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
  // One line per window: its name, a bar of how much of it is used, the
  // share, and when it starts over — drawn, rather than a row of `▰`.
  const windows = el('ul', { class: 'windows' })
  into(body, ringOf('plan'), name, meter, under, windows)
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
  const [ring, name, meter, under, windows] = body.children
  // The fullest window as the ring beside the name: the one that runs out first.
  const most = Math.max(...(plan.windows ?? []).map((one) => one.used), -1)
  shareIn(ring, most < 0 ? null : most, most < 0 ? '' : planBar(most).pressure)
  textIn(name, `${plan.harness}${plan.account === null ? '' : ` · ${plan.account.words}`}`)
  const told = (said) => {
    textIn(under, said)
    under.hidden = said === ''
  }
  if (plan.cannotTell !== null && plan.cannotTell !== undefined) {
    textIn(meter, '—')
    told(plan.cannotTell)
    keyed(windows, [], (one) => one.label, createWindow, fillWindow)
    return
  }
  if (plan.pays === 'per-token') {
    textIn(meter, '')
    told('per-token — no window')
    keyed(windows, [], (one) => one.label, createWindow, fillWindow)
    return
  }
  textIn(meter, plan.windows.length === 0 ? '—' : '')
  told(plan.windows.length === 0 ? 'no window was reported' : '')
  keyed(
    windows,
    plan.windows,
    (one) => one.label,
    createWindow,
    (one, window) => fillWindow(one, window, view),
  )
}

function createWindow() {
  const node = el('li')
  const bar = meter()
  into(
    node,
    el('span', { class: 'window-label' }),
    bar,
    el('span', { class: 'window-share num' }),
    el('span', { class: 'window-resets' }),
  )
  return node
}

function fillWindow(node, window, view) {
  const [label, bar, share, resets] = node.children
  const drawn = planBar(window.used)
  textIn(label, window.label)
  meterIn(bar, window.used, drawn.pressure)
  textIn(share, drawn.said)
  const until = untilSaid(window.resetsAt, view?.asOf ?? Date.now())
  textIn(resets, until === null ? 'no reset said' : `resets in ${until}`)
}

function createSpendRow() {
  const node = el('tr')
  for (let at = 0; at < 4; at += 1) {
    into(node, el('td', { class: at === 0 ? '' : 'figure' }))
  }
  // Each project's share of the largest, as a bar under its name: a picture
  // of the money column beside it, and `aria-hidden` because it is that.
  const name = el('span', { class: 'share-name' })
  const share = meter()
  share.classList.add('share')
  into(node.firstChild, name, share)
  return node
}

function fillSpendRow(node, project, view, most = 0) {
  const cells = node.children
  const tasks = tasksIn(view.store, project.name)
  const fold = spendFold(tasks, omitted(view.store, 'tasks') > 0)
  const paid = money(fold, mayFor(view.store, 'tasks.spend'))
  const [name, share] = cells[0].children
  textIn(name, project.name)
  const part = paid.said === '—' || most <= 0 ? 0 : fold.usd / most
  share.hidden = part === 0
  meterIn(share, part * 100)
  textIn(cells[1], paid.said === '—' ? '—' : `${fold.partial ? '≥' : ''}${paid.said}`)
  cells[1].setAttribute('aria-label', paid.said === '—' ? paid.why : paid.said)
  const tokens = tokensSaid(fold)
  textIn(cells[2], tokens === null ? '—' : tokens.said)
  const plan = onPlan(fold)
  textIn(cells[3], plan === null ? '—' : plan.said)
}
