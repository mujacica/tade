// The frame every screen is drawn inside: the wordmark, the freshness clock, the
// navigation, the bars that say how the page stands to the machine, and the
// region a screen reader is told about.
//
// **The freshness line is the most important thing on the page**, and §5.10 is
// why: when the stream drops, every row keeps its last state and the page gains
// one bar. No row changes glyph, no count changes, nothing becomes nought.
// *Unreachable is never stopped* — a sleeping laptop runs nothing, and a page
// that drew `0 working` because it could not ask would be lying about
// somebody's morning.
//
// Two accessibility decisions are structural rather than attributes sprinkled
// on afterwards:
//
// - **One `aria-live` region, and it announces only what crossed into wanting
//   you and what stopped.** Announcing the snapshot would read the whole page
//   aloud every two seconds, which is worse than announcing nothing.
// - **The navigation is a real `<nav>` with `aria-current` on where you are**,
//   and **an update never moves it**: the tab you are on changes when you
//   navigate and at no other time.

import { classOn, el, glyphOf, hintOf, into, keyed, markIn, textIn, toneOn } from './dom.js'
import { clockOf, duration, shortClockOf } from './figures.js'
import { freshMark, taskMark } from './glyphs.js'
import { icon, wordmark } from './icons.js'
import { backoffAt, partsOf } from './live.js'
import { GROUPS, MORE_TAB, NAV, navFor, pathOf, placeOf, TITLES, taskPath } from './routes.js'
import { projectsOf, tasksIn } from './store.js'

/**
 * The whole frame, built once for the life of the page.
 *
 * Returns the parts the wiring writes into. Nothing here is rebuilt: a screen
 * is swapped inside `main`, and everything else is patched.
 *
 * `desk` is the three parts a desk adds (`desk.js`) — projects along the top,
 * and a dock beside the work with the running agents and Tade — placed here so
 * the reading order is the window's: what is open, the work, what is running,
 * and then the conversation. Each is hidden by the stylesheet below its width.
 *
 * **Tade is one press from anywhere**: the command bar in the header at every
 * width, `⌘K` at a keyboard, and the middle of the tab bar under a thumb. All
 * three open the same bar (`palette.js`), which `boot.js` hands in as `ask`.
 */
export function shell(desk = null) {
  const skip = el('a', {
    class: 'skip',
    text: 'skip to what wants you',
    attrs: { href: '#main' },
  })

  const top = el('header', { class: 'top' })
  const brand = el('a', { class: 'brand', attrs: { href: '/', 'aria-label': 'Tade, overview' } })
  into(brand, wordmark())
  const ask = el('button', {
    class: 'cmd',
    attrs: { type: 'button', 'aria-label': 'Ask Tade, or go anywhere', 'aria-haspopup': 'dialog' },
  })
  into(
    ask,
    icon('spark'),
    el('span', { class: 'cmd-said', text: 'Ask Tade', attrs: { 'aria-hidden': 'true' } }),
    el('kbd', { text: '⌘K', attrs: { 'aria-hidden': 'true' } }),
  )
  const fresh = el('p', { class: 'fresh', attrs: { role: 'status' } })
  const dot = el('span', { class: 'dot', attrs: { 'aria-hidden': 'true' } })
  const freshSaid = el('span', { class: 'fresh-said' })
  into(fresh, dot, freshSaid)
  const tools = el('div', { class: 'tools' })
  const again = el('button', {
    class: 'tap icon',
    attrs: { type: 'button', 'aria-label': 'Ask the machine again' },
  })
  into(again, icon('refresh'))
  const keys = el('button', {
    class: 'tap icon',
    attrs: { type: 'button', 'aria-label': 'Keyboard keys' },
  })
  into(keys, icon('help'))
  into(tools, again, keys)
  into(top, brand, ask, fresh, tools)

  const bars = el('div', { class: 'bars' })

  const frame = el('div', { class: 'frame' })
  const rail = el('nav', { class: 'rail', attrs: { 'aria-label': 'Sections' } })
  const main = el('main', { attrs: { id: 'main' } })
  // The dock: what is running and the conversation, beside the work at a desk.
  const dock =
    desk === null
      ? null
      : el('aside', { class: 'dock', attrs: { 'aria-label': 'Running agents and Tade' } })
  if (dock !== null) into(dock, desk.side, desk.strip)
  // The projects head the work's own column, so the rail and the dock start
  // level with them and the dock's foot — Tade's box — is on the screen.
  into(frame, rail, desk?.projects, main, dock)

  const tabs = el('nav', { class: 'tabs', attrs: { 'aria-label': 'Sections' } })
  const talk = el('button', {
    class: 'tab tab-ask',
    attrs: { type: 'button', 'aria-label': 'Ask Tade, or go anywhere', 'aria-haspopup': 'dialog' },
  })
  const disc = el('span', { class: 'ask-disc' })
  into(disc, icon('spark'))
  into(talk, disc, el('span', { class: 'label', text: 'Ask' }))

  const sheet = el('div', {
    class: 'sheet',
    attrs: { role: 'dialog', 'aria-label': 'Keyboard keys' },
  })
  sheet.hidden = true
  into(sheet, keySheet())

  const announce = el('p', {
    class: 'sr-only',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'false' },
  })

  const { made: links, tree } = navLinks(rail, tabs, talk)
  // The whole rail folds to its icons at a desk, and back: a press at its foot.
  const fold = el('button', {
    class: 'rail-fold',
    attrs: { type: 'button', 'aria-label': 'Fold the sidebar', 'aria-pressed': 'false' },
  })
  into(fold, icon('back'))
  fold.addEventListener('click', () => {
    const mini = !frame.classList.contains('rail-mini')
    frame.classList.toggle('rail-mini', mini)
    fold.setAttribute('aria-pressed', mini ? 'true' : 'false')
    fold.setAttribute('aria-label', mini ? 'Unfold the sidebar' : 'Fold the sidebar')
  })
  rail.append(fold)

  return {
    parts: [skip, top, bars, frame, tabs, sheet, announce].filter(
      (one) => one !== null && one !== undefined,
    ),
    // What only a device with a session is drawn (`insideIn`).
    inside: [rail, tabs, again, ask, desk?.projects, dock, desk?.side, desk?.strip].filter(
      (one) => one !== null && one !== undefined,
    ),
    main,
    bars,
    dot,
    freshSaid,
    announce,
    sheet,
    again,
    keys,
    links,
    tree,
    // The two presses that open the command bar; `boot.js` wires both.
    asks: [ask, talk],
  }
}

/**
 * The navigation, drawn twice: a rail for a tablet and up, a bottom bar for a
 * phone.
 *
 * Twice rather than one list moved by CSS, because the two are different
 * shapes — the rail carries every place with its count at a desk and the bar
 * carries three plus Ask plus More, which is the only arrangement that fits
 * 360px with 44px targets. Both are in the DOM, one is displayed, and each is
 * a `<nav>` a screen reader can jump to.
 */
function navLinks(rail, tabs, talk) {
  const made = []
  const [first, second, ...rest] = NAV
  for (const one of [first, second]) made.push(entry(tabs, one, 'tab'))
  tabs.append(talk)
  for (const one of [...rest, MORE_TAB]) made.push(entry(tabs, one, 'tab'))
  // **The rail, in its categories.** A group with a title has a header that
  // folds it — a press, with `aria-expanded`, never a hover — and the
  // projects' group is the project tree, filled from the store (`railIn`).
  let tree = null
  for (const group of GROUPS) {
    const node = el('div', { class: `rail-group rail-${group.key}` })
    const items = el('div', { class: 'rail-items', attrs: { id: `rail-${group.key}` } })
    if (group.title !== '') {
      const head = el('button', {
        class: 'rail-head',
        attrs: { type: 'button', 'aria-expanded': 'true', 'aria-controls': `rail-${group.key}` },
      })
      into(head, el('span', { text: group.title }), icon('chevron', 'twist'))
      head.addEventListener('click', () => {
        items.hidden = !items.hidden
        head.setAttribute('aria-expanded', items.hidden ? 'false' : 'true')
      })
      into(node, head)
    }
    for (const view of group.views) {
      const one = placeOf(view)
      if (one !== null) made.push(entry(items, one, 'rail'))
    }
    if (group.key === 'projects') {
      tree = el('ul', { class: 'rail-tree', attrs: { 'aria-label': 'Projects' } })
      into(items, tree)
    }
    into(node, items)
    rail.append(node)
  }
  return { made, tree }
}

/* ── the project tree in the rail ──────────────────────────────────────────── */

/** Which projects somebody opened or closed in the tree, for as long as the page is. */
const opened = new Map()

/**
 * The projects in the rail, each a link with its counts and a press that
 * opens it onto its work: every task in it, the ones that want somebody first,
 * each with its state's glyph and a link to its page.
 *
 * **The project you are in opens on its own**, and one somebody closed stays
 * closed; nothing else moves on a delta. Built once per project and patched,
 * as every list here is.
 */
export function railIn(shown, view) {
  if (shown.tree === null) return
  const here =
    view.where.view === 'project' || view.where.view === 'task' ? view.where.project : null
  const on = view.where.view === 'task' ? `${view.where.project}/${view.where.task}` : null
  keyed(
    shown.tree,
    projectsOf(view.store),
    (row) => row.name,
    createTreeProject,
    (one, row) => fillTreeProject(one, row, view, here, on),
  )
}

function createTreeProject() {
  const node = el('li', { class: 'tree-project' })
  const row = el('div', { class: 'tree-row' })
  const twist = el('button', {
    class: 'tree-twist',
    attrs: { type: 'button', 'aria-expanded': 'false' },
  })
  into(twist, icon('chevron', 'twist'))
  const link = el('a', { class: 'tree-link', attrs: { href: '/' } })
  const wants = el('span', { class: 'ui-count is-wants' })
  const working = el('span', { class: 'ui-count is-working' })
  into(link, el('span', { class: 'tree-name' }), wants, working)
  into(row, twist, link)
  const tasks = el('ul', { class: 'tree-tasks' })
  tasks.hidden = true
  into(node, row, tasks)
  twist.addEventListener('click', () => {
    const name = node.getAttribute('data-key') ?? ''
    opened.set(name, tasks.hidden)
    tasks.hidden = !tasks.hidden
    twist.setAttribute('aria-expanded', tasks.hidden ? 'false' : 'true')
  })
  return node
}

/** The order a project's tasks are listed in: what wants somebody, then what works. */
const RANK = { blocked: 0, failed: 1, review: 2, working: 3, queued: 4, parked: 5, merged: 6 }

function fillTreeProject(node, project, view, here, on) {
  const [row, tasks] = node.children
  const [twist, link] = row.children
  const [name, wants, working] = link.children
  link.setAttribute('href', pathOf({ view: 'project', project: project.name }))
  if (project.name === here) link.setAttribute('aria-current', 'page')
  else link.removeAttribute('aria-current')
  textIn(name, project.name)
  const counts = project.counts
  textIn(wants, counts.wantsYou === 0 ? '' : String(counts.wantsYou))
  wants.setAttribute('aria-label', `${counts.wantsYou} wanting you`)
  textIn(working, counts.working === 0 ? '' : String(counts.working))
  working.setAttribute('aria-label', `${counts.working} working`)
  const open = opened.get(project.name) ?? project.name === here
  tasks.hidden = !open
  twist.setAttribute('aria-expanded', open ? 'true' : 'false')
  twist.setAttribute('aria-label', `${open ? 'Close' : 'Open'} ${project.name}`)
  if (!open) return
  const rows = tasksIn(view.store, project.name)
    .filter((task) => task.state !== 'merged')
    .sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9) || (a.name < b.name ? -1 : 1))
  keyed(
    tasks,
    rows,
    (task) => task.id,
    () => {
      const item = el('li')
      const to = el('a', { class: 'tree-task', attrs: { href: '/' } })
      into(to, glyphOf(taskMark('queued')), el('span', { class: 'tree-name' }))
      into(item, to)
      return item
    },
    (item, task) => {
      const to = item.firstChild
      to.setAttribute('href', taskPath(task.id))
      if (task.id === on) to.setAttribute('aria-current', 'page')
      else to.removeAttribute('aria-current')
      markIn(to.firstChild, taskMark(task.state))
      textIn(to.lastChild, task.name)
    },
  )
}

function entry(parent, one, where) {
  // The bottom bar's rows are styled by class and the rail's by descendant, so
  // the class is what the bar needs and the rail does not.
  const link = el('a', {
    class: where === 'tab' ? 'tab' : '',
    attrs: { href: pathOf({ view: one.view }), 'data-label': one.label },
  })
  const label = el('span', { class: 'label', text: one.label })
  // Violet means *waiting on you* and nothing else, so only the two counts of
  // that wear it; every other count is a neutral figure.
  const wants = one.counts === 'wantsYou' || one.counts === 'intake'
  const figure = el('span', { class: wants ? 'count ui-count is-loud' : 'count ui-count' })
  into(link, icon(one.icon), label, figure)
  parent.append(link)
  return { link, figure, view: one.view, counts: one.counts, where }
}

/**
 * The navigation, the desk and the retry, drawn only for a device with a
 * session.
 *
 * Without one the page is the pairing screen or the last view it kept, and
 * nothing around it may say otherwise: a rail into screens it cannot read, an
 * agents list saying *no agent is running* and a strip saying talking is *not
 * turned on* were each a claim about a machine this page never asked — and
 * together they read as a broken connection rather than *pair first*.
 */
export function insideIn(shown, inside) {
  for (const part of shown.inside) part.hidden = !inside
}

/**
 * Where you are, written into the navigation.
 *
 * **Only navigation calls this.** A delta never moves the current tab: the one
 * thing worse than a page that does not update is a page that moves the thing
 * you were about to press.
 */
export function navOn(links, where) {
  const here = navFor(where)
  for (const one of links) {
    if (one.view === here) one.link.setAttribute('aria-current', 'page')
    else one.link.removeAttribute('aria-current')
  }
}

/** What each count is a count *of*, because `5` alone is read aloud as "five". */
const NOUNS = {
  wantsYou: 'wanting you',
  agents: 'agents running',
  queue: 'queued',
  reviews: 'offered for merge',
  findings: 'findings',
  notes: 'notes',
  // Waiting on somebody, not handed over: a badge counting answered requests
  // is a badge nobody looks at twice.
  intake: 'requests waiting on you',
  runs: 'runs',
  workflows: 'workflows',
}

/** The counts beside the navigation, which a delta does move. */
export function navCounts(links, counts) {
  for (const one of links) {
    if (one.counts === null) continue
    const n = counts[one.counts] ?? 0
    // Nothing at nought: a badge of `0` on an icon is a badge nobody reads.
    textIn(one.figure, n === 0 ? '' : n > 99 ? '99+' : String(n))
    one.figure.setAttribute('aria-label', `${n} ${NOUNS[one.counts] ?? one.counts}`)
  }
}

/**
 * The freshness line, and the bar under it when there is something to say.
 *
 * The time is **the server's own**, out of the snapshot; the device's clock is
 * read only for the parenthesis, so a phone with a wrong clock shows an odd age
 * rather than a wrong time.
 */
export function freshIn(shown, standing, connection, store, now) {
  const mark = freshMark(standing)
  // At 360px the seconds are what gets cut off the end of the line, and the
  // line is the most important thing on the page. The minute is enough there;
  // the second is worth having where there is room for it.
  const tight = globalThis.matchMedia?.('(max-width: 479px)').matches === true
  const clock = tight ? shortClockOf : clockOf
  const at = store.fresh === null ? '—' : clock(store.fresh.at)
  const said = partsOf(standing, connection, at, now, tight)
  textIn(shown.freshSaid, said.words)
  textIn(shown.dot, said.glyph)
  toneOn(shown.dot, mark.tone)
  shown.freshSaid.setAttribute('aria-label', `${mark.word}. ${said.words}`)
}

/**
 * The bars: one per thing the page has to say about itself, and never more than
 * one of a kind.
 *
 * **One line each**: a glyph, the lead in a few words, and — where there is
 * more to say — a `?` that opens the rest under it. The sentence is still
 * there for whoever asks; it is no longer a paragraph across the top of every
 * screen for whoever did not.
 *
 * Rebuilt only when the set of them changes, because a bar that was replaced on
 * every beat would take the retry button out from under a thumb.
 */
export function barsIn(shown, said) {
  const want = said.map((one) => one.key).join('|')
  if (shown.barsAre === want) {
    // The same bars, so only their words are written — a bar rebuilt on every
    // beat would take the retry button out from under a thumb mid-press.
    for (let at = 0; at < said.length; at += 1) {
      const node = shown.bars.children[at]
      const under = node?.querySelector('.under')
      if (under !== null && under !== undefined) textIn(under, said[at].under ?? '')
      const lead = node?.querySelector('.lead')
      if (lead !== null && lead !== undefined) textIn(lead, said[at].lead)
    }
    return
  }
  shown.barsAre = want
  shown.bars.textContent = ''
  for (const one of said) {
    const node = el('div', { class: `bar ${one.tone ?? ''}`, attrs: { 'data-bar': one.key } })
    const line = el('div', { class: 'bar-line' })
    into(
      line,
      el('span', { class: 'glyph', text: one.glyph, attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'lead', text: one.lead }),
    )
    const hint = (one.under ?? '') === '' ? null : hintOf(one.under, 'under')
    if (hint !== null) into(line, hint.press)
    if (one.press !== undefined) {
      const press = el('button', {
        class: 'press quietly small',
        text: one.press.said,
        attrs: { type: 'button' },
      })
      press.addEventListener('click', one.press.does)
      into(line, press)
    }
    into(node, line, hint?.body)
    shown.bars.append(node)
  }
}

/**
 * What the bars say, as a pure function of how the page stands.
 *
 * Held apart from the drawing so a test can read it: the hardest thing to get
 * right here is that an unreachable page **says when it was last true** and
 * never says that nothing is running.
 */
export function barsFor(standing, connection, store, now, tries, extra = []) {
  const said = [...extra]
  const at = store.fresh === null ? '—' : clockOf(store.fresh.at)
  if (standing === 'reconnecting') {
    said.push({
      key: 'reconnecting',
      tone: 'is-stale',
      glyph: '◴',
      lead: 'Reconnecting.',
      under: `Nothing here is newer than ${at}. Trying again in ${duration(backoffAt(tries))}.`,
    })
  }
  if (standing === 'unreachable') {
    said.push({
      key: 'unreachable',
      tone: 'is-gone',
      glyph: '○',
      lead: `Unreachable since ${at}.`,
      // The sentence this bar exists for. Nothing here is nought, empty or
      // stopped: what is on screen is the last thing that was known to be
      // true, and it could not be asked again.
      under:
        'The machine may be asleep, or Tade may be closed. What is below is the last thing this device was told — not what is happening now.',
    })
  }
  if (standing === 'closed') {
    said.push({
      key: 'closed',
      glyph: '⏸',
      lead: connection.why,
      under: `Nothing here is newer than ${at}.`,
    })
  }
  void now
  return said
}

/** How long before a session ends the page starts saying so. */
export const ENDING_WARNS_MS = 3 * 24 * 60 * 60 * 1000

/**
 * The bar for a session about to run out, or null — pure, so a test holds it.
 *
 * A phone that is signed out in the middle of a trip, with nothing having
 * said so, is a phone somebody has to walk back to the machine for. Three
 * days ahead, a bar with the time left; past the end, nothing, because the
 * next read answers `401` and the page is the pairing screen anyway.
 */
export function endingBar(until, now) {
  const ends = typeof until === 'string' ? Date.parse(until) : Number.NaN
  if (Number.isNaN(ends) || ends <= now || ends - now > ENDING_WARNS_MS) return null
  return {
    key: 'ending',
    tone: 'is-stale',
    glyph: '◷',
    lead: `Signs out in ${duration(ends - now)}`,
    under: 'Pair this device again at the machine before then to carry on without a gap.',
  }
}

/** The keys, listed where `?` and the header button both reach them. */
function keySheet() {
  const list = el('dl')
  for (const [key, what] of [
    ['⌘ K', 'ask Tade, or go anywhere'],
    ['/', 'the same, from anywhere but a box'],
    ['g n', 'Overview'],
    ['g a', 'Agents'],
    ['g q', 'Queue'],
    ['g s', 'Spend'],
    ['g c', 'Checks'],
    ['j / k', 'move through rows'],
    ['Enter', 'open the row'],
    ['Escape', 'go back'],
    ['?', 'these keys'],
  ]) {
    into(list, el('dt', { text: key }), el('dd', { text: what }))
  }
  return list
}

/**
 * What crossed into wanting you, and what stopped — the only thing announced.
 *
 * Pure, so the wording is testable: *two tasks now want you: a, b* rather than
 * a page read aloud twice a second. Nothing is announced on the first snapshot,
 * because arriving at a page is not a change to it.
 */
export function crossing(was, is) {
  if (was === null) return ''
  const into_ = [...is].filter((id) => !was.has(id))
  const out = [...was].filter((id) => !is.has(id))
  const parts = []
  if (into_.length > 0) parts.push(`${said(into_.length)} now want you: ${into_.join(', ')}`)
  if (out.length > 0) parts.push(`${said(out.length)} stopped wanting you: ${out.join(', ')}`)
  return parts.join('. ')
}

const said = (n) => `${n} task${n === 1 ? '' : 's'}`

/** The document title, which is what a screen reader announces on navigation. */
export function titleFor(where) {
  const name = TITLES[where.view] ?? 'Tade'
  if (where.view === 'project') return `${where.project} · Tade`
  if (where.view === 'task') return `${where.task} · ${where.project} · Tade`
  return `${name} · Tade`
}

/** Whether a region should be dimmed, which is the whole of what stale looks like. */
export function heldOn(root, standing) {
  classOn(root, 'held', standing === 'unreachable' || standing === 'closed')
}
