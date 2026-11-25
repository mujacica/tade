// One agent's menu, and the presses on its row: what the window's own agent
// row offers — start, stop, close, and the whole of its right-click menu —
// from a phone or a browser.
//
// **The list is the window's** (`GET /api/agent/:project/:task/menu`): its
// items in its order, each off with the window's own word for why where it
// cannot be done now, and only what this device may ask (`agent-menu.ts`). So
// nothing here decides what an agent can be asked; it draws the answer and
// sends each press through the same act door every control on the page uses
// (`bodyFor`, a key per press kept across a retry, `afterAnswer`).
//
// **On a phone it is a sheet from the bottom**, where the thumb is, opened by
// the row's ⋯ or by holding the row down; at a desk it opens beside what was
// pressed, and a right-click opens it too. Every item is a `--tap` high, an
// item that cannot be done is drawn with its reason rather than left out —
// the window's menu does the same, so the two read alike — and the ones that
// are not undone by asking again take a second tap.

import { afterAnswer, bodyFor, confirms, standingOf } from './acts.js'
import { keyOf } from './controls.js'
import { classOn, el, into, textIn } from './dom.js'
import { icon, iconIn } from './icons.js'
import { changesPath, taskPath } from './routes.js'
import { fullAccessOf } from './trouble.js'
import { answerIn } from './ui.js'

/** How long a row must be held for it to be a long-press rather than a tap or a scroll. */
export const HOLD_MS = 480

/** How far a finger may move during a hold and still be holding, not scrolling. */
const HOLD_SLOP = 10

/** How long a "tap again" stays asked before it goes back to its own word. */
const ASKED_MS = 4_000

/** The path one agent's menu is read from. */
export function menuPath(task) {
  const cut = task.indexOf('/')
  const project = encodeURIComponent(task.slice(0, cut))
  const name = encodeURIComponent(task.slice(cut + 1))
  return `/api/agent/${project}/${name}/menu`
}

/**
 * What one press sends, for a verb a menu item or a row's button carries:
 * `bodyFor`'s body, with what the item says beside it (`with`), what was
 * chosen and what was typed.
 */
export function menuTyped(act, choice = '', typed = '') {
  const given = act?.with ?? {}
  return { ...given, choice, title: typed, summary: '' }
}

/**
 * Send one act about one agent, through the page's one door, and say what
 * came of it in `said`. `row` is read **at the press** (`rowOf`), so the
 * revision echoed is the one the screen shows now.
 */
export async function sendAct(ctx, verb, row, typed, said) {
  if (row === null || row === undefined) return { ok: false }
  const answer = await ctx.ask(
    'POST',
    `/api/act/${verb}`,
    bodyFor(verb, row, keyOf(), ctx.revOf(), typed),
  )
  const came = afterAnswer(answer, ctx.sentence(answer), ctx.session?.() ?? null)
  if (said !== null) answerIn(said, came.said, came.trouble)
  return came
}

/**
 * Hold a row down to open its menu: a finger kept still for `HOLD_MS`, or a
 * right-click. The click that would follow a hold is swallowed, so holding a
 * row never also opens it.
 */
export function holdOpens(node, open) {
  let timer = null
  let start = null
  let held = false
  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    start = null
  }
  node.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return
    held = false
    start = { x: event.clientX, y: event.clientY }
    timer = setTimeout(() => {
      timer = null
      held = true
      open(node)
    }, HOLD_MS)
  })
  node.addEventListener('pointermove', (event) => {
    if (start === null) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > HOLD_SLOP) cancel()
  })
  node.addEventListener('pointerup', cancel)
  node.addEventListener('pointercancel', cancel)
  // A hold's click would hit the menu's scrim.
  node.addEventListener('touchend', (event) => {
    if (held) event.preventDefault()
  })
  node.addEventListener(
    'click',
    (event) => {
      if (!held) return
      held = false
      event.preventDefault()
      event.stopPropagation()
    },
    true,
  )
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    cancel()
    open(node)
  })
}

/**
 * Start or stop, close, and ⋯ on one agent's row — the side's and the Agents
 * list's alike: the window's row's own presses, each through the
 * act door with what the row says it can be asked (`standingOf`). A verb this
 * device was not granted is not drawn at all; one it was, that cannot be done
 * now, is not drawn here and is in the menu with its reason. `acting` is the
 * page's context, the one menu, and how to read a row at the press; `saidOf`
 * is where what came of a press is said, under the row.
 */
export function agentPresses(acting, saidOf) {
  // A `span`, so a list's own `.rows > li > div` (a whole row) is never it.
  const node = el('span', { class: 'side-acts agent-acts' })
  const toggle = el('button', { class: 'tap icon side-press', attrs: { type: 'button' } })
  const toggleIcon = icon('play')
  into(toggle, toggleIcon)
  const shut = el('button', { class: 'tap icon side-press is-danger', attrs: { type: 'button' } })
  into(shut, icon('close'))
  const more = el('button', {
    class: 'tap icon side-press',
    attrs: { type: 'button', 'aria-haspopup': 'dialog' },
  })
  into(more, icon('more'))
  into(node, toggle, shut, more)
  node.hidden = acting === null
  let task = null
  let toggleVerb = null
  let asked = null
  let askedTimer = null
  let saidTimer = null
  let going = false

  const label = (press, verb, words) => {
    press.setAttribute('aria-label', asked === verb ? `Tap again to ${words.toLowerCase()}` : words)
    press.title = asked === verb ? 'Tap again to confirm' : words
    classOn(press, 'asked', asked === verb)
  }
  const relabel = () => {
    const name = task?.name ?? ''
    if (toggleVerb !== null) {
      label(toggle, toggleVerb, toggleVerb === 'stop' ? `Stop ${name}` : `Start ${name}`)
    }
    label(shut, 'remove', `Close ${name}`)
    more.setAttribute('aria-label', `More for ${name}`)
    more.title = 'More'
  }
  const press = async (verb) => {
    if (acting === null || task === null || going) return
    if ((verb === 'stop' || verb === 'remove') && asked !== verb) {
      asked = verb
      clearTimeout(askedTimer)
      askedTimer = setTimeout(() => {
        asked = null
        relabel()
      }, 4_000)
      relabel()
      return
    }
    asked = null
    relabel()
    going = true
    const said = saidOf()
    said.hidden = false
    const came = await sendAct(acting.ctx, verb, acting.rowOf(task.id), {}, said)
    going = false
    clearTimeout(saidTimer)
    // Said long enough to read, then let go: the row itself shows what is true now.
    saidTimer = setTimeout(
      () => {
        said.hidden = true
      },
      came.ok ? 6_000 : 12_000,
    )
  }
  toggle.addEventListener('click', () => void press(toggleVerb))
  shut.addEventListener('click', () => void press('remove'))
  const openMenu = (from) => {
    if (acting === null || task === null) return
    const id = task.id
    acting.menu.open(id, from, () => acting.rowOf(id))
  }
  more.addEventListener('click', () => openMenu(more))

  return {
    node,
    openMenu,
    update(row, acts) {
      task = row
      // Whether this is the person's own device, off its own session: a drawing
      // hint, asked again of the record at the act (`Verb.theirs`).
      const theirs = acting !== null && fullAccessOf(acting.ctx.session?.() ?? null)
      const stop = standingOf('stop', row, acts)
      const start = standingOf('start', row, acts)
      toggleVerb = stop.kind === 'yes' ? 'stop' : start.kind === 'yes' ? 'start' : null
      toggle.hidden = toggleVerb === null
      if (toggleVerb !== null) iconIn(toggleIcon, toggleVerb === 'stop' ? 'stop' : 'play')
      // Closing removes its worktree and branch: the person's own device's alone.
      shut.hidden = !theirs || standingOf('remove', row, acts).kind !== 'yes'
      relabel()
    },
  }
}

/**
 * The menu, built once and filled each time it is opened.
 *
 * `open(task, from, rowOf)`: the agent, the element it was opened from (focus
 * goes back there when it closes), and how to read the agent's row at the
 * moment of a press.
 */
export function agentMenu(ctx) {
  const node = el('div', {
    class: 'amenu',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'amenu-head' },
  })
  node.hidden = true
  const scrim = el('div', { class: 'scrim', attrs: { 'aria-hidden': 'true' } })
  const box = el('div', { class: 'amenu-box' })
  const top = el('div', { class: 'amenu-top' })
  const back = el('button', {
    class: 'tap icon amenu-back',
    attrs: { type: 'button', 'aria-label': 'Back to its menu' },
  })
  into(back, icon('back'))
  const head = el('h2', { class: 'amenu-head', attrs: { id: 'amenu-head' } })
  const close = el('button', {
    class: 'tap icon',
    attrs: { type: 'button', 'aria-label': 'Close' },
  })
  into(close, icon('close'))
  into(top, back, head, close)
  const list = el('ul', { class: 'amenu-list', attrs: { role: 'list' } })
  const form = el('form', { class: 'amenu-form' })
  const input = el('input', {
    attrs: { type: 'text', maxlength: '200', 'aria-label': 'its new name', autocomplete: 'off' },
  })
  const save = el('button', { class: 'press', text: 'Save', attrs: { type: 'submit' } })
  into(form, input, save)
  const said = el('p', { class: 'amenu-said', attrs: { role: 'status' } })
  into(box, top, list, form, said)
  into(node, scrim, box)

  let task = ''
  let rowOf = () => null
  let opener = null
  let items = []
  let sub = null
  let typing = null
  let asked = null
  let askedTimer = null
  let going = false
  let mounted = false

  const shut = () => {
    if (node.hidden) return
    node.hidden = true
    document.documentElement.classList.remove('pal-open')
    if (opener !== null && typeof opener.focus === 'function') opener.focus()
    opener = null
  }

  // A redraw replaces the focused row, and focus would fall out of the sheet,
  // past its Escape and Tab: it goes back to that item, or the first one.
  const inside = () => box.contains(document.activeElement) && document.activeElement.offsetParent
  const draw = () => {
    const held = inside() ? (document.activeElement.dataset.item ?? '') : null
    paint()
    if (held === null || node.hidden || inside()) return
    const rows = [...list.querySelectorAll('.amenu-item:not(.is-off)')]
    ;(rows.find((one) => one.dataset.item === held) ?? rows[0] ?? close).focus()
  }

  const paint = () => {
    const name = rowOf()?.name ?? task.slice(task.indexOf('/') + 1)
    back.hidden = sub === null && typing === null
    textIn(
      head,
      sub !== null
        ? `${sub.item.label.replace(/…$/, '')} — ${name}`
        : typing !== null
          ? `Rename ${name}`
          : name,
    )
    form.hidden = typing === null
    list.hidden = typing !== null
    if (typing !== null) return
    const rows = sub === null ? items : sub.item.act.choices
    list.replaceChildren(...rows.map((one) => (sub === null ? itemNode(one) : choiceNode(one))))
    if (sub !== null && rows.length === 0) {
      list.replaceChildren(
        el('li', { class: 'amenu-none', text: sub.item.act.why ?? 'nothing to choose from now' }),
      )
    }
  }

  /** One of the window's items: its label, its note, and why not where it cannot be done. */
  const itemNode = (item) => {
    const li = el('li', { class: 'amenu-row' })
    classOn(li, 'is-rule', item.divider)
    const off = item.off !== null
    const askedHere = asked === item.id
    // Its screen and its changes are places, so a link: a press that goes there.
    const goes =
      item.act.kind === 'page' && !off
        ? { open: taskPath(task), changes: changesPath(task) }[item.act.does]
        : undefined
    const tag = goes === undefined ? 'button' : 'a'
    const press = el(tag, {
      class: 'amenu-item',
      attrs:
        tag === 'a'
          ? { href: goes, 'data-item': item.id }
          : { type: 'button', 'data-item': item.id, ...(off ? { 'aria-disabled': 'true' } : {}) },
    })
    classOn(press, 'is-danger', item.danger)
    classOn(press, 'is-off', off)
    classOn(press, 'asked', askedHere)
    const words = el('span', { class: 'amenu-words' })
    into(
      words,
      el('span', { class: 'amenu-label', text: askedHere ? 'Tap again to confirm' : item.label }),
    )
    if (off) into(words, el('span', { class: 'amenu-why', text: item.off }))
    into(press, words)
    if (!off && item.note !== null && item.note !== '') {
      into(press, el('span', { class: 'amenu-note', text: item.note }))
    }
    if (item.act.kind === 'choose' && !off) into(press, icon('chevron', 'amenu-more'))
    if (tag === 'a') press.addEventListener('click', () => shut())
    else press.addEventListener('click', () => void pressed(item))
    into(li, press)
    return li
  }

  /** One choice under an item: the one it is on marked, the ones it cannot take with why. */
  const choiceNode = (choice) => {
    const li = el('li', { class: 'amenu-row' })
    const off = choice.off !== null
    const press = el('button', {
      class: 'amenu-item',
      attrs: {
        type: 'button',
        ...(off ? { 'aria-disabled': 'true' } : {}),
        ...(choice.current ? { 'aria-current': 'true' } : {}),
      },
    })
    classOn(press, 'is-off', off)
    const words = el('span', { class: 'amenu-words' })
    into(words, el('span', { class: 'amenu-label', text: choice.label }))
    if (off) into(words, el('span', { class: 'amenu-why', text: choice.off }))
    into(press, el('span', { class: 'amenu-mark', text: choice.current ? '●' : '' }), words)
    const note = choice.current ? 'now' : choice.note
    if (!off && note !== null && note !== '')
      into(press, el('span', { class: 'amenu-note', text: note }))
    press.addEventListener('click', () => {
      if (off || choice.current) return
      void send(sub.item.act.verb, menuTyped(sub.item.act, choice.id))
    })
    into(li, press)
    return li
  }

  const pressed = async (item) => {
    if (item.off !== null || going) return
    const act = item.act
    if (act.kind === 'here') return
    if (act.kind === 'page') {
      if (act.does === 'copy-branch') {
        const branch = rowOf()?.branch ?? ''
        try {
          await navigator.clipboard.writeText(branch)
          answerIn(said, `copied ${branch}`, null)
        } catch (error) {
          // The browser would not copy (no permission, not a secure page): the
          // name is said instead, with why, so it can be copied by hand.
          answerIn(said, `its branch is ${branch} — not copied: ${error?.name ?? 'refused'}`, null)
        }
      }
      return
    }
    if (act.kind === 'choose') {
      sub = { item }
      draw()
      list.querySelector('button:not([aria-disabled])')?.focus()
      return
    }
    if (act.kind === 'type') {
      typing = { item }
      input.value = act.value
      draw()
      input.focus()
      input.select()
      return
    }
    // A second tap for what asking again does not undo; the body's own
    // `confirm` literal is the other half (`confirms`).
    if (confirms(act.verb) && asked !== item.id) {
      asked = item.id
      clearTimeout(askedTimer)
      askedTimer = setTimeout(() => {
        asked = null
        if (!node.hidden && sub === null) draw()
      }, ASKED_MS)
      draw()
      list.querySelector('.asked')?.focus()
      return
    }
    asked = null
    await send(act.verb, menuTyped(act))
  }

  const send = async (verb, typed) => {
    if (going) return
    going = true
    node.setAttribute('aria-busy', 'true')
    const came = await sendAct(ctx, verb, rowOf(), typed, said)
    going = false
    node.removeAttribute('aria-busy')
    sub = null
    typing = null
    // **What it can be asked now is the machine's to say again**: a start
    // made a stop, a park made a pick-up. Removed is gone, and the sheet with it.
    if (came.ok && verb === 'remove') {
      shut()
      return
    }
    await load()
  }

  const load = async () => {
    const answer = await ctx.ask('GET', menuPath(task))
    if (node.hidden) return
    if (answer.status === 200 && Array.isArray(answer.body?.items)) {
      items = answer.body.items
      if (items.length === 0) {
        answerIn(said, answer.body.why ?? 'nothing can be done to it from this device', null)
      }
    } else {
      items = []
      const came = afterAnswer(answer, ctx.sentence(answer), ctx.session?.() ?? null)
      answerIn(said, came.said, came.trouble)
    }
    draw()
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (typing === null || input.value.trim() === '') return
    void send(typing.item.act.verb, menuTyped(typing.item.act, '', input.value))
  })
  back.addEventListener('click', () => {
    sub = null
    typing = null
    draw()
    list.querySelector('.amenu-item')?.focus()
  })
  close.addEventListener('click', shut)
  scrim.addEventListener('click', shut)
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (sub !== null || typing !== null) back.click()
      else shut()
      return
    }
    // Focus stays inside the menu: Tab from the last control comes back to the first.
    if (event.key !== 'Tab') return
    const presses = [...box.querySelectorAll('button:not([hidden]), a, input')].filter(
      (one) => one.offsetParent !== null,
    )
    if (presses.length === 0) return
    const first = presses[0]
    const last = presses[presses.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })

  return {
    node,
    /** Open it for one agent, from the element pressed or held. */
    open(id, from, read) {
      if (!mounted) {
        // On the document itself: the side is a drawer that may be moved by a
        // transform, and a fixed sheet inside one would be placed by it.
        document.body.append(node)
        mounted = true
      }
      task = id
      rowOf = read
      opener = from
      items = []
      sub = null
      typing = null
      asked = null
      textIn(said, '')
      said.classList.remove('ui-problem', 'is-inline')
      answerIn(said, 'asking what it offers…', null)
      placeBeside(node, from)
      node.hidden = false
      document.documentElement.classList.add('pal-open')
      draw()
      close.focus()
      void load().then(() => {
        if (said.textContent === 'asking what it offers…') textIn(said, '')
        list.querySelector('.amenu-item:not(.is-off)')?.focus()
      })
    },
    close: shut,
  }
}

/**
 * Where the menu opens at a desk: beside what was pressed, inside the window.
 * Through the CSSOM (`--mx`, `--my`), which the content policy allows where a
 * `style` attribute would be refused. A phone's sheet ignores both.
 */
function placeBeside(node, from) {
  const rect =
    typeof from?.getBoundingClientRect === 'function' ? from.getBoundingClientRect() : null
  const width = 288
  const x = rect === null ? 16 : Math.min(Math.max(8, rect.right - width), innerWidth - width - 8)
  const y = rect === null ? 16 : Math.min(rect.bottom + 4, Math.max(8, innerHeight - 360))
  node.style.setProperty('--mx', `${Math.round(x)}px`)
  node.style.setProperty('--my', `${Math.round(y)}px`)
}
