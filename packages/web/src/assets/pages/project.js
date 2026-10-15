// One project: what in it wants you, what its agents are doing, what is next
// and what that waits on, how its branches' checks stand, what is committed,
// what a judge asked about it, and what it cost. The landing across every
// project is `overview.js`; a task's own page is `agent.js`.
//
// Drawn in the order somebody opening it asks:
//
// 1. **The lead**, one panel under the bar: what wants you or failed as a
//    strip across its top, washed in its tone — the one thing on the page that
//    is loud; the agents as a ring of what each is doing; and four meters —
//    the checks at each branch's HEAD, the queue, the commits ahead and the
//    findings — each a figure, a bar of how it divides and the words for the
//    parts, and a press to its section; then the money.
// 2. **What needs you and what failed**, with the presses this device was
//    granted on each row.
// 3. **The detail, in two bands of two columns at a desk**: the agents beside
//    the checks and the findings; the queue as a graph of what waits on what,
//    the whole width; the branches beside the money. One column on a phone,
//    in that order. What is over — a finished agent, a merged branch, a false
//    positive — folds away behind a count.
//
// **Nothing here derives a state.** Every figure is `project-shape.js`'s fold
// over what came off the wire, held by `test/project-client.test.ts`; every
// reason is `deriveState`'s clause verbatim; a figure nobody could read is a
// dash with its word. A chart is decoration over words that are on the page.
//
// **Built once and then patched**, like every screen: a delta writes text and
// classes into nodes that are already there, so a press keeps its place and a
// half-made selection survives.

import { PROJECT_SHOWN } from '../acts.js'
import {
  donut,
  donutIn,
  flow,
  flowIn,
  legendIn,
  bars as rankedBars,
  barsIn as rankedBarsIn,
  stack,
  stackIn,
  toneIn,
} from '../charts.js'
import { actsIn } from '../controls.js'
import { classOn, el, glyphOf, into, keyed, skeleton, textIn, toneOn, unknown } from '../dom.js'
import { AGENT_MARKS, checkMark, findingMark } from '../glyphs.js'
import { icon } from '../icons.js'
import { pathOf } from '../routes.js'
import { pageBar, section } from '../rows.js'
import { servedBy, servingIn } from '../serving.js'
import { projectAt, queueIn, tasksIn } from '../store.js'
import { queuePaused, queueTree } from '../tree.js'
import { facts, factsIn, panel, stateBox, stateBoxIn } from '../ui.js'
import {
  createAgent,
  createBranch,
  createCheck,
  createFinding,
  createPiece,
  createWant,
  fillAgent,
  fillBranch,
  fillCheck,
  fillFinding,
  fillPiece,
  fillWant,
} from './project-rows.js'
import {
  agentsOf,
  branchesOf,
  checksOf,
  failedOf,
  findingsIn,
  graphOf,
  moneyOf,
  outlineOf,
  queueOf,
  ringOf,
  wantsOf,
} from './project-shape.js'

/* ── the screen ────────────────────────────────────────────────────────────── */

export function projectScreen(where, ctx) {
  const node = el('div')
  const bar = pageBar(where.project, { name: true, back: { text: 'Overview', href: '/' } })
  // The pages every agent's dev servers here serve, a press out each.
  const serving = servingIn(bar.tools)
  // Before the first snapshot: the shape of what is coming, never a blank.
  const coming = skeleton(5)
  const gone = stateBox()

  const lead = leadView()

  const needs = part('NEEDS YOU', 'pj-needs')
  const wantList = el('ol', { class: 'pj-wants ui-panel' })
  into(needs.body, wantList)

  const failed = part('FAILED', 'pj-failed')
  const failList = el('ol', { class: 'pj-wants ui-panel' })
  into(failed.body, failList)

  const agents = part('AGENTS', 'pj-agents')
  const agentsView = foldedList('pj-agents', 'Agents', 'finished or set aside')
  const noAgents = stateBox()
  into(agents.body, agentsView.node, noAgents)

  const checks = part('CHECKS', 'pj-checks', {
    hint: 'How each agent’s branch stood at its last commit. A check nobody ran here is not a check that passed.',
  })
  const checkList = panel('ul', 'pj-list')
  const green = el('p', { class: 'pj-green' })
  into(green, glyphOf(checkMark('pass')), el('span'))
  const noChecks = el('p', { class: 'empty nothing' })
  into(checks.body, checkList, green, noChecks)

  const found = part('FINDINGS', 'pj-findings', {
    hint: 'A judge answers questions; it never decides. A probability is not a verdict, and an agent’s account is its own testimony.',
  })
  const findingList = panel('ul', 'pj-list')
  const cleared = el('a', { class: 'pj-green', attrs: { href: pathOf({ view: 'findings' }) } })
  into(cleared, glyphOf(findingMark({ verdict: { was: 'false positive' } })), el('span'))
  const noFindings = el('p', { class: 'empty nothing' })
  const notGranted = unknown('not granted to this device')
  into(found.body, findingList, cleared, noFindings, notGranted)

  const queue = part('QUEUE', 'pj-queue', {
    hint: 'What starts next, and what each piece waits on. An arrow runs from the work waited on to the work that waits.',
  })
  const graph = flow('The queue, and what each piece waits on')
  graph.classList.add('pj-graph')
  const outline = panel('ol', 'pj-list pj-outline')
  outline.setAttribute('aria-label', 'The queue, with what waits on each piece under it')
  const noQueue = stateBox()
  into(queue.body, graph, outline, noQueue)

  const branches = part('BRANCHES', 'pj-branches', {
    hint: 'Each agent’s branch: commits ahead of where it started and behind it, what is not committed, and whether it is offered for review.',
  })
  const branchesView = foldedList('pj-branches', 'Branches', 'merged')
  const noBranches = el('p', { class: 'empty nothing' })
  into(branches.body, branchesView.node, noBranches)

  const spend = part('SPEND', 'pj-spend')
  const spendView = spendDetail()
  into(spend.body, spendView.node)

  // Two bands of two columns at a desk, each column as full as its neighbour:
  // the agents beside their branches' checks, the branches beside what a judge
  // asked about them and the money. The queue's graph wants the width, so it
  // has the whole of it, between the two.
  const first = band([agents], [checks])
  const second = band([branches], [found, spend])
  const regions = [lead, needs, failed, first, queue, second]

  // Closing it, or opening it again: the same blocks a task's page builds, over
  // the two verbs about the whole project, at the foot where a reach for the
  // ordinary controls does not land on it.
  const foot = el('div', { class: 'pj-foot' })
  const acts = ctx === undefined || ctx === null ? null : actsIn(foot, ctx, PROJECT_SHOWN)

  into(node, bar.node, coming, gone, ...regions.map((one) => one.node), foot)

  return {
    node,
    update(view) {
      const store = view.store
      coming.hidden = store.had
      const project = store.had ? projectAt(store, where.project) : null
      const shut = project?.open === false
      // A project that is not in this device's reach, or is not there any more,
      // is said rather than drawn as an empty project — which would read as a
      // repository where nothing is happening — and a closed one says what
      // closing did and did not do, because its tasks are not drawn here.
      stateBoxIn(
        gone,
        !store.had
          ? null
          : project === null
            ? stateOf(
                'empty',
                'Not on this device',
                'This project is not one this device may read, or it is not on Tade’s list any more.',
                'folder',
              )
            : shut
              ? stateOf(
                  'empty',
                  'Closed',
                  'Nothing was deleted and its agents keep working. Open it again below to see them here.',
                  'folder',
                )
              : null,
      )
      // **A project with nothing in it is one sentence**, not a page of
      // noughts: no agent, nothing queued and nothing asked about it.
      const bare =
        project !== null &&
        !shut &&
        tasksIn(store, where.project).length === 0 &&
        queueIn(store, where.project).length === 0 &&
        findingsIn(store, where.project).n === 0
      if (bare) {
        stateBoxIn(
          gone,
          stateOf(
            'empty',
            'Nothing here yet',
            'No agent has worked in this project and nothing is queued for it. Start or queue work at the machine and it shows here.',
            'folder',
          ),
        )
      }
      const shown = project !== null && !shut && !bare
      for (const one of regions) one.node.hidden = !shown
      serving.update(shown ? servedBy(tasksIn(store, where.project)) : [])
      foot.hidden = project === null
      if (project !== null) acts?.update(project, view)
      if (!shown) {
        textIn(bar.figure, bare ? 'no agents' : '')
        return
      }

      const tasks = tasksIn(store, where.project)
      const list = agentsOf(tasks)
      textIn(bar.figure, countSaid(list.all.length, 'agent', 'agents'))

      const wants = wantsOf(store, where.project)
      const broke = failedOf(list.all)
      const ring = ringOf(list.all)
      const checked = checksOf(list.all)
      const queued = queueIn(store, where.project)
      const standing = queueOf(queued)
      const branched = branchesOf(list.all)
      const judged = findingsIn(store, where.project)
      const paid = moneyOf(store, where.project)
      lead.update({ wants, broke, ring, checked, standing, branched, judged, paid })

      // What needs you, and what failed: each a list of rows with their presses.
      needs.node.hidden = wants.n === 0
      tagIn(needs.figure, wants.n, 't-wants', 'wanting you')
      keyed(
        wantList,
        wants.rows,
        (task) => task.id,
        () => createWant(ctx),
        (one, task) => fillWant(one, task, view),
      )
      failed.node.hidden = broke.length === 0
      tagIn(failed.figure, broke.length, 't-failed', 'failed')
      keyed(
        failList,
        broke,
        (task) => task.id,
        () => createWant(ctx),
        (one, task) => fillWant(one, task, view),
      )

      // The agents: what is still in play, and what is over behind a count.
      figureSaid(
        agents.figure,
        list.all.length === 0 ? '' : String(list.all.length),
        countSaid(list.all.length, 'agent', 'agents'),
      )
      agentsView.update(
        list.live,
        list.over,
        (task) => task.id,
        createAgent,
        (one, task) => fillAgent(one, task, view),
      )
      stateBoxIn(
        noAgents,
        list.all.length > 0
          ? null
          : stateOf(
              'empty',
              'No agent here yet',
              queued.length > 0
                ? 'Nothing has started: the queue below is what will.'
                : 'Start one at the machine, or queue work for this project, and it shows here.',
              'agents',
            ),
      )

      checksIn(checks, checkList, green, noChecks, checked)
      findingsIn_(found, findingList, cleared, noFindings, notGranted, judged, where.project)

      // The queue: a graph where there is the width, an outline where there is not.
      const paused = queuePaused(queued)
      figureSaid(
        queue.figure,
        queued.length === 0 ? '' : paused ? `${queued.length} · paused` : String(queued.length),
        `${queued.length} queued${paused ? ', paused' : ''}`,
      )
      graph.hidden = queued.length === 0
      outline.hidden = queued.length === 0
      if (queued.length > 0) flowIn(graph, graphOf(store, where.project), 'right')
      keyed(
        outline,
        outlineOf(queueTree(queued)),
        (one) => one.row.task,
        createPiece,
        (one, piece) => fillPiece(one, piece, where.project),
      )
      stateBoxIn(
        noQueue,
        queued.length > 0
          ? null
          : stateOf(
              'empty',
              'Nothing queued',
              'Work queued for this project lines up here, with what each piece waits on.',
              'queue',
            ),
      )

      // The branches, to one scale; the merged ones behind a count.
      textIn(branches.figure, branched.live.length === 0 ? '' : branched.said)
      branchesView.update(
        branched.live,
        branched.over,
        (one) => one.id,
        createBranch,
        (one, row) => fillBranch(one, row, branched.most),
      )
      noBranches.hidden = branched.live.length + branched.over.length > 0
      textIn(noBranches, 'No agent here has a branch yet')

      textIn(spend.figure, paid.value ?? '')
      spendView.update(paid)
    },
  }
}

/** A section with an id to be pressed to from the lead. */
function part(title, id, opts = {}) {
  const made = section(title, opts)
  made.node.setAttribute('id', id)
  return made
}

/** Two columns at a desk, the narrow one for what is short; one column on a phone. */
function band(wide, narrow) {
  const node = el('div', { class: 'pj-band' })
  const main = el('div', { class: 'pj-col' })
  const side = el('div', { class: 'pj-col' })
  into(main, ...wide.map((one) => one.node))
  into(side, ...narrow.map((one) => one.node))
  into(node, main, side)
  return { node }
}

const countSaid = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** A region's state, in `stateBoxIn`'s shape. */
const stateOf = (kind, title, line = null, drawn = undefined) => ({
  kind,
  title,
  line,
  icon: drawn,
})

/**
 * A section's figure, and the words for it read aloud — **only while it says
 * something**: a label on an empty `<span>` is a name for nothing, which axe
 * refuses (`aria-prohibited-attr`).
 */
function figureSaid(node, said, label) {
  textIn(node, said)
  if (said === '') node.removeAttribute('aria-label')
  else if (node.getAttribute('aria-label') !== label) node.setAttribute('aria-label', label)
}

/** A count that is somebody's to act on, worn as a tag of its tone beside the heading. */
function tagIn(node, n, tone, noun) {
  figureSaid(node, n === 0 ? '' : String(n), `${n} ${noun}`)
  toneOn(node, n === 0 ? '' : tone)
}

/* ── the lead ──────────────────────────────────────────────────────────────── */

/** The four meters, each a press to its section. */
const METERS = [
  { key: 'checks', label: 'Checks at HEAD', href: '#pj-checks', quiet: 'no branch to check yet' },
  { key: 'queue', label: 'Queue', href: '#pj-queue', quiet: 'nothing waiting to start' },
  { key: 'branches', label: 'Commits', href: '#pj-branches', quiet: 'no agent has a branch yet' },
  { key: 'findings', label: 'Findings', href: '#pj-findings', quiet: 'nothing asked about it' },
]

function leadView() {
  const node = el('div', { class: 'pj-lead ui-panel' })

  const alerts = el('div', { class: 'pj-alerts' })
  const wants = alertOf('wants', '#pj-needs')
  const broke = alertOf('failed', '#pj-failed')
  into(alerts, wants.node, broke.node)

  const ringCell = el('div', { class: 'pj-ring' })
  const ring = donut('The agents, by what each is doing')
  const legend = el('ul', { class: 'ui-legend pj-ring-legend' })
  legend.setAttribute('aria-label', 'The agents, by what each is doing')
  into(ringCell, ring, legend)

  const meters = METERS.map(meterOf)

  const money = el('a', { class: 'pj-meter pj-money', attrs: { href: '#pj-spend' } })
  const moneyHead = el('span', { class: 'pj-meter-head' })
  const moneyFigure = el('span', { class: 'pj-meter-figure' })
  into(moneyHead, el('span', { class: 'pj-meter-label', text: 'Spend' }), moneyFigure)
  const moneyUnder = el('span', { class: 'pj-meter-under' })
  into(money, moneyHead, moneyUnder)

  into(node, alerts, ringCell, ...meters.map((one) => one.node), money)

  return {
    node,
    update(f) {
      alerts.hidden = f.wants.n === 0 && f.broke.length === 0
      wants.update(
        f.wants.n > 0,
        `${f.wants.n} ${f.wants.n === 1 ? 'needs' : 'need'} you`,
        f.wants.said,
      )
      const first = f.broke[0]
      broke.update(
        f.broke.length > 0,
        `${f.broke.length} failed`,
        f.broke.length === 1 && first !== undefined
          ? `${first.name}: ${first.reason}`
          : f.broke.map((task) => task.name).join(', '),
      )

      donutIn(
        ring,
        f.ring.parts.map((one) => ({ label: one.label, n: one.n, tone: one.tone })),
        { said: String(f.ring.n), under: f.ring.n === 1 ? 'agent' : 'agents' },
      )
      legendIn(
        legend,
        f.ring.parts.map((one) =>
          one.key === 'working' && f.ring.stalled > 0
            ? { ...one, label: `working, ${f.ring.stalled} stalled` }
            : one,
        ),
      )

      const [checks, queue, branches, findings] = meters
      checks.fill({ figure: f.checked.figure, tone: f.checked.tone, parts: f.checked.parts })
      queue.fill({
        figure: f.standing.figure,
        tone: null,
        parts: f.standing.parts,
      })
      branches.fill({
        figure: f.branched.figure,
        tone: null,
        parts: f.branched.parts,
      })
      findings.fill(
        f.judged.may
          ? { figure: f.judged.figure, tone: f.judged.tone, parts: f.judged.parts }
          : { figure: null, tone: null, parts: null, why: 'not granted to this device' },
      )

      textIn(moneyFigure, f.paid.value ?? '—')
      classOn(moneyFigure, 'is-unknown', f.paid.value === null)
      textIn(
        moneyUnder,
        f.paid.value === null
          ? f.paid.granted
            ? 'none recorded'
            : 'not granted to this device'
          : [
              f.paid.since === null ? null : `since ${f.paid.since}`,
              f.paid.tokens === null ? null : `${f.paid.tokens} tokens`,
            ]
              .filter(Boolean)
              .join(' · '),
      )
    },
  }
}

/**
 * The strip across the lead's top: what wants you, or what failed, washed in
 * its tone — the glyph carries the colour, the words stay in the text greys so
 * they read on the wash — and a press to the rows.
 */
function alertOf(kind, href) {
  const node = el('a', { class: `pj-alert is-${kind}`, attrs: { href } })
  const mark = glyphOf(AGENT_MARKS[kind === 'wants' ? 'needs-you' : 'failed'], 'pj-alert-mark')
  const words = el('span', { class: 'pj-alert-words' })
  const head = el('strong')
  const line = el('span')
  into(words, head, line)
  into(node, mark, words, icon('chevron', 'pj-go'))
  return {
    node,
    update(shown, said, under) {
      node.hidden = !shown
      if (!shown) return
      textIn(head, said)
      textIn(line, under)
      line.hidden = under === ''
    },
  }
}

/**
 * A meter: a label, its figure, and a bar of how it divides with the words for
 * each part under it — the shared stack, the legend its text. A figure this
 * device could not read is a dash with which dash, and no bar; a whole of
 * nought is one quiet line rather than an empty track and a legend of noughts.
 */
function meterOf(spec) {
  const node = el('a', { class: `pj-meter pj-m-${spec.key}`, attrs: { href: spec.href } })
  const head = el('span', { class: 'pj-meter-head' })
  const figure = el('span', { class: 'pj-meter-figure' })
  into(head, el('span', { class: 'pj-meter-label', text: spec.label }), figure)
  const drawn = stack(spec.label)
  const under = el('span', { class: 'pj-meter-under' })
  into(node, head, drawn, under)
  return {
    node,
    fill(one) {
      textIn(figure, one.figure ?? '—')
      classOn(figure, 'is-unknown', one.figure === null)
      toneIn(figure, one.tone)
      const whole = one.parts === null ? 0 : one.parts.reduce((sum, part) => sum + part.n, 0)
      drawn.hidden = whole === 0
      if (whole > 0) stackIn(drawn, one.parts)
      const why = one.parts === null ? one.why : whole === 0 ? spec.quiet : ''
      textIn(under, why)
      under.hidden = why === ''
    },
  }
}

/* ── a list with what is over folded behind a count ────────────────────────── */

/** Which of this page's folds somebody opened, for as long as the page is. */
const opened = new Set()

/**
 * A list of rows in play, and under it a press that shows what is over — a
 * finished agent, a merged branch — in a second list. Closed unless somebody
 * opened it, and remembered while the page is open.
 */
function foldedList(key, label, overWord) {
  const node = el('div', { class: 'pj-folded' })
  const live = panel('ul', 'pj-list')
  live.setAttribute('aria-label', label)
  const press = el('button', { class: 'pj-more', attrs: { type: 'button' } })
  const words = el('span')
  into(press, icon('chevron', 'pj-twist'), words)
  const over = panel('ul', 'pj-list is-over')
  over.setAttribute('id', `${key}-over`)
  over.setAttribute('aria-label', `${label}, ${overWord}`)
  press.setAttribute('aria-controls', `${key}-over`)
  into(node, live, press, over)
  let n = 0
  const set = () => {
    const open = opened.has(key)
    over.hidden = !open || n === 0
    press.setAttribute('aria-expanded', open ? 'true' : 'false')
    textIn(words, `${open ? 'Hide' : 'Show'} ${n} ${overWord}`)
  }
  press.addEventListener('click', () => {
    if (opened.has(key)) opened.delete(key)
    else opened.add(key)
    set()
  })
  return {
    node,
    update(inPlay, done, keyOf, create, fill) {
      keyed(live, inPlay, keyOf, create, fill)
      keyed(over, done, keyOf, create, fill)
      live.hidden = inPlay.length === 0
      n = done.length
      press.hidden = n === 0
      set()
    },
  }
}

/* ── the checks and the findings ───────────────────────────────────────────── */

/**
 * The branches whose checks want a look — red first, then not run here — and
 * the green as one line, because a branch that is green is nothing to read.
 */
function checksIn(made, list, green, none, checked) {
  textIn(made.figure, checked.total === 0 ? '' : checked.figure)
  toneOn(made.figure, checked.fail > 0 ? 't-failed' : '')
  const rows = [...checked.red, ...checked.unrun]
  keyed(
    list,
    rows,
    (task) => task.id,
    createCheck,
    (one, task) => fillCheck(one, task),
  )
  list.hidden = rows.length === 0
  green.hidden = checked.pass === 0
  textIn(
    green.lastChild,
    checked.pass === checked.total
      ? `Every branch is green (${checked.pass})`
      : `${countSaid(checked.pass, 'more branch is', 'more branches are')} green`,
  )
  none.hidden = checked.total > 0
  textIn(none, 'No agent here has anything to check yet')
}

function findingsIn_(made, list, cleared, none, notGranted, judged, project) {
  notGranted.hidden = judged.may
  textIn(made.figure, judged.may && judged.n > 0 ? judged.figure : '')
  toneOn(made.figure, judged.tone === 'wants' ? 't-wants' : '')
  keyed(
    list,
    judged.live,
    (one) => one.key,
    createFinding,
    (one, row) => fillFinding(one, row, project),
  )
  list.hidden = !judged.may || judged.live.length === 0
  cleared.hidden = !judged.may || judged.over.length === 0
  textIn(
    cleared.lastChild,
    `${countSaid(judged.over.length, 'more was', 'more were')} read and found a false positive`,
  )
  none.hidden = !judged.may || judged.n > 0
  textIn(none, 'No judge has asked anything about this project')
}

/* ── the money ─────────────────────────────────────────────────────────────── */

/**
 * What the money is made of — billed exactly, estimated, the tokens and what of
 * them no rate covers — then which agents spent most of it, and every way the
 * figure could be short of the truth said beside it.
 */
function spendDetail() {
  const node = el('div', { class: 'pj-spend-body' })
  const cells = facts('What the spend is made of')
  const most = rankedBars('Most spent, by agent')
  most.classList.add('pj-most')
  const notes = el('ul', { class: 'pj-notes' })
  const scope = unknown('not granted to this device')
  into(node, scope, cells, most, notes)
  return {
    node,
    update(paid) {
      scope.hidden = paid.granted
      for (const one of [cells, most, notes]) one.hidden = !paid.granted
      if (!paid.granted) return
      // What was billed and what was estimated are two claims, never added in
      // silence; an estimate nobody made is not a cell.
      factsIn(
        cells,
        [
          {
            label: 'billed',
            value: paid.exact,
            under: paid.exact === null ? 'none recorded' : null,
          },
          paid.estimated === null ? null : { label: 'estimated', value: paid.estimated },
          { label: 'tokens', value: paid.tokens, under: paid.unpriced },
        ].filter(Boolean),
      )
      most.hidden = paid.top.length === 0
      rankedBarsIn(most, paid.top)
      // A figure without its period is not a figure (`sinceSaid`), and a plan's
      // equivalent is said apart because nobody was charged it.
      const said = [
        {
          key: 'since',
          line:
            paid.since === null
              ? 'What period this covers cannot be told from here'
              : `Spent since ${paid.since}, and nothing before it`,
        },
        paid.plan === null ? null : { key: 'plan', line: `${paid.plan.said} ${paid.plan.why}` },
        paid.unreported > 0
          ? {
              key: 'unreported',
              line: `${countSaid(paid.unreported, 'agent', 'agents')} reported no spend`,
            }
          : null,
        paid.partial
          ? { key: 'partial', line: 'Some of its work is not on this page: this is a floor' }
          : null,
      ].filter(Boolean)
      keyed(
        notes,
        said,
        (one) => one.key,
        () => el('li'),
        (one, note) => textIn(one, note.line),
      )
      notes.hidden = said.length === 0
    },
  }
}
