// The workflow designer, as two screens: the workflows there are, and one
// workflow as a list, a form and a dry run.
//
// **A list, a form and a dry run — never a canvas.** That is
// `templates-edit.ts`'s own decision carried onto a phone rather than a new
// one: a template has three to five steps with one shape, a canvas is for a
// graph you do not already know, and positions are noise in every diff. The
// form's rows are `workflowFields`' own, which is the same form the window
// walks, so neither surface can offer a field the validator would refuse.
//
// **A published version is a snapshot and never changes.** `versions` is the
// list of them and `draft` is the one thing an edit can reach, so what is
// published cannot move under a run that is going.
//
// **What is absent is the point.** There is no publish, no new, no rename and
// no delete: each of those decides what every future run does, and each is an
// act at the machine with no route at all. They are *named* with their clause
// (`locally`) rather than left as holes.

import { afterAnswer, draftBody, savingOf } from './acts.js'
import { el, glyphOf, into, keyed, markIn, proseOf, textIn } from './dom.js'
import { count } from './figures.js'
import { checkMark } from './glyphs.js'
import { nothingSaid } from './pages.js'
import { pathOf } from './routes.js'
import {
  createLocally,
  createSaidRow,
  createWaitRow,
  dl,
  dlIn,
  fillLocally,
  fillSaidRow,
  fillWaitRow,
  sayIn,
  section,
} from './rows.js'
import { mayRead, omitted, workflowAt, workflowsOf } from './store.js'

/* ── the workflows ─────────────────────────────────────────────────────────── */

export function workflowsScreen() {
  const node = el('div')
  const made = section('WORKFLOWS', { top: true })
  const list = el('ul', { class: 'rows' })
  const none = el('p', { class: 'empty' })
  into(made.body, list, none)
  into(node, made.node)

  return {
    node,
    update(view) {
      const rows = workflowsOf(view.store)
      const total = rows.length + omitted(view.store, 'workflows')
      textIn(made.figure, count(total))
      made.figure.setAttribute('aria-label', `${total} workflows`)
      none.hidden = rows.length > 0
      textIn(
        none,
        rows.length > 0
          ? ''
          : nothingSaid(
              mayRead(view.store, 'workflows'),
              total,
              'no workflow has been written here',
            ),
      )
      keyed(list, rows, (row) => row.name, createWorkflowRow, fillWorkflowRow)
    },
  }
}

function createWorkflowRow() {
  const node = el('li')
  const link = el('a', { attrs: { href: '/workflows' } })
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  const under = el('span', { class: 'under' })
  into(link, name, aside, under)
  return into(node, link)
}

function fillWorkflowRow(node, row) {
  const [link] = node.children
  const [name, aside, under] = link.children
  link.setAttribute('href', pathOf({ view: 'workflow', name: row.name }))
  textIn(name, row.name)
  textIn(aside, row.published === null ? 'not published' : `v${row.published}`)
  aside.setAttribute(
    'aria-label',
    row.published === null ? 'no published version' : `published version ${row.published}`,
  )
  textIn(under, workflowSays(row))
}

/**
 * One workflow in a line.
 *
 * **A published version and a draft are said apart**, always: a published
 * version is a snapshot a run can still point at and never changes, and a
 * draft is a file no run reads. Collapsing them would make *v3* mean two
 * different things on one screen.
 */
export function workflowSays(row) {
  const bits = []
  if (row.builtIn) bits.push('one Tade ships')
  if (row.draft !== null) bits.push(`draft v${row.draft}`)
  if (row.steps.length > 0)
    bits.push(`${row.steps.length} ${row.steps.length === 1 ? 'step' : 'steps'}`)
  if (row.runs > 0) bits.push(`${row.runs} ${row.runs === 1 ? 'run' : 'runs'}`)
  if (row.problems.length > 0) bits.push(`${row.problems.length} would stop it publishing`)
  return bits.join(' · ')
}

/* ── one workflow: the designer ────────────────────────────────────────────── */

/**
 * One workflow, as a list, a form and a dry run.
 *
 * **Three regions and no fourth.** The list is the steps in the order they go,
 * with what each waits on; the form is `workflowFields`' own rows, which is
 * the same form the window walks, so neither can offer a field the validator
 * would refuse; and the dry run is `dryRunOf`'s own answer — what would be
 * made, what it grants, and what bounds it — which is the thing that makes a
 * stored workflow safe to have at all.
 *
 * **What is absent is the point.** There is no publish, no new, no rename and
 * no delete: each of those decides what every future run does, and each is an
 * act at the machine with no route at all. They are *named* with their clause
 * (`locally`) rather than left as holes.
 */
export function workflowScreen(where, ctx) {
  const node = el('div')
  const back = el('a', { class: 'back', text: '‹ Workflows', attrs: { href: '/workflows' } })
  const head = el('div', { class: 'page-head' })
  const title = el('h1', { text: where.name })
  into(head, title)
  const gone = el('p', { class: 'empty' })

  const about = section('THE WORKFLOW')
  const facts = dl()
  const says = el('div')
  into(about.body, facts, says)

  const problems = section('WHAT WOULD STOP IT PUBLISHING')
  const problemList = el('ul', { class: 'rows' })
  const problemNone = el('p', { class: 'empty', text: 'nothing: it would publish as it stands' })
  into(problems.body, problemList, problemNone)

  const steps = section('THE STEPS')
  const stepList = el('div')
  const stepNone = el('p', { class: 'empty' })
  into(steps.body, stepList, stepNone)

  const form = section('THE TEMPLATE’S OWN FIELDS')
  const formBody = formIn(form.body, ctx)

  const shape = section('THE SHAPE A RUN TAKES')
  const shapeBody = shapeIn(shape.body)

  const stays = section('AT THE MACHINE')
  const locally = el('ul', { class: 'locally' })
  into(stays.body, locally)

  const parts = [about, problems, steps, form, shape, stays]
  into(node, back, head, gone, ...parts.map((one) => one.node))

  return {
    node,
    update(view) {
      const row = workflowAt(view.store, where.name)
      gone.hidden = row !== null
      textIn(
        gone,
        row === null
          ? mayRead(view.store, 'workflows')
            ? 'There is no workflow by that name here.'
            : 'This device was not granted the workflows.'
          : '',
      )
      for (const one of parts) one.node.hidden = row === null
      if (row === null) return
      dlIn(facts, [
        [
          'published',
          row.versions.length === 0 ? 'never' : row.versions.map((v) => `v${v}`).join(', '),
        ],
        ['draft', row.draft === null ? 'none' : `v${row.draft}`],
        // **Which template the steps below are of.** A draft is a file nothing
        // runs and the one thing an edit reaches; a published snapshot is what
        // a run points at and never changes. Said, because `v3` meaning two
        // things on one screen is the ambiguity this row must not have.
        ['the steps below', SHOWS[row.shows] ?? row.shows],
        ['runs pointing at it', String(row.runs)],
        ['names the repository', row.projectInput],
        ['becomes the sentence', row.saidInput],
        ['name tail', row.nameSuffix],
      ])
      says.replaceChildren()
      into(says, proseOf(row.about))
      keyed(
        problemList,
        [
          ...row.problems.map((said) => ({ said, bad: true })),
          ...row.warnings.map((said) => ({ said, bad: false })),
        ],
        (one) => one.said,
        createSaidRow,
        fillSaidRow,
      )
      problemNone.hidden = row.problems.length + row.warnings.length > 0
      keyed(
        stepList,
        row.steps,
        (step) => step.name,
        createStepBlock,
        (one, step) => fillStepBlock(one, step, row, ctx, view),
      )
      stepNone.hidden = row.steps.length > 0
      textIn(
        stepNone,
        row.steps.length > 0
          ? ''
          : row.draft === null
            ? 'there is no draft: what is published is a snapshot nothing may change'
            : 'this draft has no steps yet',
      )
      formBody.update(row, { scope: 'template', fields: row.fields }, view)
      shapeBody.update(row, view)
      keyed(locally, row.locally, (one) => one.act, createLocally, fillLocally)
    },
  }
}

function createStepBlock() {
  const node = el('div', { class: 'section' })
  const head = el('h3', { class: 'aside' })
  const facts = dl()
  const prompt = el('div')
  const waits = el('ul', { class: 'waits' })
  const form = el('div')
  return into(node, head, facts, prompt, waits, form)
}

/**
 * One step's form, made once and kept on its own node.
 *
 * Kept rather than rebuilt because `keyed` fills a row it already has, and a
 * form rebuilt on every delta is a box that empties itself twice a second
 * under somebody's thumb. `ctx` is handed in so a step block made before the
 * page knew its scopes still gets the same one.
 */
const FORMS = new WeakMap()

function formOn(node, parent, ctx) {
  const held = FORMS.get(node)
  if (held !== undefined) return held
  const made = formIn(parent, ctx)
  FORMS.set(node, made)
  return made
}

function fillStepBlock(node, step, row, ctx, view) {
  const [head, facts, prompt, waits, form] = node.children
  textIn(head, step.name)
  dlIn(facts, [
    ['persona', step.persona],
    ['model', step.model],
    ['finished when', step.done],
    ['produces', step.produces],
    ['leaves the checks', step.leaves],
    ['touches', step.touches.join(', ') || null],
  ])
  prompt.replaceChildren()
  into(prompt, proseOf(step.prompt, true))
  keyed(
    waits,
    step.after,
    (one) => one.agent,
    createWaitRow,
    (one, wait) => fillWaitRow(one, { task: wait.agent, why: wait.why }),
  )
  // The step's own form, built once and then patched, so what somebody is part
  // way through typing survives every delta.
  formOn(node, form, ctx).update(row, { scope: step.name, fields: step.fields }, view)
}

/**
 * The form: one row per field, each with what it means under it.
 *
 * **Saving is one field at a time**, which is the bound rather than a
 * limitation: the body carries a field id, a value and the draft's own hash, so
 * an edit from a stale screen meets a draft that has moved and is refused —
 * and there is no shape in which it writes a whole template, renames one or
 * publishes anything.
 */
function formIn(parent, ctx) {
  const node = el('div', { class: 'form' })
  const list = el('div')
  const none = el('p', { class: 'empty' })
  const said = el('p', { class: 'said' })
  into(node, list, none, said)
  into(parent, node)
  let scope = 'template'
  let held = null
  return {
    node,
    update(row, part, view) {
      scope = part.scope
      held = row
      const acts = view.may.acts ?? {}
      none.hidden = part.fields.length > 0
      textIn(none, part.fields.length > 0 ? '' : 'nothing to fill in here')
      keyed(
        list,
        part.fields,
        (field) => field.id,
        createField,
        (one, field) =>
          fillField(one, field, { standing: savingOf(row, field, acts), send: sendOne }),
      )
    },
  }

  /**
   * One field, saved.
   *
   * **The key is minted once per press**: a press whose answer never arrived
   * is a press whose repeat must not be a second write, and the key is what
   * lets the machine tell the two apart. `afterAnswer`'s rule holds here too —
   * only a `200` clears the box, because a `409` is somebody else having saved
   * the same draft and throwing away what was typed because of it is the one
   * failure a person cannot undo.
   */
  function sendOne(field, box) {
    if (ctx === undefined || ctx === null || held === null) return
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const body = draftBody(held, scope, field.id, box.value, key, ctx.revOf())
    void ctx.ask('POST', '/api/draft/save', body).then((answer) => {
      const came = afterAnswer(answer, ctx.sentence(answer))
      textIn(said, came.said)
      if (came.clear) box.value = ''
    })
  }
}

/**
 * One field, built once.
 *
 * The `<label>` is tied to the box with `for`/`id` rather than only by an
 * `aria-label`, because a label that names nothing is a label a pointer
 * cannot use: tapping one should put the keyboard in the field, which on a
 * phone is the difference between a 44px target and a 16px one.
 */
let fields = 0

function createField() {
  fields += 1
  const id = `f${fields}`
  const node = el('div', { class: 'field' })
  const label = el('label', { attrs: { for: id } })
  const value = el('p', { class: 'said' })
  const means = el('p', { class: 'unknown' })
  const off = el('p', { class: 'empty' })
  const box = el('input', { attrs: { type: 'text', id } })
  const press = el('button', {
    class: 'press',
    text: 'Save to the draft',
    attrs: { type: 'button' },
  })
  return into(node, label, value, means, off, box, press)
}

function fillField(node, field, how) {
  const [label, value, means, off, box, press] = node.children
  textIn(label, field.label)
  textIn(value, field.value === null ? '—' : field.value.words)
  sayIn(means, field.means ?? '')
  // **Absent with its reason, never disabled** — `acts.js`' own rule, and
  // `savingOf` is where the four answers are decided. A field the template
  // says cannot be changed here, a workflow Tade ships, a published snapshot
  // with no draft behind it: each turns the box off *and* says why. A device
  // that was not granted saving at all is told nothing, because a sentence
  // naming a scope somebody does not have is a map of what else to ask for.
  const yes = how.standing.kind === 'yes'
  sayIn(off, how.standing.kind === 'no' ? how.standing.why : '')
  box.hidden = !yes
  press.hidden = !yes
  box.setAttribute('aria-label', `${field.label}, a new value for the draft`)
  // Wired once. A listener added on every fill would send one act per delta
  // the row has seen, which is the bug a page that patches rather than rebuilds
  // is most likely to have.
  if (node.getAttribute('data-wired') !== 'yes') {
    node.setAttribute('data-wired', 'yes')
    press.addEventListener('click', () => how.send(field, box))
  }
}

/** What `shows` means, in words rather than as a word nobody defined. */
const SHOWS = {
  draft: 'a draft nothing runs until it is published',
  published: 'the newest published version, which never changes',
  nothing: 'nothing: there is neither a draft nor a published version',
}

/**
 * The shape a run takes: one block per column, the steps in it, and the waits.
 *
 * **The shape and not a dry run**, which is the honest preview a template can
 * give: nobody has asked for a run, so there are no inputs, and a dry run
 * filled with invented values would say a run would happen somewhere it would
 * not. The dry run proper is on a request, where the inputs are real — and
 * this says so rather than leaving a reader to wonder where the figures are.
 *
 * A step in a cycle is **named** rather than drawn at some column: a cycle has
 * no column, `templateProblems` is what refuses it, and a drawing that put one
 * at depth nought would read as an order.
 */
function shapeIn(parent) {
  const columns = el('div', { class: 'layers' })
  const none = el('p', { class: 'empty' })
  const says = el('p', { class: 'unknown' })
  into(parent, columns, none, says)
  return {
    update(row, view) {
      const places = row.places
      none.hidden = places.length > 0
      textIn(
        none,
        places.length > 0
          ? ''
          : mayRead(view.store, 'workflows')
            ? 'there are no steps to put in an order'
            : 'not granted to this device',
      )
      const deep = [...new Set(places.map((place) => place.depth))].sort((a, b) => a - b)
      keyed(
        columns,
        deep,
        (n) => String(n),
        createColumn,
        (one, n) =>
          fillColumn(
            one,
            n,
            places.filter((place) => place.depth === n),
          ),
      )
      sayIn(
        says,
        places.length === 0
          ? ''
          : 'what one run of this would actually make — which repository, which names, what it may spend — is answered on the request it is stamped for',
      )
    },
  }
}

function createColumn() {
  const node = el('div', { class: 'layer' })
  const head = el('h3', { class: 'aside' })
  const list = el('ul', { class: 'rows' })
  return into(node, head, list)
}

function fillColumn(node, n, places) {
  const [head, list] = node.children
  textIn(head, n === 0 ? 'can go first' : `after column ${n}`)
  keyed(list, places, (place) => place.name, createPlaceRow, fillPlaceRow)
}

function createPlaceRow() {
  const node = el('li')
  const body = el('div', { class: 'row-static' })
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  const under = el('span', { class: 'under' })
  into(body, name, aside, under)
  const waits = el('ul', { class: 'waits' })
  return into(node, body, waits)
}

function fillPlaceRow(node, place) {
  const [body, waits] = node.children
  const [name, aside, under] = body.children
  textIn(name, place.name)
  textIn(aside, place.circular ? 'in a cycle' : place.parent === null ? 'waits on nothing' : '')
  textIn(
    under,
    place.circular
      ? 'it waits, directly or not, on itself: publishing refuses this, and no column is drawn for it'
      : '',
  )
  keyed(
    waits,
    place.why,
    (one) => one.on,
    createWaitRow,
    (one, wait) => fillWaitRow(one, { task: wait.on, why: wait.why }),
  )
}
