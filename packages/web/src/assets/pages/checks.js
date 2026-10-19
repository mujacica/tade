// The checks: what is failing and since when, then how every check has been
// going in every project, then what each agent's head adds up to.
//
// **What somebody opening this page wants first** is whether anything is red,
// where, and for how long — so the page leads with three figures and a card
// for each failing check, longest-red first, with the strip of its runs and the
// agent that last asked for one. Then every project as a card: each tree it ran
// in, each check a row of every run its record keeps, newest on the right and
// scrolled sideways when long, so a flaky check and a broken one look
// different at a glance.
//
// **Two greens, never one.** A check whose last run passed is history; a head
// whose every required check ran on its commit is the rollup. The strips are
// the first and the heads' line under each project is the second, and a check
// nobody ran is neither: `—`, *no answer*, hatched or grey, never green.
//
// Nothing here decides a state, a streak or a count (`checks-shape.js`).

import { heat, heatIn, stat, statIn, stats } from '../charts.js'
import { el, glyphOf, into, keyed, markIn, skeleton, textIn, toneOn, unknown } from '../dom.js'
import { count } from '../figures.js'
import { pathOf } from '../routes.js'
import { section } from '../rows.js'
import { projectsOf, tasksIn } from '../store.js'
import { stateBox, stateBoxIn } from '../ui.js'
import {
  answerSaid,
  CELLS,
  checksOf,
  figuresOf,
  headsSaid,
  isQuiet,
  quietSaid,
  redLine,
  sinceLine,
  standingSaid,
} from './checks-shape.js'

/** A region's state, as `stateBoxIn` takes it, with a mark: this page's unless it says. */
function stateOf(kind, title, line, icon = 'checks') {
  return { kind, icon, title, line }
}

export function checksScreen() {
  const node = el('div')
  const made = section('CHECKS', { top: true })
  const coming = skeleton(4)
  const nothing = stateBox()
  nothing.classList.add('checks-nothing')
  const lead = leadOf()
  const red = redOf()
  const board = boardOf()
  into(made.body, coming, nothing, lead.node, red.made.node, board.made.node)
  into(node, made.node)

  return {
    node,
    update(view) {
      const had = view.store.had === true
      coming.hidden = had
      const projects = had ? projectsOf(view.store) : []
      const page = checksOf(projects, (name) => tasksIn(view.store, name), view.asOf, view.frozen)
      figureIn(made.figure, page, had)
      stateBoxIn(
        nothing,
        !had
          ? null
          : projects.length === 0
            ? stateOf(
                'empty',
                'No projects',
                'Open a project in Tade, and what its checks said is drawn here.',
              )
            : page.read
              ? null
              : stateOf(
                  'loading',
                  'Reading the run records',
                  'The window reads what ran in each project while somebody is looking. It takes a few seconds.',
                ),
      )
      lead.node.hidden = !had || !page.read
      if (!lead.node.hidden) lead.fill(page)
      red.made.node.hidden = !had || !page.read
      if (!red.made.node.hidden) red.fill(page)
      board.made.node.hidden = !had || projects.length === 0
      if (!board.made.node.hidden) board.fill(page)
    },
  }
}

/**
 * The bar's figure: how many are failing, as a pill in its tone, or the word
 * for none — green only where every required check last passed, because
 * *nothing failing* over checks that never answered is not a pass.
 */
function figureIn(figure, page, had) {
  const { fail, pass, none } = page.totals
  const word = !had || !page.read ? '' : fail > 0 ? `${fail} failing` : 'nothing failing'
  textIn(figure, word)
  figure.classList.toggle('ui-pill', word !== '')
  toneOn(figure, fail > 0 ? 't-failed' : word !== '' && none === 0 && pass > 0 ? 't-done' : null)
}

/* ── the lead: failing, passing and unanswered, counted ────────────────────── */

function leadOf() {
  const node = stats('Every required check, by its last answer')
  node.classList.add('checks-lead')
  const tiles = ['Failing', 'Passing', 'No answer'].map((label) => stat(label))
  into(node, ...tiles)
  return {
    node,
    fill(page) {
      figuresOf(page).forEach((one, at) => {
        statIn(tiles[at], { value: one.value, under: one.under, tone: one.tone })
      })
    },
  }
}

/* ── what is failing now, longest first ───────────────────────────────────── */

function redOf() {
  const made = section('FAILING NOW')
  const calm = stateBox()
  const list = el('ul', { class: 'checks-reds', attrs: { 'aria-label': 'Failing checks' } })
  into(made.body, calm, list)
  return {
    made,
    fill(page) {
      textIn(made.figure, page.red.length === 0 ? '' : count(page.red.length))
      // A label on an empty figure is one axe refuses: said only when drawn.
      if (page.red.length === 0) made.figure.removeAttribute('aria-label')
      else made.figure.setAttribute('aria-label', `${page.red.length} failing`)
      stateBoxIn(calm, page.red.length > 0 ? null : calmOf(page.totals))
      list.hidden = page.red.length === 0
      keyed(list, page.red, (one) => one.key, createRed, fillRed)
    },
  }
}

/** Nothing failing, in the words that are true of it: all passed, some unanswered, or none ran. */
function calmOf({ pass, none }) {
  if (pass === 0 && none === 0) {
    return stateOf(
      'empty',
      'Nothing is failing',
      'No required check has run yet in a project read here. An agent’s checks_run, or tade check, starts one.',
    )
  }
  const unanswered = `${none} ${none === 1 ? 'has' : 'have'} no answer yet`
  return stateOf(
    'empty',
    'Nothing is failing',
    none === 0
      ? 'Every required check last passed.'
      : `Every required check that answered last passed; ${unanswered}.`,
    'check',
  )
}

/**
 * A failing check: the card is one press to its project, and who asked for
 * its newest run is a second, under it, where that is an agent to go and tell.
 */
function createRed() {
  const item = el('li', { class: 'ui-card checks-red' })
  const main = el('a', { class: 'checks-red-main', attrs: { href: '/' } })
  const head = el('span', { class: 'checks-red-head' })
  into(
    head,
    glyphOf({ glyph: '✕', word: 'failing', tone: 't-failed' }),
    el('strong', { class: 'checks-red-name' }),
  )
  const where = el('span', { class: 'checks-red-where' })
  into(where, el('span'), el('span'), el('span'))
  into(
    main,
    head,
    el('span', { class: 'checks-red-for' }),
    where,
    heat('Runs'),
    el('span', { class: 'checks-red-line' }),
  )
  const by = el('a', { class: 'checks-red-by', attrs: { href: '/' } })
  into(by, el('span', { class: 'checks-red-by-word', text: 'Last asked by' }), el('strong'))
  const asked = el('p', { class: 'checks-red-asked' })
  into(item, main, by, asked)
  return item
}

function fillRed(item, one) {
  const [main, by, asked] = item.children
  const [head, length, where, strip, line] = main.children
  main.setAttribute('href', pathOf({ view: 'project', project: one.project }))
  const [, name] = head.children
  textIn(name, one.check)
  textIn(length, one.forSaid ?? '—')
  const [project, tree, since] = where.children
  textIn(project, one.project)
  textIn(tree, one.tree === 'checkout' ? 'checkout' : `${one.tree}’s worktree`)
  textIn(since, one.sinceSaid === null ? '' : `since ${one.sinceSaid}`)
  since.hidden = one.sinceSaid === null
  heatIn(strip, one.cells, { said: one.said })
  textIn(line, redLine(one))
  // An agent is a place to go; `you` or the orchestrator is a word.
  by.hidden = one.by === null || one.by.href === null
  if (!by.hidden) {
    by.setAttribute('href', one.by.href)
    textIn(by.lastChild, one.by.name)
  }
  asked.hidden = one.by === null || one.by.href !== null
  textIn(asked, one.by === null ? '' : `Last asked by ${one.by.name}`)
}

/* ── every project: each tree, each check a strip of its runs ─────────────── */

function boardOf() {
  const made = section('BY PROJECT')
  const legend = el('ul', { class: 'checks-legend', attrs: { 'aria-label': 'What a cell is' } })
  for (const one of Object.values(CELLS)) {
    const item = el('li')
    into(
      item,
      el('span', { class: `checks-swatch tone-${one.tone}`, attrs: { 'aria-hidden': 'true' } }),
      el('span', { text: one.word }),
    )
    legend.append(item)
  }
  into(legend, el('li', { class: 'checks-legend-order', text: 'newest on the right' }))
  const list = el('ul', { class: 'checks-projects', attrs: { 'aria-label': 'Projects' } })
  into(made.body, legend, list)
  return {
    made,
    fill(page) {
      textIn(made.figure, count(page.projects.length))
      made.figure.setAttribute('aria-label', `${page.projects.length} projects`)
      keyed(list, page.projects, (one) => one.name, createProject, fillProject)
    },
  }
}

function createProject() {
  const item = el('li', { class: 'ui-card checks-project' })
  const head = el('div', { class: 'checks-project-head' })
  into(
    head,
    el('a', { class: 'checks-project-name', attrs: { href: '/' } }),
    el('span', { class: 'ui-pill' }),
  )
  const groups = el('div', { class: 'checks-groups' })
  const state = el('div', { class: 'checks-project-state' })
  const heads = el('p', { class: 'checks-heads' })
  into(item, head, groups, state, heads)
  return item
}

function fillProject(item, project) {
  const [head, groups, state, heads] = item.children
  const [name, pill] = head.children
  textIn(name, project.name)
  name.setAttribute('href', project.href)
  const standing = standingSaid(project)
  textIn(pill, standing.word)
  toneOn(pill, standing.tone)
  keyed(groups, project.groups, (one) => one.key, createGroup, fillGroup)
  // The checkout is the one tree every project has, and needs no name of its
  // own until a worktree is beside it.
  for (const group of groups.children) group.firstChild.hidden = project.groups.length === 1
  // Not read, and read with nothing in it, are two sentences and never a blank.
  const said =
    project.standing === 'unread'
      ? 'the window reads its run records within a few seconds'
      : project.standing === 'empty'
        ? 'no check has run here yet: an agent’s checks_run, or tade check, puts one here'
        : null
  state.hidden = said === null
  if (said !== null && state.dataset.said !== said) {
    state.dataset.said = said
    state.replaceChildren(unknown(said))
  }
  headsIn(heads, project.heads)
}

/** The trees whose quiet checks somebody unfolded, for as long as the page is open. */
const unfolded = new Set()
let lists = 0

function createGroup() {
  lists += 1
  const node = el('div', { class: 'checks-group' })
  const name = el('p', { class: 'checks-group-name' })
  const tracks = el('ul', { class: 'checks-tracks', attrs: { id: `checks-tracks-${lists}` } })
  const press = el('button', {
    class: 'press quietly small checks-quiet',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': tracks.id },
  })
  press.addEventListener('click', () => {
    const key = node.dataset.key ?? ''
    if (unfolded.has(key)) unfolded.delete(key)
    else unfolded.add(key)
    quietIn(node)
  })
  into(node, name, tracks, press)
  return node
}

/** Show or fold a tree's quiet checks, as its press last left them. */
function quietIn(node) {
  const [, tracks, press] = node.children
  const open = unfolded.has(node.dataset.key ?? '')
  const quiet = Number(node.dataset.quiet ?? '0')
  for (const row of tracks.children) row.hidden = row.classList.contains('is-quiet') && !open
  press.hidden = quiet === 0
  press.setAttribute('aria-expanded', open ? 'true' : 'false')
  textIn(press, quietSaid(quiet, open))
}

function fillGroup(node, group) {
  const [name, tracks] = node.children
  // Keyed by tree, so a checkout's node is never a worktree's: the link is
  // made once, the first time, and patched after.
  if (group.task === null) textIn(name, 'checkout')
  else {
    if (name.firstElementChild === null) {
      const link = el('a', { class: 'checks-group-link', attrs: { href: '/' } })
      into(link, el('strong'), el('span', { text: '’s worktree' }))
      name.replaceChildren(link)
    }
    const link = name.firstElementChild
    textIn(link.firstChild, group.name)
    link.setAttribute('href', group.href)
  }
  keyed(tracks, group.tracks, (one) => one.key, createTrack, fillTrack)
  node.dataset.key = group.key
  node.dataset.quiet = String(group.quiet)
  quietIn(node)
}

function createTrack() {
  const item = el('li', { class: 'checks-track' })
  const name = el('span', { class: 'checks-track-name' })
  into(name, el('span'), el('span', { class: 'checks-track-optional', text: 'optional' }))
  into(
    item,
    glyphOf({ glyph: '—', word: 'no answer', tone: 't-quiet' }, 'checks-track-mark'),
    name,
    el('span', { class: 'checks-track-word' }),
    heat('Runs'),
    el('span', { class: 'checks-track-since' }),
    el('span', { class: 'checks-track-ms' }),
  )
  return item
}

function fillTrack(item, one) {
  const [mark, name, word, strip, since, ms] = item.children
  markIn(mark, one.mark)
  const [label, optional] = name.children
  textIn(label, one.check)
  optional.hidden = one.required
  textIn(word, answerSaid(one))
  heatIn(strip, one.cells, { said: one.said })
  textIn(since, sinceLine(one))
  textIn(ms, one.typical ?? '—')
  ms.setAttribute('aria-label', one.typical === null ? 'no time recorded' : `about ${one.typical}`)
  item.classList.toggle('is-failing', one.answer === 'fail')
  item.classList.toggle('is-quiet', isQuiet(one))
}

/**
 * The heads' line: the red ones named, with what failed, and the rest counted.
 * Rebuilt only when what it says changed, because it holds links somebody may
 * be on, and a delta comes twice a second.
 */
function headsIn(node, heads) {
  node.hidden = heads.total === 0
  if (node.hidden) return
  const said = headsSaid(heads)
  const key = JSON.stringify([heads.red, said])
  if (node.dataset.said === key) return
  node.dataset.said = key
  const parts = [el('span', { class: 'checks-heads-label', text: 'At each agent’s head' })]
  for (const one of heads.red) {
    const link = el('a', { class: 'checks-head', attrs: { href: one.href } })
    into(
      link,
      glyphOf({ glyph: '✕', word: 'red at its commit', tone: 't-failed' }),
      el('strong', { text: one.name }),
    )
    if (one.failed.length > 0) {
      link.append(el('span', { class: 'checks-heads-what', text: one.failed.join(', ') }))
    }
    parts.push(link)
  }
  if (said !== '') parts.push(el('span', { class: 'checks-heads-rest', text: said }))
  node.replaceChildren(...parts)
}
