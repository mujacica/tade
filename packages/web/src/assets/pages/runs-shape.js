// The runs, folded for drawing: how a run's steps divide, which of its steps
// is the loudest, where each dot of its map goes, and what is happening in it
// now — in numbers and words, and nothing that touches the DOM, so the offline
// suite runs every one of them (`test/runs-client.test.ts`).
//
// **Nothing here decides a state.** A step's state is `deriveState`'s and the
// journal's, carried on the wire and drawn by `stepMark`; every fold here
// starts from that mark's word and only ever counts, orders or picks among
// them. A run wears **its loudest step's mark** — the one thing a person
// opening the page would want to hear first — and that is a choice of which
// existing answer to show, never a new rule about when work is stuck.

import { mayFor } from '../access.js'
import { flowGeometry } from '../charts.js'
import { money } from '../figures.js'
import { checkMark, joined, reviewMark, stepMark } from '../glyphs.js'
import { taskPath } from '../routes.js'

/* ── how a run's steps divide ──────────────────────────────────────────────── */

/**
 * The parts a run's steps fall into, in the order progress reads: finished
 * first, then what is moving, then what wants somebody, then what is waiting.
 *
 * `tone` is a chart's word (`charts.js`'s `TONES`) and `glyph` the mark the
 * same step wears in a row, so the legend and the rows never disagree about
 * what a colour means. `always` parts stay in a legend at nought — *nothing
 * failed* is a fact — and the rest appear only where a step is in them.
 */
export const PARTS = [
  { key: 'finished', label: 'finished', tone: 'done', text: 't-done', glyph: '✓', always: true },
  { key: 'review', label: 'in review', tone: 'done', text: 't-done', glyph: '✓', always: false },
  {
    key: 'working',
    label: 'working',
    tone: 'working',
    text: 't-working',
    glyph: '●',
    always: true,
  },
  { key: 'wants', label: 'wants you', tone: 'wants', text: 't-wants', glyph: '◆', always: true },
  { key: 'failed', label: 'failed', tone: 'failed', text: 't-failed', glyph: '▲', always: true },
  { key: 'waiting', label: 'waiting', tone: 'queued', text: 't-quiet', glyph: '○', always: true },
  { key: 'parked', label: 'parked', tone: 'quiet', text: 't-quiet', glyph: '◻', always: false },
]

/**
 * A part's mark, as `glyphs.js` shapes one: the glyph a step in it wears, its
 * word, and its text tone. A wait on a step this device cannot see is
 * `unseen`, which is a hollow ring and says so.
 */
export function partMark(part) {
  const one = PARTS.find((each) => each.key === part)
  if (one === undefined) return { glyph: '◌', word: 'not readable here', tone: 't-quiet' }
  return { glyph: one.glyph, word: one.label, tone: one.text }
}

/** A part's chart tone (`charts.js`'s `TONES`); a step out of sight is `unknown`. */
export function toneOfPart(part) {
  return PARTS.find((each) => each.key === part)?.tone ?? 'unknown'
}

/** `stepMark`'s word, as the part of a run it counts towards. */
const PART_OF = {
  finished: 'finished',
  working: 'working',
  blocked: 'wants',
  failed: 'failed',
  review: 'review',
  merged: 'review',
  parked: 'parked',
}

/** Which part one step is in: its mark's word, and `waiting` for everything else. */
export function partOf(step) {
  return PART_OF[stepMark(step).word] ?? 'waiting'
}

/**
 * How many steps are in each part, as a stack's parts — over one run or over
 * every run on the page. A part nobody is in is left out unless it is one of
 * the `always` ones.
 */
export function partsOf(steps) {
  const counts = new Map(PARTS.map((one) => [one.key, 0]))
  for (const step of steps) {
    const part = partOf(step)
    counts.set(part, (counts.get(part) ?? 0) + 1)
  }
  return PARTS.filter((one) => one.always || (counts.get(one.key) ?? 0) > 0).map((one) => ({
    key: one.key,
    label: one.label,
    tone: one.tone,
    n: counts.get(one.key) ?? 0,
  }))
}

/* ── which way a run stands ────────────────────────────────────────────────── */

/**
 * What a run is wearing, loudest first: a step that wants somebody, then one
 * that failed, then one at work; finished only when every step is; and the
 * quiet answers last. A run with no step this device may read says *that*,
 * never *finished* — nought of nought is not done.
 */
export const STANDINGS = {
  wants: { glyph: '◆', word: 'wants you', tone: 't-wants', group: 'needs' },
  failed: { glyph: '▲', word: 'a step failed', tone: 't-failed', group: 'needs' },
  working: { glyph: '●', word: 'working', tone: 't-working', group: 'going' },
  review: { glyph: '✓', word: 'in review', tone: 't-done', group: 'going' },
  waiting: { glyph: '○', word: 'waiting', tone: 't-quiet', group: 'going' },
  finished: { glyph: '✓', word: 'finished', tone: 't-done', group: 'finished' },
  unseen: { glyph: '◌', word: 'not readable here', tone: 't-quiet', group: 'unseen' },
}

/** Which of `STANDINGS` a run wears. */
export function standingOf(run) {
  if (run.steps.length === 0) return 'unseen'
  const parts = new Set(run.steps.map(partOf))
  for (const loud of ['wants', 'failed', 'working']) if (parts.has(loud)) return loud
  if (run.total > 0 && run.finished === run.total) return 'finished'
  const open = run.steps.filter((step) => !step.finished).map(partOf)
  if (open.length > 0 && open.every((one) => one === 'review')) return 'review'
  return 'waiting'
}

/** The mark a run wears: `{ glyph, word, tone }`, as `glyphs.js` shapes one. */
export function runMark(run) {
  const one = STANDINGS[standingOf(run)]
  return { glyph: one.glyph, word: one.word, tone: one.tone }
}

/**
 * The page's groups, in the order they are drawn: what wants a person, what
 * is under way, what is done, and what this device cannot see into. A group
 * with nothing in it is not drawn at all.
 */
export const GROUPS = [
  { key: 'needs', heading: 'NEEDS YOU' },
  { key: 'going', heading: 'UNDER WAY' },
  { key: 'finished', heading: 'FINISHED' },
  { key: 'unseen', heading: 'OUT OF REACH' },
]

/** The runs, each in its group, the order inside a group kept as it came. */
export function groupsOf(runs) {
  const into = new Map(GROUPS.map((one) => [one.key, []]))
  for (const run of runs) into.get(STANDINGS[standingOf(run)].group)?.push(run)
  return GROUPS.map((one) => ({ ...one, runs: into.get(one.key) ?? [] }))
}

/**
 * The numbers the page leads with, over every run on it: how many are under
 * way, how many are finished, how many want somebody — and every step, as
 * parts. Runs nobody here can see into are counted as runs and add no step.
 */
export function overallOf(runs) {
  const standing = runs.map(standingOf)
  const count = (group) => standing.filter((one) => STANDINGS[one].group === group).length
  const steps = runs.flatMap((run) => run.steps)
  return {
    runs: runs.length,
    needs: count('needs'),
    going: count('going'),
    finished: count('finished'),
    unseen: count('unseen'),
    steps: steps.length,
    done: steps.filter((step) => step.finished).length,
    parts: partsOf(steps),
  }
}

/* ── what is happening in a run, now ───────────────────────────────────────── */

/** How loud each part is, for which steps a run's line names first. */
const LOUDNESS = ['wants', 'failed', 'working']

/**
 * What a run's steps are doing, loudest first, as lines a card can draw:
 * every step that wants somebody, has failed or is at work — and, where
 * nothing is, the next step waiting and what it waits on. At most `room` of
 * them, and how many more are left over, so a run of forty is never forty
 * lines on a phone.
 *
 * `said` is the clause after the step's name. A wait names **only what is not
 * finished yet**, because those are what it is actually waiting for; a step
 * whose waits are all finished is `queued`, which is the queue's word, and
 * never *ready* — when it starts is the queue's rule, not this page's guess.
 */
export function nowOf(run, room = 3) {
  const loud = run.steps
    .filter((step) => LOUDNESS.includes(partOf(step)))
    .sort((a, b) => LOUDNESS.indexOf(partOf(a)) - LOUDNESS.indexOf(partOf(b)))
  const lines =
    loud.length > 0
      ? loud
      : run.steps.filter((step) => partOf(step) === 'waiting').sort((a, b) => a.layer - b.layer)
  const names = shortNamesOf(run.steps)
  const shown = lines.slice(0, room).map((step) => ({
    task: step.task,
    name: names.get(step.task) ?? step.name,
    project: step.project,
    part: partOf(step),
    said: clauseOf(step, run),
  }))
  const open = run.steps.filter((step) => !step.finished).length
  return { lines: shown, more: Math.max(0, open - shown.length) }
}

/** The words after a step's name in a `now` line. */
function clauseOf(step, run) {
  const part = partOf(step)
  if (part === 'wants') return 'wants you'
  if (part === 'failed') return 'failed'
  if (part === 'working') return 'working'
  // **A number, never a list of names.** What it waits on is the run's own
  // screen's to name, with why; a card that spelt out three task ids under
  // every step was a paragraph where a figure would do.
  const open = waitsOf(step, run).filter((one) => !one.finished).length
  return open === 0 ? 'queued' : `waits on ${open}`
}

/**
 * What one step waits on, each with whether it has finished — by name where
 * the step it waits on is on this page, and by its task id where it is not
 * (a step in a project this device may not read is still something waited
 * on, and leaving it out would draw a step as free when it is not).
 */
export function waitsOf(step, run) {
  const byTask = new Map(run.steps.map((one) => [one.task, one]))
  const names = shortNamesOf(run.steps)
  return step.waits.map((wait) => {
    const on = byTask.get(wait.task)
    return {
      task: wait.task,
      name: names.get(wait.task) ?? wait.task,
      finished: on?.finished ?? false,
      seen: on !== undefined,
      part: on === undefined ? 'unseen' : partOf(on),
      why: wait.why,
    }
  })
}

/* ── a step's name, without what every step of its run shares ─────────────── */

/** Where a name may be cut: after a word, never inside one. */
const CUTS = ['-', '_', '/', '.', ' ']

/**
 * Each step's name with the front every step of its run shares cut off —
 * `checkout-v2-schema` and `checkout-v2-api` are `schema` and `api` — keyed by
 * task. **Drawing, not renaming**: the cut is at a word's end, only where at
 * least two steps share it and every step keeps a name, and the run's own
 * name is on the same screen, so nothing is lost. A box 184 pixels wide that
 * says `checkout-v2-sche…` five times says nothing.
 */
export function shortNamesOf(steps) {
  const out = new Map(steps.map((step) => [step.task, step.name]))
  if (steps.length < 2) return out
  let shared = steps[0].name
  for (const step of steps) {
    while (!step.name.startsWith(shared)) shared = shared.slice(0, -1)
  }
  const cut = Math.max(...CUTS.map((one) => shared.lastIndexOf(one)))
  if (cut <= 0) return out
  const front = shared.slice(0, cut + 1)
  if (steps.some((step) => step.name.length <= front.length)) return out
  for (const step of steps) out.set(step.task, step.name.slice(front.length))
  return out
}

/* ── which way the graph is drawn ──────────────────────────────────────────── */

/**
 * Which way a run's boxes go in `room` pixels: across, layer after layer,
 * where that fits — which is the picture of a graph people expect — and down
 * where it does not and down does, so a chain of five on a desk is five boxes
 * one under another rather than a strip that scrolls. Where neither fits, the
 * one that leaves less out of sight. Measured with the flow's own geometry
 * (`flowGeometry`), so this cannot disagree with what is drawn.
 */
export function directionFor(graph, room) {
  if (!(room > 0)) return 'right'
  const across = flowGeometry(graph.nodes, graph.edges, 'right').width
  if (across <= room) return 'right'
  const down = flowGeometry(graph.nodes, graph.edges, 'down').width
  if (down <= room) return 'down'
  return across <= down ? 'right' : 'down'
}

/* ── the graph, as boxes and curves ────────────────────────────────────────── */

/** A run as `flowIn` takes a graph: a box per step, an edge per wait it can see. */
export function graphOf(row, names = shortNamesOf(row.steps)) {
  const seen = new Set(row.steps.map((step) => step.task))
  const finished = new Map(row.steps.map((step) => [step.task, step.finished]))
  return {
    nodes: row.steps.map((step) => {
      const part = partOf(step)
      const mark = partMark(part)
      return {
        id: step.task,
        label: names.get(step.task) ?? step.name,
        under: `${step.project} · ${mark.word}`,
        tone: toneOfPart(part),
        glyph: mark.glyph,
        href: taskPath(step.task),
      }
    }),
    edges: row.steps.flatMap((step) =>
      step.waits
        .filter((wait) => seen.has(wait.task))
        .map((wait) => ({
          from: wait.task,
          to: step.task,
          tone: finished.get(wait.task) === true ? 'done' : 'queued',
        })),
    ),
  }
}

/* ── the stages: a run's layers, as a reader counts them ───────────────────── */

/**
 * A run's steps by layer, in the order the map draws them, each layer with how
 * many of its steps have finished. **Numbered from the wire's own `layer`**,
 * so a stage this device cannot see into leaves a gap in the numbers rather
 * than two stages quietly becoming one.
 */
export function stagesOf(run) {
  const order = orderOf(run.steps)
  const layers = [...new Set(run.steps.map((step) => step.layer))].sort((a, b) => a - b)
  return layers.map((layer) => {
    const steps = run.steps
      .filter((step) => step.layer === layer)
      .sort((a, b) => (order.get(a.task) ?? 0) - (order.get(b.task) ?? 0))
    const done = steps.filter((step) => step.finished).length
    return {
      layer,
      name: `Stage ${layer + 1}`,
      said: layer === 0 ? 'can go first' : stageWaits(steps, run),
      steps,
      done,
      part: stagePart(steps),
    }
  })
}

/** What a stage as a whole waits on: the stages its steps' waits are in. */
function stageWaits(steps, run) {
  const layerOf = new Map(run.steps.map((step) => [step.task, step.layer]))
  const before = new Set(
    steps.flatMap((step) => step.waits.map((wait) => layerOf.get(wait.task))).filter(isNumber),
  )
  if (before.size === 0) return 'after steps not on this page'
  return `after ${joined([...before].sort((a, b) => a - b).map((one) => `stage ${one + 1}`))}`
}

/** A stage's own mark: finished when all of it is, its loudest step otherwise. */
function stagePart(steps) {
  if (steps.length > 0 && steps.every((step) => step.finished)) return 'finished'
  const parts = new Set(steps.map(partOf))
  for (const loud of ['wants', 'failed', 'working']) if (parts.has(loud)) return loud
  return 'waiting'
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/* ── the map: a run's graph in dots, for a card ────────────────────────────── */

/**
 * The order of the steps inside each layer, so an edge crosses as little as
 * two sweeps can manage: each step goes where the middle of what it waits on
 * is, and a step waiting on nothing on this page keeps its place.
 */
export function orderOf(steps) {
  const byLayer = new Map()
  for (const step of steps) {
    if (!byLayer.has(step.layer)) byLayer.set(step.layer, [])
    byLayer.get(step.layer).push(step)
  }
  const rowOf = new Map()
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  for (const layer of layers) {
    const list = byLayer.get(layer)
    const centre = new Map(
      list.map((step, at) => {
        const rows = step.waits.map((wait) => rowOf.get(wait.task)).filter(isNumber)
        return [step.task, rows.length === 0 ? at : rows.reduce((a, b) => a + b, 0) / rows.length]
      }),
    )
    list
      .map((step, at) => ({ step, at }))
      .sort((a, b) => centre.get(a.step.task) - centre.get(b.step.task) || a.at - b.at)
      .forEach((one, row) => {
        rowOf.set(one.step.task, row)
      })
  }
  return rowOf
}

/**
 * A run's steps in the order its map reads them — stage by stage, and inside a
 * stage as `orderOf` places them — which is the order its track's segments
 * go in, so the third segment is the third dot.
 */
export function inOrder(steps) {
  const order = orderOf(steps)
  return [...steps].sort(
    (a, b) => a.layer - b.layer || (order.get(a.task) ?? 0) - (order.get(b.task) ?? 0),
  )
}

/** The map's spacing, in the drawing's own units (a CSS pixel at its natural size). */
export const MAP = { dx: 56, dxLeast: 32, dxMost: 160, dy: 26, r: 7, pad: 8 }

/**
 * How far apart a map's columns go in `room` pixels: spread to fill it, so a
 * run of three stages uses the card a run of eight does — but never so far
 * that two dots become a line with nothing on it (`dxMost`), and never so
 * close that the curves between them knot (`dxLeast`, under which the drawing
 * scales down instead). No room known is the natural spacing.
 */
export function spreadOf(columns, room) {
  if (!(room > 0) || columns < 2) return MAP.dx
  const fit = (room - 2 * (MAP.pad + MAP.r)) / (columns - 1)
  return Math.round(Math.max(MAP.dxLeast, Math.min(MAP.dxMost, fit)))
}

/**
 * Where each dot and line of a run's map goes, pure.
 *
 * Columns are the layers this page can see, packed — a run whose middle
 * stage is in a project this device may not read is drawn without a hole,
 * and its edges simply run on to the next column it can see. A line from a
 * finished step is `done` (solid); one from a step not finished yet is
 * `ahead` (dashed), because it is a promise rather than a path yet.
 */
export function mapOf(run, room = 0) {
  const order = orderOf(run.steps)
  const columns = [...new Set(run.steps.map((step) => step.layer))].sort((a, b) => a - b)
  const colOf = new Map(columns.map((layer, at) => [layer, at]))
  const { dy, r, pad } = MAP
  const dx = spreadOf(columns.length, room)
  const dots = run.steps.map((step) => ({
    task: step.task,
    name: step.name,
    part: partOf(step),
    x: pad + r + (colOf.get(step.layer) ?? 0) * dx,
    y: pad + r + (order.get(step.task) ?? 0) * dy,
  }))
  const at = new Map(dots.map((dot) => [dot.task, dot]))
  const finished = new Map(run.steps.map((step) => [step.task, step.finished]))
  const lines = []
  for (const step of run.steps) {
    for (const wait of step.waits) {
      const a = at.get(wait.task)
      const b = at.get(step.task)
      if (a === undefined || b === undefined || a === b) continue
      const x1 = a.x + r + 2
      const x2 = b.x - r - 2
      const mid = (x1 + x2) / 2
      lines.push({
        from: wait.task,
        to: step.task,
        done: finished.get(wait.task) === true,
        d: `M${x1} ${a.y}C${mid} ${a.y} ${mid} ${b.y} ${x2} ${b.y}`,
      })
    }
  }
  const rows = Math.max(1, ...dots.map((dot) => (order.get(dot.task) ?? 0) + 1))
  return {
    dots,
    lines,
    width: dots.length === 0 ? 0 : 2 * (pad + r) + (columns.length - 1) * dx,
    height: dots.length === 0 ? 0 : 2 * (pad + r) + (rows - 1) * dy,
  }
}

/**
 * A dot's shape, as an SVG path centred on it: the same shape its step's
 * glyph has, so a map read without its colour still says which is which — a
 * diamond wants somebody, a triangle failed, a square is parked, and a circle
 * is everything that is simply somewhere along the way.
 */
export function dotPath(dot, r = MAP.r) {
  const { x, y } = dot
  if (dot.part === 'wants')
    return `M${x} ${y - r - 1}L${x + r + 1} ${y}L${x} ${y + r + 1}L${x - r - 1} ${y}Z`
  if (dot.part === 'failed')
    return `M${x} ${y - r - 1}L${x + r + 1} ${y + r}L${x - r - 1} ${y + r}Z`
  if (dot.part === 'parked')
    return `M${x - r + 1} ${y - r + 1}H${x + r - 1}V${y + r - 1}H${x - r + 1}Z`
  return `M${x - r} ${y}A${r} ${r} 0 1 0 ${x + r} ${y}A${r} ${r} 0 1 0 ${x - r} ${y}Z`
}

/** The sentence a map is read as, since its dots are `aria-hidden`. */
export function mapSaid(run) {
  const parts = partsOf(run.steps).filter((one) => one.n > 0)
  const stages = new Set(run.steps.map((step) => step.layer)).size
  const said = parts.map((one) => `${one.n} ${one.label}`).join(', ')
  return `${run.steps.length} ${run.steps.length === 1 ? 'step' : 'steps'} in ${stages} ${
    stages === 1 ? 'stage' : 'stages'
  }${said === '' ? '' : `: ${said}`}`
}

/* ── the sentences: a run and a step in a line ─────────────────────────────── */

/**
 * One run in a line: what is happening, and what it has cost.
 *
 * **Partial completion is a fraction and never a percentage.** "Two of three"
 * is what somebody can act on — the third is the one to go and look at — and a
 * percentage is a figure about a run rather than about a step.
 */
export function runSays(row, view) {
  const active = row.steps.filter((step) => step.active)
  const waiting = row.steps.filter((step) => !step.finished && !step.active)
  const bits = []
  if (active.length > 0) bits.push(`${active.map((step) => step.name).join(', ')} working`)
  else if (waiting.length > 0) bits.push(`${waiting.length} waiting`)
  else if (row.total > 0) bits.push('every step finished')
  if (row.retries > 0)
    bits.push(`${row.retries} delivery ${row.retries === 1 ? 'retry' : 'retries'}`)
  if (row.stamp !== null) bits.push(`${row.stamp.name}@${row.stamp.version}`)
  // **The figure or nothing, never a dash in a list of clauses.** `money`
  // answers with the three dashes apart — not granted, not recorded, nought —
  // and a row's quiet line is the wrong place to say which: the run's own
  // screen has the room and says it there.
  const paid = paidOf(row.usd, view, row.usd !== null && row.usd > 0)
  if (paid.said !== '—') bits.push(paid.said)
  return bits.join(' · ')
}

/**
 * One step in a line: its checks, its review, and **how many agents have been
 * on it**.
 *
 * The last of those is the retry history and there is no counter behind it: it
 * is how many `run_started` lines the journal still holds for this task, so
 * *two* means somebody or something started it again. A figure of one is not
 * worth saying and is left out.
 *
 * **Money is not in it.** A step's figure is beside its name where there is
 * one, and *not granted* is said once, in the run's facts (`costSaid`) —
 * the same three words under every step of a run said nothing the first
 * time did not.
 */
export function stepSays(step) {
  const bits = [`checks ${checkMark(step.checks).word}`]
  if (step.review !== null) bits.push(`review ${reviewMark(step.review).word}`)
  if (step.runs > 1) bits.push(`${step.runs} agents have been on it`)
  if (step.parked) bits.push('set aside')
  return bits.join(' · ')
}

/**
 * What one figure of money says, with **which** dash it is where it is one.
 *
 * `money`'s own three answers, put into the one shape a labelled fact takes:
 * the figure where there is one, and the word for the dash where there is not.
 * Not granted, not recorded and nought are three different mornings.
 */
export function costSaid(usd, view) {
  const paid = paidOf(usd, view, usd !== null)
  return paid.why === '' ? paid.said : `${paid.said} ${paid.why}`
}

/** `money`'s answer for one figure of a run, under this device's grant. */
export function paidOf(usd, view, hasCost = usd !== null) {
  return money({ usd: usd ?? 0, usdEstimated: 0, hasCost }, mayFor(view.store, 'runs.usd'))
}

/**
 * Why a step waits, in words — and **which** nothing it is where there are
 * none: a reason nobody gave, and one this device was not granted, are two
 * different answers to *why is this waiting*.
 */
export function whySaid(wait, view) {
  if (wait.why !== null) return wait.why.more ? `${wait.why.words}…` : wait.why.words
  return mayFor(view.store, 'runs.steps.waits.why') ? 'no reason given' : 'reason not granted'
}

/**
 * A region's state, as `stateBoxIn` takes one: what kind, what it is, and
 * what would change it. One place, so both screens say *nothing* the same way.
 */
export function stateOf(kind, title, line) {
  return { kind, icon: 'runs', title, line }
}
