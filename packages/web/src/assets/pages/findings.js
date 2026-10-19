// The findings: what a judge asked about an agent's change, whose move each
// one is, and how each question has done.
//
// **What somebody opening this page wants first** is whether anything waits on
// their verdict and how long it has — so the page leads with a ring of every
// finding by whose move it is and the oldest wait of each, then a card for each
// finding waiting on them, a group per project, longest wait first: the
// question, the judge's probability, and what the agent said back. What waits
// on an agent is a quiet list under it, what has its verdict is folded away,
// and under all of them, at the page's full width, each question's precision,
// out of verdicts, as a grid of cards — so neither the findings nor the
// questions are squeezed into a column that takes a long scroll to read.
//
// **A probability is not a verdict.** It is drawn as the judge's reading — a
// grey meter labelled *judge*, never in a state's colour — beside the question
// and never as the answer to it, and the account under it is the agent's own
// testimony, in a plain pill. Only a verdict somebody wrote takes red or green.
//
// Nothing here decides whose move a finding is or what a question's precision
// is (`findings-shape.js`).

import { mayFor } from '../access.js'
import { donut, donutIn, stack, stackIn } from '../charts.js'
import {
  el,
  glyphOf,
  into,
  keyed,
  markIn,
  proseOf,
  skeleton,
  textIn,
  toneOn,
  unknown,
} from '../dom.js'
import { count, shortClockOf } from '../figures.js'
import { icon } from '../icons.js'
import { section } from '../rows.js'
import { findingsOf, omitted, taskAt } from '../store.js'
import { TROUBLES } from '../trouble.js'
import { meter, meterIn, panel, stateBox, stateBoxIn } from '../ui.js'
import {
  ENOUGH,
  figureSaid,
  findingsPage,
  readSaid,
  rowLine,
  tallyUnder,
  verdictAside,
} from './findings-shape.js'

/** A region's state, as `stateBoxIn` takes it, with this page's mark unless it says. */
function stateOf(kind, title, line, mark = 'findings') {
  return { kind, icon: mark, title, line }
}

/** A long account folds to three lines behind a `more`; a short one is said whole. */
const LONG = 220

export function findingsScreen() {
  const node = el('div')
  const made = section('FINDINGS', {
    top: true,
    hint: 'A judge answers questions; it never decides. A probability is not a verdict, and the account under one is the agent’s own testimony.',
  })
  const coming = skeleton(4)
  const whole = stateBox()
  whole.classList.add('fd-whole')
  const lead = leadOf()
  const left = el('div', { class: 'fd-omitted' })
  const yours = yoursOf()
  const agent = agentOf()
  const read = readOf()
  const questions = questionsOf()
  const main = el('div', { class: 'fd-main' })
  into(main, yours.made.node, agent.made.node, read.made.node)
  questions.made.node.classList.add('fd-by-question')
  made.body.classList.add('fd-body')
  into(made.body, coming, whole, lead.node, left, main, questions.made.node)
  into(node, made.node)

  return {
    node,
    update(view) {
      const store = view.store
      const had = store.had === true
      const may = had && mayFor(store, 'findings')
      const rows = may ? findingsOf(store) : []
      const known = (id) => {
        const cut = id.indexOf('/')
        return cut > 0 && taskAt(store, id.slice(0, cut), id.slice(cut + 1)) !== null
      }
      const page = may ? findingsPage(rows, view.asOf, known) : null
      const shut = view.standing === 'unreachable' || view.standing === 'closed'
      coming.hidden = had || shut
      figureIn(made.figure, page)
      stateBoxIn(whole, wholeOf(had, shut, may, page, omitted(store, 'findings')))
      const shown = page !== null && page.total > 0
      lead.node.hidden = !shown
      main.hidden = !shown
      questions.made.node.hidden = !shown
      left.hidden = !shown || !view.frozen
      if (!left.hidden) sayLeft(left, `as of ${shortClockOf(new Date(view.asOf).toISOString())}`)
      if (!shown) return
      lead.fill(page)
      yours.fill(page)
      agent.fill(page)
      read.fill(page)
      questions.fill(page)
    },
  }
}

/**
 * The page's own state, when there is nothing to draw: coming, could not
 * reach, not granted, or none — four sentences and never a blank.
 */
function wholeOf(had, shut, may, page, gone) {
  if (!had) {
    return shut ? stateOf('error', TROUBLES.offline.title, TROUBLES.offline.fix, 'alert') : null
  }
  if (!may) {
    return stateOf(
      'empty',
      'Findings aren’t granted to this device',
      gone > 0
        ? `${gone} here. Grant this device findings at the machine to read them.`
        : 'Grant this device findings at the machine to read them.',
    )
  }
  if (page.total > 0) return null
  // True whether there are none or the window sent none: it says what reached
  // this device, never that a judge found nothing.
  return stateOf(
    'empty',
    'No findings',
    'Nothing a judge asked about an agent’s change was sent to this device.',
  )
}

/** The bar's word: how many want a verdict, in violet, or that nothing waits on you. */
function figureIn(figure, page) {
  const said = figureSaid(page)
  textIn(figure, said.word)
  figure.classList.toggle('ui-pill', said.word !== '')
  toneOn(figure, said.tone)
}

/** The line under the lead: the moment a page that is not live was true at, and what it was not sent. */
function sayLeft(node, said) {
  if (node.dataset.said === said) return
  node.dataset.said = said
  node.replaceChildren(unknown(said))
}

/* ── the lead: every finding by whose move it is ───────────────────────────── */

function leadOf() {
  const node = el('div', { class: 'ui-card fd-lead' })
  const ring = donut('Findings, by whose move')
  const tally = el('ul', { class: 'fd-tally', attrs: { 'aria-label': 'Whose move' } })
  into(node, ring, tally)
  return {
    node,
    fill(page) {
      const n = page.counts.yours
      donutIn(ring, page.parts, { said: String(n), under: 'to read' })
      node.classList.toggle('is-wanted', n > 0)
      keyed(
        tally,
        page.parts,
        (one) => one.key,
        createTally,
        (item, one) => fillTally(item, one, page),
      )
    },
  }
}

const TALLY_MARKS = {
  yours: { glyph: '◆', word: 'wants your verdict', tone: 't-wants' },
  agent: { glyph: '◴', word: 'agent to answer', tone: 't-working' },
  confirmed: { glyph: '▲', word: 'confirmed', tone: 't-failed' },
  wrong: { glyph: '✓', word: 'false positive', tone: 't-done' },
}

function createTally() {
  const item = el('li')
  into(
    item,
    glyphOf(TALLY_MARKS.yours, 'fd-tally-mark'),
    el('span', { class: 'fd-tally-label' }),
    el('span', { class: 'fd-tally-n' }),
    el('span', { class: 'fd-tally-under' }),
  )
  return item
}

function fillTally(item, one, page) {
  const [mark, label, n, under] = item.children
  markIn(mark, TALLY_MARKS[one.key])
  textIn(label, one.label)
  textIn(n, String(one.n))
  const said = tallyUnder(page, one.key)
  textIn(under, said)
  under.hidden = said === ''
  item.classList.toggle('is-yours', one.key === 'yours' && one.n > 0)
  item.classList.toggle('is-none', one.n === 0)
}

/* ── waiting on you: a group per project, a card per finding ──────────────── */

function yoursOf() {
  const made = section('WANTS YOUR VERDICT')
  const calm = stateBox()
  const list = el('ul', { class: 'fd-groups', attrs: { 'aria-label': 'By project' } })
  into(made.body, calm, list)
  return {
    made,
    fill(page) {
      const n = page.counts.yours
      textIn(made.figure, n === 0 ? '' : count(n))
      // A label on an empty figure is one axe refuses: said only when drawn.
      if (n === 0) made.figure.removeAttribute('aria-label')
      else made.figure.setAttribute('aria-label', `${n} want a verdict`)
      stateBoxIn(
        calm,
        n > 0
          ? null
          : stateOf(
              'empty',
              'Nothing waits on you',
              page.counts.agent > 0
                ? `${page.counts.agent} ${page.counts.agent === 1 ? 'waits' : 'wait'} on an agent to answer first.`
                : 'Every finding here has its verdict.',
              'check',
            ),
      )
      list.hidden = n === 0
      keyed(list, page.groups, (one) => one.project, createGroup, fillGroup)
    },
  }
}

function createGroup() {
  const item = el('li', { class: 'fd-group' })
  const head = el('div', { class: 'fd-group-head' })
  into(
    head,
    el('a', { class: 'fd-group-name', attrs: { href: '/' } }),
    el('span', { class: 'fd-group-n' }),
  )
  const cards = el('ul', { class: 'fd-cards' })
  into(item, head, cards)
  return item
}

function fillGroup(item, group) {
  const [head, cards] = item.children
  const [name, n] = head.children
  textIn(name, group.project)
  name.setAttribute('href', group.href)
  textIn(n, `${group.n} · oldest ${group.oldestSaid}`)
  cards.setAttribute('aria-label', `In ${group.project}`)
  keyed(cards, group.cards, (one) => one.key, createCard, fillCard)
}

/**
 * A finding waiting on a verdict: the question and how long, where it points,
 * the judge's probability as a grey meter, the agent's account, and one press
 * to that agent's page across its foot.
 */
function createCard() {
  const item = el('li', { class: 'ui-card fd-card' })
  const body = el('div', { class: 'fd-card-body' })
  const head = el('div', { class: 'fd-card-head' })
  into(
    head,
    glyphOf(TALLY_MARKS.yours, 'fd-card-mark'),
    el('strong', { class: 'fd-q' }),
    el('span', { class: 'fd-card-wait' }),
  )
  const where = el('p', { class: 'fd-card-where' })
  into(
    where,
    el('span', { class: 'fd-card-file' }),
    el('span', { class: 'ui-pill fd-card-moved', text: 'no longer raised' }),
  )
  const judge = el('div', { class: 'fd-p', attrs: { role: 'img' } })
  into(
    judge,
    el('span', { class: 'fd-p-label', text: 'judge', attrs: { 'aria-hidden': 'true' } }),
    meter(),
    el('span', { class: 'fd-p-value', attrs: { 'aria-hidden': 'true' } }),
  )
  const account = el('div', { class: 'fd-account' })
  const says = el('p', { class: 'fd-account-head' })
  into(
    says,
    el('span', { text: 'The agent says' }),
    el('span', { class: 'ui-pill fd-account-did' }),
  )
  into(account, says, el('div', { class: 'fd-account-words' }))
  into(body, head, where, judge, account)
  const foot = el('a', { class: 'fd-card-foot', attrs: { href: '/' } })
  into(foot, el('span', { text: 'Open' }), el('strong'), el('span'), icon('chevron'))
  const gone = el('p', { class: 'fd-card-gone' })
  into(item, body, foot, gone)
  return item
}

function fillCard(item, card) {
  const [body, foot, gone] = item.children
  const [head, where, judge, account] = body.children
  const [, question, wait] = head.children
  textIn(question, card.question)
  textIn(wait, card.waitedSaid)
  wait.setAttribute('aria-label', `waiting ${card.waitedSaid}`)
  const [file, moved] = where.children
  textIn(file, card.file)
  moved.hidden = !card.moved
  moved.setAttribute('aria-label', 'the newest reading of this change no longer raises it')
  const [, bar, value] = judge.children
  textIn(value, card.p)
  meterIn(bar, card.pShare ?? 0)
  judge.setAttribute('aria-label', `The judge’s probability: ${card.p}. A reading, not a verdict.`)
  accountIn(account, card)
  // An agent still in the store is a place to go; one that has gone is a word.
  foot.hidden = card.href === null
  if (card.href !== null) {
    foot.setAttribute('href', card.href)
    textIn(foot.children[1], card.name)
    textIn(foot.children[2], card.others > 0 ? `and ${card.others} more` : '')
  }
  gone.hidden = card.href !== null || card.name === null
  textIn(gone, card.name === null ? '' : `${card.name} is no longer on Tade’s list`)
}

/**
 * The agent's account: what it says it did, and its words — rebuilt only when
 * they change. When it said so is the card's figure: the wait began then.
 */
function accountIn(node, card) {
  const [says, words] = node.children
  const [, did] = says.children
  node.hidden = card.did === null
  if (card.did === null) return
  textIn(did, card.did)
  const key = card.said === null ? '' : `${card.said.more ? '+' : ''}${card.said.words}`
  if (words.dataset.said === key) return
  words.dataset.said = key
  words.replaceChildren(
    proseOf(card.said, (card.said?.words.length ?? 0) > LONG) ??
      el('p', { class: 'fd-account-none', text: 'It gave no reason.' }),
  )
}

/* ── waiting on an agent: quiet rows ──────────────────────────────────────── */

function agentOf() {
  const made = section('WAITING ON AN AGENT')
  const list = panel('ul', 'fd-rows')
  list.setAttribute('aria-label', 'Waiting on an agent')
  into(made.body, list)
  return {
    made,
    fill(page) {
      made.node.hidden = page.agent.length === 0
      textIn(made.figure, page.agent.length === 0 ? '' : count(page.agent.length))
      if (page.agent.length === 0) made.figure.removeAttribute('aria-label')
      else made.figure.setAttribute('aria-label', `${page.agent.length} waiting on an agent`)
      keyed(
        list,
        page.agent,
        (one) => one.key,
        createRow,
        (row, one) => fillRow(row, one, `waiting ${one.waitedSaid}`, one.waitedSaid),
      )
    },
  }
}

/** A row: the mark, the question and where it points, and a figure on the right — the whole of it a link where the agent is still listed. */
function createRow() {
  const item = el('li')
  const link = el('a', { class: 'fd-row' })
  into(
    link,
    glyphOf(TALLY_MARKS.agent, 'fd-row-mark'),
    el('span', { class: 'fd-q' }),
    el('span', { class: 'fd-row-aside' }),
    el('span', { class: 'fd-row-line' }),
  )
  into(item, link)
  return item
}

function fillRow(item, row, label, aside) {
  const [link] = item.children
  const [mark, question, side, line] = link.children
  markIn(mark, row.mark)
  textIn(question, row.question)
  textIn(side, aside)
  side.setAttribute('aria-label', label)
  textIn(line, rowLine(row))
  if (row.href === null) link.removeAttribute('href')
  else link.setAttribute('href', row.href)
}

/* ── with a verdict: folded away until asked for ─────────────────────────── */

/** Whether the read findings are unfolded, for as long as the page is open. */
let unfolded = false

function readOf() {
  const made = section('WITH A VERDICT')
  const list = panel('ul', 'fd-rows')
  list.id = 'fd-read'
  list.setAttribute('aria-label', 'With a verdict')
  const press = el('button', {
    class: 'press quietly small fd-fold',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': list.id },
  })
  let n = 0
  const foldIn = () => {
    list.hidden = !unfolded
    press.setAttribute('aria-expanded', unfolded ? 'true' : 'false')
    textIn(press, readSaid(n, unfolded))
  }
  press.addEventListener('click', () => {
    unfolded = !unfolded
    foldIn()
  })
  into(made.body, press, list)
  return {
    made,
    fill(page) {
      n = page.read.length
      made.node.hidden = n === 0
      textIn(made.figure, n === 0 ? '' : count(n))
      if (n === 0) made.figure.removeAttribute('aria-label')
      else made.figure.setAttribute('aria-label', `${n} with a verdict`)
      keyed(
        list,
        page.read,
        (one) => one.key,
        createRow,
        (row, one) => {
          const said = verdictAside(one)
          fillRow(row, one, said, said)
        },
      )
      foldIn()
    },
  }
}

/* ── each question: its findings by verdict, and its precision ────────────── */

function questionsOf() {
  const made = section('BY QUESTION', {
    hint: `Precision is how many of a question’s findings somebody confirmed, out of the ones given a verdict. It is drawn as a rate from ${ENOUGH} verdicts; under that the counts are said and the rate is not. A finding with no verdict is counted as neither.`,
  })
  const list = el('ul', { class: 'fd-questions', attrs: { 'aria-label': 'Questions' } })
  into(made.body, list)
  return {
    made,
    fill(page) {
      textIn(made.figure, count(page.questions.length))
      made.figure.setAttribute('aria-label', `${page.questions.length} questions`)
      keyed(list, page.questions, (one) => one.question, createQuestion, fillQuestion)
    },
  }
}

/**
 * A question: its name with how many of its findings wait on you, its
 * precision on the right, and its findings by verdict as a bar whose legend is
 * the counts — so the bar is never the only place a figure is.
 */
function createQuestion() {
  const item = el('li', { class: 'ui-card fd-question' })
  const head = el('div', { class: 'fd-question-head' })
  const name = el('span', { class: 'fd-question-name' })
  into(name, el('span', { class: 'fd-q' }), el('span', { class: 'ui-pill t-wants' }))
  const figure = el('span', { class: 'fd-question-figure' })
  into(
    figure,
    el('strong', { class: 'fd-question-value' }),
    el('span', { class: 'fd-question-word' }),
  )
  into(head, name, figure)
  const bar = stack('Verdicts')
  bar.classList.add('fd-question-bar')
  into(item, head, bar)
  return item
}

function fillQuestion(item, one) {
  const [head, bar] = item.children
  const [name, figure] = head.children
  const [question, waiting] = name.children
  textIn(question, one.question)
  textIn(waiting, one.yours === 0 ? '' : `${one.yours} to read`)
  waiting.hidden = one.yours === 0
  const [value, word] = figure.children
  textIn(value, one.figure)
  textIn(word, one.under)
  bar.setAttribute('aria-label', `${one.question}, by verdict`)
  stackIn(bar, one.parts)
  item.classList.toggle('is-rate', one.enough)
}
