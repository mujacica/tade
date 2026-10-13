// The checks page's pure half: what each project's run records add up to, in
// the order a person wants them — what is red and since when first, then every
// check's history, then each agent's head — and the words for all of it.
//
// **Nothing here decides a state.** How long a check has answered what it
// answers now is the projection's (`streak`, over every run kept), and what is
// red at a head is the rollup's (`task.checks`). This only sorts, counts and
// says: a check's newest answer, a strip of its runs, and the two kinds of
// green kept apart — *its last run passed* is never *this commit passed*.

import { duration, shortClockOf } from '../figures.js'
import { pathOf, taskPath } from '../routes.js'

/** A check's newest answer, as the page says it: the glyph, the word and the tone. */
export const ANSWERS = {
  fail: { glyph: '✕', word: 'failing', tone: 't-failed' },
  pass: { glyph: '✓', word: 'passing', tone: 't-done' },
  none: { glyph: '—', word: 'no answer', tone: 't-quiet' },
}

/** One run, as a cell: passed green, failed red, skipped or cancelled grey. */
export const CELLS = {
  pass: { tone: 'done', word: 'passed' },
  fail: { tone: 'failed', word: 'failed' },
  other: { tone: 'quiet', word: 'skipped or cancelled' },
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The newest answer of one track: `fail`, `pass` or `none` for nothing that said either. */
export function answerOf(track) {
  return track.streak?.state ?? 'none'
}

/** The name a tree is shown by: the project's checkout, or the task whose worktree it is. */
export function treeName(tree) {
  if (tree.task === null) return 'checkout'
  const cut = tree.task.indexOf('/')
  return cut < 0 ? tree.task : tree.task.slice(cut + 1)
}

/**
 * When something began, as a person says it: the time today, the weekday this
 * week, the date before that. `asOf` is the clock the page counts against.
 */
export function whenSaid(at, asOf) {
  const when = new Date(at)
  if (Number.isNaN(when.getTime())) return '—'
  const now = new Date(asOf)
  const sameDay = when.toDateString() === now.toDateString()
  if (sameDay) return shortClockOf(at)
  const days = (asOf - when.getTime()) / 86_400_000
  if (days < 6) {
    const day = when.toLocaleDateString(undefined, { weekday: 'short' })
    return `${day} ${shortClockOf(at)}`
  }
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * How long an answer has stood, `≥` where its row reaches back past what is
 * kept — and, while the stream is not live, the moment it was last true, so a
 * dead snapshot never counts up (`ageSaid`'s rule).
 */
export function forSaid(streak, asOf, frozen = false) {
  if (streak === null || streak === undefined) return null
  const since = Date.parse(streak.since)
  if (Number.isNaN(since)) return null
  const said = `${streak.atLeast ? '≥ ' : ''}${duration(Math.max(0, asOf - since))}`
  return frozen ? `${said} at ${shortClockOf(new Date(asOf).toISOString())}` : said
}

/** The middle of how long its timed runs took, or null where none said. */
export function typicalMs(track) {
  const times = track.runs
    .map((one) => one.ms)
    .filter((ms) => typeof ms === 'number')
    .sort((a, b) => a - b)
  if (times.length === 0) return null
  const mid = Math.floor(times.length / 2)
  return times.length % 2 === 1 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2)
}

/** The strip's sentence, for whoever cannot see the cells. */
export function stripSaid(track) {
  const n = { pass: 0, fail: 0, other: 0 }
  for (const run of track.runs) n[run.state] = (n[run.state] ?? 0) + 1
  const parts = [
    n.pass > 0 ? `${n.pass} passed` : null,
    n.fail > 0 ? `${n.fail} failed` : null,
    n.other > 0 ? `${n.other} skipped or cancelled` : null,
  ].filter(Boolean)
  const head = `${track.check}, the last ${plural(track.runs.length, 'run')}`
  return parts.length === 0 ? `${track.check}: no run with a time` : `${head}: ${parts.join(', ')}`
}

/** Who asked for the newest run, as a name and where to go and tell them. */
export function byOf(track) {
  if (track.by === null || track.by === undefined) return null
  const cut = track.by.indexOf('/')
  if (cut < 0) return { name: track.by, href: null }
  return { name: track.by.slice(cut + 1), href: taskPath(track.by) }
}

/**
 * One check in one tree, as the page draws it: its answer and since when,
 * the strip of its runs, how long it usually takes and who asked last.
 */
export function trackOf(project, tree, track, asOf, frozen = false) {
  const answer = answerOf(track)
  const streak = track.streak
  const last = track.runs.at(-1)?.at ?? null
  const ms = typicalMs(track)
  return {
    key: `${project}\u0000${tree.task ?? ''}\u0000${track.check}`,
    project,
    tree: treeName(tree),
    task: tree.task,
    check: track.check,
    required: track.required,
    answer,
    mark: ANSWERS[answer],
    since: streak?.since ?? null,
    sinceSaid: streak === null ? null : whenSaid(streak.since, asOf),
    forSaid: forSaid(streak, asOf, frozen),
    row: streak?.runs ?? 0,
    atLeast: streak?.atLeast ?? false,
    last,
    lastSaid: last === null ? null : whenSaid(last, asOf),
    typical: ms === null ? null : ms < 1000 ? '<1s' : duration(ms),
    by: byOf(track),
    cells: track.runs.map((run) => ({ tone: CELLS[run.state]?.tone ?? 'unknown' })),
    said: stripSaid(track),
    more: track.more,
  }
}

/**
 * A check nobody is waiting on that has never said anything here — optional,
 * and skipped every time it ran. Folded under one press: a row of grey that
 * says nothing is a row that hides the ones that do.
 */
export function isQuiet(track) {
  return !track.required && track.answer === 'none'
}

/** What one project's records add up to: every track, its counts and its headline. */
export function projectOf(row, tasks, asOf, frozen = false) {
  const trees = row.checks === null ? null : row.checks
  const groups =
    trees === null
      ? []
      : trees.map((tree) => {
          const tracks = tree.checks.map((track) => trackOf(row.name, tree, track, asOf, frozen))
          return {
            key: `${row.name}\u0000${tree.task ?? ''}`,
            name: treeName(tree),
            task: tree.task,
            href: tree.task === null ? null : taskPath(tree.task),
            tracks,
            quiet: tracks.filter(isQuiet).length,
          }
        })
  const all = groups.flatMap((group) => group.tracks)
  const required = all.filter((one) => one.required)
  const counts = { fail: 0, pass: 0, none: 0 }
  for (const one of required) counts[one.answer] += 1
  const standing =
    trees === null
      ? 'unread'
      : all.length === 0
        ? 'empty'
        : counts.fail > 0
          ? 'fail'
          : counts.none > 0 || counts.pass === 0
            ? 'none'
            : 'pass'
  return {
    name: row.name,
    href: pathOf({ view: 'project', project: row.name }),
    groups,
    counts,
    standing,
    heads: headsOf(tasks),
  }
}

/** The project's headline, in a word and a tone: what its required checks last said. */
export function standingSaid(project) {
  switch (project.standing) {
    // Grey is the pill's own ground: a quiet word needs no tone to be quiet.
    case 'unread':
      return { word: 'not read yet', tone: null }
    case 'empty':
      return { word: 'nothing ran here', tone: null }
    case 'fail':
      return { word: `${project.counts.fail} failing`, tone: 't-failed' }
    case 'none':
      return { word: 'no answer yet', tone: null }
    default:
      return { word: 'passing', tone: 't-done' }
  }
}

/**
 * Every agent's head, as the rollup says it: the red ones by name with what
 * failed, the rest counted. **Green here is the rollup's green** — the commit
 * in hand, every required check run on it — and the one green that is.
 */
export function headsOf(tasks) {
  const red = []
  let pass = 0
  let unknown = 0
  let overruled = 0
  for (const task of tasks) {
    const checks = task.checks
    if (checks === undefined) continue
    if (checks.overridden) overruled += 1
    if (checks.state === 'fail') {
      red.push({ id: task.id, name: task.name, href: taskPath(task.id), failed: checks.failed })
    } else if (checks.state === 'pass') pass += 1
    else unknown += 1
  }
  return { red, pass, unknown, overruled, total: tasks.length }
}

/** The heads' line under a project, in words: what is red at a head, and how many are not. */
export function headsSaid(heads) {
  const parts = []
  if (heads.pass > 0) parts.push(`${heads.pass} green at the commit in hand`)
  if (heads.unknown > 0) parts.push(`${heads.unknown} not checked at their commit`)
  if (heads.overruled > 0) parts.push(`${heads.overruled} overruled`)
  return parts.join(' · ')
}

/**
 * The whole page: projects in the order a person wants them, every red check
 * across them longest-red first, and the counts the lead draws.
 */
export function checksOf(projects, tasksOf, asOf, frozen = false) {
  const made = projects.map((row) => projectOf(row, tasksOf(row.name), asOf, frozen))
  const order = { fail: 0, none: 1, pass: 2, empty: 3, unread: 4 }
  made.sort(
    (a, b) =>
      order[a.standing] - order[b.standing] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
  const tracks = made.flatMap((one) => one.groups.flatMap((group) => group.tracks))
  const red = tracks
    .filter((one) => one.answer === 'fail' && one.required)
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || (a.key < b.key ? -1 : 1))
  const required = tracks.filter((one) => one.required)
  const totals = { fail: 0, pass: 0, none: 0 }
  for (const one of required) totals[one.answer] += 1
  const oldest = red[0] ?? null
  const passing = required.filter((one) => one.answer === 'pass')
  const newest = passing.reduce(
    (best, one) => (best === null || (one.last ?? '') > (best.last ?? '') ? one : best),
    null,
  )
  return {
    projects: made,
    red,
    totals,
    read: made.some((one) => one.standing !== 'unread'),
    unread: made.filter((one) => one.standing === 'unread').length,
    oldest,
    newest,
    optional: tracks.filter((one) => !one.required).length,
  }
}

/** The lead's three figures, each with the line under it. */
export function figuresOf(page) {
  const { totals, oldest, newest } = page
  return [
    {
      key: 'fail',
      label: 'Failing',
      value: page.read ? String(totals.fail) : null,
      tone: totals.fail > 0 ? 'failed' : null,
      under: oldest === null ? (page.read ? 'nothing red' : null) : `longest ${oldest.forSaid}`,
    },
    {
      key: 'pass',
      label: 'Passing',
      value: page.read ? String(totals.pass) : null,
      tone: null,
      under: newest === null || newest.lastSaid === null ? null : `last ${newest.lastSaid}`,
    },
    {
      key: 'none',
      label: 'No answer',
      value: page.read ? String(totals.none) : null,
      tone: null,
      under: totals.none > 0 ? 'no pass or fail' : null,
    },
  ]
}

/** A red check's line under its name: how many runs in a row, how long one takes, who asked. */
export function redLine(track) {
  const parts = [`${track.atLeast ? '≥ ' : ''}${plural(track.row, 'failing run')} in a row`]
  if (track.typical === '<1s') parts.push('each under a second')
  else if (track.typical !== null) parts.push(`about ${track.typical} each`)
  return parts.join(' · ')
}

/** The fold's press, in words: how many quiet checks it holds, and which way it goes. */
export function quietSaid(n, open) {
  const what = `${plural(n, 'optional check')} with no answer`
  return open ? `Hide ${what}` : `Show ${what}`
}

/** Why a track has no answer, so `—` is never left to mean nothing. */
export function noneSaid(track) {
  if (track.cells.length === 0) return 'no run with a time'
  return 'skipped every time'
}

/** The word on a track's first line: its answer and how long it has stood. */
export function answerSaid(track) {
  if (track.answer === 'none') return track.mark.word
  return track.forSaid === null ? track.mark.word : `${track.mark.word} ${track.forSaid}`
}

/** The words under a track's strip: since when, or why there is no answer. */
export function sinceLine(track) {
  if (track.answer === 'none') return noneSaid(track)
  return track.sinceSaid === null ? '' : `since ${track.sinceSaid}`
}
