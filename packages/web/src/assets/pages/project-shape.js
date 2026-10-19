// One project's figures: the lead, the agents, the queue as a graph, the
// checks at each branch's HEAD, the branches, the findings and the money — as
// pure folds over the store, so every count and word on the project's page is
// a test rather than a picture (`test/project-client.test.ts`).
//
// **Nothing here derives a state.** An agent's mark is the window's `markOf`,
// carried on the row; a check's rollup is `deriveState`'s; queued work stands
// where `queueStateOf` put it and its words are `describeQueueState`'s
// (`queueMark`, `queueLine`); a finding's standing is `findingMark`'s. This
// counts what came off the wire, groups it the way the page draws it, and
// words it — with a dash and *which* dash where a figure could not be read.
//
// Nothing here touches the DOM.

import { mayFor } from '../access.js'
import { money, onPlan, shortClockOf, tokensSaid } from '../figures.js'
import { findingMark, joined, queueMark, reviewMark, rowMark } from '../glyphs.js'
import { pathOf, taskPath } from '../routes.js'
import {
  checksFold,
  findingsOf,
  projectAt,
  queueIn,
  spendFold,
  spendSince,
  tasksIn,
  wantsYou,
} from '../store.js'
import { queueAt } from '../tree.js'

/* ── the agents ───────────────────────────────────────────────────────────── */

/**
 * The parts the ring is made of, in the order they read: what wants somebody,
 * then what works, then what is over. `marks` are the window's own words
 * (`AGENT_MARKS`); stopped and parked are one part, *set aside*, because
 * neither is doing anything and neither is finished.
 */
export const AGENT_PARTS = [
  { key: 'wants', label: 'needs you', tone: 'wants', marks: ['needs-you'] },
  { key: 'failed', label: 'failed', tone: 'failed', marks: ['failed'] },
  { key: 'working', label: 'working', tone: 'working', marks: ['working'] },
  { key: 'idle', label: 'idle', tone: 'queued', marks: ['idle'] },
  { key: 'done', label: 'finished', tone: 'done', marks: ['done'] },
  { key: 'aside', label: 'set aside', tone: 'quiet', marks: ['stopped', 'parked'] },
]

/** The parts still in play: a row in one of these is drawn; the rest fold away. */
const IN_PLAY = ['wants', 'failed', 'working', 'idle']

/** Which part a task's mark is, by the window's mark — or `aside` for a word nothing here knows. */
export function partOf(task) {
  const mark = task?.mark
  return AGENT_PARTS.find((part) => part.marks.includes(mark))?.key ?? 'aside'
}

/**
 * A project's agents: every task that is not queued work (that is the queue's,
 * below), in the order they were made — **never sorted by state**, the side's
 * rule, because a list that reorders itself when an agent goes quiet moves the
 * row somebody was reaching for. Split in two: what is still in play, and what
 * is finished or set aside, which the page folds away.
 */
export function agentsOf(tasks) {
  const listed = tasks
    .filter((task) => task.state !== 'queued')
    .sort((a, b) => byText(a.createdAt ?? '', b.createdAt ?? '') || byText(a.name, b.name))
  return {
    live: listed.filter((task) => IN_PLAY.includes(partOf(task))),
    over: listed.filter((task) => !IN_PLAY.includes(partOf(task))),
    all: listed,
  }
}

/** The ring's parts and its middle: `{ parts: [{ key, label, n, tone }], n, stalled }`. */
export function ringOf(agents) {
  const parts = AGENT_PARTS.map((part) => ({
    key: part.key,
    label: part.label,
    tone: part.tone,
    n: agents.filter((task) => partOf(task) === part.key).length,
  }))
  const stalled = agents.filter((task) => partOf(task) === 'working' && task.stalled).length
  return { parts, n: agents.length, stalled }
}

/* ── what wants somebody ───────────────────────────────────────────────────── */

/**
 * What is waiting on a person in this project, and how it divides — out of
 * the window's own *needs you* (`wantsYou`), which counts held queued work
 * too: an overlap nobody has decided about is a decision, like an approval.
 */
export function wantsOf(store, project) {
  const rows = wantsYou(store).filter((task) => task.project === project)
  const approvals = rows.filter((task) => task.approval !== null && task.approval !== undefined)
  const questions = rows.filter((task) => !approvals.includes(task) && task.question === true)
  const held = rows.filter(
    (task) => !approvals.includes(task) && !questions.includes(task) && task.state === 'queued',
  )
  const rest = rows.length - approvals.length - questions.length - held.length
  return {
    rows,
    n: rows.length,
    said: partsSaid(
      [approvals.length, 'approval', 'approvals'],
      [questions.length, 'question', 'questions'],
      [held.length, 'held in the queue'],
      [rest, 'to decide'],
    ),
  }
}

/** The tasks whose agent failed: the window's own mark, red, and somebody's to look at. */
export function failedOf(tasks) {
  return tasks.filter((task) => task.mark === 'failed')
}

/* ── the checks at each branch's HEAD ──────────────────────────────────────── */

/**
 * The checks, as counts and a word **only where there is nothing left to be
 * unsure about** — a check nobody ran here is not a check that passed. Over the
 * agents (queued work has no commit of its own yet).
 *
 * `red` and `unrun` are the rows the page lists; the green fold into a count,
 * because a branch that is green is not one anybody needs to look at.
 */
export function checksOf(agents) {
  const fold = checksFold(agents)
  const total = fold.pass + fold.fail + fold.unknown
  const red = agents.filter((task) => task.checks?.state === 'fail')
  const unrun = agents.filter((task) => task.checks?.state === 'unknown')
  const green = agents.filter((task) => task.checks?.state === 'pass')
  return {
    pass: fold.pass,
    fail: fold.fail,
    unknown: fold.unknown,
    total,
    red,
    unrun,
    green,
    figure:
      total === 0
        ? 'no work'
        : fold.fail > 0
          ? `${fold.fail} red`
          : fold.unknown === 0
            ? 'all green'
            : `${fold.pass} of ${total} green`,
    tone: fold.fail > 0 ? 'failed' : total > 0 && fold.unknown === 0 ? 'done' : null,
    parts: [
      { key: 'pass', label: 'green', n: fold.pass, tone: 'done' },
      { key: 'fail', label: 'red', n: fold.fail, tone: 'failed' },
      { key: 'unknown', label: 'not run here', n: fold.unknown, tone: 'unknown' },
    ],
  }
}

/**
 * A branch's checks that want a look, in words: which, by the names the
 * project's own hook and workflows give them, and whether a red run was
 * overruled — which leaves it red.
 */
export function checkSaid(checks) {
  const named = checks.state === 'fail' ? checks.failed : checks.missing
  const word = checks.state === 'fail' ? 'red' : 'not run here'
  const over = checks.overridden ? ' · overruled' : ''
  return named.length === 0 ? `${word}${over}` : `${word}: ${joined(named)}${over}`
}

/* ── the queue, as a graph ─────────────────────────────────────────────────── */

/** Queued work's standings, in the order a reader asks about them, each its legend's tone. */
const STANDINGS = [
  { key: 'ready', label: 'ready', tone: 'working' },
  { key: 'waiting', label: 'waiting', tone: 'queued' },
  { key: 'held', label: 'held', tone: 'failed' },
  { key: 'scheduled', label: 'scheduled', tone: 'quiet' },
  { key: 'paused', label: 'paused', tone: 'quiet' },
]

/**
 * The queue's figure and how it divides. Ready and waiting are always in the
 * legend — they are what a queue is — and the other three only where some
 * piece stands there, so a legend of five is not mostly noughts.
 */
export function queueOf(rows) {
  const parts = STANDINGS.map((one) => ({
    ...one,
    n: rows.filter((row) => row.state?.kind === one.key).length,
  })).filter((one) => one.n > 0 || one.key === 'ready' || one.key === 'waiting')
  const ready = parts.find((one) => one.key === 'ready')?.n ?? 0
  return {
    n: rows.length,
    ready,
    figure: rows.length === 0 ? 'empty' : `${rows.length} queued`,
    parts,
  }
}

/**
 * Every task id a queued piece names as one it waits on: its edges, and its
 * standing's own list — `tree.js`'s reading of the same row.
 */
export function waitsOn(row) {
  const named = (row.waitsOn ?? []).map((one) => one.task)
  if (row.state?.kind === 'waiting') named.push(...row.state.on)
  if (row.state?.kind === 'held' && typeof row.state.on === 'string') named.push(row.state.on)
  return [...new Set(named)]
}

/** A task id with this project's own name taken off: the page is the project's already. */
export function shortName(id, project) {
  return id.startsWith(`${project}/`) ? id.slice(project.length + 1) : id
}

/**
 * The queue as a graph for `flowIn`: a box per queued piece, a box per piece
 * of work one of them waits on that is not itself queued — an agent still
 * working, a branch in review, work in another project — and an edge from
 * what is waited on to what waits.
 *
 * An edge out of queued work is a promise (dashed, `queued`); one out of work
 * already under way is a path. Every box is a link to its task. What a piece
 * waits on that is on no row this device holds is still drawn — named, with
 * its mark unknown — because an edge to nothing reads as work that is free to
 * start.
 */
export function graphOf(store, project, clock = shortClockOf) {
  const rows = queueIn(store, project)
  const queued = new Set(rows.map((row) => row.task))
  const tasks = new Map(tasksIn(store, project).map((task) => [task.id, task]))
  const nodes = []
  const edges = []
  const anchors = new Map()
  for (const row of rows) {
    const mark = queueMark(row.state)
    nodes.push({
      id: row.task,
      label: shortName(row.task, project),
      under: queueAt(row.state, clock) || mark.word,
      tone: TONE_OF[mark.tone] ?? 'queued',
      glyph: mark.glyph,
      href: taskPath(row.task),
    })
    for (const id of waitsOn(row)) {
      edges.push({ from: id, to: row.task, tone: queued.has(id) ? 'queued' : null })
      if (queued.has(id) || anchors.has(id)) continue
      const task = tasks.get(id) ?? store.rows.tasks.get(id) ?? null
      const drawn = task === null ? null : rowMark(task)
      anchors.set(id, {
        id,
        label: shortName(id, project),
        // Every task this device reads is on it, so one that is not is in a
        // project it was not given, or gone: the agent page's own words.
        under: drawn === null ? 'not on this device' : drawn.word,
        tone: drawn === null ? 'unknown' : (TONE_OF[drawn.tone] ?? 'quiet'),
        glyph: drawn === null ? '?' : drawn.glyph,
        href: taskPath(id),
      })
    }
  }
  return { nodes: [...anchors.values(), ...nodes], edges }
}

/**
 * The queue's tree (`queueTree`) flattened in reading order — a piece, then
 * what waits on it — each with how deep it hangs, for the outline a phone has
 * where a desk has the graph.
 */
export function outlineOf(tree) {
  const out = []
  const walk = (list, depth) => {
    for (const one of list) {
      out.push({ row: one.row, depth })
      walk(one.children, depth + 1)
    }
  }
  walk(tree, 0)
  return out
}

/** A glyph's tone class, as the word the charts tone with. */
const TONE_OF = {
  't-wants': 'wants',
  't-failed': 'failed',
  't-working': 'working',
  't-done': 'done',
  't-quiet': 'quiet',
}

/* ── the branches: what is committed and where it stands ───────────────────── */

/**
 * Every agent's branch: how far ahead of and behind where it started, how
 * much is not committed, and whether it is offered for merge. A branch that
 * is merged and has nothing ahead is over, and folds away.
 *
 * `review` is the forge's word; *not offered* is a branch with work on it
 * nobody asked to have looked at, which is the one worth seeing
 * (`reviewsOf`'s second list).
 */
export function branchesOf(agents) {
  const all = agents
    .filter((task) => typeof task.branch === 'string' && task.branch !== '')
    .map((task) => ({
      id: task.id,
      name: task.name,
      branch: task.branch,
      ahead: task.ahead ?? null,
      behind: task.behind ?? null,
      dirty: task.dirty ?? null,
      review: task.review?.state ?? null,
      href: taskPath(task.id),
      offered: task.review !== null && task.review !== undefined,
    }))
  const over = all.filter((one) => one.review === 'merged' && (one.ahead ?? 0) === 0)
  const live = all.filter((one) => !over.includes(one))
  const ahead = live.reduce((sum, one) => sum + Math.max(0, one.ahead ?? 0), 0)
  const unknown = live.filter((one) => one.ahead === null).length
  const count = (state) => all.filter((one) => one.review === state).length
  const unoffered = live.filter((one) => !one.offered && (one.ahead ?? 0) > 0).length
  return {
    live,
    over,
    ahead,
    unknown,
    // The longest arm either way, so every branch's bars are drawn to one scale.
    most: Math.max(1, ...live.map((one) => Math.max(one.ahead ?? 0, one.behind ?? 0))),
    figure: all.length === 0 ? 'no branch' : `${unknown > 0 ? '≥' : ''}${ahead} ahead`,
    said:
      all.length === 0
        ? ''
        : `${unknown > 0 ? '≥' : ''}${ahead} ${ahead === 1 ? 'commit' : 'commits'} ahead`,
    parts: [
      { key: 'open', label: 'in review', n: count('open'), tone: 'working' },
      { key: 'draft', label: 'draft', n: count('draft'), tone: 'queued' },
      { key: 'merged', label: 'merged', n: count('merged'), tone: 'done' },
      { key: 'unoffered', label: 'not offered', n: unoffered, tone: 'quiet' },
    ],
  }
}

/**
 * How long one arm of a branch's bar is, out of a hundred: the square root of
 * its share of the longest, so a branch thirty behind does not flatten every
 * other one into a dot. The figures beside it are exact.
 */
export function armOf(n, most) {
  if (n === null || n === undefined || n <= 0 || most <= 0) return 0
  return Math.round(Math.sqrt(Math.min(n, most) / most) * 100)
}

/**
 * A branch's line beside its bar. Noughts are left out, so it stays one line
 * on a phone, and a branch neither ahead nor behind with nothing changed says
 * so in words; ahead that nobody could compare is *cannot tell*, never nought.
 */
export function branchSaid(one) {
  const parts = [
    one.ahead === null ? 'ahead: cannot tell' : one.ahead > 0 ? `${one.ahead} ahead` : null,
    (one.behind ?? 0) > 0 ? `${one.behind} behind` : null,
    (one.dirty ?? 0) > 0 ? `${one.dirty} changed` : null,
  ].filter(Boolean)
  return parts.length === 0 ? 'level with where it started' : parts.join(' · ')
}

/**
 * Whether a branch is offered for review, as its pill says it — the forge's
 * word, *not offered* for work ahead that nobody asked to have looked at, or
 * null for a branch with nothing to offer. A quiet word (draft, closed) takes
 * no tone: the quiet grey is under AA at a pill's size on a wash of itself.
 */
export function reviewOf(one) {
  if (one.review === null || one.review === undefined) {
    return (one.ahead ?? 0) > 0 ? { word: 'not offered', tone: '' } : null
  }
  const mark = reviewMark(one.review)
  return { word: mark.word, tone: mark.tone === 't-quiet' ? '' : mark.tone }
}

/* ── the findings ──────────────────────────────────────────────────────────── */

/** Whose move a finding is: a person's, an agent's, or nobody's any more. */
const FINDING_PARTS = [
  { key: 'read', label: 'to read', tone: 'wants' },
  { key: 'open', label: 'not answered', tone: 'working' },
  { key: 'confirmed', label: 'confirmed', tone: 'failed' },
  { key: 'cleared', label: 'false positive', tone: 'done' },
]

/** Which of `FINDING_PARTS` a finding is: `findingMark`'s reading, as a key. */
export function findingPart(finding) {
  if (finding.verdict !== null && finding.verdict !== undefined) {
    return finding.verdict.was === 'confirmed' ? 'confirmed' : 'cleared'
  }
  return finding.accounted ? 'read' : 'open'
}

/**
 * This project's findings, whose move first and the likeliest first inside
 * that; the ones nobody needs to read again (a false positive) fold away.
 * `may` is false where this device was not granted findings, which is not
 * *none*.
 */
export function findingsIn(store, project) {
  const may = mayFor(store, 'findings')
  const order = (one) => FINDING_PARTS.findIndex((part) => part.key === findingPart(one))
  const rows = findingsOf(store)
    .filter((one) => one.project === project)
    .sort((a, b) => order(a) - order(b) || b.probability - a.probability || byText(a.key, b.key))
    .map((one) => ({
      ...one,
      mark: findingMark(one),
      href: one.tasks.length > 0 ? taskPath(one.tasks[0]) : pathOf({ view: 'findings' }),
    }))
  const parts = FINDING_PARTS.map((part) => ({
    ...part,
    n: rows.filter((one) => findingPart(one) === part.key).length,
  }))
  const read = parts[0].n
  const open = parts[1].n
  return {
    may,
    live: rows.filter((one) => findingPart(one) !== 'cleared'),
    over: rows.filter((one) => findingPart(one) === 'cleared'),
    n: rows.length,
    figure: !may
      ? null
      : read > 0
        ? `${read} to read`
        : open > 0
          ? `${open} not answered`
          : rows.length === 0
            ? 'none'
            : 'all read',
    tone: may && read > 0 ? 'wants' : null,
    parts,
  }
}

/* ── the money ─────────────────────────────────────────────────────────────── */

/** How many agents the money names, largest first. */
export const TOP = 5

/**
 * What this project's work cost, since when, how it divides, and which agents
 * spent most of it.
 *
 * `value` is null where there is no figure — not granted, or nobody wrote it
 * down — and `why` says which (`money`'s two words). A sum over a snapshot that
 * left tasks out is a floor and says `≥`. What a plan's turns would have cost
 * at list is said apart and is in no total.
 */
export function moneyOf(store, project) {
  const granted = mayFor(store, 'tasks.spend')
  const row = projectAt(store, project)
  const tasks = tasksIn(store, project)
  const partial = row !== null && row.counts.shown < row.counts.tasks
  const fold = spendFold(tasks, partial)
  const paid = money(fold, granted)
  const known = paid.said !== '—'
  const since = spendSince(store)
  const toks = granted ? tokensSaid(fold) : null
  const plan = granted ? onPlan(fold) : null
  const top = granted
    ? tasks
        .filter((task) => task.spend?.hasCost === true && task.spend.usd > 0)
        .sort((a, b) => b.spend.usd - a.spend.usd || byText(a.id, b.id))
        .slice(0, TOP)
        .map((task) => ({
          key: task.id,
          label: task.name,
          value: task.spend.usd,
          said: spentSaid(task.spend),
          href: taskPath(task.id),
          // Money is not a state: a quiet bar, never one in Tade's own amber.
          tone: 'queued',
        }))
    : []
  return {
    granted,
    value: known ? `${partial ? '≥' : ''}${paid.said}` : null,
    why: paid.why,
    since: since === null ? null : shortClockOf(since),
    tokens: toks === null ? null : toks.said,
    unpriced: toks === null || toks.unpriced === '' ? null : toks.unpriced,
    exact: granted && fold.usdExact > 0 ? `$${fold.usdExact.toFixed(2)}` : null,
    estimated: granted && fold.usdEstimated > 0 ? `~$${fold.usdEstimated.toFixed(2)}` : null,
    plan,
    unreported: granted ? fold.unknown : 0,
    partial,
    top,
  }
}

/**
 * One agent's money, for its row: `~` where any of it was estimated, and null
 * where nothing was recorded or this device was not granted it — **never a
 * nought**; the money's own section says which.
 */
export function spentSaid(spend) {
  if (spend === null || spend === undefined || spend.hasCost !== true) return null
  return `${spend.usdEstimated > 0 ? '~' : ''}$${spend.usd.toFixed(2)}`
}

/* ── words ─────────────────────────────────────────────────────────────────── */

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** `2 approvals · 1 question`, leaving out what is nought. */
export function partsSaid(...parts) {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : (many ?? one)}`)
    .join(' · ')
}
