// The three screens about work: the overview, a project, and a task.
//
// Each returns its node and an `update`, because **a screen is built once and
// then patched** — nothing re-creates a region because a figure moved, so the
// keyboard keeps its row, a half-made selection survives, and the scroll
// position stays the browser's own business.
//
// The overview's one rule: **`WANTS YOU` is the top of every viewport and the
// question it answers is *is anything stopped*.** Nothing is above it but the
// wordmark and the freshness clock, and when it is empty it says so in words —
// an empty heading reads as broken.

import {
  classOn,
  el,
  empty,
  glyphOf,
  into,
  keyed,
  markIn,
  proseOf,
  textIn,
  toneOn,
  unknown,
} from './dom.js'
import { count, money, onPlan, sinceSaid, tokensSaid } from './figures.js'
import { checkMark, taskMark } from './glyphs.js'
import { pathOf } from './routes.js'
import {
  createQueueRow,
  createTaskCard,
  createTaskRow,
  dl,
  dlIn,
  fillQueueRow,
  fillTaskCard,
  fillTaskRow,
  originOf,
  sayIn,
  section,
} from './rows.js'
import {
  omitted,
  projectAt,
  queueIn,
  spendFold,
  spendSince,
  taskAt,
  tasksIn,
  wantsYou,
} from './store.js'

/* ── the overview ──────────────────────────────────────────────────────────── */

export function nowScreen() {
  const node = el('div')
  const wants = section('WANTS YOU', { top: true })
  const cards = el('div', { class: 'cards' })
  const none = empty('nothing is stopped')
  into(wants.body, cards, none)
  const projects = el('div')
  const left = el('p', { class: 'unknown' })
  into(node, wants.node, projects, left)

  return {
    node,
    update(view) {
      const rows = wantsYou(view.store)
      textIn(wants.figure, count(rows.length))
      wants.figure.setAttribute('aria-label', `${rows.length} wanting you`)
      classOn(none, 'hidden', rows.length > 0)
      none.hidden = rows.length > 0
      keyed(
        cards,
        rows,
        (task) => task.id,
        createTaskCard,
        (one, task) => fillTaskCard(one, task, view),
      )
      keyed(
        projects,
        projectsHere(view),
        (row) => row.name,
        createProjectBlock,
        (one, row) => fillProjectBlock(one, row, view),
      )
      textIn(left, leftOut(view.store))
      left.hidden = leftOut(view.store) === ''
    },
  }
}

/**
 * The projects, and the busy ones first.
 *
 * Ordered by what wants you, then by what is working: the overview's job is to
 * put what is stopped at the top of a phone, and a list sorted by name buries
 * the one repository that needs somebody under three that do not.
 */
function projectsHere(view) {
  return [...view.store.rows.projects.values()].sort(
    (a, b) =>
      b.counts.wantsYou - a.counts.wantsYou ||
      b.counts.working - a.counts.working ||
      (a.name < b.name ? -1 : 1),
  )
}

/**
 * What the projection left out, said out loud.
 *
 * A flat cap that said nothing would lose four repositories without a word;
 * every page carries its own count of what it omitted, and a page that holds
 * the first twenty of ninety tasks answers "is anything waiting for me" wrongly
 * and looks complete doing it.
 */
function leftOut(store) {
  const parts = []
  for (const name of ['projects', 'tasks']) {
    const n = omitted(store, name)
    if (n > 0) parts.push(`${n} ${name}`)
  }
  return parts.length === 0 ? '' : `${parts.join(' and ')} are not on this page`
}

function createProjectBlock() {
  const made = section('project')
  const list = el('ul', { class: 'rows' })
  const none = empty('nothing running here')
  into(made.body, list, none)
  made.node.setAttribute('data-block', 'project')
  return made.node
}

function fillProjectBlock(node, project, view) {
  const [head, body] = node.children
  const [heading, figure] = head.children
  const [list, none] = body.children
  const link = heading.querySelector('a') ?? el('a', { attrs: { href: '/' } })
  if (link.parentElement === null) {
    heading.textContent = ''
    into(heading, link)
  }
  link.setAttribute('href', pathOf({ view: 'project', project: project.name }))
  textIn(link, project.name)
  heading.setAttribute('aria-label', `Project ${project.name}`)
  const paid = money(spendFold(tasksIn(view.store, project.name)), view.may.spend)
  textIn(figure, paid.said === '—' ? `— ${paid.why}` : paid.said)
  const rows = tasksIn(view.store, project.name).filter((task) => task.state !== 'merged')
  keyed(
    list,
    rows,
    (task) => task.id,
    createTaskRow,
    (one, task) => fillTaskRow(one, task, view),
  )
  none.hidden = rows.length > 0
}

/* ── one project ───────────────────────────────────────────────────────────── */

export function projectScreen(where) {
  const node = el('div')
  const head = el('div', { class: 'page-head' })
  const back = el('a', { class: 'back', text: '‹ Now', attrs: { href: '/' } })
  const title = el('h1', { text: where.project })
  const figure = el('span', { class: 'figure' })
  into(head, title, figure)
  const strip = el('nav', { class: 'tabstrip', attrs: { 'aria-label': 'This project' } })
  const gone = el('p', { class: 'empty' })

  const agents = section('AGENTS')
  const agentList = el('ul', { class: 'rows' })
  const noAgents = empty('nothing running here')
  into(agents.body, agentList, noAgents)

  const queue = section('QUEUE')
  const queueList = el('ul', { class: 'queue' })
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

  into(node, back, head, strip, gone, agents.node, queue.node, checks.node, spend.node)
  const folds = foldsOf(checks, spend)

  return {
    node,
    update(view) {
      const project = projectAt(view.store, where.project)
      gone.hidden = project !== null
      // A project that is not in this device's reach, or is not there any more.
      // Said rather than drawn as an empty project, which would read as a
      // repository where nothing is happening.
      textIn(gone, project === null ? 'This project is not on this device, or is not there.' : '')
      for (const one of [agents.node, queue.node, checks.node, spend.node]) {
        one.hidden = project === null
      }
      if (project === null) return
      const tasks = tasksIn(view.store, where.project)
      const paid = money(spendFold(tasks, omitted(view.store, 'tasks') > 0), view.may.spend)
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
        view.may.spend,
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
    quiet: el('p', { class: 'unknown' }),
    spend: dl(),
    outside: el('div', { class: 'outside' }),
    planWhy: el('p', { class: 'aside' }),
    planSaid: el('p', { class: 'num' }),
    planNot: el('p', {
      class: 'unknown',
      text: 'not in the total — a subscription already paid for these',
    }),
    noMoney: el('p', { class: 'unknown' }),
    floor: el('p', {
      class: 'unknown',
      text: '— some tasks are not on this page, so this is a floor',
    }),
    scope: el('p', { class: 'unknown', text: '— not granted to this device' }),
    // What period the figures above cover. Said here as well as on the Spend
    // screen, because a dash on either reads as *nothing was spent* without
    // it (`sinceSaid`).
    covers: el('p', { class: 'unknown' }),
  }
  into(made.outside, made.planWhy, made.planSaid, made.planNot)
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
  sayIn(made.quiet, quiet > 0 ? '— a check nobody ran here is not a check that passed' : null)
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
  sayIn(
    made.noMoney,
    fold.unknown > 0 ? `— ${fold.unknown} of these reported no money at all` : null,
  )
  made.floor.hidden = !fold.partial
}

/* ── one task ──────────────────────────────────────────────────────────────── */

/**
 * A task, read-only.
 *
 * What is **not** here is the point of Phase 1: no approve, no deny, no steer,
 * no diff and no lane output. Not greyed out and not behind a toast — absent,
 * because a control that is missing is already the answer and a disabled one
 * invites a tap and then says nothing.
 */
export function taskScreen(where, ctx) {
  const node = el('div')
  const back = el('a', {
    class: 'back',
    text: `‹ ${where.project}`,
    attrs: { href: pathOf({ view: 'project', project: where.project }) },
  })
  const head = el('div', { class: 'page-head' })
  const glyph = glyphOf(taskMark('queued'))
  const title = el('h1', { text: where.task })
  into(head, glyph, title)
  const gone = el('p', { class: 'empty' })

  const state = section('STATE')
  const asked = section('ASKED FOR')
  const agent = section('AGENT')
  const work = section('WORK')
  const checks = section('CHECKS')
  const rest = section('ABOUT')
  into(
    node,
    back,
    head,
    gone,
    state.node,
    asked.node,
    agent.node,
    work.node,
    checks.node,
    rest.node,
  )
  const parts = [state, asked, agent, work, checks, rest]
  const made = partsOf(state, agent, work, checks, rest)
  const park = parkIn(state, ctx, where)

  return {
    node,
    update(view) {
      const task = taskAt(view.store, where.project, where.task)
      gone.hidden = task !== null
      textIn(gone, task === null ? 'This task is not on this device, or is not there.' : '')
      for (const one of parts) one.node.hidden = task === null
      if (task === null) return
      markIn(glyph, taskMark(task.state))
      stateIn(made, task, view)
      askedIn(asked, task, view.may)
      agentIn(made, task, view.may)
      workIn(made, task)
      taskChecksIn(made, task)
      restIn(made, task, view)
      park.update(task, view)
    },
  }
}

/**
 * The one control on this page that changes anything: park, or pick back up.
 *
 * **Absent rather than refused**, three times over. It is not built at all
 * where this device was not granted `steer` — the `scopes` on its own session,
 * out of `/api/devices`, which is also what the machine re-checks. And where
 * it is built, what it sends is the task's own `rev`: what the screen said,
 * echoed back, so a park somebody made at the keyboard since is a `409` that
 * redraws the truth rather than a toggle that undoes their decision.
 *
 * The key is minted here, once per press, and **kept across a retry**: a press
 * whose answer never arrived is a press whose repeat must not be a second act,
 * and the key is what makes the machine able to tell the two apart.
 */
function parkIn(section_, ctx, where) {
  const press = el('button', { class: 'press quietly' })
  const said = el('p', { attrs: { role: 'status' } })
  let may = false
  let rev = null
  let parked = false
  let going = false
  if (ctx !== undefined && ctx !== null) into(section_.body, press, said)

  press.addEventListener('click', async () => {
    if (going || rev === null) return
    going = true
    press.disabled = true
    const answer = await ctx.ask('POST', '/api/act/park', {
      task: `${where.project}/${where.task}`,
      parked: !parked,
      was: rev,
      key: keyOf(),
      rev: ctx.revOf(),
    })
    going = false
    press.disabled = false
    // Tade's own sentence either way. A `409` is not an error to apologise
    // for: the next frame carries what is actually true, and this says which
    // of the two happened.
    textIn(said, answer.status === 200 ? (answer.body?.said ?? 'done') : ctx.sentence(answer))
  })

  return {
    update(task, view) {
      may = view.may.act === true
      rev = task.rev
      parked = task.parked
      press.hidden = !may
      said.hidden = !may
      if (!may) return
      textIn(press, parked ? 'Pick this back up' : 'Set this aside')
    },
  }
}

/**
 * A fresh idempotency key: this browser's own randomness, and nothing of the
 * machine's.
 *
 * `crypto.randomUUID` where the browser has it — every target this page claims
 * does, over a secure context — and a value out of `getRandomValues` where it
 * does not. Never a counter and never a timestamp: two tabs of one phone would
 * mint the same one, and a key bound to another act is refused rather than
 * obeyed, so a collision would read as a broken button.
 */
export function keyOf() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().replaceAll('-', '')
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((one) => one.toString(16).padStart(2, '0')).join('')
}

/**
 * Every part of the task screen, built once.
 *
 * The file's rule, kept: **a screen is built once and then patched.** These
 * sections hold the branch, the model and the account — the things somebody
 * actually selects and copies — and the page repaints every two seconds, so
 * rebuilding them would collapse that selection on every beat. Each `*In`
 * below writes text and toggles `hidden`, and nothing under here is created or
 * removed after this.
 */
function partsOf(state, agent, work, checks, rest) {
  const made = {
    word: el('p', { class: 'word' }),
    why: el('p', { class: 'said' }),
    asked: el('p', { class: 'block' }),
    askedWhy: el('p', {
      class: 'unknown',
      text: 'the whole of what it asked is in the window, at the machine',
    }),
    stalled: el('p', { class: 'unknown', text: 'nothing has moved here for a while' }),
    queue: el('ul', { class: 'queue' }),
    agent: dl(),
    noHarness: el('p', { class: 'unknown', text: 'no harness was written down' }),
    work: dl(),
    noBranch: el('p', { class: 'unknown', text: 'this task has no branch of its own' }),
    shared: el('p', {
      class: 'unknown',
      text: 'other agents work in this checkout, so uncommitted work here is nobody’s',
    }),
    checksWord: el('p', { class: 'word' }),
    checksNames: dl(),
    overruled: el('p', {
      class: 'unknown',
      text: 'a failing check here was overruled, with a reason, at the machine',
    }),
    noChecks: el('p', {
      class: 'unknown',
      text: 'nobody ran these here — which is not that they passed',
    }),
    rest: dl(),
    origin: el('p', { class: 'aside' }),
    findings: el('p', { class: 'aside' }),
    toFindings: el('a', { text: 'Findings ›', attrs: { href: '/findings' } }),
  }
  into(state.body, made.word, made.why, made.asked, made.askedWhy, made.stalled, made.queue)
  into(agent.body, made.agent, made.noHarness)
  into(work.body, made.work, made.noBranch, made.shared)
  into(checks.body, made.checksWord, made.checksNames, made.overruled, made.noChecks)
  into(rest.body, made.rest, made.origin, made.findings, made.toFindings)
  return made
}

function stateIn(made, task, view) {
  const mark = taskMark(task.state)
  textIn(made.word, mark.word)
  toneOn(made.word, mark.tone)
  textIn(made.why, task.reason)
  const approval = task.approval
  // **The tool's name, and never its arguments.** A command's arguments are the
  // field that reliably holds a path and a credential, and the place to read
  // the whole of one is the window, at the machine, where the person who has to
  // decide is.
  sayIn(made.asked, approval ? `waiting for you to answer: ${approval.tool}` : null)
  made.askedWhy.hidden = !approval
  made.stalled.hidden = !task.stalled
  const queue = view.store.rows.queue.get(task.id)
  keyed(
    made.queue,
    queue === undefined ? [] : [queue],
    (row) => row.task,
    createQueueRow,
    (one, row) => fillQueueRow(one, row, { ...view, project: task.project }),
  )
}

/**
 * What somebody asked for, in their own words, folded to three lines.
 *
 * **Verbatim, and never reworded.** This is the person's own sentence; the fold
 * is a control they open, not an edit. And a device that was granted neither
 * the titles nor the intent is told *that*, rather than that nobody wrote
 * anything down — which would be a page blaming them for their own read scope.
 *
 * Written once: what somebody asked for does not change, and rebuilding it
 * would close a fold they had opened.
 */
function askedIn(made, task, may) {
  if (made.body.children.length > 0) return
  if (!may.intent && !may.titles) {
    into(made.body, unknown('not granted to this device'))
    return
  }
  const said = task.intent ?? task.title
  into(made.body, proseOf(said, true) ?? empty('nobody wrote down what this is for'))
  if (task.intent !== null && task.title !== null) {
    into(made.body, el('p', { class: 'aside', text: 'as a title' }), proseOf(task.title))
  }
}

function agentIn(made, task, may) {
  dlIn(made.agent, [
    ['harness', task.harness],
    ['model', task.model],
    // Which sign-in an agent runs as is its own grant, so a null here is two
    // different facts and the page says which.
    ['account', may.accounts ? (task.account?.words ?? null) : 'not granted'],
    ['agents', String(task.agents), `${task.agents} agents`],
    ['lanes', String(task.lanes), `${task.lanes} lanes`],
  ])
  made.noHarness.hidden = task.harness !== null
}

/**
 * The work: a branch, how far it is from its base, and **counts of changed
 * files rather than their names**.
 *
 * A branch name is not a path, which is why it may be here at all. The names of
 * changed files are repository-relative when the projection carries them and it
 * does not carry them in this phase, so what is drawn is the count — a figure
 * that is honest at every width.
 */
function workIn(made, task) {
  dlIn(made.work, [
    ['branch', task.branch],
    ['ahead', task.ahead === null ? null : String(task.ahead)],
    ['behind', task.behind === null ? null : String(task.behind)],
    ['changed', task.dirty === null ? null : String(task.dirty)],
    ['workspace', task.shared ? `${task.workspace} · shared` : task.workspace],
  ])
  made.noBranch.hidden = task.branch !== null
  made.shared.hidden = !task.shared
}

function taskChecksIn(made, task) {
  const mark = checkMark(task.checks.state)
  // The coloured word says it; a second copy in the section's figure is the
  // same fact twice on one line.
  textIn(made.checksWord, mark.word)
  toneOn(made.checksWord, mark.tone)
  dlIn(made.checksNames, [
    ['red', task.checks.failed.length === 0 ? null : task.checks.failed.join(', ')],
    ['not run', task.checks.missing.length === 0 ? null : task.checks.missing.join(', ')],
  ])
  // A red run that was overruled is still recorded red, and this is where
  // somebody reading from away finds out that it was.
  made.overruled.hidden = !task.checks.overridden
  made.noChecks.hidden = task.checks.state !== 'unknown'
}

function restIn(made, task, view) {
  const produces = task.produces
  dlIn(made.rest, [
    ['done when', task.done],
    ['effort', task.effort],
    ['produces', produces === null ? null : `${produces.name} · ${written(produces)}`],
    ['review', task.review === null ? null : task.review.state],
  ])
  textIn(made.origin, originOf(task))
  const found = [...view.store.rows.findings.values()].filter((one) => one.tasks.includes(task.id))
  sayIn(
    made.findings,
    found.length === 0
      ? null
      : `${found.length} finding${found.length === 1 ? '' : 's'} about this change`,
  )
  made.toFindings.hidden = found.length === 0
}

const written = (produces) => (produces.written ? 'written' : 'not yet')
