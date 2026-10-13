// The two screens about one piece of work: a project, and a task. The third,
// the overview across every project, is `overview.js`.
//
// Each returns its node and an `update`, because **a screen is built once and
// then patched** — nothing re-creates a region because a figure moved, so the
// keyboard keeps its row, a half-made selection survives, and the scroll
// position stays the browser's own business.
//
import { mayFor } from './access.js'
import {
  afterAnswer,
  asksFor,
  bodyFor,
  confirms,
  controlsFor,
  headingFor,
  howSaid,
  PROJECT_SHOWN,
  QUEUE_ASKS,
  SHOWN,
  wordsFor,
} from './acts.js'
import { classOn, el, empty, into, keyed, textIn } from './dom.js'
import { count, money, onPlan, sinceSaid, tokensSaid } from './figures.js'
import { checkMark } from './glyphs.js'
import { glanceOf, glanceTiles, tilesIn } from './overview.js'
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
} from './rows.js'
import { omitted, projectAt, queueIn, spendFold, spendSince, tasksIn } from './store.js'
import { answerIn, note, panel } from './ui.js'

/* The overview is `overview.js`: the landing screen has grown its own file. */

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

/* ── the controls a task's page and a project's page are built with ──────── */

/* One task's own page is `task.js`; its controls are these. */

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
export function actsIn(node, ctx, verbs = SHOWN) {
  const blocks = new Map()
  for (const verb of verbs) {
    const block = blockFor(verb, ctx)
    blocks.set(verb, block)
    into(node, block.node)
  }
  return {
    update(row, view) {
      const acts = view.may.acts ?? { answer: false, steer: false }
      for (const one of controlsFor(row, acts, verbs)) {
        blocks.get(one.verb)?.update(row, one)
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
    answerIn(said, came.said, came.trouble)
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
      // Hidden where there is nothing to say as well as where the control is
      // drawn: a row from a server that mentioned this verb in neither list
      // has no reason to give, and an empty paragraph under a heading reads as
      // something that failed to load.
      why.hidden = shown || standing.why === ''
      textIn(why, shown ? '' : standing.why)
      // A block that can only say why not is one line, not a section: its
      // heading and its reason side by side, quiet, so the presses that can be
      // pressed are what the eye lands on.
      classOn(part.node, 'is-off', !shown)
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
