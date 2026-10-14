// What Tade is set up with, as this device may read it — and the few settings
// it may change.
//
// **What somebody opening this page wants** is one of two things: to change
// one of the few settings a phone may change, or to find out what something is
// set to. So the page leads with the first — *Change from here*, every row this
// device may change, wherever its group is, each with its control one tap away
// — and puts the second behind a search and an index: every group a card that
// opens, its rows one line each, a name and a value in a column down the right.
// A phone sees the cards; a desk sees the index down the left and one group at
// a time beside it, the way a settings window is read.
//
// **Asked when the screen opens, never on the stream.** Settings change when
// somebody changes one, so a phone is not sent a hundred and fifty rows on
// every beat for a page nobody has open: this screen asks `/api/settings` once
// when it is drawn, again when somebody presses *Read again*, and a change
// answers with what is true after it.
//
// **Built when the answer arrives and never by a paint**: a delta twice a
// second would wipe a value somebody was halfway through typing. It is built
// again only when what this device may do changed — a grant somebody made at
// the machine — and then whatever was open stays open.
//
// **Nothing here derives anything.** What may be changed and what a change
// must echo are on the row (`may`, `was`) and in `settingStanding`; every word
// and every count is `settings-shape.js`'s, and each row is `settings-row.js`'s.

import { SETTINGS_PATH, settingStanding } from '../acts.js'
import { classOn, el, into, skeleton, textIn } from '../dom.js'
import { icon } from '../icons.js'
import { section } from '../rows.js'
import { troubleOf, UNKNOWN_TROUBLE } from '../trouble.js'
import { panel, problem, problemIn, stateBox, stateBoxIn } from '../ui.js'
import { settingRow } from './settings-row.js'
import {
  finds,
  firstChosen,
  foundIn,
  groupSaid,
  HERE,
  hereOf,
  iconOf,
  leftSaid,
  missedBox,
  pageState,
  partsOf,
  queryOf,
  totalOf,
} from './settings-shape.js'

/** The width, in rem, from which the index stands beside the groups (`settings.css`). */
const DESK = 44

export function settingsScreen(ctx) {
  const node = el('div')
  const top = section('SETTINGS', { top: true })
  // Asking again, at the end of the bar: a setting changed at the machine
  // while this page was open is not on the stream, so it is asked for.
  const again = el('button', { class: 'press quietly small st-again', attrs: { type: 'button' } })
  into(again, icon('refresh'), el('span', { text: 'Read again' }))
  into(top.tools, again)
  // A read again that failed, over the settings it could not replace.
  const failed = problem()
  const state = stateBox()
  const coming = skeleton(6)
  classOn(coming, 'st-coming', true)

  const cols = el('div', { class: 'st-cols' })
  const side = el('div', { class: 'st-side' })
  const find = findOf((typed) => {
    words = queryOf(typed)
    said = typed
    shut.clear()
    apply()
  })
  const index = el('nav', { class: 'st-index', attrs: { 'aria-label': 'Setting groups' } })
  const entries = el('ul', { class: 'st-entries' })
  into(index, entries)
  into(side, find.node, index)

  const work = el('div', { class: 'st-main' })
  const lead = section('CHANGE FROM HERE')
  classOn(lead.node, 'st-lead', true)
  const leadRows = panel('ul', 'st-rows')
  into(lead.body, leadRows)
  const groups = el('div', { class: 'st-groups' })
  const missed = stateBox()
  const left = el('p', { class: 'st-left' })
  into(work, lead.node, groups, missed, left)
  into(cols, side, work)
  classOn(top.body, 'st-page', true)
  into(top.body, failed, state, coming, cols)
  into(node, top.node)

  let answer = null
  let trouble = null
  let acts = {}
  let drawnWith = null
  let gone = false
  /** What the search box holds, as typed and as words. */
  let said = ''
  let words = []
  /** Where the desk is: `HERE`, or a group's id. */
  let chosen = null
  /** The groups open, the ones closed while a search held them open, and each group's scope. */
  const open = new Set()
  const shut = new Set()
  const scopes = new Map()
  /** The rows somebody opened, by where they are and their path. */
  const opened = new Set()
  /** What is drawn now: the lead's rows, the cards, and every drawing of each setting. */
  let leadMade = []
  let cards = []
  let views = new Map()

  const wide = () => {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    return node.clientWidth >= DESK * rem
  }

  /** Every drawing of one setting, refilled after an answer moved it. */
  const saved = (path) => (sync) => {
    for (const one of views.get(path) ?? []) one.fill(sync)
  }

  const rowFor = (row, group, where, crumb) => {
    const key = `${where}:${row.path}`
    const made = settingRow(row, {
      crumb,
      standing: settingStanding(row, acts),
      open: opened.has(key),
      toggled: (now) => {
        if (now) opened.add(key)
        else opened.delete(key)
      },
      ctx,
      saved: saved(row.path),
    })
    views.set(row.path, [...(views.get(row.path) ?? []), made])
    return { ...made, group }
  }

  const draw = () => {
    const now = pageState(answer, answer === null ? trouble : null)
    const box = now.box
    // The skeleton is the shape of what is coming; the box says the rest.
    stateBoxIn(
      state,
      box === null || now.kind === 'coming'
        ? null
        : { ...box, action: box.retry ? { word: 'Ask again', run: () => void load() } : null },
    )
    coming.hidden = now.kind !== 'coming'
    cols.hidden = now.kind !== 'ready'
    again.hidden = now.kind === 'coming' || now.kind === 'wrong'
    drawnWith = acts.configure === true
    views = new Map()
    if (now.kind !== 'ready') {
      leadRows.replaceChildren()
      groups.replaceChildren()
      entries.replaceChildren()
      leadMade = []
      cards = []
      textIn(top.figure, '')
      return
    }
    const ids = new Set([HERE, ...answer.groups.map((group) => group.id)])
    if (
      chosen === null ||
      !ids.has(chosen) ||
      (chosen === HERE && hereOf(answer, acts).length === 0)
    ) {
      chosen = firstChosen(answer, acts)
      // A desk opens on one group, so that one starts open; a phone starts
      // with every card closed, which is the index.
      if (chosen !== HERE && wide()) open.add(chosen)
    }
    leadMade = hereOf(answer, acts).map((one) => rowFor(one.row, one.group, HERE, one.crumb))
    leadRows.replaceChildren(...leadMade.map((one) => one.node))
    textIn(lead.figure, String(leadMade.length))
    cards = answer.groups.map((group) => cardFor(group))
    groups.replaceChildren(...cards.map((card) => card.node))
    entries.replaceChildren(
      ...(leadMade.length > 0 ? [entryFor(HERE, 'Change from here', 'flag', true)] : []),
      ...answer.groups.map((group) => entryFor(group.id, group.title, iconOf(group.id), false)),
    )
    textIn(left, leftSaid(answer) ?? '')
    apply()
  }

  /** One group, as a card that opens: its mark, its name and count, its rows. */
  const cardFor = (group) => {
    const id = `st-group-${group.id}`
    const node = el('section', {
      class: 'ui-panel st-group',
      attrs: { 'aria-labelledby': `${id}-name` },
    })
    const head = el('h2', { class: 'st-head' })
    const toggle = el('button', {
      class: 'st-toggle',
      attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': `${id}-body` },
    })
    const mark = el('span', { class: 'st-mark', attrs: { 'aria-hidden': 'true' } })
    into(mark, icon(iconOf(group.id), 'st-mark-ic'))
    const named = el('span', { class: 'st-words' })
    const name = el('span', {
      class: 'st-group-name',
      text: group.title,
      attrs: { id: `${id}-name` },
    })
    const sub = el('span', { class: 'st-sub' })
    into(named, name, sub)
    const chev = el('span', { class: 'st-end', attrs: { 'aria-hidden': 'true' } })
    into(chev, icon('chevron', 'st-chev'))
    into(toggle, mark, named, chev)
    into(head, toggle)
    const body = el('div', { class: 'st-body', attrs: { id: `${id}-body` } })
    into(node, head, body)
    classOn(node, 'is-here', groupHere(group))

    const parts = partsOf(group)
    const rows = []
    if (parts.own.length > 0) {
      const list = el('ul', { class: 'st-rows' })
      for (const row of parts.own) {
        const made = rowFor(row, group, group.id, null)
        rows.push(made)
        into(list, made.node)
      }
      into(body, list)
    }
    const blocks = []
    let chips = null
    if (parts.scopes.length > 0) {
      if (!scopes.has(group.id) || !parts.scopes.some((one) => one.key === scopes.get(group.id))) {
        scopes.set(group.id, parts.scopes[0].key)
      }
      chips = el('div', {
        class: 'st-scopes',
        attrs: { role: 'group', 'aria-label': `Which of ${group.title} to show` },
      })
      for (const scope of parts.scopes) {
        const chip = el('button', {
          class: 'ui-chip st-chip',
          text: scope.key,
          attrs: { type: 'button', 'aria-pressed': 'false' },
        })
        chip.addEventListener('click', () => {
          scopes.set(group.id, scope.key)
          apply()
        })
        into(chips, chip)
        const block = el('div', { class: 'st-scope' })
        const heading = el('h3', { class: 'st-scope-name', text: scope.key })
        const list = el('ul', { class: 'st-rows' })
        const mine = []
        for (const row of scope.rows) {
          const made = rowFor(row, group, group.id, null)
          rows.push(made)
          mine.push(made)
          into(list, made.node)
        }
        into(block, heading, list)
        into(body, block)
        blocks.push({ key: scope.key, node: block, chip, rows: mine })
      }
      body.insertBefore(chips, body.querySelector('.st-scope'))
    }

    toggle.addEventListener('click', () => {
      if (words.length > 0) {
        if (shut.has(group.id)) shut.delete(group.id)
        else shut.add(group.id)
      } else if (open.has(group.id)) open.delete(group.id)
      else open.add(group.id)
      apply()
    })
    return { group, node, toggle, body, sub, rows, blocks, chips }
  }

  /** Whether a group holds a row this device may change. */
  const groupHere = (group) =>
    group.settings.some((row) => settingStanding(row, acts).kind === 'yes')

  /** One line of the desk's index: a mark, the name, and how many. */
  const entryFor = (id, name, mark, here) => {
    const item = el('li')
    const press = el('button', {
      class: here ? 'st-entry is-here' : 'st-entry',
      attrs: { type: 'button', 'data-group': id },
    })
    const figure = el('span', { class: 'st-entry-n' })
    into(press, icon(mark), el('span', { class: 'st-entry-name', text: name }), figure)
    press.addEventListener('click', () => choose(id))
    into(item, press)
    return item
  }

  /** The desk's index pressed: that group beside it, opened, and the keyboard on it. */
  const choose = (id) => {
    chosen = id
    if (id !== HERE) open.add(id)
    shut.delete(id)
    apply()
    const card = cards.find((one) => one.group.id === id)
    const target = id === HERE ? lead.node : card?.node
    target?.scrollIntoView({ block: 'nearest' })
    if (id === HERE) leadMade[0]?.node.querySelector('button')?.focus({ preventScroll: true })
    else card?.toggle.focus({ preventScroll: true })
  }

  /** Who is shown, opened and counted, for the search and the choices as they are now. */
  const apply = () => {
    if (answer === null || answer.granted !== true || answer.groups.length === 0) return
    const finding = words.length > 0
    classOn(cols, 'is-finding', finding)
    let found = 0
    // What this device may change, found like everything else.
    let leadFound = 0
    for (const one of leadMade) {
      const shown = finds(one.row, one.group, words)
      one.node.hidden = !shown
      if (shown) leadFound += 1
    }
    lead.node.hidden = leadMade.length === 0 || leadFound === 0
    classOn(lead.node, 'is-chosen', chosen === HERE)
    for (const card of cards) {
      const n = foundIn(card.group, words)
      found += n
      card.node.hidden = finding && n === 0
      classOn(card.node, 'is-chosen', chosen === card.group.id)
      const expanded = finding ? !shut.has(card.group.id) : open.has(card.group.id)
      card.body.hidden = !expanded
      card.toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      classOn(card.node, 'is-open', expanded)
      textIn(card.sub, groupSaid(card.group, acts, words))
      for (const row of card.rows) row.node.hidden = !finds(row.row, card.group, words)
      if (card.chips !== null) {
        card.chips.hidden = finding
        const scope = scopes.get(card.group.id)
        for (const block of card.blocks) {
          block.chip.setAttribute('aria-pressed', block.key === scope ? 'true' : 'false')
          const any = block.rows.some((row) => !row.node.hidden)
          block.node.hidden = finding ? !any : block.key !== scope
          classOn(block.node, 'is-named', finding)
        }
      }
    }
    for (const entry of entries.children) {
      const press = entry.firstChild
      const id = press.getAttribute('data-group')
      const group = answer.groups.find((one) => one.id === id)
      const n = id === HERE ? (finding ? leadFound : leadMade.length) : foundIn(group, words)
      entry.hidden = finding && n === 0
      textIn(press.lastChild, String(id === HERE || finding ? n : group.settings.length))
      if (chosen === id && !finding) press.setAttribute('aria-current', 'true')
      else press.removeAttribute('aria-current')
    }
    const total = totalOf(answer) ?? 0
    textIn(top.figure, finding ? `${found} of ${total}` : String(total))
    stateBoxIn(
      missed,
      finding && found === 0 && leadFound === 0
        ? { ...missedBox(said), action: { word: 'Clear the search', run: () => find.clear() } }
        : null,
    )
    left.hidden = finding || left.textContent === ''
  }

  const load = async () => {
    again.disabled = true
    const got = await ctx.ask('GET', SETTINGS_PATH)
    if (gone) return
    again.disabled = false
    if (got.status === 200 && got.body !== null && typeof got.body?.granted === 'boolean') {
      answer = got.body
      trouble = null
      problemIn(failed, null)
    } else if (answer === null) {
      trouble = troubleOf(got) ?? UNKNOWN_TROUBLE
    } else {
      // What was read before stays: a failed read again is not a reason to
      // take away the settings it could not replace.
      problemIn(failed, troubleOf(got) ?? UNKNOWN_TROUBLE, {
        word: 'Ask again',
        run: () => void load(),
      })
      return
    }
    draw()
  }
  again.addEventListener('click', () => void load())

  draw()
  void load()

  return {
    node,
    update(view) {
      acts = view.may?.acts ?? {}
      // Built again only when what this device may do changed — a grant
      // somebody made at the machine — and never on an ordinary paint.
      if (answer !== null && drawnWith !== (acts.configure === true)) draw()
    },
    leave() {
      gone = true
    },
  }
}

/**
 * The search: a box with its mark, finding as it is typed, and Escape empties
 * it. (The page's own keys are never a field's, so Escape here goes nowhere
 * else either way.)
 */
function findOf(typed) {
  const node = el('div', { class: 'st-find', attrs: { role: 'search' } })
  const box = el('input', {
    class: 'st-find-box',
    attrs: {
      type: 'search',
      'aria-label': 'Find a setting',
      placeholder: 'Find a setting',
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
    },
  })
  into(node, icon('search', 'st-find-mark'), box)
  box.addEventListener('input', () => typed(box.value))
  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || box.value === '') return
    box.value = ''
    typed('')
  })
  return {
    node,
    clear() {
      box.value = ''
      typed('')
      box.focus()
    },
  }
}
