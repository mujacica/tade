// Machines: what each of the person's machines has, item by item — the
// window's Settings › Machines, on the phone — and the one move that page
// offers beyond looking again: the keys the shell's files set, moved into one
// file, shown first as a diff with every value hidden and done on a second
// press, with what any agent can read said between the two. And, first where
// there are any, the notes taken on this machine that another one retired,
// took back or widened, each waiting for Take it here or Leave it: a linked
// machine's word about a note is only that machine's, and this phone is yours.
//
// **What somebody opening this wants first** is whether their machines agree:
// how many there are, what is missing on this one and what differs between
// them — so those lead as stat tiles. Then every item, a group per kind, each
// with a line per machine (a column per machine does not fit a phone, and
// nothing here is cut to fit), where it is set on this machine and what is
// wrong with it. Then the move.
//
// **Asked when the screen opens, never on the stream** (`POST /api/machines`,
// the person's own device's — `src/machines.ts`), again every second and a
// half while a look or a move is under way, and every half minute otherwise.
// A press answers at once with the page as it stands; nothing waits on a look.
// Every word is `machines-shape.js`'s or the machine's.

import { stat, statIn, stats, toneIn } from '../charts.js'
import { el, into, keyed, skeleton, textIn } from '../dom.js'
import { shortClockOf } from '../figures.js'
import { icon } from '../icons.js'
import { section } from '../rows.js'
import { theirsTrouble, UNKNOWN_TROUBLE } from '../trouble.js'
import { callout, panel, problem, problemIn, stateBox, stateBoxIn } from '../ui.js'
import {
  cellSaid,
  columnSaid,
  columnTrouble,
  diffTone,
  groupsOf,
  leadOf,
  leftSaid,
  markTone,
  NOTE_PRESSES,
  notesOf,
  pressesOf,
  underWay,
} from './machines-shape.js'

/** Where the page is asked, and where a press goes. */
export const MACHINES_PATH = '/api/machines'
export const PRESS_PATH = '/api/machines/press'

/** A region's state, as `stateBoxIn` takes it: a kind, its heading, a line, its steps and the one press. */
function boxOf(kind, heading, line = null, action = null, steps = null) {
  const title = heading
  return { kind, title, line, action, steps }
}

/**
 * Refusals that asking again on a clock will not change: a device that is not
 * the person's own, and a Tade too old to have the page. Each says its fix.
 */
const FOR_GOOD = new Set(['out_of_scope', 'no_such', 'not_offered'])

/** How often an open page asks again while something is under way, and while nothing is. */
const SOON_MS = 1_500
const AGAIN_MS = 30_000

/** What a held change to a note is, behind its section's `?`. */
const NOTES_HINT =
  'Another machine retired, took back or widened a note that was taken on this one. Any agent there runs as you and could have written it, so it is only that machine’s word until you take it here. Leave it, and the note stays as it is.'

/** What the move is, said once where somebody is deciding — behind its `?`. */
const MOVE_HINT =
  'Your shell’s files can keep their keys in one file instead, which your login shell and `tade serve` both read, and which you keep in step between machines yourself. Shown first as a diff with every value hidden; each file is copied beside itself, a fresh login shell is asked before and after, and anything different puts every file back byte for byte.'

/**
 * One machine, as the list of them heads the page — and, where its link is
 * down, this machine is signed out there or its Tade is too old, what to do
 * about it (`columnTrouble`). Not an alert: it is a state, read with the page.
 */
function createColumn() {
  const node = el('li', { class: 'mc-machine' })
  const trouble = problem()
  trouble.removeAttribute('role')
  into(
    node,
    icon('laptop'),
    el('span', { class: 'mc-name' }),
    el('span', { class: 'mc-asof' }),
    trouble,
  )
  return node
}

function fillColumn(node, column) {
  const [, name, asOf, trouble] = node.children
  textIn(name, column.machine)
  node.classList.toggle('is-here', column.here)
  textIn(asOf, columnSaid(column, shortClockOf))
  problemIn(trouble, columnTrouble(column))
}

/** One item: its name, a line per machine, and where it is set here. */
function createItem() {
  const node = el('li', { class: 'mc-item' })
  into(
    node,
    el('span', { class: 'mc-label' }),
    el('ul', { class: 'mc-cells' }),
    el('span', { class: 'mc-where' }),
    el('span', { class: 'mc-said' }),
  )
  return node
}

function fillItem(node, row, columns) {
  const [label, cells, where, said] = node.children
  textIn(label, row.label)
  keyed(
    cells,
    row.cells.map((cell, at) => ({ cell, column: columns[at] })),
    (one) => one.column?.machine ?? '',
    () => {
      const line = el('li', { class: 'mc-cell' })
      into(
        line,
        el('span', { class: 'mc-mark', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'mc-on' }),
        el('span', { class: 'mc-word' }),
      )
      return line
    },
    (line, one) => {
      const [mark, on, word] = line.children
      textIn(mark, one.cell.mark)
      toneIn(mark, markTone(one.cell.mark))
      textIn(on, one.column?.machine ?? '')
      textIn(word, cellSaid(one.cell))
    },
  )
  const here = columns.findIndex((one) => one.here)
  const mine = here < 0 ? null : row.cells[here]
  textIn(where, mine && mine.where.length > 0 ? mine.where.join(' · ') : '')
  where.hidden = where.textContent === ''
  textIn(said, mine?.said ?? '')
  said.hidden = said.textContent === ''
  said.classList.toggle('is-wrong', mine !== null && mine.mark !== '✓')
}

export function machinesScreen(ctx) {
  const node = el('div')
  const top = section('MACHINES', { top: true })
  const coming = skeleton(5)
  const failed = stateBox()

  const lead = stats('Your machines at a glance')
  const tiles = new Map()
  for (const one of leadOf(null)) {
    const tile = stat(one.label)
    tiles.set(one.key, tile)
    into(lead, tile)
  }

  const changed = section('NOTES CHANGED ELSEWHERE', { hint: NOTES_HINT })
  const noteList = panel('ul', 'mc-items')
  const noteTrouble = problem()
  into(changed.body, noteList, noteTrouble)

  const seen = section('EACH MACHINE')
  const columnList = panel('ul', 'mc-machines')
  into(seen.body, columnList)

  const items = el('div', { class: 'mc-groups' })
  const nothing = stateBox()

  const moving = section('KEYS IN ONE FILE', { hint: MOVE_HINT })
  const plan = panel('div', 'mc-plan')
  const diff = el('ol', {
    class: 'mc-diff',
    attrs: { 'aria-label': 'what changes, values hidden' },
  })
  const left = el('ul', { class: 'mc-left' })
  const none = el('p', { class: 'mc-none', text: 'Nothing can be moved as it is.' })
  into(plan, diff, left, none)
  const warn = callout('')
  warn.hidden = true
  const presses = el('div', { class: 'mc-presses' })
  const saidLine = el('p', { class: 'mc-said-line', attrs: { role: 'status' } })
  const trouble = problem()
  into(moving.body, plan, warn, presses, saidLine, trouble)

  const again = el('button', { class: 'press quietly small', attrs: { type: 'button' } })
  into(again, icon('refresh'), el('span', { text: 'Look again' }))
  into(top.tools, again)

  const body = el('div', { class: 'mc-body' })
  into(body, lead, changed.node, seen.node, nothing, items, moving.node)
  into(top.body, coming, failed, body)
  into(node, top.node)

  let answer = null
  let refused = null
  let armed = null
  let gone = false
  let timer = null
  /** Each kind's section, by its node: its heading and its list. */
  const groups = new WeakMap()

  function createGroup() {
    const part = section('')
    const list = panel('ul', 'mc-items')
    into(part.body, list)
    groups.set(part.node, { heading: part.heading, list })
    return part.node
  }

  function fillGroup(part, group, columns) {
    const made = groups.get(part)
    textIn(made.heading, group.head.toUpperCase())
    made.heading.setAttribute('aria-label', group.head)
    keyed(
      made.list,
      group.rows,
      (row) => row.id,
      createItem,
      (item, row) => fillItem(item, row, columns),
    )
  }

  function draw() {
    coming.hidden = answer !== null || refused !== null
    stateBoxIn(
      failed,
      refused === null
        ? null
        : boxOf(
            'error',
            refused.title,
            refused.why ?? refused.fix,
            { word: 'Ask again', run: () => void load() },
            refused.steps ?? null,
          ),
    )
    body.hidden = answer === null
    if (answer === null) return
    const columns = answer.columns ?? []
    textIn(top.figure, answer.columns === null ? '' : String(columns.length))
    textIn(again.lastChild, answer.looking ? 'Looking…' : 'Look again')
    again.disabled = answer.looking
    for (const one of leadOf(answer)) {
      const tile = tiles.get(one.key)
      if (tile) statIn(tile, { value: one.value, under: one.under, tone: one.tone ?? null })
    }
    // What waits on a press leads, and is not there at all while nothing does.
    const notes = notesOf(answer)
    changed.node.hidden = notes.length === 0
    textIn(changed.figure, notes.length === 0 ? '' : String(notes.length))
    keyed(noteList, notes, (one) => one.id, createNote, fillNote)
    seen.node.hidden = answer.columns === null
    keyed(columnList, columns, (one) => one.machine, createColumn, fillColumn)

    stateBoxIn(
      nothing,
      answer.columns === null
        ? boxOf('loading', 'Looking at what this machine has')
        : answer.rows.length === 0
          ? boxOf('empty', 'Nothing to compare yet', 'Look again in a moment')
          : null,
    )
    keyed(
      items,
      groupsOf(answer),
      (group) => group.kind,
      createGroup,
      (part, group) => fillGroup(part, group, columns),
    )

    // The move: the plan shown, and the presses as the window offers them.
    const shown = answer.plan
    plan.hidden = shown === null
    if (shown !== null) {
      keyed(
        diff,
        shown.diff.map((line, at) => ({ line, at })),
        (one) => String(one.at),
        () => el('li', { class: 'mc-line' }),
        (line, one) => {
          textIn(line, one.line)
          toneIn(line, diffTone(one.line))
        },
      )
      keyed(
        left,
        shown.left,
        (one) => one.name,
        () => el('li'),
        (line, one) => textIn(line, leftSaid(one)),
      )
      none.hidden = shown.moved.length > 0
    }
    if (shown === null || answer.busy) armed = null
    textIn(warn, armed === 'move' ? answer.agents : '')
    warn.hidden = armed !== 'move'
    // Look again is the bar's press; the section's are the move's.
    keyed(
      presses,
      pressesOf(answer).filter((one) => one.id !== 'look'),
      (one) => one.id,
      () => el('button', { class: 'press', attrs: { type: 'button' } }),
      (press, one) => {
        textIn(press, armed === one.id ? (one.again ?? one.word) : one.word)
        press.classList.toggle('asked', armed === one.id)
        press.classList.toggle('quietly', one.id === 'leave')
        press.disabled = answer.busy || (one.id === 'look' && answer.looking)
        press.onclick = () => void pressed(one)
      },
    )
    textIn(saidLine, answer.said ?? '')
    saidLine.hidden = !answer.said
  }

  /** One held change: what it would do and where, the note, the sentence, and its two presses. */
  function createNote() {
    const node = el('li', { class: 'mc-item' })
    const presses = el('div', { class: 'mc-presses' })
    for (const one of NOTE_PRESSES) {
      const press = el('button', { class: 'press', attrs: { type: 'button' }, text: one.word })
      press.classList.toggle('quietly', one.answer === 'leave')
      press.dataset.answer = one.answer
      into(presses, press)
    }
    into(
      node,
      el('span', { class: 'mc-label' }),
      el('span', { class: 'mc-note' }),
      el('span', { class: 'mc-said' }),
      presses,
    )
    return node
  }

  function fillNote(node, one) {
    const [label, note, said, presses] = node.children
    textIn(label, one.label)
    textIn(note, `“${one.note}”`)
    textIn(said, one.said)
    for (const press of presses.children) {
      press.onclick = () => void settled(one.id, press.dataset.answer)
    }
  }

  async function settled(note, answer) {
    problemIn(noteTrouble, null)
    await send({ note, answer }, noteTrouble)
  }

  async function pressed(one) {
    // The move edits the person's own files, so it is asked twice.
    if (one.id === 'move' && armed !== 'move') {
      armed = 'move'
      draw()
      return
    }
    armed = null
    problemIn(trouble, null)
    await send({ press: one.id }, trouble)
  }

  /** One press to the machine, answered with the page as it stands, or why not where it was. */
  async function send(body, where) {
    const got = await ctx.ask('POST', PRESS_PATH, body)
    if (gone) return
    if (got.status === 200 && Array.isArray(got.body?.rows)) answer = got.body
    else problemIn(where, theirsTrouble(got, ctx.session()) ?? UNKNOWN_TROUBLE)
    draw()
    later()
  }

  function later() {
    clearTimeout(timer)
    timer = setTimeout(() => void load(), underWay(answer) ? SOON_MS : AGAIN_MS)
  }

  async function load() {
    const got = await ctx.ask('POST', MACHINES_PATH, {})
    if (gone) return
    if (got.status === 200 && Array.isArray(got.body?.rows)) {
      answer = got.body
      refused = null
    } else if (answer === null) {
      // Told apart by what the page knows of its own session: a Tade too old
      // for this page, or the boxes this device lacks — never "tick full
      // access" for a device that has it.
      refused = theirsTrouble(got, ctx.session()) ?? UNKNOWN_TROUBLE
    }
    draw()
    // A device that is not the person's own, or a Tade without the page, is
    // not asked again on a clock: the fix is somebody's act, and Ask again is there.
    if (answer !== null || !FOR_GOOD.has(got?.body?.error)) later()
  }

  again.addEventListener('click', () => void pressed({ id: 'look' }))

  draw()
  void load()

  return {
    node,
    update() {},
    leave() {
      gone = true
      clearTimeout(timer)
    },
  }
}
