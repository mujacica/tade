// Another machine's screen, `/m/<machine>/…`: the same screen, built with no
// `ctx` (nothing to ask or press here), drawn out of that machine's copy and
// clock, its links that machine's (ONE-AWAY-VIEW §2.4, add-away-surface).

import { classOn, el, into, keyed, textIn, toneOn } from './dom.js'
import { chipsOf, drawsOf, HERE, pickedIn, thereOf } from './machines.js'
import { THERE, thereHref } from './routes.js'
import { copiesOf } from './store.js'

// What the reviews page thins every machine's stores by, for the router.
export { reviewsOnce } from './machines.js'

/** The router's screen for `at`, made another machine's where `at` is one. */
export function thereOn(at, screen) {
  if (typeof at.machine !== 'string' || !THERE.includes(at.view)) return screen
  const drawn = drawnThere(at.machine, screen)
  return { ...drawn, update: (view) => drawn.update(view, onOf(view, at.machine)) }
}

/** `screen` drawn as `machine`'s out of `on` (`thereOf`): its line over it, its links that machine's. */
function drawnThere(machine, screen) {
  const line = el('p', { class: 'there-line', attrs: { role: 'status' } })
  screen.node.prepend(line)
  return {
    node: screen.node,
    update(view, on) {
      screen.update({ ...view, store: on.store, asOf: on.asOf, frozen: on.frozen })
      textIn(line, on.line)
      classOn(screen.node, 'is-there-down', !on.up)
      linksThere(screen.node, machine)
    },
    leave() {
      screen.leave?.()
    },
  }
}

const onOf = (view, machine) =>
  thereOf(view.store, machine, view.standing === 'live', view.now ?? Date.now())

/* ── every machine's rows on one page (ONE-AWAY-VIEW §2.4) ─────────────────── */

// Which machine the chips picked: one for the page, kept while it is open, never on the disk.
let picked = null

/** The pick as it stands for `store`: `null` All, `HERE` this machine, or another's name. */
export const machinePicked = (store) => pickedIn(store, picked)

/** All · This machine · each other: a press picks, and every screen is drawn again. */
export function machineChips() {
  const node = el('div', {
    class: 'filter machine-chips',
    attrs: { role: 'group', 'aria-label': 'Machines' },
  })
  return {
    node,
    update(store) {
      const chips = chipsOf(store, picked)
      node.hidden = chips.length === 0
      keyed(node, chips, (one) => (one.key === null ? '*' : `@${one.key}`), createChip, fillChip)
    },
  }
}

function createChip() {
  const chip = el('button', { class: 'ui-chip filter-chip', attrs: { type: 'button' } })
  into(
    chip,
    el('span', { class: 'glyph', text: '●', attrs: { 'aria-hidden': 'true' } }),
    el('span'),
    el('span', { class: 'chip-said' }),
  )
  chip.addEventListener('click', () => {
    picked = chip.pick
    globalThis.dispatchEvent?.(new Event('tade:machine'))
  })
  return chip
}

function fillChip(chip, one) {
  const [dot, name, said] = chip.children
  chip.pick = one.key
  chip.setAttribute('aria-pressed', one.on ? 'true' : 'false')
  chip.setAttribute('aria-label', one.said === null ? one.label : `${one.label}, ${one.said}`)
  dot.hidden = one.key === null
  toneOn(dot, one.tone)
  textIn(name, one.label)
  // Up is the dot alone; any other state is said, since a colour is never the only word.
  textIn(said, one.said === null || one.said === 'up' ? '' : one.said)
}

/**
 * A list screen drawn for every machine the chips pick: this one's, then each
 * other's out of its copy under its line, built with no `ctx`. `once` may
 * thin what each is drawn from, given them all in order (`reviewsOnce`).
 */
export function everyMachine(make, ctx = null, once = null) {
  const own = make(ctx)
  const chips = machineChips()
  const mark = el('p', { class: 'there-line', text: 'This machine' })
  // Under this page's own bar, which stays the top of the screen whichever is picked.
  const bar = own.node.querySelector('.pg-bar')
  if (bar === null) own.node.prepend(chips.node, mark)
  else bar.after(chips.node, mark)
  const others = el('div')
  const node = el('div')
  into(node, own.node, others)
  return {
    node,
    update(view) {
      const pick = machinePicked(view.store)
      chips.update(view.store)
      const copies = copiesOf(view.store)
      const drawn = [
        { machine: HERE, on: null, store: view.store },
        ...copies.map(({ machine }) => {
          const on = onOf(view, machine)
          return { machine, on, store: on.store }
        }),
      ].filter((one) => drawsOf(pick, one.machine))
      const stores = once === null ? drawn.map((one) => one.store) : once(drawn)
      const mine = drawn[0]?.machine === HERE
      // Marked only where more than one machine is drawn from.
      mark.hidden = !mine || copies.length === 0
      classOn(own.node, 'not-here', !mine)
      if (mine) own.update({ ...view, store: stores[0] })
      const theirs = drawn
        .map((one, at) => ({ ...one, store: stores[at] }))
        .filter((one) => one.on !== null)
      keyed(
        others,
        theirs,
        (one) => one.machine,
        (one) => holder(one.machine, make),
        (box, one) => box.there.update(view, { ...one.on, store: one.store }),
      )
    },
    leave() {
      own.leave?.()
    },
  }
}

function holder(machine, make) {
  const box = el('div', { class: 'there-box' })
  box.there = drawnThere(machine, make(null))
  into(box, box.there.node)
  return box
}

// A verb carried to another machine, and its fields there (`pressed-there.ts`).
const CARRIED = {
  steer: (b) => ({ said: b.said }),
  stop: () => ({ confirm: true }),
  park: (b) => ({ parked: b.parked }),
  note: (b) => ({ text: b.text }),
  queue: (b) => ({ change: b.change }),
  remove: () => ({}),
  // A whole project's queue, which names no task (`projectScreen`'s one press there).
  'queue project': (b) => ({ project: b.project, change: b.change }),
}

export const THERE_VERBS = Object.keys(CARRIED)

/** `ctx` with its acts carried to `machine` through this door; any other refused here. */
export function thereCtx(ctx, machine) {
  const ask = async (method, path, body) => {
    const verb = path.startsWith('/api/act/') ? path.slice(9) : ''
    const fields = method === 'POST' ? CARRIED[verb] : undefined
    if (
      fields === undefined ||
      (verb.startsWith('queue') && !['pause', 'resume'].includes(body.change))
    )
      return refusedThere(`${machine} takes that only at its own screen: ask Tade`)
    const answer = await ctx.ask('POST', '/api/there/press', {
      machine,
      key: body.key,
      verb: verb === 'remove' ? 'close' : verb,
      task: body.task,
      ...fields(body),
    })
    if (answer.status !== 200 || answer.body?.ok === true) return answer
    return refusedThere(answer.body?.said ?? `${machine} did not do it`)
  }
  return { ...ctx, ask, machine }
}

const refusedThere = (said) => ({ status: 409, body: { error: 'there', said } })

/** Every link on a screen made `machine`'s (`thereHref`), or words. */
export function linksThere(node, machine) {
  for (const link of node.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')
    const made = thereHref(machine, href)
    if (made === null) link.removeAttribute('href')
    else if (made !== href) link.setAttribute('href', made)
  }
}
