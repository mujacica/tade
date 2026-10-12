// What just changed, said once and then let go: a toast per piece of work that
// crossed into a state somebody would want to know about.
//
// **Nothing here decides a state.** The states are `deriveState`'s, off the
// wire; this compares the last set it saw with this one and names the
// crossings — the same comparison `crossing` makes for the one live region,
// with a picture. So a toast can only ever say what the page already says
// somewhere, and it says it where the eye is at the moment it happened.
//
// **Never on arriving.** The first snapshot is not a change to anything, and a
// page reopened after a night away would otherwise greet somebody with forty
// toasts about yesterday; and past `MOST` at once they fold into one that
// counts them, because a stack that fills the screen is the opposite of
// telling somebody what changed.
//
// **Not a second live region.** The page has exactly one (`shell.js`), and it
// already reads out what crossed into wanting you; a toast is a link to the
// work for the eye, inside a labelled region, and says nothing aloud.

import { el, into, toneOn } from './dom.js'
import { icon } from './icons.js'
import { taskPath } from './routes.js'

/** How many toasts stand at once before the rest are counted into one. */
export const MOST = 3

/** How long a toast stands, unless somebody's pointer or focus is on it. */
export const STANDS_MS = 6000

/**
 * What each crossing is called, drawn as and toned.
 *
 * Into `blocked` or `failed` is somebody being wanted; working into `review`
 * is an agent finishing; into `merged` is the work landing; a task that had
 * no agent gaining one is work starting. Everything else — a reason changing,
 * a figure moving — is a delta, not news.
 */
export const KINDS = {
  wants: { word: 'wants you', icon: 'flag', tone: 't-wants' },
  failed: { word: 'failed', icon: 'alert', tone: 't-failed' },
  finished: { word: 'finished', icon: 'check', tone: 't-done' },
  merged: { word: 'merged', icon: 'check', tone: 't-done' },
  started: { word: 'started', icon: 'bolt', tone: 't-working' },
}

/** What a set of tasks is, for comparing: each id's state and whether an agent runs it. */
export function statesOf(tasks) {
  const held = new Map()
  for (const task of tasks) {
    held.set(task.id, { state: task.state, running: (task.agents ?? 0) > 0 })
  }
  return held
}

/**
 * The crossings between two sets, in a stable order — pure, so a test holds it.
 *
 * `null` for the set before is *nothing was seen yet*, and answers nothing.
 */
export function transitionsOf(was, is) {
  if (was === null) return []
  const out = []
  for (const [id, now] of is) {
    const then = was.get(id)
    if (then === undefined) {
      if (now.running) out.push({ id, kind: 'started' })
      continue
    }
    if (now.state === then.state) {
      if (now.running && !then.running && now.state === 'working') out.push({ id, kind: 'started' })
      continue
    }
    if (now.state === 'blocked') out.push({ id, kind: 'wants' })
    else if (now.state === 'failed') out.push({ id, kind: 'failed' })
    else if (now.state === 'review' && then.state === 'working') out.push({ id, kind: 'finished' })
    else if (now.state === 'merged') out.push({ id, kind: 'merged' })
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The toasts to stand: the first few as themselves, the rest as one count. */
export function shownOf(changes) {
  if (changes.length <= MOST) return changes.map((one) => ({ ...one, ...KINDS[one.kind] }))
  const first = changes.slice(0, MOST - 1).map((one) => ({ ...one, ...KINDS[one.kind] }))
  return [
    ...first,
    {
      id: '',
      kind: 'more',
      word: `${changes.length - first.length} more changed`,
      icon: 'overview',
      tone: 't-quiet',
    },
  ]
}

/** How many changes the page remembers having seen. */
export const LOG_MOST = 12

/**
 * The changes this page has seen since it opened, newest first, each with
 * the moment it saw it — held in memory and nowhere else, so a reload starts
 * the list over and the overview says that is what it is.
 */
const seen = []

export function changesSeen() {
  return seen
}

/** A list of changes with the newest in front, each once, and no longer than `most`. */
export function loggedWith(log, changes, at, most = LOG_MOST) {
  const fresh = changes.map((one) => ({ ...one, at, key: `${one.id}|${one.kind}|${at}` }))
  return [...fresh, ...log].slice(0, most)
}

export function toasts() {
  const node = el('aside', { class: 'toasts', attrs: { 'aria-label': 'What just changed' } })
  let was = null

  const stand = (one) => {
    const toast = el('a', {
      class: 'toast',
      attrs: { href: one.id === '' ? '/' : taskPath(one.id) },
    })
    const mark = icon(one.icon)
    toneOn(mark, one.tone)
    const words = el('span', { class: 'toast-words' })
    if (one.id !== '') into(words, el('span', { class: 'toast-name', text: one.id }))
    into(words, el('span', { class: `toast-word ${one.tone}`, text: one.word }))
    into(toast, mark, words)
    node.prepend(toast)
    // Held while somebody is on it: a toast that leaves under a thumb or a
    // pointer is a link that moved as it was pressed.
    let gone = null
    const go = () => {
      gone = setTimeout(() => {
        toast.classList.add('leaving')
        setTimeout(() => toast.remove(), 220)
      }, STANDS_MS)
    }
    const hold = () => clearTimeout(gone)
    toast.addEventListener('pointerenter', hold)
    toast.addEventListener('focus', hold)
    toast.addEventListener('pointerleave', go)
    toast.addEventListener('blur', go)
    toast.addEventListener('click', () => toast.remove())
    go()
    while (node.children.length > MOST) node.lastElementChild?.remove()
  }

  return {
    node,
    /** One frame's tasks: stand a toast for each crossing since the last. */
    update(tasks, live) {
      const is = statesOf(tasks)
      const changes = transitionsOf(was, is)
      was = is
      if (changes.length > 0) {
        const next = loggedWith(seen, changes, Date.now())
        seen.length = 0
        seen.push(...next)
      }
      // Only for a page that is live and in front of somebody: a hidden tab
      // catching up, or a page reconnecting with a backlog, is not news.
      if (!live || document.visibilityState !== 'visible') return
      for (const one of shownOf(changes).reverse()) stand(one)
    },
  }
}
