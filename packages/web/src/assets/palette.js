// The command bar: Tade, and everywhere else, one press away.
//
// `⌘K` at a keyboard, the field in the header at any width, the middle of the
// tab bar on a phone — all three open this. **What is typed is first a message
// to Tade** where this device may send one, and then a filter over where it
// could go (`commands.js`): the lit row is what Enter does, and the first row
// is the message. So talking to the orchestrator is never more than a press
// and a sentence away, and going anywhere is the same press and a word.
//
// **The same ask flow as the conversation's own box**, not a second door:
// `askBody` and `afterAnswer` from `acts.js`, the same route, the same `rev`,
// the same rule that only an answer that did something clears what was typed.
// What a message from here may reach is decided at the machine (`origin.ts`)
// and nothing here widens it.
//
// **A dialog, done properly**: `aria-modal`, a combobox with an
// `aria-activedescendant` listbox, focus into the field on opening and back to
// whatever opened it on closing, Escape to close. Built once and patched, like
// every screen, so a delta that arrives mid-sentence moves nothing under the
// thumb.

import { afterAnswer, askBody } from './acts.js'
import { commandsFor, movedTo } from './commands.js'
import { el, hintOf, into, keyed, textIn, toneOn } from './dom.js'
import { CHAT_KINDS, taskMark } from './glyphs.js'
import { icon, iconIn } from './icons.js'
import { MORE, NAV, pathOf, taskPath } from './routes.js'
import { keyOf } from './screens.js'
import { agentsOf, chatOf, mayRead, projectsOf, talkOf, wantsYou } from './store.js'
import { reasonFor, saidOn, whoSaid } from './talk.js'

/** How many lines of the conversation the bar shows under the field. */
const LINES = 4

/** The icon a task's row carries, by the state `deriveState` gave it. */
const STATE_ICONS = {
  blocked: 'flag',
  failed: 'alert',
  review: 'check',
  merged: 'check',
  working: 'bolt',
  queued: 'queue',
  parked: 'pause',
}

/** The screens, as rows: every place the navigation has, by its own word. */
function screensOf() {
  return [...NAV, ...MORE].map((one) => ({
    label: one.label,
    icon: one.icon,
    path: pathOf({ view: one.view }),
  }))
}

/**
 * What the bar can jump to, out of the store: what wants somebody first, then
 * every agent at work, each once.
 */
export function jumpsOf(store) {
  const seen = new Set()
  const tasks = []
  for (const task of [...wantsYou(store), ...agentsOf(store)]) {
    if (seen.has(task.id)) continue
    seen.add(task.id)
    tasks.push({
      id: task.id,
      path: taskPath(task.id),
      icon: STATE_ICONS[task.state] ?? 'bolt',
      tone: taskMark(task.state).tone,
    })
  }
  return {
    tasks,
    projects: projectsOf(store).map((row) => row.name),
    screens: screensOf(),
  }
}

export function palette(ctx) {
  const node = el('div', {
    class: 'palette',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ask Tade, or go anywhere' },
  })
  node.hidden = true
  const scrim = el('div', { class: 'scrim', attrs: { 'aria-hidden': 'true' } })
  const box = el('div', { class: 'pal' })
  const field = el('div', { class: 'pal-field' })
  const input = el('input', {
    attrs: {
      type: 'text',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'pal-list',
      'aria-autocomplete': 'list',
      'aria-label': 'Ask Tade, or go anywhere',
      placeholder: 'Ask Tade, or jump to…',
      autocomplete: 'off',
      enterkeyhint: 'send',
      maxlength: '4000',
    },
  })
  const close = el('button', {
    class: 'tap icon',
    attrs: { type: 'button', 'aria-label': 'Close' },
  })
  into(close, icon('close'))
  into(field, icon('spark', 'pal-mark'), input, close)

  const talkPart = el('div', { class: 'pal-talk' })
  const lines = el('ul', { class: 'pal-lines', attrs: { 'aria-label': 'The conversation' } })
  const standing = el('div', { class: 'pal-standing' })
  const standingWord = el('span')
  const why = hintOf('', 'pal-why')
  into(standing, el('span', { class: 'dot', attrs: { 'aria-hidden': 'true' } }), standingWord)
  into(standing, why.press)
  const status = el('p', { class: 'pal-status', attrs: { role: 'status' } })
  const whole = el('a', { class: 'pal-whole', attrs: { href: '/talk' } })
  into(whole, el('span', { text: 'Whole conversation' }), icon('chevron'))
  into(talkPart, standing, why.body, lines, status, whole)

  const list = el('ul', { class: 'pal-list', attrs: { id: 'pal-list', role: 'listbox' } })
  const hints = el('p', { class: 'pal-keys', attrs: { 'aria-hidden': 'true' } })
  into(
    hints,
    el('kbd', { text: '↑↓' }),
    el('span', { text: 'move' }),
    el('kbd', { text: '↵' }),
    el('span', { text: 'go' }),
    el('kbd', { text: 'esc' }),
    el('span', { text: 'close' }),
  )
  into(box, field, list, talkPart, hints)
  into(node, scrim, box)

  let view = null
  let rows = []
  let lit = 0
  let opener = null
  let going = false

  const talkNow = () => (view === null ? undefined : talkOf(view.store))

  const draw = () => {
    if (view === null) return
    rows = commandsFor(input.value, { ...jumpsOf(view.store), talk: talkNow() ?? null })
    if (lit >= rows.length) lit = Math.max(0, rows.length - 1)
    const drawn = []
    let group = null
    rows.forEach((row, at) => {
      if (row.group !== group) {
        group = row.group
        drawn.push({ head: true, group, key: `g:${group}` })
      }
      drawn.push({ ...row, at, key: `r:${row.key}` })
    })
    keyed(
      list,
      drawn,
      (one) => one.key,
      createRow,
      (one, row) => fillRow(one, row, lit),
    )
    const on = rows[lit]
    if (on === undefined) input.removeAttribute('aria-activedescendant')
    else input.setAttribute('aria-activedescendant', `pal-${lit}`)
    talkIn()
  }

  /** The conversation's standing, its last lines, and why there is no message row. */
  const talkIn = () => {
    const talk = talkNow()
    const may = mayRead(view.store, 'talk')
    const shown = may ? chatOf(view.store).slice(-LINES) : []
    keyed(lines, shown, (line) => line.id, createLine, fillLine)
    lines.hidden = shown.length === 0
    const word =
      talk === undefined
        ? 'not read yet'
        : talk === null
          ? 'talking off'
          : talk.mine !== true
            ? 'not granted'
            : talk.busy === true
              ? 'answering'
              : 'ready'
    textIn(standingWord, word)
    toneOn(
      standing.firstChild,
      talk?.busy === true ? 't-working' : talk?.mine ? 't-done' : 't-quiet',
    )
    const reason = reasonFor(talk)
    textIn(why.body, reason)
    why.press.hidden = reason === ''
    if (reason === '') why.body.hidden = true
  }

  const run = async (row) => {
    if (row === undefined) return
    if (row.kind === 'go') {
      shut()
      ctx.go(row.path)
      return
    }
    const talk = talkNow()
    if (going || talk === null || talk === undefined) return
    going = true
    const answer = await ctx.ask(
      'POST',
      '/api/ask/ask',
      askBody(talk, keyOf(), ctx.revOf(), input.value.trim()),
    )
    going = false
    const came = afterAnswer(answer, ctx.sentence(answer))
    textIn(status, came.said)
    // **Only what actually happened clears the field.** A `409` is the
    // conversation having moved, and what somebody typed stays where it is.
    if (came.clear) input.value = ''
    lit = 0
    draw()
  }

  const open = (from = null) => {
    opener = from ?? document.activeElement
    node.hidden = false
    document.documentElement.classList.add('pal-open')
    lit = 0
    draw()
    input.focus()
  }

  const shut = () => {
    if (node.hidden) return
    node.hidden = true
    document.documentElement.classList.remove('pal-open')
    textIn(status, '')
    opener?.focus?.()
  }

  input.addEventListener('input', () => {
    lit = 0
    draw()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      lit = Math.max(0, movedTo(lit, rows.length, event.key === 'ArrowDown' ? 1 : -1))
      draw()
      list.querySelector(`#pal-${lit}`)?.scrollIntoView?.({ block: 'nearest' })
      return
    }
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      void run(rows[lit])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      shut()
    }
  })
  list.addEventListener('click', (event) => {
    const option = event.target.closest?.('[role="option"]')
    if (option === null || option === undefined) return
    void run(rows[Number(option.getAttribute('data-at'))])
  })
  scrim.addEventListener('click', shut)
  close.addEventListener('click', shut)
  whole.addEventListener('click', () => shut())
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // Not as far as the page's own Escape, which is *go back*: closing the
      // bar is the whole of what this press meant.
      event.stopPropagation()
      shut()
      return
    }
    // Focus stays inside the dialog: Tab from the last control comes back to
    // the field rather than walking out into a page that is behind a scrim.
    if (event.key !== 'Tab') return
    const stops = [...node.querySelectorAll('input, button:not([hidden]), a[href]')].filter(
      (one) => one.offsetParent !== null,
    )
    const first = stops[0]
    const last = stops.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  })

  return {
    node,
    open,
    shut,
    isOpen: () => !node.hidden,
    update(next) {
      view = next
      if (!node.hidden) draw()
    },
  }
}

function createRow(row) {
  if (row.head === true) {
    return el('li', { class: 'pal-group', attrs: { role: 'presentation' } })
  }
  const node = el('li', { attrs: { role: 'option' } })
  into(node, icon('bolt'), el('span', { class: 'pal-label' }), el('span', { class: 'pal-kind' }))
  return node
}

function fillRow(node, row, lit) {
  if (row.head === true) {
    textIn(node, row.group)
    return
  }
  const [glyph, label, kind] = node.children
  node.setAttribute('id', `pal-${row.at}`)
  node.setAttribute('data-at', String(row.at))
  node.setAttribute('aria-selected', row.at === lit ? 'true' : 'false')
  iconIn(glyph, row.icon)
  toneOn(glyph, row.tone ?? '')
  textIn(label, row.label)
  textIn(kind, row.kind === 'ask' ? 'Ask Tade' : 'Go')
}

function createLine() {
  const node = el('li')
  into(node, el('span', { class: 'who' }), el('span', { class: 'words' }))
  return node
}

function fillLine(node, line) {
  const [who, words] = node.children
  const kind = CHAT_KINDS[line.kind] ?? CHAT_KINDS.tade
  textIn(
    who,
    line.kind === 'tool' ? `${kind.word} · ${line.tool ?? ''}` : whoSaid(line) || kind.word,
  )
  toneOn(who, kind.tone)
  textIn(words, saidOn(line))
}
