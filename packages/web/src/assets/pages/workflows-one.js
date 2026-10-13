// One workflow: whether it is published and whether its draft would publish,
// the shape its steps make, each step stage by stage, what a run of it is
// given, and what was run from it.
//
// **What somebody opening this wants first** is whether the thing is ready —
// published, a draft open, a draft that would not publish — and what it does.
// So it leads with one card that says that and draws the versions, then what
// would stop it publishing where anything would, then the shape: as boxes and
// curves where the work has the width, and always as stages down a rail with
// each step's card on it. What a run is given, the runs and what stays at the
// machine are short, and sit beside the steps at a desk.
//
// **Editing is one tap away and never in the way.** A device that may save a
// field of the draft gets one press on the card for the template and one on
// each step's card, which open that scope's form; nothing else on the screen
// is a box. Where it may not, the reason is said once, at the top — never
// under every field. There is no publish, no new, no rename and no delete:
// each decides what every future run does and stays at the machine, named
// with its clause (`locally`).

import { mayFor } from '../access.js'
import { savingOf } from '../acts.js'
import { flow, flowIn } from '../charts.js'
import {
  classOn,
  el,
  glyphOf,
  into,
  keyed,
  markIn,
  proseOf,
  skeleton,
  textIn,
  toneOn,
} from '../dom.js'
import { pathOf } from '../routes.js'
import { createSaidRow, fillSaidRow, pageBar, sayIn, section } from '../rows.js'
import { runsOf, workflowAt } from '../store.js'
import { note, panel, stateBox, stateBoxIn } from '../ui.js'
import { figureSaid, runsLine, runsLineIn, versionLine, versionLineIn } from './workflows-draw.js'
import { form } from './workflows-form.js'
import {
  fitsAcross,
  foldsAt,
  graphOf,
  RUN_MARKS,
  readinessOf,
  runStandingOf,
  runsFrom,
  runsLineOf,
  stagesOf,
  standingMark,
  standingOf,
  stateOf,
  stepFactsOf,
} from './workflows-shape.js'

export function workflowScreen(where, ctx) {
  const node = el('div')
  const glyph = glyphOf(standingMark('empty'))
  const bar = pageBar(where.name, {
    name: true,
    glyph,
    back: { text: 'Workflows', href: '/workflows' },
  })
  const coming = skeleton(4)
  const gone = stateBox()

  const hero = heroOf(ctx)

  const before = section('BEFORE IT PUBLISHES')
  const beforeList = panel('ul', 'rows wf-before')
  into(before.body, beforeList)

  const shape = section('THE SHAPE')
  const drawing = flow('The steps, and what each waits on')
  into(shape.body, drawing)

  const cols = el('div', { class: 'wf-cols' })
  const main = el('div', { class: 'wf-main' })
  const side = el('div', { class: 'wf-side' })

  const steps = section('STEP BY STEP')
  const rail = el('ol', { class: 'wf-rail' })
  const noSteps = stateBox()
  into(steps.body, rail, noSteps)

  const given = section('WHAT A RUN IS GIVEN')
  const inputList = panel('ul', 'rows')
  const noInputs = el('p', { class: 'empty nothing', text: 'Nothing: a run of it takes no input.' })
  into(given.body, inputList, noInputs)

  const ran = section('RUNS FROM IT')
  const runList = panel('ul', 'rows')
  const ranNone = el('p', { class: 'empty nothing' })
  const ranMore = el('p', { class: 'unknown' })
  into(ran.body, runList, ranNone, ranMore)

  const machine = section('AT THE MACHINE')
  const locally = el('ul', { class: 'wf-locally' })
  into(machine.body, locally)

  into(main, steps.node)
  into(side, given.node, ran.node, machine.node)
  into(cols, main, side)

  const parts = [hero, before, shape, { node: cols }]
  into(node, bar.node, coming, gone, ...parts.map((one) => one.node))

  return {
    node,
    update(view) {
      const had = view.store.had === true
      const row = had ? workflowAt(view.store, where.name) : null
      coming.hidden = had
      stateBoxIn(
        gone,
        had && row === null
          ? mayFor(view.store, 'workflows')
            ? stateOf(
                'empty',
                'No workflow by that name',
                'It may have been renamed or removed at the machine. The workflows there are under Workflows.',
              )
            : stateOf(
                'empty',
                'Not granted to this device',
                'The workflows are a grant of their own, given at the machine when a device is paired.',
              )
          : null,
      )
      for (const one of parts) one.node.hidden = row === null
      glyph.hidden = row === null
      if (row === null) return

      const runs = runsOf(view.store)
      const acts = view.may.acts ?? {}
      markIn(glyph, standingMark(standingOf(row)))
      hero.fill(row, runs, view)

      // What would stop it publishing, and what it would publish with: only
      // where there is any, because *nothing* is already the hero's ✓.
      const said = [
        ...row.problems.map((one) => ({ said: one, bad: true })),
        ...row.warnings.map((one) => ({ said: one, bad: false })),
      ]
      before.node.hidden = said.length === 0
      figureSaid(before.figure, said.length === 0 ? '' : String(said.length), said.length, 'things')
      keyed(beforeList, said, (one) => one.said, createSaidRow, fillSaidRow)

      // **Across or not at all**: where the boxes would not fit, the stages
      // under them are the same graph drawn down (`fitsAcross`). The room is
      // read off the screen itself, which is on the page by the time it is
      // first painted (`boot.js` attaches, then paints).
      const graph = graphOf(row)
      const across = fitsAcross(graph, node.clientWidth)
      shape.node.hidden = !across
      if (across) flowIn(drawing, graph, 'right')

      const staged = stagesOf(row)
      const n = row.places.length
      figureSaid(steps.figure, n === 0 ? '' : String(n), n, 'steps')
      const may = savingOf(row, {}, acts).kind === 'yes'
      keyed(
        rail,
        staged,
        (stage) => stage.key,
        createStage,
        (one, stage) => fillStage(one, stage, row, may, ctx, view),
      )
      stateBoxIn(
        noSteps,
        staged.length > 0
          ? null
          : stateOf(
              'empty',
              'No steps yet',
              row.draft === null
                ? 'There is no draft to add one to: steps are written at the machine.'
                : 'Steps are added to the draft at the machine; their fields can then be filled in here.',
            ),
      )

      fillInputs(inputList, noInputs, given, row)

      const seen = runsFrom(row, runs)
      const line = runsLineOf(row, runs)
      figureSaid(ran.figure, line.total === 0 ? '' : String(line.total), line.total, 'runs')
      keyed(runList, seen, (run) => run.run, createRunRow, fillRunRow)
      runList.hidden = seen.length === 0
      sayIn(
        ranNone,
        line.total === 0
          ? 'Nothing has been run from it yet. A run is stamped from a published version.'
          : '',
      )
      const unseen = line.total - seen.length
      sayIn(
        ranMore,
        unseen === 0
          ? ''
          : `${unseen} ${unseen === 1 ? 'run is' : 'runs are'} in projects this device may not read`,
      )

      machine.node.hidden = row.locally.length === 0
      keyed(
        locally,
        row.locally,
        (one) => `${one.act}:${one.why}`,
        (one) => into(el('li'), note(`${one.act}, at the machine`, one.why, 'laptop')),
        () => {},
      )
    },
  }
}

/* ── the hero: ready or not, what it is, and its versions ──────────────────── */

/**
 * The card a person's eye lands on: what the workflow is for, whether its
 * draft would publish, its versions drawn with the runs on each, and — where
 * this device may save — the one press that opens the template's own fields.
 */
function heroOf(ctx) {
  const node = el('div', { class: 'ui-card wf-hero' })
  const text = el('div', { class: 'wf-hero-text' })
  const heading = el('p', { class: 'wf-hero-title' })
  const about = el('div', { class: 'wf-hero-about' })
  const ready = el('p', { class: 'wf-ready' })
  into(
    ready,
    el('span', { class: 'glyph', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'wf-ready-said' }),
  )
  const saving = el('p', { class: 'wf-hero-saving' })
  into(text, heading, about, ready, saving)

  const versions = el('div', { class: 'wf-hero-versions' })
  const line = versionLine('is-big')
  const ranLine = runsLine()
  into(versions, el('p', { class: 'wf-hero-label', text: 'Versions' }), line, ranLine)

  const edit = el('div', { class: 'wf-hero-edit' })
  const made = form(ctx, 'The template’s own fields')
  const open = foldPress('Edit the template', made.node)
  into(edit, open, made.node)

  const top = el('div', { class: 'wf-hero-top' })
  into(top, text, versions)
  into(node, top, edit)
  return {
    node,
    fill(row, runs, view) {
      textIn(heading, row.title?.words || 'No title yet')
      classOn(heading, 'is-missing', !row.title?.words)
      proseIn(about, row.about, false)
      const said = readinessOf(row)
      const [mark, words] = ready.children
      textIn(mark, said.glyph)
      toneOn(mark, said.tone)
      textIn(words, said.said)
      const acts = view.may.acts ?? {}
      const standing = savingOf(row, {}, acts)
      sayIn(saving, savingSaid(row, standing))
      versionLineIn(line, row, runs)
      runsLineIn(ranLine, runsLineOf(row, runs))
      edit.hidden = standing.kind !== 'yes' || row.fields.length === 0
      if (!edit.hidden) made.update(row, { scope: 'template', fields: row.fields }, view)
    },
  }
}

/**
 * Whether its fields can be filled in from here, in one line, or nothing.
 *
 * **Said once, and only what the line above has not said**: one Tade ships
 * already says why in its readiness, and a published version with no draft
 * is told where a draft is opened rather than that it is not one. A device
 * that was not granted saving is told nothing, because a sentence naming a
 * scope somebody does not have is a map of what else to ask for.
 */
function savingSaid(row, standing) {
  if (standing.kind === 'yes') {
    return 'Its fields can be filled in from here. Publishing stays at the machine.'
  }
  if (standing.kind !== 'no' || row.builtIn) return ''
  if (row.shows !== 'draft')
    return 'A published version never changes. A draft of it is opened at the machine.'
  return `${standing.why.charAt(0).toUpperCase()}${standing.why.slice(1)}.`
}

/* ── the steps, stage by stage ─────────────────────────────────────────────── */

function createStage() {
  const item = el('li', { class: 'wf-stage' })
  const head = el('div', { class: 'wf-stage-head' })
  into(
    head,
    el('span', { class: 'wf-stage-n', attrs: { 'aria-hidden': 'true' } }),
    el('p', { class: 'wf-stage-label' }),
  )
  const list = el('ul', { class: 'wf-steps' })
  return into(item, head, list)
}

function fillStage(item, stage, row, may, ctx, view) {
  const [head, list] = item.children
  const [n, label] = head.children
  textIn(n, stage.n === null ? '↻' : String(stage.n))
  textIn(label, stage.n === null ? stage.label : `Stage ${stage.n} · ${stage.label}`)
  classOn(item, 'is-cycle', stage.n === null)
  keyed(
    list,
    stage.steps,
    (one) => one.name,
    () => createStep(ctx),
    (one, entry) => fillStep(one, entry, row, may, view),
  )
}

/**
 * One step's card: its name and who does it, what it waits on and why, its
 * facts, what its agent is told, and — where the draft can be saved from
 * here — a press that opens its form. Built once, so a form somebody is part
 * way through survives every delta.
 */
function createStep(ctx) {
  const item = el('li', { class: 'ui-card wf-step' })
  const head = el('div', { class: 'wf-step-head' })
  const name = el('h3', { class: 'wf-step-name' })
  const persona = el('span', { class: 'ui-pill' })
  const model = el('span', { class: 'ui-pill is-mono' })
  into(head, name, persona, model)
  const waits = el('ul', { class: 'wf-waits', attrs: { 'aria-label': 'Waits on' } })
  const facts = el('dl', { class: 'wf-facts' })
  const told = el('div', { class: 'wf-told' })
  into(told, el('p', { class: 'wf-told-label', text: 'Told' }), el('div'))
  const cycle = el('p', { class: 'wf-step-cycle' })
  const made = form(ctx, 'This step’s fields')
  const open = foldPress('Edit this step', made.node)
  const foot = el('div', { class: 'wf-step-edit' })
  into(foot, open, made.node)
  into(item, head, waits, facts, told, cycle, foot)
  item.wf = { name, persona, model, waits, facts, told, cycle, foot, made, open }
  return item
}

function fillStep(item, entry, row, may, view) {
  const parts = item.wf
  const step = entry.step
  textIn(parts.name, entry.name)
  sayIn(parts.persona, step?.persona ?? '')
  sayIn(parts.model, step?.model ?? '')
  keyed(parts.waits, entry.waits, (one) => one.on, createWait, fillWait)
  parts.waits.hidden = entry.waits.length === 0
  factsIn(parts.facts, step === null ? [] : stepFactsOf(step))
  const [, prompt] = parts.told.children
  proseIn(prompt, step?.prompt ?? null, foldsAt(step?.prompt))
  parts.told.hidden = step?.prompt === null || step?.prompt === undefined
  sayIn(
    parts.cycle,
    entry.waits.length > 0 && row.places.find((one) => one.name === entry.name)?.circular
      ? 'It waits, directly or not, on itself. Publishing refuses this; change what it waits on to undo it.'
      : '',
  )
  parts.foot.hidden = !may || step === null || step.fields.length === 0
  if (!parts.foot.hidden) {
    parts.made.update(row, { scope: entry.name, fields: step.fields }, view)
  }
}

function createWait() {
  const item = el('li', { class: 'wf-wait' })
  into(
    item,
    el('span', { class: 'wf-wait-arrow', text: '↳', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'wf-wait-on' }),
    el('span', { class: 'wf-wait-why' }),
  )
  return item
}

function fillWait(item, wait) {
  const [, on, why] = item.children
  textIn(on, `after ${wait.on}`)
  // **A wait with no reason given is the one thing `checkPlan` cannot tell you
  // anything useful about**, so the absence is said rather than left blank.
  const none = wait.why === null || wait.why.words === ''
  textIn(why, none ? 'no reason given' : wait.why.words)
  classOn(why, 'is-missing', none)
}

/** A step's facts as names and values, patched pair by pair. */
function factsIn(list, facts) {
  while (list.children.length > facts.length * 2) list.lastElementChild?.remove()
  while (list.children.length < facts.length * 2) into(list, el('dt'), el('dd'))
  facts.forEach((one, at) => {
    textIn(list.children[at * 2], one.label)
    const value = list.children[at * 2 + 1]
    textIn(value, one.value)
    classOn(value, 'is-mono', one.mono)
  })
  list.hidden = facts.length === 0
}

/* ── what a run is given ───────────────────────────────────────────────────── */

/** What each input is to the workflow, where the template says it is something. */
function rolesOf(row, name) {
  const roles = []
  if (row.projectInput === name) roles.push('names the repository')
  if (row.saidInput === name) roles.push('becomes the task’s sentence')
  if (row.nameSuffix === name) roles.push('ends every task name')
  return roles
}

function fillInputs(list, none, made, row) {
  const n = row.inputs.length
  figureSaid(made.figure, n === 0 ? '' : String(n), n, 'inputs')
  none.hidden = row.inputs.length > 0
  list.hidden = row.inputs.length === 0
  keyed(
    list,
    row.inputs,
    (input) => input.name,
    () => {
      const item = el('li')
      const body = el('div', { class: 'row-static wf-input' })
      into(
        body,
        el('span', { class: 'name' }),
        el('span', { class: 'aside' }),
        el('span', { class: 'under' }),
      )
      return into(item, body)
    },
    (item, input) => {
      const [body] = item.children
      const [name, aside, under] = body.children
      textIn(name, input.name)
      textIn(aside, input.required ? input.kind : `${input.kind}, optional`)
      const roles = rolesOf(row, input.name)
      textIn(under, [...roles, input.about?.words ?? ''].filter(Boolean).join(' · '))
    },
  )
}

/* ── the runs stamped from it ──────────────────────────────────────────────── */

function createRunRow() {
  const item = el('li')
  const link = el('a', { attrs: { href: '/runs' } })
  const glyph = glyphOf(RUN_MARKS.waiting)
  into(
    link,
    glyph,
    el('span', { class: 'name' }),
    el('span', { class: 'aside' }),
    el('span', { class: 'under' }),
  )
  return into(item, link)
}

function fillRunRow(item, run) {
  const [link] = item.children
  const [glyph, name, aside, under] = link.children
  link.setAttribute('href', pathOf({ view: 'run', run: run.run }))
  const mark = RUN_MARKS[runStandingOf(run)]
  markIn(glyph, mark)
  textIn(name, run.run)
  textIn(aside, `v${run.stamp.version}`)
  aside.setAttribute('aria-label', `stamped from version ${run.stamp.version}`)
  textIn(
    under,
    run.total === 0 ? mark.word : `${mark.word} · ${run.finished} of ${run.total} steps finished`,
  )
}

/* ── the small things ──────────────────────────────────────────────────────── */

/**
 * A press that opens a region under it and closes it again, with
 * `aria-expanded` — wired once, so a delta never closes a form somebody has
 * open. The region starts closed.
 */
let folds = 0

function foldPress(word, region) {
  folds += 1
  const id = `wf-fold${folds}`
  region.setAttribute('id', id)
  region.hidden = true
  const press = el('button', {
    class: 'press quietly small wf-fold',
    text: word,
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': id },
  })
  press.addEventListener('click', () => {
    region.hidden = !region.hidden
    press.setAttribute('aria-expanded', region.hidden ? 'false' : 'true')
    textIn(press, region.hidden ? word : 'Close')
  })
  return press
}

/**
 * Free text somebody wrote, redrawn **only when its words changed** — a fold
 * somebody opened stays open across every delta that said the same thing.
 */
function proseIn(holder, said, folded) {
  const words =
    said === null || said === undefined ? '' : `${said.more ? 1 : 0}${folded ? 1 : 0}${said.words}`
  if (holder.getAttribute('data-words') === words) return
  holder.setAttribute('data-words', words)
  holder.replaceChildren()
  into(holder, proseOf(said, folded))
  holder.hidden = words === ''
}
