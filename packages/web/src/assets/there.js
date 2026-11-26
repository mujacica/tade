// Another machine's screen, `/m/<machine>/…`: the same screen, built with no
// `ctx` (nothing to ask or press here), drawn out of that machine's copy and
// clock, its links that machine's (ONE-AWAY-VIEW §2.4, add-away-surface).

import { classOn, el, textIn } from './dom.js'
import { thereOf } from './machines.js'
import { THERE, thereHref } from './routes.js'

/** The router's screen for `at`, made another machine's where `at` is one. */
export function thereOn(at, screen) {
  if (typeof at.machine !== 'string' || !THERE.includes(at.view)) return screen
  const line = el('p', { class: 'there-line', attrs: { role: 'status' } })
  screen.node.prepend(line)
  return {
    node: screen.node,
    update(view) {
      const on = thereOf(view.store, at.machine, view.standing === 'live', view.now ?? Date.now())
      screen.update({ ...view, store: on.store, asOf: on.asOf, frozen: on.frozen })
      textIn(line, on.line)
      classOn(screen.node, 'is-there-down', !on.up)
      linksThere(screen.node, at.machine)
    },
    leave() {
      screen.leave?.()
    },
  }
}

// A verb carried to another machine, and its fields there (`pressed-there.ts`).
const CARRIED = {
  steer: (b) => ({ said: b.said }),
  stop: () => ({ confirm: true }),
  park: (b) => ({ parked: b.parked }),
  note: (b) => ({ text: b.text }),
  queue: (b) => ({ change: b.change }),
  remove: () => ({}),
}

export const THERE_VERBS = Object.keys(CARRIED)

/** `ctx` with its acts carried to `machine` through this door; any other refused here. */
export function thereCtx(ctx, machine) {
  const ask = async (method, path, body) => {
    const verb = path.startsWith('/api/act/') ? path.slice(9) : ''
    const fields = method === 'POST' ? CARRIED[verb] : undefined
    if (fields === undefined || (verb === 'queue' && !['pause', 'resume'].includes(body.change)))
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
