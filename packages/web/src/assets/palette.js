// The command bar: Tade, every act and everywhere else, one press away.
//
// `⌘K` at a keyboard, the field in the header at any width, the middle of the
// tab bar on a phone — all three open this. **What is typed is first a message
// to Tade** where this device may send one, then the acts this device was
// granted on the work that matches (allow, deny, done, set aside, tell), then
// where it could go (`commands.js`): the lit row is what Enter does, and the
// first row is the message. So talking to the orchestrator, answering an agent
// and going anywhere are each a press and a word away.
//
// **The same doors as the screens, not a second set.** A message is
// `askBody` over `/api/ask/ask`; an act is `bodyFor` over `/api/act/<verb>`
// with the row's own revision; `afterAnswer` says what came of it and only an
// answer that did something clears what was typed. Finishing work asks twice,
// as everywhere (`confirms`). What any of it may reach is decided at the
// machine and nothing here widens it.
//
// **Telling an agent something is a mode**: choosing *Tell* on a task puts
// that task in the field as a chip, and what is typed next goes to its agent
// rather than to Tade. Backspace on an empty field, or Escape, leaves it.
//
// **A dialog, done properly**: `aria-modal`, a combobox with an
// `aria-activedescendant` listbox, focus into the field on opening and back to
// whatever opened it on closing, Escape to close, Tab kept inside. Built once
// and patched, so a delta that arrives mid-sentence moves nothing under the
// thumb.

import { afterAnswer, askBody, bodyFor, confirms, controlsFor } from './acts.js'
import { commandsFor, litOf, movedTo, rememberedWith } from './commands.js'
import { el, felt, hintOf, into, keyed, textIn, toneOn } from './dom.js'
import { CHAT_KINDS, taskMark } from './glyphs.js'
import { icon, iconIn } from './icons.js'
import { MORE, NAV, pathOf, taskPath } from './routes.js'
import { keyOf } from './screens.js'
import { agentsOf, chatOf, mayRead, projectsOf, talkOf, wantsYou } from './store.js'
import { reasonFor, saidOn, whoSaid } from './talk.js'
import { answerIn } from './ui.js'

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

/** The keys that go to a screen (`boot.js`'s `GOES`), shown beside its row. */
const KEYS = {
  now: 'g n',
  agents: 'g a',
  queue: 'g q',
  spend: 'g s',
  checks: 'g c',
  reviews: 'g r',
  findings: 'g f',
}

/** The screens, as rows: every place the navigation has, by its own word. */
function screensOf() {
  return [...NAV, ...MORE].map((one) => ({
    label: one.label,
    icon: one.icon,
    path: pathOf({ view: one.view }),
    hint: KEYS[one.view] ?? '',
  }))
}

/**
 * The acts a task may be asked for from the bar, as this session could ask
 * them: `controlsFor`'s answer, in the bar's short words.
 */
export function actsOn(task, acts) {
  const yes = new Set(
    controlsFor(task, acts ?? {}, ['answer', 'done', 'park', 'steer'])
      .filter((one) => one.kind === 'yes')
      .map((one) => one.verb),
  )
  const out = []
  if (yes.has('answer')) {
    const tool = task.approval?.tool ?? ''
    out.push({
      verb: 'answer',
      word: `Allow ${tool}`.trim(),
      typed: { allow: true },
      icon: 'check',
      tone: 't-done',
    })
    out.push({
      verb: 'answer',
      word: 'Deny',
      typed: { allow: false },
      icon: 'close',
      tone: 't-failed',
    })
  }
  if (yes.has('steer')) out.push({ verb: 'steer', word: 'Tell', icon: 'talk' })
  if (yes.has('done')) {
    out.push({ verb: 'done', word: 'Mark done', typed: { summary: '' }, icon: 'flag' })
  }
  if (yes.has('park')) {
    out.push({
      verb: 'park',
      word: task.parked === true ? 'Resume' : 'Set aside',
      typed: {},
      icon: 'pause',
    })
  }
  return out
}

/**
 * What the bar can jump to and act on, out of the store: what wants somebody
 * first, then every agent at work, each once.
 */
export function jumpsOf(store, acts = {}) {
  const seen = new Set()
  const tasks = []
  for (const task of [...wantsYou(store), ...agentsOf(store)]) {
    if (seen.has(task.id)) continue
    seen.add(task.id)
    tasks.push({
      id: task.id,
      title: task.title?.words ?? null,
      path: taskPath(task.id),
      icon: STATE_ICONS[task.state] ?? 'bolt',
      tone: taskMark(task.state).tone,
      wants: task.wantsYou === true,
      acts: actsOn(task, acts),
    })
  }
  return {
    tasks,
    projects: projectsOf(store).map((row) => row.name),
    screens: screensOf(),
  }
}

/**
 * The places gone to lately, for as long as this page is open.
 *
 * Held in memory and nowhere else: nothing on this page writes to the
 * browser's storage (`test/assets.test.ts`), and a list of where somebody
 * went is not worth being the first thing that does.
 */
let recent = []

function recentIn() {
  return recent
}

function remember(one) {
  recent = rememberedWith(recent, one)
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
  const chip = el('span', { class: 'ui-pill t-working pal-chip' })
  chip.hidden = true
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
  into(field, icon('spark', 'pal-mark'), chip, input, close)

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
    el('span', { text: 'do' }),
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
  /** The task whose agent what is typed goes to, or null for Tade. */
  let telling = null
  /** The act waiting for its second press: its row's key, or null. */
  let asked = null

  const talkNow = () => (view === null ? undefined : talkOf(view.store))

  const draw = () => {
    if (view === null) return
    if (telling !== null) {
      // In *Tell* mode the list is the one thing Enter will do.
      const typed = input.value.trim()
      rows = [
        {
          kind: 'steer',
          group: `Tell ${telling.id}`,
          label: typed === '' ? 'Type what to tell its agent' : typed,
          icon: 'send',
          match: [],
          key: 'steer',
        },
      ]
    } else {
      rows = commandsFor(input.value, {
        ...jumpsOf(view.store, view.may?.acts),
        talk: talkNow() ?? null,
        recent: recentIn(),
      })
    }
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
      (one, row) => fillRow(one, row, lit, asked),
    )
    if (rows[lit] === undefined) input.removeAttribute('aria-activedescendant')
    else input.setAttribute('aria-activedescendant', `pal-${lit}`)
    talkIn()
  }

  /** The conversation's standing, its last lines, and why there is no message row. */
  const talkIn = () => {
    const talk = talkNow()
    const may = mayRead(view.store, 'talk')
    // With something typed the list is what matters, and the conversation
    // steps back to its one line of standing.
    const shown = may && input.value.trim() === '' ? chatOf(view.store).slice(-LINES) : []
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

  const tell = (task) => {
    telling = task
    chip.hidden = task === null
    textIn(chip, task === null ? '' : task.id.split('/').at(-1))
    input.setAttribute('placeholder', task === null ? 'Ask Tade, or jump to…' : 'Tell its agent…')
    input.value = ''
    lit = 0
    draw()
    input.focus()
  }

  /** One press of a door, and what came of it in Tade's own words. */
  const send = async (path, body) => {
    going = true
    const answer = await ctx.ask('POST', path, body)
    going = false
    const came = afterAnswer(answer, ctx.sentence(answer))
    if (came.ok) felt()
    answerIn(status, came.said, came.trouble)
    return came
  }

  const run = async (row) => {
    if (row === undefined || going) return
    if (row.kind === 'go') {
      remember({ path: row.path, label: row.label, icon: row.icon })
      shut()
      ctx.go(row.path)
      return
    }
    const task = row.task === undefined ? null : (view?.store.rows.tasks.get(row.task) ?? null)
    if (row.kind === 'tell') {
      if (task !== null) tell(task)
      return
    }
    if (row.kind === 'act') {
      if (task === null) return
      // Twice for what asking again does not undo, as on the task's own page.
      if (confirms(row.verb) && asked !== row.key) {
        asked = row.key
        draw()
        return
      }
      asked = null
      await send(`/api/act/${row.verb}`, bodyFor(row.verb, task, keyOf(), ctx.revOf(), row.typed))
      draw()
      return
    }
    if (row.kind === 'steer') {
      const said = input.value.trim()
      const target = view?.store.rows.tasks.get(telling?.id) ?? telling
      if (said === '' || target === null) return
      const came = await send(
        '/api/act/steer',
        bodyFor('steer', target, keyOf(), ctx.revOf(), { said }),
      )
      if (came.clear) tell(null)
      return
    }
    const talk = talkNow()
    if (talk === null || talk === undefined) return
    const came = await send('/api/ask/ask', askBody(talk, keyOf(), ctx.revOf(), input.value.trim()))
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
    asked = null
    draw()
    input.focus()
  }

  const shut = () => {
    if (node.hidden) return
    node.hidden = true
    document.documentElement.classList.remove('pal-open')
    textIn(status, '')
    telling = null
    chip.hidden = true
    input.setAttribute('placeholder', 'Ask Tade, or jump to…')
    opener?.focus?.()
  }

  input.addEventListener('input', () => {
    lit = 0
    asked = null
    draw()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      lit = Math.max(0, movedTo(lit, rows.length, event.key === 'ArrowDown' ? 1 : -1))
      asked = null
      draw()
      list.querySelector(`#pal-${lit}`)?.scrollIntoView?.({ block: 'nearest' })
      return
    }
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      void run(rows[lit])
      return
    }
    if (event.key === 'Backspace' && input.value === '' && telling !== null) {
      event.preventDefault()
      tell(null)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (telling !== null) tell(null)
      else shut()
    }
  })
  list.addEventListener('click', (event) => {
    const option = event.target.closest?.('[role="option"]')
    if (option === null || option === undefined) return
    lit = Number(option.getAttribute('data-at'))
    void run(rows[lit])
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
  const words = el('span', { class: 'pal-words' })
  into(words, el('span', { class: 'pal-label' }), el('span', { class: 'pal-sub' }))
  into(node, icon('bolt'), words, el('span', { class: 'pal-kind' }))
  return node
}

/** What the right-hand column says a row will do when Enter is pressed. */
function kindSaid(row, again) {
  if (again) return 'Again to confirm'
  if (row.kind === 'ask') return 'Ask Tade'
  if (row.kind === 'steer') return 'Send'
  if (row.kind === 'tell') return 'Then type'
  if (row.kind === 'act') return 'Do'
  return row.hint !== undefined && row.hint !== '' ? row.hint : 'Go'
}

function fillRow(node, row, lit, asked) {
  if (row.head === true) {
    textIn(node, row.group)
    return
  }
  const [glyph, words, kind] = node.children
  const [label, sub] = words.children
  node.setAttribute('id', `pal-${row.at}`)
  node.setAttribute('data-at', String(row.at))
  node.setAttribute('aria-selected', row.at === lit ? 'true' : 'false')
  node.classList.toggle('is-asked', asked === row.key)
  iconIn(glyph, row.icon)
  toneOn(glyph, row.tone ?? '')
  // The typed letters lit inside the label: built as text nodes and `<mark>`s,
  // never as markup, and rebuilt only when the label or the letters moved.
  const want = `${row.label}|${(row.match ?? []).join(',')}`
  if (label.getAttribute('data-was') !== want) {
    label.setAttribute('data-was', want)
    label.textContent = ''
    for (const part of litOf(row.label, row.match ?? [])) {
      label.append(part.on ? el('mark', { text: part.text }) : document.createTextNode(part.text))
    }
  }
  textIn(sub, row.sub ?? '')
  sub.hidden = (row.sub ?? '') === ''
  textIn(kind, kindSaid(row, asked === row.key))
  kind.classList.toggle('is-key', row.kind === 'go' && (row.hint ?? '') !== '')
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
