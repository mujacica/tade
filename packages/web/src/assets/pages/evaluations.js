// Evaluations: which harness, model, persona and template lands work, and the
// judge's own record beside them — one surface for everything measured about
// how the work goes.
//
// **What somebody opening this wants first** is the whole of it at a glance —
// how much landed, how often the first push was green, how many reds were
// caught here before CI, what a landed agent cost and how long it took — so
// those lead as stat tiles. Then one way of grouping it at a time, as ranked
// bars of what landed with every other figure on the line under each; and the
// judge as its own tab, precision per question and per band.
//
// **Asked when the screen opens, never on the stream**, and again every
// `AGAIN_MS` while it stays open: a scorecard moves when work finishes, and a
// phone is not sent four tables of it on every beat (`GET /api/evaluations`).
// Every word is `evaluations-shape.js`'s, and the machine's: counts before
// rates, and a rate only from five.

import { bars, barsIn, stat, statIn, stats } from '../charts.js'
import { classOn, el, into, skeleton, textIn } from '../dom.js'
import { icon } from '../icons.js'
import { section } from '../rows.js'
import { troubleOf, UNKNOWN_TROUBLE } from '../trouble.js'
import { panel, stateBox, stateBoxIn } from '../ui.js'
import {
  boxOf,
  cardsOf,
  EVAL_TABS,
  emptyOf,
  judgeOf,
  leadOf,
  mergedSaid,
} from './evaluations-shape.js'

/** Where the answer is asked. */
export const EVALUATIONS_PATH = '/api/evaluations'

/** How often an open page asks again. */
const AGAIN_MS = 60_000

/** Which tab the page was last on, for as long as the page is open. */
let chosen = 'harness'

export function evaluationsScreen(ctx) {
  const node = el('div')
  const top = section('EVALUATIONS', { top: true })
  const again = el('button', { class: 'press quietly small ev-again', attrs: { type: 'button' } })
  into(again, icon('refresh'), el('span', { text: 'Read again' }))
  into(top.tools, again)

  const coming = skeleton(5)
  const failed = stateBox()
  const lead = stats('The whole of it')
  const tiles = new Map()
  for (const one of leadOf(null)) {
    const tile = stat(one.label)
    tiles.set(one.key, tile)
    into(lead, tile)
  }
  const merged = el('p', { class: 'ev-merged' })
  const tabs = el('div', {
    class: 'ev-tabs',
    attrs: { role: 'group', 'aria-label': 'Score the work by' },
  })
  const presses = EVAL_TABS.map((one) => {
    const press = el('button', {
      class: 'ui-chip ev-tab',
      text: one.word,
      attrs: { type: 'button', 'aria-pressed': one.id === chosen ? 'true' : 'false' },
    })
    press.addEventListener('click', () => {
      if (chosen === one.id) return
      chosen = one.id
      draw()
    })
    into(tabs, press)
    return { id: one.id, press }
  })

  const cards = section('SCORECARDS')
  const cardBars = bars('What landed, by what it ran on')
  const cardPanel = panel('div', 'ev-panel')
  into(cardPanel, cardBars)
  into(cards.body, cardPanel)

  const judge = section('THE JUDGE')
  const judgeSaid = el('p', { class: 'ev-judge-said' })
  const questions = bars('Precision per question')
  const bands = bars('Precision per band of probability')
  const questionPanel = panel('div', 'ev-panel')
  into(questionPanel, questions)
  const bandHead = el('h3', { class: 'ev-sub', text: 'By how sure it was' })
  const bandPanel = panel('div', 'ev-panel')
  into(bandPanel, bands)
  into(judge.body, judgeSaid, questionPanel, bandHead, bandPanel)

  const state = stateBox()
  const body = el('div', { class: 'ev-body' })
  into(body, lead, merged, tabs, state, cards.node, judge.node)
  into(top.body, coming, failed, body)
  into(node, top.node)

  let answer = null
  let trouble = null
  let gone = false
  let timer = null

  function draw() {
    coming.hidden = answer !== null || trouble !== null
    stateBoxIn(
      failed,
      trouble === null
        ? null
        : {
            ...boxOf('error', trouble.title, trouble.fix),
            action: { word: 'Ask again', run: () => void load() },
          },
    )
    body.hidden = answer === null
    if (answer === null) return
    textIn(top.figure, answer.total ? String(answer.total.tasks) : '')
    for (const one of leadOf(answer)) {
      const tile = tiles.get(one.key)
      if (tile) statIn(tile, { value: one.value, under: one.under })
    }
    textIn(merged, mergedSaid(answer))
    merged.hidden = merged.textContent === ''
    for (const { id, press } of presses) {
      press.setAttribute('aria-pressed', id === chosen ? 'true' : 'false')
    }
    const nothing = emptyOf(answer, chosen)
    stateBoxIn(state, nothing === null ? null : { ...nothing, icon: 'checks' })
    const judging = chosen === 'judge'
    cards.node.hidden = judging || nothing !== null
    judge.node.hidden = !judging || nothing !== null
    if (!judging) {
      textIn(cards.heading, `BY ${chosen.toUpperCase()}`)
      barsIn(cardBars, cardsOf(answer, chosen))
      return
    }
    const read = judgeOf(answer)
    if (read.state !== 'read') return
    textIn(judgeSaid, read.said)
    barsIn(questions, read.questions)
    barsIn(bands, read.bands)
    bandHead.hidden = read.bands.length === 0
    bandPanel.hidden = read.bands.length === 0
  }

  const load = async () => {
    again.disabled = true
    const got = await ctx.ask('GET', EVALUATIONS_PATH)
    if (gone) return
    again.disabled = false
    if (got.status === 200 && got.body !== null && typeof got.body?.read === 'boolean') {
      answer = got.body
      trouble = null
    } else if (answer === null) {
      trouble = troubleOf(got) ?? UNKNOWN_TROUBLE
    }
    draw()
    // Not read yet is a journal being read: asked again soon rather than in a minute.
    clearTimeout(timer)
    timer = setTimeout(() => void load(), answer?.read === false ? 3_000 : AGAIN_MS)
  }
  again.addEventListener('click', () => void load())
  classOn(top.body, 'ev-page', true)

  draw()
  void load()

  return {
    node,
    update() {},
    leave() {
      gone = true
      clearTimeout(timer)
    },
  }
}
