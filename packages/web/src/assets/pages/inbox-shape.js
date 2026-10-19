// The inbox page's pure half: what has been handed to this machine, in the
// order a person wants it — what waits on them and for how long, grouped by the
// one thing each needs from them, then what is on its way, then what is
// settled, and every door it came through with the one that is broken first.
//
// **Nothing here decides a state.** Where a request stands is `inboxStateOf`'s
// answer and arrives on the row; which of them wait on a person is the
// domain's `WAITING_STATES` (`store.js`' `WAITING`); whether one is finished is
// the rule `intakeMark` already draws by; and every sentence about why is
// `because`, Tade's own. What this adds is the grouping, the ageing and the
// order — the drawing's own decisions about the room it has.

import { ageSaid, untilSaid } from '../figures.js'
import { intakeMark, sourceMark, stepMark } from '../glyphs.js'
import { pathOf, requestPath, taskPath } from '../routes.js'
import { taskAt, WAITING } from '../store.js'

/**
 * Where a request stands, as the lead's bar divides them: what waits on the
 * person to say yes, what waits on them because it stopped, what is on its
 * way, what is finished and what was refused. The first two are `WAITING`.
 */
export const STANDS = {
  approve: { label: 'to approve', tone: 'wants' },
  stuck: { label: 'held or gave up', tone: 'failed' },
  moving: { label: 'on its way', tone: 'working' },
  done: { label: 'finished', tone: 'done' },
  refused: { label: 'refused', tone: 'quiet' },
}

/**
 * The three kinds of waiting, in the order the page draws them, each with the
 * heading its group goes under. Approving is the inbox's own act and comes
 * first; the two that stopped follow it, each a different thing to look at.
 */
export const KINDS = {
  proposed: { heading: 'To approve' },
  held: { heading: 'Held' },
  failure: { heading: 'Tade gave up' },
}

/**
 * The doors in the order a person needs them: the two broken ones first (red,
 * `SOURCE_NEEDS_YOU`), the one that clears on its own, the ones working, and
 * last the ones somebody decided to leave shut.
 */
export const DOOR_ORDER = [
  'trouble',
  'unreachable',
  'rate-limited',
  'found',
  'quiet',
  'unlooked',
  'paused',
  'unwatched',
  'ungranted',
  'off',
]

/** A region's state, as `stateBoxIn` takes it, with this page's mark unless it says. */
export function stateOf(kind, title, line, mark = 'inbox') {
  return { kind, icon: mark, title, line }
}

/** Whether a `<project>/<task>` id is a task this device holds, so a press goes only to a page that exists. */
export function knownIn(store) {
  return (id) => {
    const cut = id.indexOf('/')
    return cut > 0 && taskAt(store, id.slice(0, cut), id.slice(cut + 1)) !== null
  }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * What a request is called: the source's own title where this device was
 * granted it, and the source's own id where it was not — never the id dressed
 * up as a title.
 */
export function nameOf(row) {
  return row.title === null ? `${row.source} ${row.externalId}` : row.title.words
}

/** The part of a task id after its project, which is what a person calls it. */
export function taskName(id) {
  const cut = id.indexOf('/')
  return cut < 0 ? id : id.slice(cut + 1)
}

/**
 * Which part of the lead's bar a request is in. Finished is `intakeMark`'s own
 * rule — work that started and every task of it finished — read through the
 * mark rather than written a second time.
 */
export function standOf(row) {
  if (row.state === 'proposed') return 'approve'
  if (row.state === 'held' || row.state === 'failure') return 'stuck'
  if (row.state === 'refused') return 'refused'
  if (intakeMark(row).word === 'finished') return 'done'
  return 'moving'
}

/** How long ago it arrived, in milliseconds against the page's clock; null where the moment will not read. */
function waitedOf(row, asOf) {
  const at = Date.parse(row.at)
  return Number.isNaN(at) ? null : Math.max(0, asOf - at)
}

/** Longest wait first, then by key so two of the same age keep their places. */
const oldestFirst = (a, b) => (b.waited ?? -1) - (a.waited ?? -1) || byText(a.key, b.key)
const newestFirst = (a, b) => (a.waited ?? -1) - (b.waited ?? -1) || byText(a.key, b.key)

/**
 * Where a request came from, in a line: the source and its id, who asked, and
 * the project it made work in. A handle this device was not granted is left
 * out rather than drawn as a dash, because the request's own screen has the
 * room to say which nothing it is. `withId` is false where the id is already
 * the name above the line.
 */
export function fromSaid(row, withId = true) {
  const parts = withId ? [`${row.source} ${row.externalId}`] : []
  if (row.who !== null && row.who.words !== '') parts.push(`@${row.who.words}`)
  parts.push(row.project)
  return parts.join(' · ')
}

/**
 * What approving would start, in a few words — the count and where — or null
 * where nothing worked it out. It is the work that exists, parked, read off
 * its own files (`intakeWouldRun`), so it is a fact and not a forecast.
 */
export function startsSaid(would) {
  if (would === null || would === undefined) return null
  const n = would.starts.length
  if (n === 0) return 'starts nothing'
  const places = new Set(would.starts.map((one) => one.workspace))
  const where =
    places.size !== 1
      ? ''
      : places.has('worktree')
        ? n === 1
          ? ' in a worktree'
          : ' in worktrees'
        : ' in the checkout'
  return `starts ${plural(n, 'task')}${where}`
}

/**
 * The one press on a card waiting on a person, and where it goes.
 *
 * Approving is done on the request's own screen, beside what it would start —
 * never blind from a list. A held request goes to the task that is held, where
 * its own controls are, while that task is on this device; anything else goes
 * to the request, which says what stopped and what is left to do.
 */
export function actionOf(row, known) {
  if (row.state === 'proposed') {
    return { word: 'Review and approve', name: null, href: requestPath(row.item) }
  }
  const held = heldTaskOf(row, known)
  if (held !== null) return { word: 'Open', name: taskName(held), href: taskPath(held) }
  return {
    word: row.state === 'failure' ? 'See why it stopped' : 'See what is holding it',
    name: null,
    href: requestPath(row.item),
  }
}

/**
 * The task a held request is held on, where it is on this device — a place
 * with its own controls — or null: a request that is not held, one held by
 * failed deliveries rather than a task, and one whose task has gone.
 */
export function heldTaskOf(row, known) {
  if (row.state !== 'held') return null
  const held = row.work.find((one) => one.held !== null)
  return held !== undefined && known(held.task) ? held.task : null
}

/**
 * One request, as either a card or a row draws it, aged against the page's
 * clock — the server's last word while the stream is not live, so a dead page
 * never counts up (`asOf`).
 */
export function requestOf(row, asOf, known = () => false) {
  const waited = waitedOf(row, asOf)
  return {
    key: row.item,
    state: row.state,
    stand: standOf(row),
    mark: intakeMark(row),
    name: nameOf(row),
    named: row.title !== null,
    // The id is the name where the title was not granted, and is not said twice.
    from: fromSaid(row, row.title !== null),
    project: row.project,
    because: row.because,
    moved: row.moved,
    waited,
    waitedSaid: waited === null ? '—' : (ageSaid(row.at, asOf) ?? '—'),
    starts: row.state === 'proposed' ? startsSaid(row.would) : null,
    href: requestPath(row.item),
    action: WAITING.includes(row.state) ? actionOf(row, known) : null,
  }
}

/**
 * The requests waiting on a person, a group per kind in `KINDS`' order, and in
 * each the one that has waited longest first. A kind with none is not a group.
 */
export function groupsOf(cards) {
  return Object.entries(KINDS)
    .map(([kind, one]) => {
      const list = cards.filter((card) => card.state === kind).sort(oldestFirst)
      return {
        kind,
        heading: one.heading,
        n: list.length,
        oldestSaid: list[0]?.waitedSaid ?? '—',
        cards: list,
      }
    })
    .filter((group) => group.n > 0)
}

/**
 * One door, as the page draws it: its mark, when it last looked — or, for a
 * spent budget, when it clears, which is the one figure a person acts on —
 * Tade's own sentence about it, and what it is set to do.
 */
export function doorOf(row, asOf, now) {
  const mark = sourceMark(row.state)
  const until = row.state === 'rate-limited' ? untilSaid(row.until, now) : null
  const looked = ageSaid(row.lookedAt, asOf)
  const when =
    until !== null
      ? until === 'now'
        ? 'clears now'
        : `clears in ${until}`
      : looked === null
        ? null
        : `looked ${looked} ago`
  const facts = when === null ? [] : [when]
  if (row.every !== null && row.every !== '') facts.push(`every ${row.every}`)
  if (row.handed > 0) facts.push(`${row.handed} handed over`)
  if (row.projects.length > 0) {
    facts.push(
      row.projectsElsewhere > 0
        ? `${row.projects.join(', ')} +${row.projectsElsewhere}`
        : row.projects.join(', '),
    )
  }
  return {
    key: row.source,
    name: row.source,
    state: row.state,
    mark,
    // The two that are somebody's to fix are the ones drawn red
    // (`SOURCE_NEEDS_YOU`, held equal to the glyphs by `glyphs.test.ts`).
    broken: mark.tone === 't-failed',
    when,
    because: row.because,
    facts: facts.join(' · '),
  }
}

/** The doors' rows, the broken first and the shut last, then by name. */
export function byDoor(sources) {
  const rank = (state) => {
    const at = DOOR_ORDER.indexOf(state)
    return at < 0 ? DOOR_ORDER.length : at
  }
  return [...sources].sort((a, b) => rank(a.state) - rank(b.state) || byText(a.source, b.source))
}

/** The doors, as the page draws them, in `byDoor`'s order. */
export function doorsOf(sources, asOf, now) {
  return byDoor(sources).map((row) => doorOf(row, asOf, now))
}

/**
 * The whole inbox out of the projected rows: how many wait on the person and
 * the oldest of them, the lead's bar, the groups waiting, what is on its way
 * (newest first), what is settled (newest first), and the doors. `known(id)`
 * says whether a task is in the store, so a press goes only to a page that
 * exists.
 */
export function inboxPage(rows, sources, asOf, now, known = () => false) {
  const all = rows.map((row) => requestOf(row, asOf, known))
  const waiting = all.filter((one) => one.action !== null)
  const of = (stand) => all.filter((one) => one.stand === stand)
  const oldest = [...waiting].sort(oldestFirst)[0]
  return {
    total: all.length,
    waiting: waiting.length,
    oldestSaid: oldest === undefined || oldest.waited === null ? null : oldest.waitedSaid,
    parts: Object.entries(STANDS).map(([key, one]) => ({ key, ...one, n: of(key).length })),
    groups: groupsOf(waiting),
    moving: of('moving').sort(newestFirst),
    settled: [...of('done'), ...of('refused')].sort(newestFirst),
    doors: doorsOf(sources, asOf, now),
  }
}

/** The bar's word: how many wait on the person, in violet, or that nothing does — empty before there is a page. */
export function figureSaid(page) {
  if (page === null || page.total === 0) return { word: '', tone: null }
  if (page.waiting === 0) return { word: 'nothing waits on you', tone: null }
  return {
    word: `${page.waiting} ${page.waiting === 1 ? 'waits' : 'wait'} on you`,
    tone: 't-wants',
  }
}

/** The words beside the lead's figure: what it counts, and how long the oldest has waited. */
export function heroSaid(page) {
  if (page.waiting === 0) return { label: 'nothing waits on you', under: null }
  return {
    label: page.waiting === 1 ? 'waits on you' : 'wait on you',
    under: page.oldestSaid === null ? null : `oldest arrived ${page.oldestSaid} ago`,
  }
}

/**
 * What the waiting region says when nothing waits: how much is on its way and
 * how much is settled, so a calm page still says where everything went.
 */
export function calmSaid(page) {
  const [moving, done, refused] = ['moving', 'done', 'refused'].map(
    (key) => page.parts.find((one) => one.key === key)?.n ?? 0,
  )
  const parts = []
  if (moving > 0) parts.push(`${moving} on ${moving === 1 ? 'its' : 'their'} way`)
  if (done > 0) parts.push(`${done} finished`)
  if (refused > 0) parts.push(`${refused} refused`)
  return parts.length === 0 ? 'Nothing has been handed over.' : `${parts.join(', ')}.`
}

/** A group's line: how many, and how long the one at its head has waited. */
export function groupSaid(group) {
  return group.oldestSaid === '—' ? String(group.n) : `${group.n} · oldest ${group.oldestSaid}`
}

/** The press that shows or folds the settled requests. */
export function settledSaid(n, open) {
  return open ? `Hide the ${plural(n, 'settled request')}` : `Show ${plural(n, 'settled request')}`
}

/**
 * What an empty inbox means, out of the doors' own sentences.
 *
 * `nothingHandedSays`' rule, and the same order: a door in trouble first
 * because that is the one a person can act on, then the sentence of whatever
 * is not off, then the first row's. The sentences themselves are the domain's
 * — this picks which one to draw and writes none of its own.
 */
export function emptySays(sources) {
  if (sources.length === 0) return 'no source is implemented here'
  const trouble = troubleOf(sources)
  if (trouble !== undefined) return trouble.because
  const working = sources.filter((row) => row.state === 'quiet' || row.state === 'found')
  if (working.length > 0) {
    return `${working.length} ${working.length === 1 ? 'source is' : 'sources are'} being looked with and nothing has been handed over`
  }
  return sources.find((row) => row.state !== 'off')?.because ?? sources[0].because
}

/** The first door whose last look did not work, which is what an empty inbox is about. */
export function troubleOf(sources) {
  return sources.find(
    (row) => row.state === 'trouble' || row.state === 'unreachable' || row.state === 'rate-limited',
  )
}

/* ── one request ───────────────────────────────────────────────────────────── */

/**
 * Where it came from, as labelled facts — and **nothing a stranger wrote**
 * except the handle and the source's own ids, which are what *who asked* means.
 *
 * `inboxProvenance`'s own list, with the two revisions collapsed the way it
 * collapses them and `—` wherever the answer is that nobody said: a row drawn
 * with an empty grant reads as a request nothing authorised, and one nothing
 * authorised was refused and never got a row. `may` is whether this device
 * was granted a request's words, which is what tells *nobody said who* from
 * *not granted*.
 */
export function provenanceOf(row, may) {
  const dash = (value) => (value === null || value === '' ? '—' : value)
  return [
    ['source', row.source],
    ['their id', row.externalId],
    [
      'revision',
      row.taken === row.revision ? row.revision : `${row.revision} now, work made for ${row.taken}`,
    ],
    ['asked by', row.who === null ? (may ? '—' : 'not granted') : `@${row.who.words}`],
    ['project', dash(row.project)],
    ['allowed by', dash(row.grant)],
    ['mode', dash(row.mode)],
    ['workflow', row.stamp === null ? 'none: one task' : `${row.stamp.name}@${row.stamp.version}`],
    ['found by', dash(row.watch)],
    ['raw material', dash(row.ref)],
    ['its hash', dash(row.hash)],
    ['tried', `${row.attempts} of ${row.tries}`],
  ]
}

/** The facts a person reads first; the rest are the record, folded under them. */
const FIRST = ['source', 'their id', 'asked by', 'project', 'workflow', 'allowed by']

/**
 * The facts in two lists: who and what first, and the record — revisions,
 * hashes, references — under a fold. How often carrying it out failed comes up
 * into the first list as soon as it has, because then it is why it is held.
 */
export function factsSplit(pairs, row) {
  const first = (label) => FIRST.includes(label) || (label === 'tried' && row.attempts > 0)
  return {
    first: pairs.filter(([label]) => first(label)),
    more: pairs.filter(([label]) => !first(label)),
  }
}

/**
 * The square at the head of a request's screen: its mark, the glyph's own word
 * for where it stands, and which wash the square takes — violet while it waits
 * for a yes, red while it is held or given up, none otherwise.
 */
export function standingOfRequest(row, asOf) {
  const mark = intakeMark(row)
  const age = ageSaid(row.at, asOf)
  return {
    mark,
    word: mark.word.charAt(0).toUpperCase() + mark.word.slice(1),
    wash: row.state === 'proposed' ? 'wants' : WAITING.includes(row.state) ? 'failed' : null,
    arrived: age === null ? 'no moment recorded' : `arrived ${age} ago`,
    moved: row.moved
      ? `It has been edited since the work was made: the work is for ${row.taken} and it is at ${row.revision} now.`
      : null,
  }
}

/**
 * Where a request came from, as the chips under its state: the source and its
 * id, who asked, the project, and the workflow it was stamped from. Who asked
 * is left out where nobody said and *not granted* where this device may not
 * read the handle (`mayWho`) — two nothings, never one.
 */
export function chipsOf(row, mayWho) {
  const who = row.who === null ? (mayWho ? null : 'asked by: not granted') : `@${row.who.words}`
  return [
    { key: 'source', said: `${row.source} ${row.externalId}`, mono: true },
    { key: 'who', said: who, mono: false },
    { key: 'project', said: row.project, mono: false },
    {
      key: 'workflow',
      said: row.stamp === null ? 'one task' : `${row.stamp.name}@${row.stamp.version}`,
      mono: row.stamp !== null,
    },
  ].filter((one) => one.said !== null && one.said !== '')
}

/**
 * Why approving is not offered here, or `''` where it is or where there is
 * nothing to say: only a request waiting on a yes says why it cannot be given
 * one, because the rest already say where they stand in the line above, and
 * a second sentence under it would be the same fact twice. `standing` is the
 * verb's (`standingOf`), and `off` — a device not granted the act — is said
 * by the control being absent, not by a sentence.
 */
export function approveWhy(row, here, standing) {
  if (standing.kind === 'off' || row.state !== 'proposed') return ''
  if (!here) return 'the parked task this would approve is not on this device'
  return standing.kind === 'no' ? standing.why : ''
}

/**
 * What became of one task the request made: its mark, which is a step's
 * (`stepMark` — finished by its own done rule, else `deriveState`'s word, and
 * a question mark where nothing could ask), its name, its own line and a link
 * where the task is on this device.
 */
export function workOf(one, known = () => false) {
  return {
    key: one.task,
    name: taskName(one.task),
    mark: stepMark({ finished: one.finished, active: false, state: one.state ?? '' }),
    says: workSaid(one),
    href: known(one.task) ? taskPath(one.task) : null,
  }
}

/**
 * Four facts and the order is the order they matter in: held beats finished,
 * which beats started, which beats parked. `state` is null where nothing
 * could ask for one, and that is said rather than drawn as a blank.
 */
export function workSaid(one) {
  if (one.held) return `held: ${one.held}`
  if (one.finished) return 'finished'
  if (one.started) return 'an agent has been on it'
  if (one.parked) return 'parked, waiting to be approved'
  return one.state ?? 'nothing here knows its state'
}

/** The run a request's work is, as a place to go, or null where it made one task. */
export function runHref(row) {
  return row.run === null ? null : pathOf({ view: 'run', run: row.run })
}

/** A reply that did not go back, in a line, and why. */
export function unsentSaid(one) {
  return {
    said: `Could not say “${one.saying}”, ${plural(one.attempts, 'time')}`,
    why: one.problem ?? 'nothing said why',
  }
}
