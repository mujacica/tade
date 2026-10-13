// The project page's rows, each a create and a fill (`keyed` wants that shape):
// what wants somebody with its presses, an agent, a branch's checks, a branch
// with what it is ahead and behind, a finding, and a piece of queued work as a
// line of the queue's outline.
//
// Every row is a link to the task it is about, the whole of it a target; a row
// that holds presses (what wants you) makes its name the link instead, because
// a button inside a link is two targets in one place. Nothing here decides
// anything — marks are `glyphs.js`'s over what the wire carried.

import { classOn, el, glyphOf, into, markIn, textIn, toneOn } from '../dom.js'
import { ageSaid, shortClockOf } from '../figures.js'
import { checkMark, queueMark, rowMark, taskMark } from '../glyphs.js'
import { quickActs } from '../quick.js'
import { taskPath } from '../routes.js'
import { queueAt, queueLine } from '../tree.js'
import { armOf, branchSaid, checkSaid, reviewOf, spentSaid } from './project-shape.js'

/* ── what wants somebody ───────────────────────────────────────────────────── */

/**
 * One piece of work waiting on a person — or one whose agent failed: its mark
 * in a square of its tone, the name, how long ago, why in `deriveState`'s own
 * words, and the presses this device was granted.
 */
export function createWant(ctx) {
  const node = el('li', { class: 'pj-want' })
  const glyph = glyphOf(taskMark('blocked'), 'pj-want-mark')
  const link = el('a', { class: 'pj-want-name', attrs: { href: '/' } })
  const age = el('span', { class: 'pj-want-age' })
  const why = el('p', { class: 'pj-want-why' })
  const quick = ctx === null || ctx === undefined ? null : quickActs(ctx)
  quick?.node.classList.add('pj-want-acts')
  into(node, glyph, link, age, why, quick?.node)
  node.quick = quick
  return node
}

export function fillWant(node, task, view) {
  const [glyph, link, age, why] = node.children
  const mark = rowMark(task)
  markIn(glyph, mark)
  classOn(node, 'is-failed', task.mark === 'failed')
  link.setAttribute('href', taskPath(task.id))
  textIn(link, task.name)
  const moved = ageSaid(task.movedAt, view.asOf, view.frozen)
  textIn(age, moved ?? '')
  age.setAttribute('aria-label', moved === null ? 'never moved' : `moved ${moved} ago`)
  textIn(why, task.reason)
  node.quick?.update(task, view)
}

/* ── an agent ──────────────────────────────────────────────────────────────── */

/**
 * An agent: its mark, its name, how long since it last moved, why in its own
 * clause, and what it has cost. One that wants somebody or failed carries an
 * edge of its tone; one gone quiet says *stalled* beside its name.
 */
export function createAgent() {
  const node = el('li')
  const link = el('a', { class: 'pj-agent', attrs: { href: '/' } })
  const name = el('span', { class: 'pj-agent-name' })
  const words = el('span', { class: 'pj-agent-words' })
  const stalled = el('span', { class: 'ui-pill t-working pj-agent-tag', text: 'stalled' })
  into(name, words, stalled)
  into(
    link,
    glyphOf(rowMark(null), 'pj-agent-mark'),
    name,
    el('span', { class: 'pj-agent-age' }),
    el('span', { class: 'pj-agent-why' }),
    el('span', { class: 'pj-agent-spend' }),
  )
  return into(node, link)
}

export function fillAgent(node, task, view) {
  const [link] = node.children
  const [glyph, name, age, why, spend] = link.children
  const [words, stalled] = name.children
  markIn(glyph, rowMark(task))
  link.setAttribute('href', taskPath(task.id))
  classOn(link, 'is-wants', task.mark === 'needs-you')
  classOn(link, 'is-failed', task.mark === 'failed')
  classOn(link, 'is-over', ['done', 'stopped', 'parked'].includes(task.mark))
  textIn(words, task.name)
  stalled.hidden = !(task.stalled && task.mark === 'working')
  const moved = ageSaid(task.movedAt, view.asOf, view.frozen)
  textIn(age, moved ?? '')
  age.setAttribute('aria-label', moved === null ? 'never moved' : `moved ${moved} ago`)
  textIn(why, task.reason)
  textIn(spend, spentSaid(task.spend) ?? '')
}

/* ── a branch's checks ─────────────────────────────────────────────────────── */

/**
 * A branch whose checks are red or were not run here: its mark, its name, and
 * which checks — by the names the project's own hook and workflows give them.
 */
export function createCheck() {
  const node = el('li')
  const link = el('a', { class: 'pj-check', attrs: { href: '/' } })
  into(
    link,
    glyphOf(checkMark('unknown'), 'pj-check-mark'),
    el('span', { class: 'pj-check-name' }),
    el('span', { class: 'pj-check-which' }),
  )
  return into(node, link)
}

export function fillCheck(node, task) {
  const [link] = node.children
  const [glyph, name, which] = link.children
  const checks = task.checks
  markIn(glyph, checkMark(checks.state))
  link.setAttribute('href', taskPath(task.id))
  textIn(name, task.name)
  textIn(which, checkSaid(checks))
}

/* ── a branch ──────────────────────────────────────────────────────────────── */

/**
 * A branch: its name as git spells it, whether it is offered for merge, and a
 * bar either side of where it started — behind to the left, ahead to the right
 * — every branch to one scale, so the one far behind is seen across the list.
 * The figures are beside the bar in words; the bar is `aria-hidden`.
 */
export function createBranch() {
  const node = el('li')
  const link = el('a', { class: 'pj-branch', attrs: { href: '/' } })
  const bar = el('span', { class: 'pj-branch-bar', attrs: { 'aria-hidden': 'true' } })
  into(bar, el('span', { class: 'pj-branch-behind' }), el('span', { class: 'pj-branch-ahead' }))
  into(
    link,
    el('span', { class: 'pj-branch-name' }),
    el('span', { class: 'ui-pill pj-branch-review' }),
    bar,
    el('span', { class: 'pj-branch-said' }),
  )
  return into(node, link)
}

export function fillBranch(node, one, most) {
  const [link] = node.children
  const [name, review, bar, said] = link.children
  link.setAttribute('href', one.href)
  textIn(name, one.branch)
  const offered = reviewOf(one)
  review.hidden = offered === null
  textIn(review, offered?.word ?? '')
  toneOn(review, offered?.tone ?? '')
  const share = (n) => `${armOf(n, most)}%`
  const [behind, ahead] = bar.children
  behind.style.setProperty('--w', share(one.behind))
  ahead.style.setProperty('--w', share(one.ahead))
  classOn(bar, 'is-unknown', one.ahead === null && one.behind === null)
  textIn(said, branchSaid(one))
}

/* ── a finding ─────────────────────────────────────────────────────────────── */

/**
 * A finding: whose move it is, the question's own id, the likelihood the judge
 * gave it, the task and the file. **A probability is not a verdict**, so it is
 * a figure beside the question and never the answer to it.
 */
export function createFinding() {
  const node = el('li')
  const link = el('a', { class: 'pj-finding', attrs: { href: '/' } })
  into(
    link,
    glyphOf({ glyph: '◴', word: '', tone: 't-working' }, 'pj-finding-mark'),
    el('span', { class: 'pj-finding-name' }),
    el('span', { class: 'pj-finding-p' }),
    el('span', { class: 'pj-finding-where' }),
  )
  return into(node, link)
}

export function fillFinding(node, one, project) {
  const [link] = node.children
  const [glyph, name, p, where] = link.children
  markIn(glyph, one.mark)
  link.setAttribute('href', one.href)
  textIn(name, one.question)
  textIn(p, one.probability.toFixed(2))
  p.setAttribute('aria-label', `probability ${one.probability.toFixed(2)}`)
  const task = one.tasks[0]
  const whose = task === undefined ? '' : `${short(task, project)} · `
  textIn(where, `${whose}${one.file}${one.stillThere ? '' : ' · moved'}`)
}

const short = (id, project) => (id.startsWith(`${project}/`) ? id.slice(project.length + 1) : id)

/* ── the queue, as an outline ──────────────────────────────────────────────── */

/**
 * A piece of queued work as a line of the queue's outline, for a phone, where
 * the graph's boxes would scroll sideways: indented under what it waits on
 * (`outlineOf`), and the words `describeQueueState`'s.
 */
export function createPiece() {
  const node = el('li')
  const link = el('a', { class: 'pj-piece', attrs: { href: '/' } })
  into(
    link,
    glyphOf(queueMark({ kind: 'waiting', on: [] }), 'pj-piece-mark'),
    el('span', { class: 'pj-piece-name' }),
    el('span', { class: 'pj-piece-at' }),
    el('span', { class: 'pj-piece-line' }),
  )
  return into(node, link)
}

export function fillPiece(node, one, project) {
  const [link] = node.children
  const [glyph, name, at, line] = link.children
  markIn(glyph, queueMark(one.row.state))
  link.setAttribute('href', taskPath(one.row.task))
  // Three steps of indent and no more: past that a chain is a list of its own
  // at the same depth, and the line under each says what it waits on.
  for (let depth = 1; depth <= 3; depth += 1) {
    classOn(node, `is-d${depth}`, Math.min(one.depth, 3) === depth)
  }
  textIn(name, short(one.row.task, project))
  textIn(at, queueAt(one.row.state, shortClockOf))
  textIn(line, queueLine(one.row.state, project))
  line.hidden = line.textContent === ''
}
