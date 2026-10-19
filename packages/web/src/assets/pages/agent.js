// One task, and the agent on it — the page a row down the side opens.
//
// Drawn in the order somebody opening it asks:
//
// 1. **The lead**, one panel under the bar: what it is doing now in
//    `deriveState`'s own words beside its mark, washed violet where it is
//    waiting on you and red where it failed — the one loud thing on the page —
//    with what it runs on and how long since it moved; then four cells, each
//    a figure, a drawing and a line: its checks and a strip of every run,
//    its branch as commits either side of where it started, what it cost and
//    its share of its project's spend, and where it is in its run.
// 2. **Its screen**, as the `lanes` grant has it, and under it the box to tell
//    its agent something — look, then say.
// 3. **Its timeline**: a lane each for the agent running, its turns, its
//    tools, its checks and its commits over one axis ending at now, and every
//    moment in words under it, read on to its first (`agent-time.js`).
// 4. **The detail, in two bands of two columns at a desk**: every check's
//    history beside its branch and its run; what was asked for beside the
//    facts about it. One column on a phone, in that order.
// 5. **The rest of the controls**, a grid of what may be asked of it, and
//    what may not with its reason, quiet, at the end (`actsIn`).
//
// **What is absent is still the point.** There is no diff and no transcript —
// each ships source to a phone and to a browser cache. A control nothing could
// carry out is absent with its reason beside it, never greyed out.
//
// **Opening it is never a blank.** Before the first snapshot the shapes that
// are coming (`skeleton`); before the agent's own answer its screen and its
// timeline are; and only a snapshot that has been read and does not have this
// task says that it is not here. Every figure is `agent-shape.js`'s, held by
// `test/task-client.test.ts`.

import { mayFor } from '../access.js'
import { SHOWN } from '../acts.js'
import { heat, heatIn, steps, stepsIn, toneIn } from '../charts.js'
import { actsIn } from '../controls.js'
import {
  classOn,
  el,
  empty,
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
import { taskMark } from '../glyphs.js'
import { icon } from '../icons.js'
import { quickActs } from '../quick.js'
import { pathOf, safeHref } from '../routes.js'
import { createQueueRow, fillQueueRow, pageBar, section } from '../rows.js'
import { servingIn } from '../serving.js'
import { taskAt } from '../store.js'
import {
  command,
  commandIn,
  facts,
  factsIn,
  meter,
  meterIn,
  note,
  panel,
  stateBox,
  stateBoxIn,
} from '../ui.js'
import { agentPane } from './agent-pane.js'
import { conversationView } from './agent-said.js'
import {
  aboutOf,
  branchOf,
  findingsOf,
  headOf,
  nowOf,
  recentOf,
  runOf,
  spendOf,
  stateOf,
  tracksOf,
  treeOf,
} from './agent-shape.js'
import { timeline } from './agent-time.js'

/** Every control but the one under its screen, in the order the grid draws them. */
const REST = SHOWN.filter((verb) => verb !== 'steer')

export function taskScreen(where, ctx) {
  const live = ctx !== undefined && ctx !== null
  const node = el('div')
  const glyph = glyphOf(taskMark('queued'))
  const bar = pageBar(where.task, {
    name: true,
    glyph,
    back: { text: where.project, href: pathOf({ view: 'project', project: where.project }) },
  })
  // The state as a pill beside the name, in its tone, readable across a desk.
  const pill = el('span', { class: 'ui-pill' })
  bar.heading.after(pill)
  // The presses this device was granted, at the end of the bar: the answer to
  // an agent that is waiting is the reason somebody opened this page.
  // The command it would allow is the lead's, not the bar's (`command: false`).
  const quick = live ? quickActs(ctx, { tell: false, command: false }) : null
  // The pages its dev servers serve, a press out each, before them.
  const serving = servingIn(bar.tools)
  if (quick !== null) into(bar.tools, quick.node)

  const coming = el('div', { class: 'ag-coming' })
  into(coming, skeleton(3), skeleton(6))
  const gone = stateBox()

  const lead = leadView()

  // Its screen and the box to tell it something, asked for while this page is
  // open and not a moment after (`leave`).
  const screen = section('SCREEN')
  screen.node.id = 'ag-screen'
  const time = timeline()
  const pane = live ? agentPane(where, ctx, () => paint()) : null
  if (pane !== null) {
    into(screen.figure, pane.read)
    into(screen.body, pane.card)
  }
  const tell = el('div', { class: 'ag-tell' })
  into(screen.body, tell)
  const told = live ? actsIn(tell, ctx, ['steer']) : null
  // What it was told and said, and the tools it reached for, from the same asking.
  const said = conversationView()

  const checks = checksView()
  const work = workView()
  const asked = section('ASKED FOR')
  const about = aboutView()
  const first = band(checks.node, work.node)

  const acts = section('ACTIONS')
  acts.node.id = 'ag-acts'
  acts.body.classList.add('ag-acts')
  // **Every control the page has, built once** — one block per verb, each
  // hidden until the row says it may be asked for, so what somebody has typed
  // into one survives every delta.
  const controls = live ? actsIn(acts.body, ctx, REST) : null

  const regions = [
    lead.node,
    screen.node,
    said.node,
    time.node,
    first,
    asked.node,
    about.node,
    acts.node,
  ]
  into(node, bar.node, coming, gone, ...regions)

  let view = null
  const paint = () => {
    if (view === null) return
    const task = view.store.had ? taskAt(view.store, where.project, where.task) : null
    if (task === null) return
    const record = treeOf(task, view.store)
    const heard = pane?.heard() ?? { answer: null, failed: null }
    time.update(heard, task, record, view)
    said.update(heard, view)
  }

  return {
    node,
    update(next) {
      view = next
      const had = view.store.had === true
      const task = had ? taskAt(view.store, where.project, where.task) : null
      coming.hidden = had
      stateBoxIn(
        gone,
        had && task === null
          ? stateOf(
              'empty',
              'Not on this device',
              'This agent is not one this device may read, or its task is not on Tade’s list any more.',
              'agents',
            )
          : null,
      )
      for (const one of regions) one.hidden = task === null
      serving.update(task?.servers ?? [])
      if (task === null) return

      const mark = nowOf(task, view.asOf, view.frozen).mark
      markIn(glyph, mark)
      textIn(pill, mark.word)
      // A quiet pill is drawn without its tone: the grey word on its own wash is under AA.
      toneOn(pill, mark.tone === 't-quiet' ? '' : mark.tone)
      quick?.update(task, view)

      const record = treeOf(task, view.store)
      lead.update(task, view, record)
      pane?.update(view)
      told?.update(task, view)
      // A box nothing could be drawn in is not a place on the page.
      tell.hidden = [...tell.children].every((one) => one.hidden)
      paint()
      checks.update(task, view, record)
      work.update(task, view)
      askedIn(asked, task, view.store)
      about.update(task, view)
      controls?.update(task, view)
      kindsIn(acts.body)
      // A block of controls nothing could be drawn in is not a heading.
      acts.node.hidden = [...acts.body.children].every((one) => one.hidden)
    },
    leave() {
      pane?.leave()
      said.leave()
    },
  }
}

/**
 * The controls in three kinds, so each lines up with its own: a press and
 * nothing to type (allow, set aside, stop) first, the ones that take words in
 * pairs, and what cannot be asked now last, a line each. The last of an odd
 * run takes the whole width, so no card stands beside a hole.
 */
function kindsIn(grid) {
  const all = [...grid.children]
  const shown = all.filter((one) => !one.hidden && !one.classList.contains('is-off'))
  const typed = shown.filter((one) => one.querySelector('textarea') !== null)
  const pressed = shown.filter((one) => !typed.includes(one))
  const wide = [typed, pressed].flatMap((run) => (run.length % 2 === 1 ? [run.at(-1)] : []))
  for (const one of all) {
    classOn(one, 'ag-press', pressed.includes(one))
    classOn(one, 'ag-wide', wide.includes(one))
  }
}

/** Two columns where the work has the room, each as full as its neighbour; one on a phone. */
function band(...columns) {
  const node = el('div', { class: 'ag-band' })
  into(node, ...columns)
  return node
}

/* ── the lead ──────────────────────────────────────────────────────────────── */

/** A cell of the lead: its label, its figure, its drawing and its line — a press where it goes somewhere. */
function cellOf(label, href) {
  const node = el(href === null ? 'div' : 'a', {
    class: 'ag-cell',
    attrs: href === null ? {} : { href },
  })
  const value = el('span', { class: 'ag-cell-value' })
  const drawing = el('span', { class: 'ag-cell-drawing' })
  const under = el('span', { class: 'ag-cell-under' })
  into(node, el('span', { class: 'ag-cell-label', text: label }), value, drawing, under)
  return { node, value, drawing, under }
}

function leadView() {
  const node = el('div', { class: 'ag-lead ui-panel' })

  const now = el('div', { class: 'ag-now' })
  const mark = glyphOf(taskMark('working'), 'ag-now-mark')
  const words = el('div', { class: 'ag-now-words' })
  const said = el('p', { class: 'ag-now-said' })
  const under = el('p', { class: 'ag-now-under' })
  const word = el('span', { class: 'ui-pill' })
  const waiting = el('span', { class: 'ui-pill is-mono' })
  const stalled = el('span', { class: 'ui-pill t-here', text: 'gone quiet' })
  const runsOn = el('span', { class: 'ag-now-on' })
  into(under, word, waiting, stalled, runsOn)
  // What it is waiting to run, whole, under the line that says it is waiting.
  const toRun = command()
  into(words, said, under, toRun)
  const age = el('span', { class: 'ag-now-age' })
  into(now, mark, words, age)

  const cells = el('div', { class: 'ag-cells' })
  const checks = cellOf('Checks', '#ag-checks')
  const strip = heat('Its checks, newest last')
  into(checks.drawing, strip)
  const branch = cellOf('Branch', '#ag-work')
  const dots = dotsOf()
  into(branch.drawing, dots.node)
  const spend = cellOf('Spend', null)
  const share = meter()
  into(spend.drawing, share)
  const run = cellOf('Plan', '#ag-work')
  const chain = el('ol', { class: 'ag-chain', attrs: { 'aria-hidden': 'true' } })
  into(run.drawing, chain)
  into(cells, checks.node, branch.node, spend.node, run.node)

  into(node, now, cells)

  return {
    node,
    update(task, view, record) {
      const state = nowOf(task, view.asOf, view.frozen)
      classOn(now, 'is-wants', state.loud === 'wants')
      classOn(now, 'is-failed', state.loud === 'failed')
      markIn(mark, state.mark)
      textIn(said, state.said)
      textIn(word, state.mark.word)
      // On a washed line the square carries the tone: a toned pill on its own
      // colour's wash is under AA, and a quiet one is under it anywhere.
      toneOn(word, state.loud !== null || state.mark.tone === 't-quiet' ? '' : state.mark.tone)
      waiting.hidden = state.waiting === null
      textIn(
        waiting,
        state.waiting === null
          ? ''
          : `${state.waiting.tool}${state.waiting.for === null ? '' : ` · ${state.waiting.for}`}`,
      )
      commandIn(toRun, state.waiting?.command ?? null)
      stalled.hidden = !state.stalled
      textIn(runsOn, state.runsOn)
      runsOn.hidden = state.runsOn === ''
      textIn(age, state.moved ?? '—')
      age.setAttribute('aria-label', state.movedSaid)

      // Checks: the word at its head, and how the newest runs went.
      const head = headOf(task)
      textIn(checks.value, head.mark.word)
      toneOn(checks.value, head.mark.tone === 't-quiet' ? '' : head.mark.tone)
      const recent = recentOf(record.tree)
      strip.hidden = recent.cells.length === 0
      heatIn(strip, recent.cells, { said: recent.said })
      textIn(
        checks.under,
        head.line !== ''
          ? head.line
          : !record.read
            ? 'not read yet'
            : (recent.line ?? 'no runs here yet'),
      )

      // The branch: commits either side of where it started.
      const branched = branchOf(task)
      textIn(branch.value, branched.value ?? '—')
      classOn(branch.value, 'is-quiet', branched.name === null)
      dots.update(branched)
      textIn(branch.under, branched.under ?? '')

      // The money, its period, and its share of its project's.
      const paid = spendOf(task, view.store)
      textIn(spend.value, paid.value ?? '—')
      classOn(spend.value, 'is-quiet', paid.value === null)
      share.hidden = paid.share === null
      if (paid.share !== null) meterIn(share, paid.share)
      textIn(
        spend.under,
        paid.value === null
          ? paid.why
          : [paid.shareSaid, paid.since].filter((one) => one !== null).join(' · '),
      )

      // The run: where it is among its steps — or on its own.
      const ran = runOf(task, view.store)
      if (ran === null) run.node.removeAttribute('href')
      else run.node.setAttribute('href', ran.href)
      textIn(run.value, ran === null ? 'on its own' : (ran.value ?? '—'))
      classOn(run.value, 'is-quiet', ran === null || ran.value === null)
      textIn(run.under, ran === null ? 'in no plan' : ran.name)
      keyed(
        chain,
        ran?.steps ?? [],
        (one) => one.key,
        () => el('li'),
        (item, one) => {
          toneIn(item, STEP_TONES[one.state] ?? 'quiet')
          classOn(item, 'is-done', one.state === 'done')
          classOn(item, 'is-mine', one.mine)
        },
      )
      chain.hidden = (ran?.steps.length ?? 0) === 0
    },
  }
}

/** A step's dot in the lead's chain, in a chart tone. */
const STEP_TONES = {
  done: 'done',
  now: 'working',
  failed: 'failed',
  wants: 'wants',
  next: 'quiet',
  skipped: 'quiet',
}

/**
 * Commits either side of where the branch started: behind to the left in grey,
 * ahead to the right in amber, a dot each up to `DOTS` and the rest said.
 */
function dotsOf() {
  const node = el('span', { class: 'ag-dots', attrs: { 'aria-hidden': 'true' } })
  const behind = el('span', { class: 'ag-dots-behind' })
  const base = el('span', { class: 'ag-dots-base' })
  const ahead = el('span', { class: 'ag-dots-ahead' })
  into(node, behind, base, ahead)
  const fill = (side, n, more) => {
    while (side.children.length > n + (more > 0 ? 1 : 0)) side.lastChild.remove()
    while (side.children.length < n) side.append(el('i'))
    const plus = side.querySelector('b')
    if (more > 0 && plus === null) side.append(el('b', { text: `+${more}` }))
    else if (more > 0) textIn(plus, `+${more}`)
    else plus?.remove()
  }
  return {
    node,
    update(one) {
      node.hidden = one.name === null
      fill(behind, one.behind, one.moreBehind)
      fill(ahead, one.ahead, one.moreAhead)
    },
  }
}

/* ── checks ────────────────────────────────────────────────────────────────── */

function checksView() {
  const part = section('CHECKS', {
    hint: 'A strip is history: a last run that passed is not this commit passing. What is at its head is what the rollup says.',
  })
  part.node.id = 'ag-checks'
  const card = el('div', { class: 'ui-panel ag-checks' })
  const head = el('div', { class: 'ag-head' })
  const word = el('span', { class: 'ui-pill' })
  const line = el('span', { class: 'ag-head-line' })
  into(head, el('span', { class: 'ag-head-label', text: 'At its head' }), word, line)
  const overruled = note(
    'overruled',
    'a failing check here was overruled, with a reason, at the machine',
    'alert',
  )
  const where = el('p', { class: 'ag-where' })
  const list = el('ul', { class: 'ag-tracks' })
  const none = el('p', { class: 'ag-none' })
  into(card, head, overruled, where, list, none)
  into(part.body, card)

  return {
    node: part.node,
    update(task, view, record) {
      const said = headOf(task)
      textIn(word, said.mark.word)
      toneOn(word, said.mark.tone === 't-quiet' ? '' : said.mark.tone)
      textIn(line, said.line)
      overruled.hidden = !said.overruled
      textIn(part.figure, record.tree === null ? '' : String(record.tree.checks.length))
      // Whose runs these are: its own worktree's, or a checkout that may be anybody's.
      where.hidden = record.tree === null || record.own
      textIn(
        where,
        task.shared
          ? 'Runs in the shared checkout — anybody’s, not only this agent’s'
          : 'Runs in the project’s checkout',
      )
      const tracks = tracksOf(record.tree, view.asOf, view.frozen)
      keyed(list, tracks, (one) => one.key, createTrack, fillTrack)
      list.hidden = tracks.length === 0
      none.hidden = tracks.length > 0
      textIn(
        none,
        !record.read
          ? 'Its record of runs has not been read yet'
          : 'No check has run for it here yet',
      )
    },
  }
}

function createTrack() {
  const node = el('li', { class: 'ag-track' })
  const mark = el('span', { class: 'ag-track-mark', attrs: { 'aria-hidden': 'true' } })
  const name = el('span', { class: 'ag-track-name' })
  const strip = heat('')
  strip.classList.add('ag-track-strip')
  const said = el('span', { class: 'ag-track-said' })
  into(node, mark, name, strip, said)
  return node
}

function fillTrack(node, track) {
  const [mark, name, strip, said] = node.children
  textIn(mark, track.mark.glyph)
  toneOn(mark, track.mark.tone)
  textIn(name, track.required ? track.check : `${track.check} · optional`)
  heatIn(strip, track.cells, { said: track.said })
  const lines = [
    track.forSaid === null ? track.mark.word : `${track.mark.word} for ${track.forSaid}`,
    track.typical === null ? null : `takes ${track.typical}`,
  ].filter((one) => one !== null)
  textIn(said, lines.join(' · '))
}

/* ── its work: the branch, the run, the queue ──────────────────────────────── */

function workView() {
  const part = section('WORK')
  part.node.id = 'ag-work'
  const card = el('div', { class: 'ui-panel ag-work' })

  const branch = el('div', { class: 'ag-branch' })
  const top = el('div', { class: 'ag-branch-top' })
  const name = el('span', { class: 'ag-branch-name' })
  const pill = el('span', { class: 'ui-pill' })
  // The one string on the page written off this machine: `https:` only
  // (`safeHref`), a new tab, and no handle or referrer for the forge.
  const link = el('a', {
    class: 'ui-chip ag-review',
    attrs: { target: '_blank', rel: 'noopener noreferrer' },
  })
  const linkWord = el('span')
  into(link, linkWord, icon('arrow'))
  into(top, name, pill, link)
  const dots = dotsOf()
  dots.node.classList.add('is-large')
  const said = el('p', { class: 'ag-branch-said' })
  const noBranch = el('p', { class: 'ag-none', text: 'No branch yet' })
  into(branch, top, dots.node, said, noBranch)

  const run = el('div', { class: 'ag-run' })
  const runLink = el('a', { class: 'ag-run-link', attrs: { href: '/' } })
  const runName = el('span', { class: 'ag-run-name' })
  const runSaid = el('span', { class: 'ag-run-said' })
  into(runLink, runName, runSaid, icon('chevron'))
  const runSteps = steps('Its plan, step by step')
  const noRun = el('p', { class: 'ag-none', text: 'Not part of a plan' })
  into(run, runLink, runSteps, noRun)

  const queue = panel('ul', 'queue ag-queue')

  into(card, branch, run, queue)
  into(part.body, card)

  return {
    node: part.node,
    update(task, view) {
      const one = branchOf(task)
      top.hidden = one.name === null
      noBranch.hidden = one.name !== null
      textIn(name, one.name ?? '')
      dots.update(one)
      const parts = [one.value, one.under, one.where].filter((each) => each !== null && each !== '')
      textIn(said, one.name === null ? '' : parts.join(' · '))
      said.hidden = one.name === null
      // The review: a press out to it where this device may have its address,
      // a word where it may not, and nothing where there is none to offer.
      const url = mayFor(view.store, 'tasks.review.url') ? safeHref(task.review?.url) : null
      const review = one.review
      link.hidden = review === null || url === null
      pill.hidden = review === null || url !== null
      if (review !== null) {
        textIn(pill, review.word)
        toneOn(pill, review.tone === 't-quiet' ? '' : review.tone)
        textIn(linkWord, `review ${review.word}`)
        if (url !== null) link.setAttribute('href', url)
      }

      const ran = runOf(task, view.store)
      runLink.hidden = ran === null
      runSteps.hidden = ran === null || ran.steps.length === 0
      noRun.hidden = ran !== null
      if (ran !== null) {
        runLink.setAttribute('href', ran.href)
        textIn(runName, ran.name)
        textIn(runSaid, ran.value ?? '')
        stepsIn(runSteps, ran.steps)
      }

      const queued = view.store.rows.queue.get(task.id)
      keyed(
        queue,
        queued === undefined ? [] : [queued],
        (row) => row.task,
        createQueueRow,
        (row, row_) => fillQueueRow(row, row_, { ...view, project: task.project }),
      )
      queue.hidden = queued === undefined
    },
  }
}

/* ── what was asked for, and the facts ─────────────────────────────────────── */

/**
 * What somebody asked for, in their own words, folded to three lines —
 * **verbatim, and never reworded**. A device granted neither the titles nor the
 * intent is told *that*, rather than that nobody wrote anything down. Written
 * once: rebuilding it would close a fold somebody had opened.
 */
function askedIn(made, task, store) {
  if (made.body.children.length > 0) return
  if (!mayFor(store, 'tasks.intent') && !mayFor(store, 'tasks.title')) {
    into(made.body, unknown('not granted to this device'))
    return
  }
  const said = task.intent ?? task.title
  const card = panel('div', 'ag-asked')
  into(card, proseOf(said, true) ?? empty('nothing written down'))
  if (task.intent !== null && task.title !== null) {
    into(card, el('p', { class: 'ag-asked-as', text: 'As a title' }), proseOf(task.title))
  }
  into(made.body, card)
}

function aboutView() {
  const part = section('ABOUT')
  const list = facts('About this agent')
  list.classList.add('ag-about')
  const found = el('a', {
    class: 'ui-chip ag-found',
    attrs: { href: pathOf({ view: 'findings' }) },
  })
  const foundWord = el('span')
  into(found, icon('findings'), foundWord)
  into(part.body, list, found)
  return {
    node: part.node,
    update(task, view) {
      factsIn(list, aboutOf(task, view.store, view.asOf, view.frozen))
      const judged = findingsOf(task, view.store)
      found.hidden = judged.n === 0
      textIn(foundWord, judged.said ?? '')
      classOn(found, 't-wants', judged.n > 0)
    },
  }
}
