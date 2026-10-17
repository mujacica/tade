// The spend page's pure half: what the work cost, how full each plan is, and
// where it went, in the words and marks the page draws.
//
// **Two currencies and a counterfactual, never added in silence.** Money is
// marked by who worked it out (nothing for a bill, `~` the harness's guess, `≈`
// Tade's off a list); a plan's windows are shares, never dollars; what a plan's
// turns would have cost at list is in no total. `≥` where a figure is a floor,
// and `—` with its word where nobody could say — never a nought.

import { onPlanOf, planPressure, pricedOf, shortClockOf, tokens, untilSaid } from '../figures.js'
import { pathOf, taskPath } from '../routes.js'
import { spendFold } from '../store.js'

/** Who worked a figure out, as the one character before it. A mix carries the guess's. */
export const MARKS = { exact: '', estimate: '~', listed: '≈', mixed: '~', none: '' }

/** What a total is made of, in a word under it (the window's `MADE_OF`). */
export const MADE_OF = {
  exact: 'billed',
  estimate: 'estimated',
  listed: 'list prices',
  mixed: 'mixed',
  none: '',
}

/** The ways to ask where it went, in the switch's order. */
export const GROUPS = [
  { key: 'project', word: 'Project', noun: ['project', 'projects'] },
  { key: 'agent', word: 'Agent', noun: ['agent', 'agents'] },
  { key: 'harness', word: 'Harness', noun: ['harness', 'harnesses'] },
  { key: 'model', word: 'Model', noun: ['model', 'models'] },
]

/** A name nobody wrote down, never a model called `unknown`. */
export const UNRECORDED = 'not recorded'

const dollars = (usd) => `$${usd.toFixed(2)}`
const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`

/** Whether a fold has anything in it: money, a plan's worth, or tokens. */
export function spentAny(fold) {
  return fold.hasCost || fold.usdOnPlan > 0 || fold.tokens > 0
}

/** Money as drawn — `~$4.20`, `≈$2.52`, `≥$8.10` — or null where nobody reported any. */
export function moneySaid(fold) {
  if (!fold.hasCost) return null
  return `${fold.partial ? '≥' : ''}${MARKS[pricedOf(fold)]}${dollars(fold.usd)}`
}

/** What a plan's turns would have cost at list, `≥` where some had no rate; null for none. */
export function onPlanSaid(fold) {
  const kind = onPlanOf(fold)
  if (kind === 'none') return null
  return `${kind === 'partly' || fold.partial ? '≥' : ''}≈${dollars(fold.usdOnPlan)}`
}

/** Why there is no money figure: this device, an empty period, or work nobody priced. */
export function noMoneyWhy(fold, granted) {
  if (!granted) return 'not granted'
  if (fold.tokens === 0 && fold.usdOnPlan === 0) return 'nothing recorded'
  return 'none reported'
}

function tokensWord(fold) {
  if (fold.tokens === 0) return 'nothing recorded'
  if (fold.tokensUnpriced >= fold.tokens) return 'none priced'
  return fold.tokensUnpriced > 0 ? `${tokens(fold.tokensUnpriced)} unpriced` : 'all priced'
}

/**
 * The lead: the bill, what a plan's turns would have cost, and the tokens —
 * each with its word, and a mixed bill's parts named rather than averaged.
 */
export function leadOf(tasks, { granted, partial }) {
  const fold = spendFold(tasks, partial)
  const money = granted ? moneySaid(fold) : null
  const kinds = [
    ['exact', fold.usdExact],
    ['estimate', fold.usdEstimated],
    ['listed', fold.usdListed],
  ].filter(([, usd]) => usd > 0)
  const plan = granted ? onPlanSaid(fold) : null
  const toks = granted && fold.tokens > 0 ? `${partial ? '≥' : ''}${tokens(fold.tokens)}` : null
  const no = 'not granted'
  return {
    fold,
    billed: {
      value: money,
      word: money === null ? noMoneyWhy(fold, granted) : MADE_OF[pricedOf(fold)],
      parts:
        money === null || kinds.length < 2
          ? []
          : kinds.map(([key, usd]) => ({
              key,
              said: `${MARKS[key]}${dollars(usd)}`,
              word: MADE_OF[key],
            })),
    },
    onPlan: {
      value: plan,
      word: !granted
        ? no
        : plan !== null
          ? 'at list · not billed'
          : fold.tokensOnPlanUnrated > 0
            ? 'no rate for its model'
            : 'no plan ran',
    },
    tokens: { value: toks, word: granted ? tokensWord(fold) : no },
  }
}

/**
 * The period every money figure covers: `today` from this reader's midnight,
 * the time from later today, the day before that, or null for nothing folded.
 * The instant is the window's (`fresh.spendSince`), shown in the reader's
 * clock, because the phone is somewhere else and *today* is not the same day.
 */
export function periodOf(since, now) {
  if (since === null || since === undefined || since === '') return null
  const when = new Date(since)
  if (Number.isNaN(when.getTime())) return null
  const midnight = when.getHours() === 0 && when.getMinutes() === 0
  if (when.toDateString() === new Date(now).toDateString()) {
    return midnight ? 'today' : `since ${shortClockOf(since)}`
  }
  const day = when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `since ${day}${midnight ? '' : ` ${shortClockOf(since)}`}`
}

/* ── where it went ─────────────────────────────────────────────────────────── */

function groupOfTask(task, by) {
  if (by === 'agent') {
    const cut = task.id.indexOf('/')
    return { key: task.id, label: task.id.slice(cut + 1), href: taskPath(task.id) }
  }
  if (by === 'harness' || by === 'model') {
    const name = task[by] ?? ''
    return { key: name, label: name || UNRECORDED, href: null }
  }
  const href = pathOf({ view: 'project', project: task.project })
  return { key: task.project, label: task.project, href }
}

/**
 * Where it went, as ranked bars: a row per project, agent, harness or model
 * that spent anything, and a count of the rest rather than a column of dashes.
 *
 * **The measure follows the money.** Where anything was billed the bars are
 * money, and a plan's row has no bar — a plan is not money — and says its
 * worth at list instead. Where nothing was, the bars are tokens, the one
 * figure every harness reports: empty money bars say nothing about the work.
 */
export function wentOf(tasks, by, { partial = false } = {}) {
  const groups = new Map()
  for (const task of tasks) {
    const one = groupOfTask(task, by)
    const had = groups.get(one.key)
    if (had === undefined) groups.set(one.key, { ...one, tasks: [task] })
    else had.tasks.push(task)
  }
  const all = [...groups.values()].map((one) => ({ ...one, fold: spendFold(one.tasks, partial) }))
  const spent = all.filter((one) => spentAny(one.fold))
  const measure = spent.some((one) => one.fold.hasCost) ? 'cost' : 'tokens'
  const rank = ({ fold }) =>
    measure === 'cost'
      ? [fold.hasCost ? fold.usd : -1, fold.usdOnPlan, fold.tokens]
      : [fold.tokens, fold.usdOnPlan]
  spent.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)]
    const at = x.findIndex((one, n) => one !== y[n])
    return at >= 0 ? y[at] - x[at] : a.label.localeCompare(b.label)
  })
  const quiet = all.length - spent.length
  const noun = (GROUPS.find((one) => one.key === by) ?? GROUPS[0]).noun
  return {
    measure,
    rows: spent.map((one) => rowOf(one, by, measure)),
    quiet,
    quietSaid: quiet === 0 ? '' : `${plural(quiet, noun)} spent nothing`,
  }
}

function rowOf(group, by, measure) {
  const { fold } = group
  const money = moneySaid(fold)
  const plan = onPlanSaid(fold)
  const toks = fold.tokens > 0 ? `${fold.partial ? '≥' : ''}${tokens(fold.tokens)}` : null
  const running = by === 'agent' && group.tasks.some((task) => task.lane === 'running')
  const under = []
  if (by === 'agent') {
    const [task] = group.tasks
    under.push(task.project, task.model || task.harness)
  }
  const row = { value: fold.tokens, said: toks ?? '—', kind: 'tokens' }
  if (measure === 'cost') {
    row.value = money === null ? null : fold.usd
    row.said = money ?? (plan === null ? '—' : `${plan} at list`)
    row.kind = money !== null ? 'money' : plan !== null ? 'plan' : 'none'
    if (toks !== null) under.push(`${toks} tokens`)
    if (money !== null && plan !== null) under.push(`${plan} on a plan`)
  } else if (plan !== null) {
    under.push(`${plan} at list`)
  }
  if (running) under.push('running')
  return {
    ...row,
    key: group.key === '' ? `:${UNRECORDED}` : group.key,
    label: group.label,
    href: group.href,
    under: under.filter(Boolean).join(' · '),
    // Money is not a state, so a bar is grey; an agent still running is the
    // one thing here in progress, and its word says so beside the amber.
    tone: running ? 'working' : 'queued',
    unrecorded: group.key === '',
  }
}

/* ── the plans ─────────────────────────────────────────────────────────────── */

const ORDER = { windows: 0, cannot: 1, silent: 2, 'per-token': 3 }

function kindOf(row) {
  if (row.cannotTell !== null && row.cannotTell !== undefined) return 'cannot'
  if ((row.windows ?? []).length > 0) return 'windows'
  return row.pays === 'per-token' ? 'per-token' : 'silent'
}

const LINES = {
  windows: '',
  'per-token': 'pays per token · no window',
  silent: 'no window was reported',
}

/**
 * Who runs as a sign-in, in the window's Accounts page's words: `new agents`
 * where the machine's do, and `in` with the projects that name it as theirs —
 * `new agents in search` where only they do. Empty where nobody runs as it,
 * and where it was not sent: not granted, or not said, which the page draws
 * as nothing, as the window does, rather than as nobody.
 */
export function usesSaid(uses) {
  if (uses === null || uses === undefined) return ''
  const names = [...uses.projects, ...(uses.notShown > 0 ? [`${uses.notShown} more`] : [])]
  const where = names.length === 0 ? '' : `in ${names.join(', ')}`
  if (uses.newAgents) return where === '' ? 'new agents' : `new agents · ${where}`
  return where === '' ? '' : `new agents ${where}`
}

/**
 * Every account as a card, a gauge per window: the fullest first — what runs
 * out first stops the work — then those that cannot say, in the harness's own
 * sentence (`cannotTell`), then those billed per token, with no window at all.
 */
export function plansShape(rows, now) {
  const cards = rows.map((row) => {
    const kind = kindOf(row)
    const windows = (kind === 'windows' ? row.windows : []).map((window) => {
      const until = untilSaid(window.resetsAt, now)
      const resets =
        until === null ? 'no reset said' : until === 'now' ? 'resets now' : `resets in ${until}`
      return {
        key: window.label,
        label: window.label,
        share: window.used,
        said: `${Math.round(window.used)}%`,
        pressure: planPressure(window.used),
        resets,
        under: `${window.label}\n${resets}`,
      }
    })
    const tightest = windows.length === 0 ? null : Math.max(...windows.map((one) => one.share))
    const account = row.account?.words ?? null
    return {
      key: row.id,
      harness: row.harness,
      account,
      name: account ?? row.harness,
      kind,
      windows,
      tightest,
      pressure: tightest === null ? null : planPressure(tightest),
      line: kind === 'cannot' ? row.cannotTell : LINES[kind],
      uses: usesSaid(row.uses),
    }
  })
  return cards.sort(
    (a, b) =>
      ORDER[a.kind] - ORDER[b.kind] ||
      (b.tightest ?? -1) - (a.tightest ?? -1) ||
      a.key.localeCompare(b.key),
  )
}

/** A card's pill: only the plan about to stop somebody — filling is its gauge's to say. */
export function pressureSaid(card) {
  return card.pressure === 'tight' ? 'nearly out' : ''
}
