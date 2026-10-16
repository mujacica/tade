// The landing desk's pure half: every finished piece of work and every open
// review, in the order it is cheapest to trust, as the machine placed it.
//
// **Nothing here decides where a piece of work stands.** The machine folded
// core's own rule (`landingOf`) over the rows this device reads and put the
// answer on each row — `landing.rank`, `landing.tier` and the sentence why —
// so this sorts by a number and draws a sentence, and the window's desk and
// this one can never disagree. What it does decide is only how a figure is
// said: the checks at the head, the findings by what became of them, the
// collisions, what its own commits changed, what it cost and how long it has
// waited, each one a dash and its word where nothing could say.
//
// **The desk reads the judge**, so it goes with the `findings` grant: a device
// without it is told so rather than shown a desk that would put a change with
// an open finding at the top as though nothing were open.

import { ageSaid, money } from '../figures.js'
import { taskPath } from '../routes.js'
import { TROUBLES } from '../trouble.js'

/** The three tiers, in the desk's order: whose move it is. Core's words (`LANDING_SAID`). */
export const TIERS = {
  ready: { heading: 'READY TO LAND', word: 'ready to land', glyph: '✓', tone: 'done' },
  yours: { heading: 'WAITING ON YOU', word: 'waiting on you', glyph: '◆', tone: 'wants' },
  theirs: {
    heading: 'WAITING ON ITS AGENT',
    word: 'waiting on its agent',
    glyph: '○',
    tone: 'working',
  },
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The rows on the desk, in its order; a row with no place on it is not on it. */
export function onDesk(tasks) {
  return tasks
    .filter((task) => task.landing !== null && task.landing !== undefined)
    .sort((a, b) => a.landing.rank - b.landing.rank)
}

/** The checks at its head, as a fact: green, what failed, what did not run, or nothing looked. */
export function checksSaid(task) {
  const checks = task.checks
  // What its commits changed and its checks are one look: none taken is not *nothing ran*.
  if (task.size === null && checks.state === 'unknown') return { value: null, under: 'not looked' }
  if (checks.state === 'pass') return { value: 'green', tone: 't-done' }
  if (checks.state === 'fail') {
    return {
      value: checks.failed.length > 0 ? `${checks.failed[0]} failed` : 'failing',
      tone: 't-failed',
    }
  }
  return { value: checks.missing.length > 0 ? 'not run' : 'nothing ran', tone: 't-quiet' }
}

/** The findings about it by what became of them; a dash where no judge reads anything. */
export function findingsSaid(found) {
  if (found === null || found === undefined) return { value: null, under: 'no judge here' }
  const open = found.open + found.confirmed
  if (open > 0) return { value: `${open} open`, tone: 't-failed' }
  if (found.answered > 0) return { value: `${found.answered} to judge`, tone: 't-wants' }
  return { value: 'none open', tone: null }
}

/** The collisions the forecast found: how many, or a dash where nobody looked. */
export function conflictsSaid(conflicts) {
  if (conflicts === null || conflicts === undefined) return { value: null, under: 'not looked' }
  if (conflicts.length === 0) return { value: 'none', tone: null }
  return { value: plural(conflicts.length, 'collision'), tone: 't-failed' }
}

/** What its own commits changed, as git counted the lines; a dash where nobody looked. */
export function sizeSaid(size) {
  if (size === null || size === undefined) return { value: null, under: 'not looked' }
  const commits = plural(size.commits, 'commit')
  if (size.added === null || size.removed === null)
    return { value: commits, under: 'lines not counted' }
  return { value: `+${size.added} −${size.removed}`, under: commits }
}

/**
 * One piece of work, as a card draws it: whose and where it goes, where it
 * stands and the one sentence why, and its figures — counted against the
 * page's clock, the server's last word while the stream is not live.
 */
export function cardOf(task, asOf, opts = {}) {
  const tier = TIERS[task.landing.tier]
  const waitedSaid = ageSaid(task.movedAt, asOf, opts.frozen === true)
  const spent = money(task.spend, opts.spend !== false)
  return {
    id: task.id,
    project: task.project,
    name: task.name,
    href: taskPath(task.id),
    words: task.title?.words ?? null,
    tier: task.landing.tier,
    mark: { glyph: tier.glyph, word: tier.word, tone: `t-${tier.tone}` },
    why: task.landing.why ?? readySaid(task),
    also: task.landing.also > 0 ? `and ${task.landing.also} more` : null,
    review: task.review?.state ?? null,
    waitedSaid,
    ageLabel: waitedSaid === null ? null : `waiting ${waitedSaid}`,
    facts: [
      { label: 'Checks', ...checksSaid(task) },
      { label: 'Findings', ...findingsSaid(task.landing.findings) },
      { label: 'Collisions', ...conflictsSaid(task.conflicts) },
      { label: 'Changed', ...sizeSaid(task.size) },
      { label: 'Cost', value: spent.why === '' ? spent.said : null, under: spent.why || 'today' },
    ],
  }
}

/** What a ready piece of work says where nothing holds it: what reading it is. */
function readySaid(task) {
  return [
    'green at its head',
    task.size ? plural(task.size.commits, 'commit') : null,
    task.review?.state === 'open' ? 'review open' : null,
    'nothing open',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The whole desk: the cards by tier in the desk's own order, and what the lead draws. */
export function deskPage(tasks, asOf, opts = {}) {
  const cards = onDesk(tasks).map((task) => cardOf(task, asOf, opts))
  const of = (tier) => cards.filter((one) => one.tier === tier)
  const groups = { ready: of('ready'), yours: of('yours'), theirs: of('theirs') }
  return {
    total: cards.length,
    groups,
    parts: Object.entries(TIERS).map(([key, one]) => ({
      key,
      label: one.word,
      tone: one.tone,
      n: groups[key].length,
    })),
  }
}

/** The bar's word: what is ready, else what waits on the person, else what is on the desk. */
export function figureSaid(page) {
  if (page === null || page.total === 0) return { word: '', tone: null }
  if (page.groups.ready.length > 0) {
    return { word: `${page.groups.ready.length} ready`, tone: 't-done' }
  }
  if (page.groups.yours.length > 0) {
    return { word: `${page.groups.yours.length} waiting on you`, tone: 't-wants' }
  }
  return { word: `${page.total} on the desk`, tone: null }
}

/** The lead's sentence, read instead of the bar. */
export function leadSaid(page) {
  if (page.total === 0) return 'Nothing is waiting to land.'
  const parts = page.parts.filter((one) => one.n > 0).map((one) => `${one.n} ${one.label}`)
  return `${plural(page.total, 'piece of work', 'pieces of work')} on the desk: ${parts.join(', ')}.`
}

function stateOf(kind, title, line, icon = 'check') {
  return { kind, icon, title, line }
}

/**
 * The page's own state where there is nothing else to draw: coming, could not
 * reach the machine, not granted the judge's findings, or nothing finished —
 * four answers, never a blank. Null where the desk has something on it.
 */
export function wholeOf(had, shut, granted, page) {
  if (!had) {
    return shut ? stateOf('error', TROUBLES.offline.title, TROUBLES.offline.fix, 'alert') : null
  }
  if (!granted) {
    return stateOf(
      'empty',
      'Findings not granted',
      'The desk orders work by its checks and by what the judge found, and this device was not granted the findings.',
      'findings',
    )
  }
  if (page !== null && page.total > 0) return null
  return stateOf(
    'empty',
    'Nothing waiting to land',
    'When an agent finishes or a review is opened, it is drawn here, cheapest to trust first.',
  )
}
