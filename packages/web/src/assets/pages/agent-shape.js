// One agent's page, its pure half: what the lead, the timeline, the checks,
// the work and the facts say, worked out of what came off the wire — and
// nothing about how any of it is drawn (`agent.js`, `agent-time.js`).
//
// **Nothing here decides a state.** The mark is the window's (`rowMark`), the
// sentence is `deriveState`'s clause verbatim, a check's answer is the
// projection's streak and the rollup at its head is `task.checks`. This only
// places, counts and says — and keeps the two dashes apart: what nobody wrote
// down and what this device was not granted (`mayFor`). Held by
// `test/task-client.test.ts`.

import { mayFor } from '../access.js'
import { ageSaid, duration, money, shortClockOf, tokensSaid } from '../figures.js'
import { checkMark, originSaid, reviewMark, rowMark, stepMark } from '../glyphs.js'
import { pathOf } from '../routes.js'
import { projectAt, runAt, spendFold, spendSince, tasksIn } from '../store.js'

/** How many of its newest check runs the lead's strip draws. */
export const STRIP = 12
/** How many commits a side of the branch's line draws before it says the rest. */
export const DOTS = 8
/** How many moments are listed before the rest fold behind a press. */
export const FOLD = 6
/** The narrowest stretch a timeline covers, so a minute's work is not one smear. */
export const SPAN_MIN = 15 * 60_000

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A region's state, in `stateBoxIn`'s shape — shorthand, which a tooltip check cannot mistake. */
export const stateOf = (kind, title, line = null, icon = undefined) => ({ kind, title, line, icon })

const known = (n) => typeof n === 'number' && Number.isFinite(n)

/* ── the lead: what it is doing now, and whether it needs you ─────────────── */

/**
 * The lead's top line: the mark, `deriveState`'s own clause, what it runs on,
 * and how long since it moved — and how loud the whole line is: `wants` where
 * it is waiting on somebody, `failed` where it stopped wrong, otherwise quiet.
 */
export function nowOf(task, asOf, frozen = false) {
  const mark = rowMark(task)
  const moved = ageSaid(task.movedAt, asOf, frozen)
  const waited = task.approval ? ageSaid(task.approval.since, asOf, frozen) : null
  return {
    mark,
    said: task.reason === '' ? mark.word : task.reason,
    loud: task.mark === 'needs-you' ? 'wants' : task.mark === 'failed' ? 'failed' : null,
    stalled: task.stalled === true,
    runsOn: [task.harness, task.model].filter((one) => one !== null && one !== '').join(' · '),
    moved: moved === null ? null : `${moved} ago`,
    movedSaid: moved === null ? 'never moved' : `moved ${moved} ago`,
    // The tool's **name**, and the command only where the machine sent it — to
    // a device that may answer it, paths shortened and keys taken out there.
    waiting: task.approval
      ? { tool: task.approval.tool, for: waited, command: task.approval.command ?? null }
      : null,
  }
}

/* ── checks ───────────────────────────────────────────────────────────────── */

/** A check's newest answer: the glyph, the word and the tone — the checks page's words. */
export const ANSWERS = {
  fail: { glyph: '✕', word: 'failing', tone: 't-failed' },
  pass: { glyph: '✓', word: 'passing', tone: 't-done' },
  none: { glyph: '—', word: 'no answer', tone: 't-quiet' },
}

/** One run, as a cell: passed green, failed red, skipped or cancelled grey. */
export const CELLS = { pass: 'done', fail: 'failed', other: 'quiet' }

/**
 * The record of runs that is this agent's: its own worktree's, or — where it
 * works in the project's checkout — the checkout's, which is **anybody's** and
 * is said to be. Null where nothing has read the records yet (`read: false`),
 * which is not *nothing ran*.
 */
export function treeOf(task, store) {
  const trees = projectAt(store, task.project)?.checks ?? null
  if (trees === null) return { read: false, tree: null, own: false }
  const own = trees.find((one) => one.task === task.id) ?? null
  if (own !== null) return { read: true, tree: own, own: true }
  const checkout = task.workspace === 'checkout' ? trees.find((one) => one.task === null) : null
  return { read: true, tree: checkout ?? null, own: false }
}

/** How long an answer has stood, `≥` where its row reaches past what is kept. */
function forSaid(streak, asOf, frozen) {
  if (streak === null || streak === undefined) return null
  const since = Date.parse(streak.since)
  if (Number.isNaN(since)) return null
  const said = `${streak.atLeast ? '≥ ' : ''}${duration(Math.max(0, asOf - since))}`
  return frozen ? `${said} at ${shortClockOf(new Date(asOf).toISOString())}` : said
}

/** The middle of how long its timed runs took, or null where none said. */
function typicalOf(runs) {
  const times = runs
    .map((one) => one.ms)
    .filter(known)
    .sort((a, b) => a - b)
  if (times.length === 0) return null
  const mid = Math.floor(times.length / 2)
  const ms = times.length % 2 === 1 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2)
  return ms < 1000 ? '<1s' : duration(ms)
}

/** A strip's sentence, for whoever cannot see the cells. */
export function stripSaid(name, runs) {
  const n = { pass: 0, fail: 0, other: 0 }
  for (const run of runs) n[run.state] = (n[run.state] ?? 0) + 1
  const parts = [
    n.pass > 0 ? `${n.pass} passed` : null,
    n.fail > 0 ? `${n.fail} failed` : null,
    n.other > 0 ? `${n.other} skipped or cancelled` : null,
  ].filter(Boolean)
  if (parts.length === 0) return `${name}: no run with a time`
  return `${name}, the last ${plural(runs.length, 'run')}: ${parts.join(', ')}`
}

/**
 * Every check in its record, failing first: its answer and how long it has
 * said it, the strip of its runs, how long one takes. Optional checks that
 * never said anything go last, where a row of grey hides nothing.
 */
export function tracksOf(tree, asOf, frozen = false) {
  if (tree === null) return []
  const rank = { fail: 0, none: 1, pass: 2 }
  return tree.checks
    .map((track) => {
      const answer = track.streak?.state ?? 'none'
      return {
        key: track.check,
        check: track.check,
        required: track.required,
        answer,
        mark: ANSWERS[answer],
        forSaid: forSaid(track.streak, asOf, frozen),
        row: track.streak?.runs ?? 0,
        typical: typicalOf(track.runs),
        cells: track.runs.map((run) => ({ tone: CELLS[run.state] ?? 'unknown' })),
        said: stripSaid(track.check, track.runs),
        more: track.more,
      }
    })
    .sort(
      (a, b) =>
        Number(b.required) - Number(a.required) ||
        rank[a.answer] - rank[b.answer] ||
        a.check.localeCompare(b.check),
    )
}

/** The rollup at its head in words: the word in its tone, and what is red or not run. */
export function headOf(task) {
  const mark = checkMark(task.checks.state)
  const lines = [
    task.checks.failed.length === 0 ? null : `${task.checks.failed.join(', ')} failing`,
    task.checks.missing.length === 0 ? null : `${task.checks.missing.join(', ')} not run here`,
  ].filter(Boolean)
  return { mark, line: lines.join(' · '), overruled: task.checks.overridden }
}

/**
 * Every run in its record, newest last, as one strip — how its checks have been
 * going lately, whichever check each run was.
 */
export function recentOf(tree, most = STRIP) {
  if (tree === null) return { cells: [], said: 'no runs read', line: null }
  const runs = tree.checks
    .flatMap((track) => track.runs.map((run) => ({ ...run, check: track.check })))
    .filter((run) => !Number.isNaN(Date.parse(run.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-most)
  const passed = runs.filter((run) => run.state === 'pass').length
  return {
    cells: runs.map((run) => ({ tone: CELLS[run.state] ?? 'unknown' })),
    said: stripSaid('its checks', runs),
    line: runs.length === 0 ? null : `${passed} of the last ${runs.length} passed`,
  }
}

/* ── the branch ───────────────────────────────────────────────────────────── */

/**
 * Its branch: how far it is from where it started either way, what is not
 * committed, whether it is offered for review — and the dots the line draws,
 * one a commit up to `DOTS` a side, with the rest said.
 */
export function branchOf(task) {
  const ahead = known(task.ahead) ? task.ahead : null
  const behind = known(task.behind) ? task.behind : null
  const dirty = known(task.dirty) ? task.dirty : null
  const value = task.branch === null ? 'no branch' : ahead === null ? null : `${ahead} ahead`
  const parts = [
    behind === null || behind === 0 ? null : `${behind} behind`,
    dirty === null || dirty === 0 ? null : `${dirty} uncommitted`,
  ].filter(Boolean)
  const even = ahead === 0 && (behind ?? 0) === 0 && (dirty ?? 0) === 0
  const review = task.review
    ? reviewMark(task.review.state)
    : (ahead ?? 0) > 0
      ? { glyph: '○', word: 'not offered', tone: 't-quiet' }
      : null
  return {
    name: task.branch,
    value,
    under:
      task.branch === null
        ? null
        : ahead === null
          ? 'not compared'
          : even
            ? 'even with where it started'
            : parts.join(' · ') || null,
    ahead: Math.min(ahead ?? 0, DOTS),
    behind: Math.min(behind ?? 0, DOTS),
    moreAhead: Math.max(0, (ahead ?? 0) - DOTS),
    moreBehind: Math.max(0, (behind ?? 0) - DOTS),
    review,
    where: task.shared
      ? 'shared checkout'
      : task.workspace === 'worktree'
        ? 'own worktree'
        : 'checkout',
  }
}

/* ── money ────────────────────────────────────────────────────────────────── */

/**
 * What it cost, the period that covers, and its share of what its project
 * cost in that period — the one comparison that says whether this is the
 * expensive one. A dash says which dash it is.
 */
export function spendOf(task, store) {
  const granted = mayFor(store, 'tasks.spend')
  const folded = task.spend === null || task.spend === undefined ? null : spendFold([task])
  const paid = money(folded, granted)
  const toks = tokensSaid(folded)
  const since = spendSince(store)
  const whole = spendFold(tasksIn(store, task.project))
  const share =
    paid.said === '—' || folded === null || whole.usd <= 0 ? null : (100 * folded.usd) / whole.usd
  return {
    value: paid.said === '—' ? null : paid.said,
    why: paid.why,
    tokens: toks === null ? null : `${toks.said} tokens`,
    since: since === null ? null : `since ${shortClockOf(since)}`,
    share,
    shareSaid: share === null ? null : `${Math.round(share)}% of ${task.project}`,
  }
}

/* ── the run ──────────────────────────────────────────────────────────────── */

/** A step's mark's tone, as `steps` names the place it stands on the line. */
const STEP_STATES = {
  't-done': 'done',
  't-failed': 'failed',
  't-wants': 'wants',
  't-working': 'now',
}

/** A step's place on the line: `stepMark`'s answer, so a step and its row never disagree. */
function stepState(step) {
  const tone = stepMark(step).tone
  return STEP_STATES[tone] ?? (step.parked ? 'skipped' : 'next')
}

/**
 * The run it is part of, every step on one line and this one said to be — or
 * null for work on its own. A run nobody sent (`row` null) still has a name.
 */
export function runOf(task, store) {
  const effort = task.effort ?? null
  if (effort === null) return null
  const row = runAt(store, effort)
  const steps =
    row === null
      ? []
      : row.steps.map((step) => ({
          key: step.task,
          label: step.name,
          state: stepState(step),
          under: step.task === task.id ? 'this one' : '',
          mine: step.task === task.id,
        }))
  return {
    name: effort,
    href: pathOf({ view: 'run', run: effort }),
    value: row === null ? null : `${row.finished} of ${row.total} done`,
    share: row === null || row.total === 0 ? null : (100 * row.finished) / row.total,
    steps,
  }
}

/* ── the facts ────────────────────────────────────────────────────────────── */

/**
 * When it counts as finished, in `DONE_RULE_MEANS`' own words — copied, because
 * a browser cannot import a `.ts` file, and held equal by `task-client.test.ts`.
 */
export const DONE_SAID = {
  said: 'its agent says so',
  idle: 'its agent ends a turn with nothing waiting',
  committed: 'its agent stops with everything committed',
  merged: 'its branch is merged into the base',
  manual: 'somebody marks it finished',
}

const LANE_SAID = { running: 'running', stopped: 'stopped, can reopen', none: 'none' }

/**
 * What is true of it that is not the work: what it runs on and as whom, who
 * asked, when it counts as done, where it works. A cell for each, a dash where
 * unknown, and *not granted* where that is why.
 */
export function aboutOf(task, store, asOf, frozen = false) {
  const account = mayFor(store, 'tasks.account') ? (task.account?.words ?? null) : 'not granted'
  const made = ageSaid(task.createdAt, asOf, frozen)
  const produces = task.produces ?? null
  return [
    { label: 'Harness', value: task.harness, under: task.model },
    { label: 'Account', value: account },
    { label: 'Asked by', value: originSaid(task.origin) },
    { label: 'Done when', value: task.done === null ? null : (DONE_SAID[task.done] ?? task.done) },
    {
      label: 'Workspace',
      value: task.shared ? 'shared checkout' : task.workspace,
      under: task.shared ? 'nobody’s work until it is committed' : null,
    },
    { label: 'Agent', value: LANE_SAID[task.lane] ?? task.lane },
    { label: 'Made', value: made === null ? null : `${made} ago` },
    {
      label: 'Produces',
      value: produces === null ? 'nothing named' : produces.name,
      under: produces === null ? null : produces.written ? 'written' : 'not yet',
    },
  ]
}

/** The judge's findings about it, counted. */
export function findingsOf(task, store) {
  if (!mayFor(store, 'findings')) return { may: false, n: 0, said: null }
  const n = [...store.rows.findings.values()].filter((one) => one.tasks.includes(task.id)).length
  return { may: true, n, said: n === 0 ? null : plural(n, 'finding') }
}

/* ── the timeline ─────────────────────────────────────────────────────────── */

/**
 * What each kind of moment looks like: a glyph and a tone in the list, a lane
 * and a mark's tone on the chart. An ordinary moment's mark is the lighter
 * grey (`queued`), which holds 3:1 against the track; the darker one does not.
 */
export const MOMENTS = {
  made: { glyph: '+', tone: 't-quiet', lane: 'agent', mark: 'queued' },
  state: { glyph: '◆', tone: 't-here', lane: null, mark: null },
  started: { glyph: '▶', tone: 't-working', lane: 'agent', mark: null },
  stopped: { glyph: '■', tone: 't-quiet', lane: 'agent', mark: null },
  turn: { glyph: '↺', tone: 't-quiet', lane: 'turns', mark: 'queued' },
  used: { glyph: '⌸', tone: 't-quiet', lane: 'tools', mark: 'queued' },
  asked: { glyph: '?', tone: 't-wants', lane: 'tools', mark: 'wants' },
  allowed: { glyph: '✓', tone: 't-done', lane: 'tools', mark: 'done' },
  refused: { glyph: '✕', tone: 't-failed', lane: 'tools', mark: 'failed' },
  checked: { glyph: '✓', tone: 't-quiet', lane: 'checks', mark: 'queued' },
  committed: { glyph: '●', tone: 't-working', lane: 'commits', mark: 'working' },
  finished: { glyph: '✓', tone: 't-done', lane: 'agent', mark: 'done' },
  told: { glyph: '✎', tone: 't-quiet', lane: 'turns', mark: 'queued' },
  failed: { glyph: '▲', tone: 't-failed', lane: 'agent', mark: 'failed' },
}

/** The lanes, in the order they are drawn. */
export const LANES = [
  { key: 'agent', label: 'Agent' },
  { key: 'turns', label: 'Turns' },
  { key: 'tools', label: 'Tools' },
  { key: 'checks', label: 'Checks' },
  { key: 'commits', label: 'Commits' },
]

/** When a moment was, as a person says it: the time today, the weekday this week. */
export function whenSaid(at, asOf) {
  const when = new Date(at)
  if (Number.isNaN(when.getTime())) return '—'
  const iso = when.toISOString()
  if (when.toDateString() === new Date(asOf).toDateString()) return shortClockOf(iso)
  const day = when.toLocaleDateString(undefined, { weekday: 'short' })
  return asOf - when.getTime() < 6 * 86_400_000
    ? `${day} ${shortClockOf(iso)}`
    : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * Its activity and its check runs over one stretch of time, as `lanesIn`
 * takes them: a lane each for the agent running, its turns, the tools it was
 * let use or asked about, its checks and its commits, from the oldest moment
 * the machine sent to now.
 *
 * **Checks are the record's when the record is its own**, because a run says
 * whether it passed and a moment of activity does not; in a checkout shared
 * with others the record is anybody's, so its own moments are drawn instead,
 * quiet. A span with no start in what was sent ran from before the stretch,
 * and one with no end is running now.
 */
export function timelineOf(answer, task, tree, own, asOf) {
  const moments = (answer?.activity ?? [])
    .map((one) => ({ ...one, ms: Date.parse(one.at) }))
    .filter((one) => !Number.isNaN(one.ms))
    .sort((a, b) => a.ms - b.ms)
  const made = Date.parse(task.createdAt)
  const oldest = moments[0]?.ms ?? null
  // From its making where everything since is here, else from the oldest
  // moment that is: the stretch is what was sent, and no wider.
  const start = oldest === null || answer?.more ? oldest : Math.min(oldest, made)
  const from = Math.min(known(start) ? start : asOf, asOf - SPAN_MIN)
  const to = asOf
  const when = (ms) => whenSaid(new Date(ms).toISOString(), asOf)

  const at = Object.fromEntries(LANES.map((one) => [one.key, { spans: [], marks: [] }]))
  let open = null
  for (const one of moments) {
    const look = MOMENTS[one.kind]
    if (look === undefined) continue
    if (one.kind === 'started') {
      open = open ?? one.ms
    } else if (one.kind === 'stopped') {
      const began = open ?? from
      at.agent.spans.push({
        from: began,
        to: one.ms,
        tone: 'working',
        said: `ran ${when(began)} to ${when(one.ms)}`,
      })
      open = null
    } else if (look.lane !== null && !(one.kind === 'checked' && own)) {
      at[look.lane].marks.push({
        at: one.ms,
        tone: look.mark,
        said: `${one.said} at ${when(one.ms)}`,
      })
    }
  }
  // Running now: from its start, or from before the stretch where the start
  // is not in what was sent. A start with no stop under a lane that is not
  // running ended when it was last heard of, and is never drawn as running.
  const running = task.lane === 'running'
  if (open !== null || (running && at.agent.spans.length === 0)) {
    const began = open ?? from
    const ended = running ? null : (moments.at(-1)?.ms ?? began)
    at.agent.spans.push({
      from: began,
      to: ended,
      tone: 'working',
      said:
        ended === null ? `running since ${when(began)}` : `ran ${when(began)} to ${when(ended)}`,
    })
  }
  for (const track of own && tree !== null ? tree.checks : []) {
    for (const run of track.runs) {
      const ms = Date.parse(run.at)
      if (Number.isNaN(ms) || ms < from || ms > to) continue
      const word = run.state === 'pass' ? 'passed' : run.state === 'fail' ? 'failed' : 'skipped'
      at.checks.marks.push({
        at: ms,
        tone: CELLS[run.state] ?? 'unknown',
        said: `${track.check} ${word} at ${when(ms)}`,
      })
    }
  }

  const mid = from + (to - from) / 2
  return {
    from,
    to,
    now: to,
    ticks: [
      { at: from, said: when(from) },
      { at: mid, said: when(mid) },
      { at: to, said: 'now' },
    ],
    lanes: LANES.map((lane) => {
      const got = at[lane.key]
      const n = got.marks.length
      const label =
        lane.key === 'agent'
          ? got.spans.length === 0
            ? 'Agent · not running'
            : 'Agent'
          : `${lane.label} · ${n === 0 ? 'none' : n}`
      return { key: lane.key, label, spans: got.spans, marks: got.marks, n }
    }),
    moments: moments.length,
    span: duration(to - from),
  }
}

/**
 * The moments, newest first and each with a key of its own — two moments of
 * one kind in one second are two rows — and the glyph and tone each is drawn in.
 */
export function momentsOf(answer) {
  const seen = new Map()
  return (answer?.activity ?? []).map((one) => {
    const base = `${one.at}|${one.kind}|${one.said}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const look = MOMENTS[one.kind] ?? { glyph: '·', tone: 't-quiet' }
    return { key: `${base}|${n}`, at: one.at, said: one.said, glyph: look.glyph, tone: look.tone }
  })
}

/** A count said the way the fold's press says it. */
export function foldSaid(hidden, open) {
  return open ? 'Show fewer' : `Show ${plural(hidden, 'earlier moment')}`
}
