// One task, and the agent on it — the page a row down the side opens.
//
// **The page template, and one card per question.** The bar is the name with
// its project before it and the presses this device was granted at its end;
// under it one row of facts — how it stands, what it runs on, as whom, its
// branch, its checks, what it cost — and then two columns: the current turn
// with the agent's own screen and its activity where the eye lands, and what
// was asked for, its run, its checks and the controls beside them. One column
// on a phone, in the same order.
//
// **What is absent is still the point.** There is no diff and no transcript —
// each ships source to a phone and to a browser cache. An agent's screen is
// here only as the `lanes` grant has it (`agents.js`, `screen.ts`), and a
// control nothing could carry out is absent with its reason beside it, never
// greyed out (`actsIn`).
//
// **Opening it is never a blank.** Before the first snapshot the facts and the
// card are the shapes that are coming (`skeleton`); before the agent's own
// answer its screen and its activity are; and only a snapshot that has been
// read and does not have this task says that it is not here.

import { mayFor } from '../access.js'
import { actsIn } from '../controls.js'
import {
  classOn,
  el,
  empty,
  glyphOf,
  into,
  keyed,
  markIn,
  proseOf,
  skeleton,
  textIn,
  toneOn,
  unknown,
} from '../dom.js'
import { ageSaid, money, tokensSaid } from '../figures.js'
import { checkMark, rowMark, taskMark } from '../glyphs.js'
import { quickActs } from '../quick.js'
import { pathOf } from '../routes.js'
import {
  createQueueRow,
  dl,
  dlIn,
  fillQueueRow,
  originOf,
  pageBar,
  sayIn,
  section,
} from '../rows.js'
import { runAt, spendFold, taskAt } from '../store.js'
import { facts, factsIn, meter, meterIn, note, panel } from '../ui.js'
import { agentPane } from './agent-pane.js'

export function taskScreen(where, ctx) {
  const node = el('div', { class: 'task' })
  const glyph = glyphOf(taskMark('queued'))
  const bar = pageBar(where.task, {
    name: true,
    glyph,
    back: { text: where.project, href: pathOf({ view: 'project', project: where.project }) },
  })
  // The state as a pill beside the name, in its tone, readable across a desk.
  const pill = el('span', { class: 'ui-pill' })
  bar.heading.after(pill)
  // The presses this device was granted, at the end of the bar: the answer to
  // an agent that is waiting is the reason somebody opened this page.
  const quick = ctx === undefined || ctx === null ? null : quickActs(ctx, { tell: false })
  if (quick !== null) into(bar.tools, quick.node)

  const gone = el('p', { class: 'empty nothing' })
  gone.hidden = true
  const coming = el('div', { class: 'task-coming', attrs: { 'aria-label': 'Loading this agent' } })
  into(coming, skeleton(2), skeleton(8))
  const strip = facts('This agent')

  // The agent's own: its current turn and screen, and what it has been doing,
  // asked for while this page is open and not a moment after (`leave`).
  const pane = ctx === undefined || ctx === null ? null : agentPane(where, ctx)
  const now = nowOf(pane?.head ?? null)

  const asked = section('ASKED FOR')
  const run = section('RUN')
  const checks = section('CHECKS')
  const rest = section('ABOUT')
  const made = partsOf(run, checks, rest)
  const acts = section('ACTIONS')
  acts.node.classList.add('task-acts')
  const parts = [asked, run, checks, rest]

  const grid = el('div', { class: 'task-grid' })
  const lead = el('div', { class: 'task-lead' })
  const side = el('div', { class: 'task-side' })
  into(lead, ...(pane?.nodes ?? []))
  into(side, asked.node, run.node, checks.node, rest.node, acts.node)
  into(grid, lead, side)
  into(node, bar.node, coming, gone, strip, grid)
  // **Every control the page has, built once** — one block per verb, each
  // hidden until the row says it may be asked for, so what somebody has typed
  // into one survives every delta.
  const controls = ctx === undefined || ctx === null ? null : actsIn(acts.body, ctx)

  return {
    node,
    update(view) {
      const had = view.store.had === true
      const task = had ? taskAt(view.store, where.project, where.task) : null
      coming.hidden = had
      gone.hidden = !had || task !== null
      textIn(gone, had && task === null ? 'Not on this device' : '')
      strip.hidden = task === null
      grid.hidden = task === null
      if (task === null) return
      pane?.update(view)
      const mark = rowMark(task)
      markIn(glyph, mark)
      textIn(pill, mark.word)
      toneOn(pill, mark.tone)
      quick?.update(task, view)
      factsIn(strip, stripOf(task, view.store))
      now.update(task, view)
      askedIn(asked, task, view.store)
      runIn(made, run, task, view)
      checksIn(made, checks, task)
      restIn(made, task, view)
      controls?.update(task, view)
      // A block of controls nothing could be drawn in is not a heading.
      acts.node.hidden = [...acts.body.children].every((one) => one.hidden)
      for (const one of parts) one.node.hidden = false
    },
    leave() {
      pane?.leave()
    },
  }
}

/**
 * The row of facts under the bar: how it stands, what it runs on and as whom,
 * where its work is, and what it cost — each a dash where it is unknown, and
 * the account and the money saying *not granted* where that is why.
 */
export function stripOf(task, store) {
  const mark = rowMark(task)
  const account = mayFor(store, 'tasks.account') ? (task.account?.words ?? null) : 'not granted'
  const paid = money(task.spend === null ? null : spendFold([task]), mayFor(store, 'tasks.spend'))
  const toks = tokensSaid(task.spend === null ? null : spendFold([task]))
  const ahead = [
    task.ahead === null || task.ahead === 0 ? null : `${task.ahead} ahead`,
    task.behind === null || task.behind === 0 ? null : `${task.behind} behind`,
    task.dirty === null || task.dirty === 0 ? null : `${task.dirty} changed`,
  ].filter((one) => one !== null)
  const check = checkMark(task.checks.state)
  return [
    { label: 'State', value: mark.word, tone: mark.tone, under: task.stalled ? 'stalled' : null },
    { label: 'Harness', value: task.harness, under: task.model },
    { label: 'Account', value: account },
    {
      label: 'Branch',
      value: task.branch,
      under: [...ahead, task.shared ? 'shared checkout' : task.workspace].join(' · '),
    },
    { label: 'Checks', value: check.word, tone: check.tone },
    {
      label: 'Spend',
      value: paid.said,
      under: paid.said === '—' ? paid.why : toks === null ? null : `${toks.said} tokens`,
    },
  ]
}

/**
 * The current turn, on the top line of the screen's card: its mark, what it is
 * doing in `deriveState`'s own words, how long since it moved — and, where an
 * approval is waiting, the tool's name and never its arguments, which are the
 * field that reliably holds a path and a credential.
 */
function nowOf(head) {
  if (head === null) return { update() {} }
  const glyph = glyphOf(taskMark('working'))
  const said = el('span', { class: 'term-said' })
  const tool = el('span', { class: 'ui-pill is-mono t-wants' })
  const age = el('span', { class: 'aside' })
  into(head, glyph, said, tool, age)
  return {
    update(task, view) {
      const mark = rowMark(task)
      markIn(glyph, mark)
      textIn(said, task.reason === '' ? mark.word : task.reason)
      toneOn(said, task.approval ? 't-wants' : '')
      tool.hidden = !task.approval
      textIn(tool, task.approval ? task.approval.tool : '')
      const moved = ageSaid(task.movedAt, view.asOf, view.frozen)
      textIn(age, moved === null ? '' : moved)
      age.setAttribute('aria-label', moved === null ? 'never moved' : `moved ${moved} ago`)
    },
  }
}

/**
 * Every part of the side column, built once: these hold the run, the checks
 * and the review — things somebody selects — and the page repaints every two
 * seconds, so each `*In` writes text and toggles `hidden`, and nothing under
 * here is created or removed after this.
 */
function partsOf(run, checks, rest) {
  const made = {
    run: el('a', { class: 'ui-card is-link task-run', attrs: { href: '/' } }),
    runName: el('span', { class: 'name' }),
    runSaid: el('span', { class: 'aside' }),
    runMeter: meter(),
    noRun: unknown('in no run'),
    queue: panel('ul', 'queue'),
    checksNames: dl(),
    overruled: note(
      'overruled',
      'a failing check here was overruled, with a reason, at the machine',
      'alert',
    ),
    rest: dl(),
    origin: el('p', { class: 'aside' }),
    findings: el('a', { class: 'ui-chip', attrs: { href: '/findings' } }),
  }
  into(made.run, made.runName, made.runSaid, made.runMeter)
  into(run.body, made.run, made.noRun, made.queue)
  into(checks.body, made.checksNames, made.overruled)
  into(rest.body, made.rest, made.origin, made.findings)
  return made
}

/**
 * What somebody asked for, in their own words, folded to three lines —
 * **verbatim, and never reworded**. A device granted neither the titles nor the
 * intent is told *that*, rather than that nobody wrote anything down. Written
 * once: rebuilding it would close a fold somebody had opened.
 */
function askedIn(made, task, store) {
  if (made.body.children.length > 0) return
  if (!mayFor(store, 'tasks.intent') && !mayFor(store, 'tasks.title')) {
    into(made.body, unknown('not granted to this device'))
    return
  }
  const said = task.intent ?? task.title
  const card = panel('div', 'asked')
  into(card, proseOf(said, true) ?? empty('nothing written down'))
  if (task.intent !== null && task.title !== null) {
    into(card, el('p', { class: 'aside', text: 'as a title' }), proseOf(task.title))
  }
  into(made.body, card)
}

/** The run it is part of, how far along that run is, and its place in the queue. */
function runIn(made, section_, task, view) {
  const effort = task.effort ?? null
  const row = effort === null ? null : runAt(view.store, effort)
  made.run.hidden = effort === null
  made.noRun.hidden = effort !== null
  if (effort !== null) {
    made.run.setAttribute('href', pathOf({ view: 'run', run: effort }))
    textIn(made.runName, effort)
    textIn(made.runSaid, row === null ? '' : `${row.finished} of ${row.total} done`)
    made.runMeter.hidden = row === null || row.total === 0
    if (row !== null && row.total > 0) meterIn(made.runMeter, (100 * row.finished) / row.total)
  }
  const queue = view.store.rows.queue.get(task.id)
  keyed(
    made.queue,
    queue === undefined ? [] : [queue],
    (one) => one.task,
    createQueueRow,
    (one, one_) => fillQueueRow(one, one_, { ...view, project: task.project }),
  )
  textIn(
    section_.figure,
    row === null ? '' : `${row.projects.length} project${row.projects.length === 1 ? '' : 's'}`,
  )
}

/**
 * Its checks: the word in its tone is the strip's; here which were red and
 * which nobody ran, and that a red run was overruled — still recorded red.
 */
function checksIn(made, section_, task) {
  const mark = checkMark(task.checks.state)
  textIn(section_.figure, mark.word)
  toneOn(section_.figure, mark.tone)
  dlIn(made.checksNames, [
    ['red', task.checks.failed.length === 0 ? null : task.checks.failed.join(', ')],
    ['not run', task.checks.missing.length === 0 ? null : task.checks.missing.join(', ')],
  ])
  made.checksNames.hidden = task.checks.failed.length + task.checks.missing.length === 0
  made.overruled.hidden = !task.checks.overridden
}

function restIn(made, task, view) {
  const produces = task.produces
  dlIn(made.rest, [
    ['done when', task.done],
    ['effort', task.effort],
    [
      'produces',
      produces === null ? null : `${produces.name} · ${produces.written ? 'written' : 'not yet'}`,
    ],
    ['review', task.review === null ? null : task.review.state],
    ['workspace', task.shared ? `${task.workspace} · shared` : task.workspace],
    ['agents', String(task.agents), `${task.agents} agents`],
    ['lanes', String(task.lanes), `${task.lanes} lanes`],
  ])
  textIn(made.origin, originOf(task))
  const found = [...view.store.rows.findings.values()].filter((one) => one.tasks.includes(task.id))
  made.findings.hidden = found.length === 0
  textIn(made.findings, `${found.length} finding${found.length === 1 ? '' : 's'} ›`)
  classOn(made.findings, 't-wants', found.length > 0)
  sayIn(made.origin, originOf(task))
}
