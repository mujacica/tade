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
  afterAnswer,
  asksFor,
  bodyFor,
  confirms,
  controlsFor,
  headingFor,
  howSaid,
  QUEUE_ASKS,
  SHOWN,
  wordsFor,
} from './acts.js'
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
 * A task: what it is, and what may be asked of it.
 *
 * **What is absent is still the point.** There is no diff, no lane output and
 * no transcript — each ships source or an agent's bytes to a phone and to a
 * browser cache, which is a *reading* grant with its own threat model and not
 * a control. And a control that nothing could carry out is absent too, with
 * the reason beside it: not greyed out and not behind a toast, because a
 * disabled button invites a tap and then says nothing.
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
  // **Every control the page has, built once** — one block per verb, in the
  // order `SHOWN` gives, each hidden until the row says it may be asked for.
  // Built here rather than per update, so what somebody has typed into one
  // survives every delta (`keyed`'s rule, one layer up).
  const acts = ctx === undefined || ctx === null ? null : actsIn(node, ctx)

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
      acts?.update(task, view)
    },
  }
}

/**
 * Every control this page has, as one block per verb.
 *
 * **Absent rather than refused, three times over.** A verb this device was not
 * granted is not built at all and says nothing — a sentence naming a scope
 * somebody does not have is a map of what else there is to ask for. A verb the
 * *world* cannot do right now is absent with the row's own reason beside it.
 * And what every one of them sends is the task's own `rev`: what the screen
 * said, echoed back, so an act against a world that has moved is a `409` that
 * redraws the truth rather than a tap that undoes somebody's decision.
 *
 * **The key is minted once per press and kept across a retry**: a press whose
 * answer never arrived is a press whose repeat must not be a second act, and
 * the key is what makes the machine able to tell the two apart.
 *
 * What is typed stays typed until the act actually happened (`afterAnswer`).
 */
function actsIn(node, ctx) {
  const blocks = new Map()
  for (const verb of SHOWN) {
    const block = blockFor(verb, ctx)
    blocks.set(verb, block)
    into(node, block.node)
  }
  return {
    update(task, view) {
      const acts = view.may.acts ?? { answer: false, steer: false }
      for (const one of controlsFor(task, acts)) {
        blocks.get(one.verb)?.update(task, one)
      }
    },
  }
}

/**
 * One verb's block: a heading, whatever it needs typed, and the press.
 *
 * One shape for all eight, because the differences are three fields — what it
 * says, whether it takes text, and how many presses it has — and eight
 * hand-written blocks would be eight places for a `rev` to stop being echoed.
 */
function blockFor(verb, ctx) {
  const part = section(headingFor(verb))
  const why = el('p', { class: 'empty' })
  const box = TYPES[verb] === undefined ? null : el('textarea', { attrs: TYPES[verb] })
  const press = el('button', { class: 'press quietly' })
  const deny = verb === 'answer' ? el('button', { class: 'press quietly' }) : null
  const row = el('div', { class: 'presses' })
  // **Two lines, not one.** `how` is a fact about this harness that is true on
  // every frame; `said` is what came of the last press. One node for both
  // would mean the next delta — two seconds away — wiping the answer somebody
  // just got with a sentence they had already read.
  const how = el('p', { class: 'empty' })
  const said = el('p', { attrs: { role: 'status' } })
  const asks = el('div', { class: 'presses' })
  into(part.body, why)
  if (box !== null) into(part.body, box)
  into(row, press)
  if (deny !== null) into(row, deny)
  into(part.body, verb === 'queue' ? asks : row, how, said)

  let held = null
  let going = false
  let asked = false

  const send = async (typed) => {
    if (going || held === null) return
    going = true
    press.disabled = true
    if (deny !== null) deny.disabled = true
    const answer = await ctx.ask(
      'POST',
      `/api/act/${verb}`,
      bodyFor(verb, held, keyOf(), ctx.revOf(), typed),
    )
    going = false
    press.disabled = false
    if (deny !== null) deny.disabled = false
    const came = afterAnswer(answer, ctx.sentence(answer))
    textIn(said, came.said)
    // **Only what actually happened clears the box.** A `409` is the world
    // having moved, and throwing away a paragraph somebody typed on a phone
    // because of it is the one failure they cannot undo.
    if (came.clear && box !== null) box.value = ''
    asked = false
    settle()
  }

  const typedOf = (over = {}) => ({
    said: box?.value ?? '',
    text: box?.value ?? '',
    add: box?.value ?? '',
    summary: box?.value ?? '',
    ...over,
  })

  const settle = () => {
    const word = wordsFor(verb, held ?? {})
    if (word === '') return
    textIn(press, asked ? 'Tap again to confirm' : word)
    classOn(press, 'asked', asked)
  }

  press.addEventListener('click', () => {
    // A second tap for the two that asking again does not undo. The schema's
    // own `confirm` literal is the other half, and neither stands in for the
    // other: this stops a mis-tap, and the literal stops a body that means
    // *do not*.
    if (confirms(verb) && !asked) {
      asked = true
      settle()
      return
    }
    void send(typedOf(verb === 'answer' ? { allow: true } : {}))
  })
  deny?.addEventListener('click', () => void send(typedOf({ allow: false })))
  const choices = []
  for (const ask of verb === 'queue' ? QUEUE_ASKS : []) {
    const one = el('button', { class: 'press quietly', text: ask.said })
    one.addEventListener('click', () => void send(typedOf({ change: ask.change })))
    choices.push({ ask, node: one })
    into(asks, one)
  }

  return {
    node: part.node,
    update(task, standing) {
      held = task
      // Nothing at all for a verb this device was not granted: no heading, no
      // reason, no control.
      part.node.hidden = standing.kind === 'off'
      if (standing.kind === 'off') return
      const shown = standing.kind === 'yes'
      why.hidden = shown
      textIn(why, shown ? '' : standing.why)
      row.hidden = !shown
      asks.hidden = !shown
      said.hidden = !shown
      how.hidden = true
      if (box !== null) box.hidden = !shown
      if (!shown) {
        asked = false
        return
      }
      settle()
      // Built once and hidden per row: parked work has no startable choice,
      // and offering one is a tap that can only be refused.
      const offered = asksFor(task)
      for (const choice of choices) choice.node.hidden = !offered.includes(choice.ask)
      if (deny !== null) textIn(deny, 'Deny')
      const clause = howSaid(standing.how)
      how.hidden = clause === ''
      textIn(how, clause)
    },
  }
}

/**
 * The boxes, and what each one is for.
 *
 * `maxlength` is the server's own bound (`BOUNDS`), so a phone says *that is
 * as much as this takes* while somebody is typing rather than after they send
 * it — and the server still refuses one past it, because a client bound is a
 * courtesy and never a check.
 *
 * **An `aria-label` as well as a placeholder**, because a placeholder is not a
 * label: it goes the moment somebody types, so a screen reader meeting a
 * half-filled box would have nothing to say about what it is for.
 */
const TYPES = {
  steer: {
    rows: '3',
    maxlength: '2000',
    placeholder: 'what to tell its agent',
    'aria-label': 'what to tell its agent',
  },
  note: {
    rows: '3',
    maxlength: '4000',
    placeholder: 'what to write down, as you write it',
    'aria-label': 'what to write down',
  },
  context: {
    rows: '4',
    maxlength: '4000',
    placeholder: 'what to add to what it is told',
    'aria-label': 'what to add to what it is told',
  },
  done: {
    rows: '2',
    maxlength: '500',
    placeholder: 'what it finished as (optional)',
    'aria-label': 'what it finished as',
  },
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
