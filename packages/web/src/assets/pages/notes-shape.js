// The notes page's pure half: what Tade was told, arranged the two ways a
// person asks about it — **where it applies** (everywhere, a project, one of
// its tasks) and **when it was said** — and the picture of both at once.
//
// **A note is never reworded, and nothing here makes words out of one.** Its
// `text` is carried through as the `Said` it arrived as and drawn verbatim; its
// `summary`, where whoever took it down wrote one, is a headline *beside* it and
// is never derived from the text. Every sentence this module writes is about
// notes — how many, where, how long ago — and never quotes one.

import { ageSaid, duration } from '../figures.js'
import { pathOf, taskPath } from '../routes.js'
import { TROUBLES } from '../trouble.js'

export const DAY = 86_400_000

/** A note said within this long is new, and drawn as *now* is. */
export const FRESH = DAY

/** How many notes a group shows before it is asked for the rest. */
export const FOLD = 5

/** Past this many characters, words that are a card's main line fold behind `more`. */
export const LONG = 240

/** How many places the picture draws a lane for; the list below has every one. */
export const LANES = 6

/**
 * Where a note came from, in words. `by` is metadata the machine wrote, never
 * the note, so it may be said in a sentence; an unknown source says nothing
 * rather than inventing one.
 */
export const BY_SAID = {
  voice: 'spoken',
  window: 'typed at the machine',
  cli: 'from the terminal',
  orchestrator: 'taken down by Tade',
}

/**
 * The stretches of time the *When* grouping uses, counted back from the moment
 * the page is as of. A note whose moment will not read is its own group rather
 * than the oldest one: not knowing when is not the same as long ago.
 */
export const BANDS = [
  { key: 'day', heading: 'LAST DAY', most: DAY },
  { key: 'week', heading: 'LAST 7 DAYS', most: 7 * DAY },
  { key: 'month', heading: 'LAST 30 DAYS', most: 30 * DAY },
  { key: 'older', heading: 'OLDER', most: Number.POSITIVE_INFINITY },
  { key: 'unknown', heading: 'WHEN IS NOT RECORDED', most: null },
]

/**
 * The windows the picture may draw, smallest first: the first that holds every
 * note is the one drawn, so a morning's notes are not a cluster in a corner of
 * twelve weeks. Each tick is how long ago it is and what it says.
 */
export const WINDOWS = [
  {
    span: DAY,
    said: 'the last day',
    ticks: [
      [DAY, '24h'],
      [DAY * 0.75, '18h'],
      [DAY * 0.5, '12h'],
      [DAY * 0.25, '6h'],
      [0, 'now'],
    ],
  },
  {
    span: 14 * DAY,
    said: 'the last two weeks',
    ticks: [
      [14 * DAY, '2w'],
      [7 * DAY, '1w'],
      [0, 'now'],
    ],
  },
  {
    span: 28 * DAY,
    said: 'the last four weeks',
    ticks: [
      [28 * DAY, '4w'],
      [21 * DAY, '3w'],
      [14 * DAY, '2w'],
      [7 * DAY, '1w'],
      [0, 'now'],
    ],
  },
  {
    span: 84 * DAY,
    said: 'the last twelve weeks',
    ticks: [
      [84 * DAY, '12w'],
      [56 * DAY, '8w'],
      [28 * DAY, '4w'],
      [0, 'now'],
    ],
  },
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const newestFirst = (a, b) => (b.at ?? -1) - (a.at ?? -1) || byText(b.id, a.id)

/**
 * What a note's scope names: everything (`null`), a project (`tade`), or one
 * of a project's tasks (`tade/window`) — `@tade/core`'s `appliesTo` reads it
 * the same way, so a note on a project is told to every agent in it.
 */
export function scopeOf(scope) {
  if (scope === null || scope === undefined || scope === '') {
    return { kind: 'everywhere', project: null, task: null }
  }
  const cut = scope.indexOf('/')
  if (cut < 0) return { kind: 'project', project: scope, task: null }
  return { kind: 'task', project: scope.slice(0, cut), task: scope.slice(cut + 1) }
}

/** Where a note came from, or null where the machine did not write it down. */
export function bySaid(by) {
  if (typeof by !== 'string' || by === '' || by === 'unknown') return null
  if (by.startsWith('device ')) return `from ${by}`
  return BY_SAID[by] ?? `from ${by}`
}

/** Which of `BANDS` a note's moment falls in, as of `asOf`. */
export function bandOf(at, asOf) {
  if (at === null || at === undefined) return 'unknown'
  const ago = Math.max(0, asOf - at)
  return BANDS.find((band) => band.most !== null && ago < band.most)?.key ?? 'unknown'
}

/**
 * The moment a note was said, as a date and a time of day in the reader's own
 * zone — the instant is the machine's, so a phone abroad reads the same moment
 * as its own wall clock. The year only where it is not the year of `asOf`.
 */
export function whenSaid(at, asOf) {
  if (at === null || at === undefined) return null
  const when = new Date(at)
  if (Number.isNaN(when.getTime())) return null
  const two = (n) => String(n).padStart(2, '0')
  const year = when.getFullYear() === new Date(asOf).getFullYear() ? '' : ` ${when.getFullYear()}`
  return `${MONTHS[when.getMonth()]} ${when.getDate()}${year}, ${two(when.getHours())}:${two(when.getMinutes())}`
}

/**
 * The place a note applies to, as a chip says it — in the *Where* grouping,
 * where the group already names the project (`inGroup`), and in the *When*
 * grouping, where the chip is the only thing that does. A link only where the
 * page has somewhere to go (`places`).
 */
export function placeOf(scope, places, inGroup) {
  if (scope.kind === 'everywhere') {
    return inGroup ? null : { kind: 'everywhere', word: 'Everywhere', of: null, href: null }
  }
  if (scope.kind === 'project') {
    if (inGroup) return { kind: 'project', word: 'whole project', of: null, href: null }
    const href = places.project(scope.project)
      ? pathOf({ view: 'project', project: scope.project })
      : null
    return { kind: 'project', word: scope.project, of: null, href }
  }
  const id = `${scope.project}/${scope.task}`
  return {
    kind: 'task',
    word: scope.task,
    of: inGroup ? null : scope.project,
    href: places.task(id) ? taskPath(id) : null,
  }
}

/** Nowhere to go: no project or task the page can link to. */
const NOWHERE = { project: () => false, task: () => false }

/**
 * One note as a card draws it. `headline` is the summary written beside it, or
 * null, and then the words themselves are the card's main line (`long` folds
 * them); `words` is the note **verbatim**, always.
 */
export function noteOf(row, asOf, places = NOWHERE) {
  const parsed = Date.parse(row.at)
  const at = Number.isNaN(parsed) ? null : parsed
  const scope = scopeOf(row.scope)
  const words = row.text ?? null
  const headline = row.summary ?? null
  return {
    id: row.id,
    at,
    age: at === null ? null : ageSaid(row.at, asOf),
    fresh: at !== null && asOf - at < FRESH,
    band: bandOf(at, asOf),
    headline,
    words,
    long: headline === null && words !== null && Array.from(words.words).length > LONG,
    scope,
    chip: placeOf(scope, places, true),
    place: placeOf(scope, places, false),
    by: bySaid(row.by),
    when: whenSaid(at, asOf),
  }
}

/** The newest moment among some cards, or null where none will read. */
function newestOf(cards) {
  return cards.reduce(
    (most, one) => (one.at !== null && (most === null || one.at > most) ? one.at : most),
    null,
  )
}

/**
 * The *Where* grouping: the notes every agent is told, then a group per
 * project — the one told something most recently first — holding the notes on
 * the whole project before the notes on its tasks, a task's notes together and
 * the task told something most recently first.
 */
export function whereOf(cards, places = NOWHERE) {
  const everywhere = cards.filter((one) => one.scope.kind === 'everywhere').sort(newestFirst)
  const byProject = new Map()
  for (const one of cards) {
    if (one.scope.kind === 'everywhere') continue
    const list = byProject.get(one.scope.project) ?? []
    list.push(one)
    byProject.set(one.scope.project, list)
  }
  const projects = [...byProject].map(([name, list]) => {
    const own = list.filter((one) => one.scope.kind === 'project').sort(newestFirst)
    const byTask = new Map()
    for (const one of list) {
      if (one.scope.kind !== 'task') continue
      byTask.set(one.scope.task, [...(byTask.get(one.scope.task) ?? []), one])
    }
    const tasks = [...byTask.values()]
      .map((mine) => mine.sort(newestFirst))
      .sort(
        (a, b) =>
          (newestOf(b) ?? -1) - (newestOf(a) ?? -1) || byText(a[0].scope.task, b[0].scope.task),
      )
      .flat()
    return {
      key: `p:${name}`,
      kind: 'project',
      name,
      href: places.project(name) ? pathOf({ view: 'project', project: name }) : null,
      n: list.length,
      own: own.length,
      tasks: tasks.length,
      newest: newestOf(list),
      under: projectUnder(own.length, tasks.length, byTask.size),
      cards: [...own, ...tasks],
    }
  })
  projects.sort((a, b) => (b.newest ?? -1) - (a.newest ?? -1) || byText(a.name, b.name))
  return {
    everywhere: {
      key: 'everywhere',
      kind: 'everywhere',
      name: 'Everywhere',
      href: null,
      n: everywhere.length,
      newest: newestOf(everywhere),
      under: 'told to every agent, whatever it works on',
      cards: everywhere,
    },
    projects,
  }
}

/** A project group's line: how its notes divide between the project and its tasks. */
export function projectUnder(own, tasks, distinct) {
  const parts = []
  if (own > 0) parts.push(`${plural(own, 'note')} on the whole project`)
  if (tasks > 0) parts.push(`${tasks} on ${plural(distinct, 'task')}`)
  return parts.join(' · ')
}

/** The *When* grouping: every band, newest first inside each, the empty ones kept and counted at nought. */
export function whenOf(cards) {
  return BANDS.map((band) => {
    const mine = cards.filter((one) => one.band === band.key).sort(newestFirst)
    return { key: band.key, heading: band.heading, n: mine.length, cards: mine }
  })
}

/**
 * The picture: a lane per place — everywhere first, then the projects in the
 * order the list has them — and a mark on it for every note, at the moment it
 * was said, over the smallest window that holds them all. Notes older than the
 * widest window are counted and not drawn (`left`), never piled at its edge,
 * and a note whose moment will not read is counted apart (`unplaced`) rather
 * than called old. A note said within `FRESH` is toned *now*; the rest quiet.
 */
export function chartOf(where, asOf) {
  const groups = [where.everywhere, ...where.projects].filter((group) => group.n > 0)
  const oldest = groups
    .flatMap((group) => group.cards)
    .reduce(
      (least, one) => (one.at !== null && (least === null || one.at < least) ? one.at : least),
      null,
    )
  const reach = oldest === null ? 0 : asOf - oldest
  const window = WINDOWS.find((one) => one.span >= reach) ?? WINDOWS[WINDOWS.length - 1]
  const from = asOf - window.span
  let left = 0
  let unplaced = 0
  const lanes = groups.slice(0, LANES).map((group) => {
    const drawn = group.cards.filter((one) => one.at !== null && one.at >= from)
    unplaced += group.cards.filter((one) => one.at === null).length
    left += group.cards.filter((one) => one.at !== null && one.at < from).length
    const newest = newestOf(drawn)
    const said =
      newest === null
        ? ''
        : `${plural(drawn.length, 'note')} in ${window.said}, the newest ${duration(Math.max(0, asOf - newest))} ago`
    return {
      key: group.key,
      label: group.name,
      href: group.href,
      marks: drawn.map((one, at) => ({
        at: one.at,
        tone: one.fresh ? 'here' : 'quiet',
        said: at === 0 ? said : '',
      })),
    }
  })
  return {
    from,
    to: asOf,
    now: asOf,
    said: window.said,
    ticks: window.ticks.map(([ago, said]) => ({ at: asOf - ago, said })),
    lanes,
    more: Math.max(0, groups.length - LANES),
    left,
    unplaced,
  }
}

/**
 * The whole page: every card, both groupings, the picture, and the counts the
 * lead says. `places` says which projects and tasks the page can link to.
 */
export function notesPage(rows, asOf, places = NOWHERE) {
  const cards = rows.map((row) => noteOf(row, asOf, places))
  const where = whereOf(cards, places)
  const counts = { everywhere: 0, project: 0, task: 0 }
  for (const one of cards) counts[one.scope.kind] += 1
  const newest = newestOf(cards)
  return {
    total: cards.length,
    counts,
    fresh: cards.filter((one) => one.fresh).length,
    newest,
    newestSaid: newest === null ? null : duration(Math.max(0, asOf - newest)),
    where,
    when: whenOf(cards),
    chart: chartOf(where, asOf),
  }
}

/** The three places a note can be about, in the order the lead counts them. */
export const PLACES = [
  { key: 'everywhere', label: 'Everywhere' },
  { key: 'project', label: 'On a project' },
  { key: 'task', label: 'On a task' },
]

/** The lead's line under its figure: how new the newest is, and how many came in the last day. */
export function leadLine(page) {
  if (page.newestSaid === null) return 'when the newest was said is not recorded'
  return `newest ${page.newestSaid} ago${page.fresh > 0 ? ` · ${page.fresh} in the last day` : ''}`
}

/** The lead's tally: how the notes divide between the three places, each with its count. */
export function tallyOf(page) {
  return PLACES.map((place) => ({ ...place, n: page.counts[place.key] }))
}

/** The picture's foot: what it left out, or nothing. */
export function chartFoot(chart) {
  const parts = []
  if (chart.more > 0) parts.push(`${plural(chart.more, 'more project')} in the list`)
  if (chart.left > 0) {
    parts.push(`${chart.left} older than ${chart.said.replace('the last ', '')} not drawn`)
  }
  if (chart.unplaced > 0) parts.push(`${chart.unplaced} with no moment recorded not drawn`)
  return parts.join(' · ')
}

/**
 * How many of a group are drawn: every one while it is open or short enough,
 * else its newest `FOLD` and a count of the rest.
 */
export function shownOf(group, open) {
  if (open || group.cards.length <= FOLD + 1) return { cards: group.cards, hidden: 0 }
  return { cards: group.cards.slice(0, FOLD), hidden: group.cards.length - FOLD }
}

/** The fold press's words: open the rest, or close back to the newest. */
export function foldSaid(group, open) {
  if (group.cards.length <= FOLD + 1) return null
  return open ? `Show the newest ${FOLD}` : `Show all ${group.cards.length}`
}

/**
 * The notes the page draws: the snapshot's, then whatever older pages were
 * asked for that the snapshot does not also carry — once each, by id.
 */
export function rowsWith(sent, held) {
  const seen = new Set(sent.map((row) => row.id))
  return [...sent, ...held.filter((row) => !seen.has(row.id))]
}

/**
 * **The older pages, asked for, not sent.** The snapshot carries the newest
 * notes and a cursor past them (`pages.notes.next`); each ask walks on from the
 * cursor (`/api/notes?after=`) and what came is held beside the snapshot's.
 * Notes are append-only, so a page once read stays true — and a cursor the
 * machine no longer knows starts over (`restarted`), which throws what was held
 * away rather than drawing a note twice.
 */
export const UNWALKED = { held: [], cursor: null, walked: false }

/** Where the walk stands after the machine answered with one more page. */
export function olderAfter(walk, page) {
  const restarted = page.restarted === true
  return {
    held: restarted ? [...page.rows] : [...walk.held, ...page.rows],
    cursor: page.next ?? null,
    walked: true,
    restarted,
  }
}

/**
 * Whether the next page is offered, and from which cursor: the snapshot's own
 * until a page has been asked for, the walk's after — so a machine that said
 * there is no more is believed over a snapshot that still points on — and only
 * while notes are left and somebody can ask.
 */
export function olderOffered(walk, left, next, canAsk) {
  const cursor = walk.walked ? walk.cursor : next
  return { cursor, offered: left > 0 && cursor !== null && canAsk }
}

/**
 * What the page says when there is nothing to draw: coming and unreachable,
 * not granted (with how many there are), or none — four sentences and never a
 * blank. Null when there are notes to draw.
 */
export function wholeOf(had, shut, may, total, withheld) {
  if (!had) {
    if (!shut) return null
    return {
      kind: 'error',
      icon: 'alert',
      heading: TROUBLES.offline.title,
      line: TROUBLES.offline.fix,
    }
  }
  if (!may) {
    return {
      kind: 'empty',
      icon: 'notes',
      heading: 'Notes aren’t granted to this device',
      line:
        withheld > 0
          ? `${plural(withheld, 'note')} here. Grant this device notes at the machine to read them.`
          : 'Grant this device notes at the machine to read them.',
    }
  }
  if (total > 0) return null
  return {
    kind: 'empty',
    icon: 'notes',
    heading: 'Nothing written down yet',
    line: 'Ask Tade to remember something, and it is kept here word for word.',
  }
}

/**
 * The line under the lead: the moment a page that is not live is as of, and
 * how many notes are older than this page and not on it.
 */
export function asOfLine(frozen, clock, notHere) {
  const parts = []
  if (frozen) parts.push(`as of ${clock}`)
  if (notHere > 0) parts.push(`${plural(notHere, 'older note')} not on this page`)
  return parts.join(' · ')
}
