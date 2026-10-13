// One project: what it is doing, what it is waiting on, what it cost and how its
// checks stand. The landing across every project is `overview.js`; a task's own
// page is `agent.js`; the controls both are built with are `../controls.js`.
//
// Each returns its node and an `update`, because **a screen is built once and
// then patched** — nothing re-creates a region because a figure moved, so the
// keyboard keeps its row, a half-made selection survives, and the scroll
// position stays the browser's own business.

import { mayFor } from '../access.js'
import { PROJECT_SHOWN } from '../acts.js'
import { actsIn } from '../controls.js'
import { el, empty, into, keyed, textIn } from '../dom.js'
import { count, money, onPlan, sinceSaid, tokensSaid } from '../figures.js'
import { glanceOf, glanceTiles, tilesIn } from '../glance.js'
import { checkMark } from '../glyphs.js'
import {
  createQueueRow,
  createTaskRow,
  dl,
  dlIn,
  fillQueueRow,
  fillTaskRow,
  pageBar,
  sayIn,
  section,
} from '../rows.js'
import { omitted, projectAt, queueIn, spendFold, spendSince, tasksIn } from '../store.js'
import { note, panel } from '../ui.js'

/* ── one project ───────────────────────────────────────────────────────────── */

export function projectScreen(where, ctx) {
  const node = el('div')
  const bar = pageBar(where.project, { name: true, back: { text: 'Overview', href: '/' } })
  const figure = bar.figure
  const strip = el('nav', { class: 'tabstrip', attrs: { 'aria-label': 'This project' } })
  const gone = el('p', { class: 'empty nothing' })

  const agents = section('AGENTS')
  const agentList = panel('ul', 'rows')
  const noAgents = empty('nothing running here')
  into(agents.body, agentList, noAgents)

  const queue = section('QUEUE')
  const queueList = panel('ul', 'queue')
  const noQueue = empty('nothing queued here')
  into(queue.body, queueList, noQueue)

  const checks = section('CHECKS')
  const spend = section('SPEND')

  for (const [name, at] of [
    ['Agents', agents],
    ['Queue', queue],
    ['Checks', checks],
    ['Spend', spend],
  ]) {
    into(strip, el('a', { text: name, attrs: { href: `#${at.heading.id}` } }))
  }

  // The project at a glance: the overview's own tiles, folded over this
  // project's work, each going to its own section below.
  const tiles = el('div', { class: 'tiles tiles-4' })
  const glance = glanceTiles(tiles, ['wants', 'working', 'queue', 'spend'], {
    wants: `#${agents.heading.id}`,
    working: `#${agents.heading.id}`,
    queue: `#${queue.heading.id}`,
    spend: `#${spend.heading.id}`,
  })
  into(node, bar.node, tiles, strip, gone, agents.node, queue.node, checks.node, spend.node)
  const folds = foldsOf(checks, spend)
  // Closing it, or opening it again: the same blocks a task's page builds, over
  // the two verbs about the whole project, at the foot where a reach for the
  // ordinary controls does not land on it.
  const acts = ctx === undefined || ctx === null ? null : actsIn(node, ctx, PROJECT_SHOWN)

  return {
    node,
    update(view) {
      const project = projectAt(view.store, where.project)
      const shut = project?.open === false
      gone.hidden = project !== null && !shut
      // A project that is not in this device's reach, or is not there any more.
      // Said rather than drawn as an empty project, which would read as a
      // repository where nothing is happening — and a closed one says what
      // closing did and did not do, because its tasks are not drawn here.
      textIn(
        gone,
        project === null
          ? 'Not on this device'
          : shut
            ? 'Closed — nothing deleted, agents still working'
            : '',
      )
      for (const one of [agents.node, queue.node, checks.node, spend.node, tiles, strip]) {
        one.hidden = project === null || shut
      }
      if (project !== null) acts?.update(project, view)
      // A closed project has no tasks here, so a figure left from when it was
      // open would be one nothing could refresh.
      if (shut) textIn(figure, '')
      if (project === null || shut) return
      tilesIn(glance, glanceOf(view.store, where.project), view)
      const tasks = tasksIn(view.store, where.project)
      const paid = money(
        spendFold(tasks, omitted(view.store, 'tasks') > 0),
        mayFor(view.store, 'tasks.spend'),
      )
      textIn(figure, paid.said === '—' ? `— ${paid.why}` : paid.said)
      textIn(agents.figure, count(tasks.length))
      agents.figure.setAttribute('aria-label', `${tasks.length} tasks`)
      keyed(
        agentList,
        tasks,
        (task) => task.id,
        createTaskRow,
        (one, task) => fillTaskRow(one, task, view),
      )
      noAgents.hidden = tasks.length > 0

      const queued = queueIn(view.store, where.project)
      textIn(queue.figure, count(queued.length))
      queue.figure.setAttribute('aria-label', `${queued.length} queued`)
      keyed(
        queueList,
        queued,
        (row) => row.task,
        createQueueRow,
        (one, row) => fillQueueRow(one, row, { ...view, project: where.project }),
      )
      noQueue.hidden = queued.length > 0

      checksIn(checks, folds, tasks)
      spendIn(
        spend,
        folds,
        tasks,
        omitted(view.store, 'tasks') > 0,
        mayFor(view.store, 'tasks.spend'),
        spendSince(view.store),
      )
    },
  }
}

/**
 * A project's checks and its money, built once and then patched.
 *
 * Both are figures somebody selects, and the page repaints every two seconds.
 */
function foldsOf(checks, spend) {
  const made = {
    checks: dl(),
    quiet: note('not run here', 'A check nobody ran here is not a check that passed.', 'clock'),
    spend: dl(),
    outside: el('div', { class: 'outside' }),
    planWhy: el('p', { class: 'aside' }),
    planSaid: el('p', { class: 'num' }),
    noMoney: el('p', { class: 'unknown' }),
    floor: note(
      'a floor',
      'Some tasks are not on this page, so this is at least what was spent.',
      'alert',
    ),
    scope: el('p', { class: 'unknown', text: '— not granted to this device' }),
    // What period the figures above cover. Said here as well as on the Spend
    // screen, because a dash on either reads as *nothing was spent* without
    // it (`sinceSaid`).
    covers: el('p', { class: 'unknown' }),
  }
  into(made.outside, made.planWhy, made.planSaid)
  into(checks.body, made.checks, made.quiet)
  into(spend.body, made.scope, made.spend, made.outside, made.noMoney, made.floor, made.covers)
  return made
}

/**
 * A project's checks, as **counts and a word only where there is one**.
 *
 * A project is not green because the tasks that answered were: a check nobody
 * ran here is `unknown`, and three greens plus an unknown folded into "green"
 * is the exact claim `deriveState` refuses to make.
 */
function checksIn(section_, made, tasks) {
  const green = tasks.filter((task) => task.checks.state === 'pass').length
  const red = tasks.filter((task) => task.checks.state === 'fail').length
  const quiet = tasks.filter((task) => task.checks.state === 'unknown').length
  const mark = checkMark(red > 0 ? 'fail' : quiet > 0 || green === 0 ? 'unknown' : 'pass')
  textIn(section_.figure, mark.word)
  dlIn(made.checks, [
    ['green', count(green), `${green} green`],
    ['red', count(red), `${red} red`],
    ['not run here', count(quiet), `${quiet} not run here`],
  ])
  // The row says *not run here*; what that is not is one `?` away.
  made.quiet.hidden = quiet === 0
}

/**
 * A project's money, with every way it could be incomplete said beside it.
 *
 * `≥` when the snapshot left tasks out, because a sum over what arrived is a
 * floor; `~` when any of it was estimated; `—` where nobody wrote anything
 * down. And a plan's equivalent **below a rule and in no total**, because a
 * subscription already paid for those turns and nobody was charged them.
 */
function spendIn(section_, made, tasks, partial, may, since = null) {
  const fold = spendFold(tasks, partial)
  const paid = money(fold, may)
  textIn(section_.figure, paid.said === '—' ? '—' : `${fold.partial ? '≥' : ''}${paid.said}`)
  // **Not granted is not "reported nothing".** Without the grant every task's
  // spend is a null, so every caveat below would read as a fact about the work
  // rather than about this device's reach — which is the same lie the dash
  // itself exists to avoid.
  made.scope.hidden = may
  for (const one of ['spend', 'outside', 'noMoney', 'floor', 'covers']) made[one].hidden = !may
  if (!may) return
  sayIn(made.covers, sinceSaid(since))
  const tokens = tokensSaid(fold)
  dlIn(made.spend, [
    ['exact', fold.usdExact > 0 ? `$${fold.usdExact.toFixed(2)}` : null],
    ['estimated', fold.usdEstimated > 0 ? `~$${fold.usdEstimated.toFixed(2)}` : null],
    ['tokens', tokens === null ? null : tokens.said],
    ['unpriced', tokens === null || tokens.unpriced === '' ? null : tokens.unpriced],
  ])
  const plan = onPlan(fold)
  made.outside.hidden = plan === null
  if (plan !== null) {
    textIn(made.planWhy, plan.why)
    textIn(made.planSaid, plan.said)
  }
  sayIn(made.noMoney, fold.unknown > 0 ? `— ${fold.unknown} unreported` : null)
  made.floor.hidden = !fold.partial
}
