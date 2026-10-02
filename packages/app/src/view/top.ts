import type { Frame, McpState } from '../frame.ts'
import { pointingIn, sameTarget, type Target } from '../hits.ts'
import { keyCaps } from '../keys.ts'
import {
  type AgentMark,
  type AgentPane,
  type AppState,
  markGlyph,
  markOf,
  projects,
  shownName,
  shownProject,
  spinner,
} from '../model.ts'
import type { Skin } from '../skin.ts'
import { blank, box, type Drawn, type Pointer, Row, stack } from '../ui.ts'
import { clock } from './text.ts'

// Along the top: the projects you are in one of, the agent that needs you, and
// the key you talk with.
//
// A card for an agent you are not looking at appears here rather than in its
// own pane, because the point of it is that you are somewhere else.
//
// A tab says what is happening in its project, because the project you are
// *not* looking at is the one a row of plain names says nothing about: two of
// them, and a spinner at the right belongs to neither as far as anyone can
// tell. So each tab carries the same marks the agent list does, counted, and
// the figures at the right say whose they are.

/**
 * An agent you are not looking at needs you: a card under the tabs, answerable
 * where it appears. Only for what blocks an agent — news that does not need
 * you goes to the orchestrator's transcript.
 */
export function toastFor(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Drawn | null {
  const shown = state.toasts
    .map((toast) => ({ toast, pane: state.panes.find((pane) => pane.task === toast.task) }))
    .filter(({ pane }) => pane?.waiting && pane.approval && pane.task !== state.focused)
    .at(-1)
  if (!shown?.pane?.approval || width < 70) return null
  const { toast, pane } = shown
  const approval = pane.approval
  if (!approval) return null
  const cardWidth = 52
  const inner = cardWidth - 2
  const seconds = Math.max(0, Math.floor(((frame.now ?? toast.at) - toast.at) / 1000))
  const card = box(
    `${skin.waiting('●')} ${shownProject(state, pane.project)} › ${shownName(pane)}`,
    [
      new Row(inner, skin)
        .space()
        .text('wants approval', skin.waiting)
        .right((r) => r.text(`${seconds}s`, skin.hint).space())
        .build(),
      new Row(inner, skin)
        .space()
        .text(approval.tool, skin.you)
        .space(2)
        .text(approval.summary)
        .build(),
      blank(inner),
      new Row(inner, skin, pointer)
        .space()
        .button('Allow once', { kind: 'action', name: `toast-allow:${pane.task}` }, 'attention')
        .space()
        .button('Deny', { kind: 'action', name: `toast-deny:${pane.task}` })
        .space()
        .button('Show', { kind: 'action', name: `toast-show:${pane.task}` })
        .build(),
    ],
    cardWidth,
    skin,
    { tone: skin.waiting, corner: '×' },
  )
  // The × in the corner closes it.
  card.hits.push({
    row: 0,
    from: cardWidth - 5,
    to: cardWidth - 3,
    target: { kind: 'action', name: `toast-close:${pane.task}` },
  })
  return card
}

/**
 * What a project tab counts: every mark an agent can have, and queued work,
 * which is not an agent yet and so has no mark of its own.
 */
export type ProjectMark = AgentMark | 'queued'

/**
 * The order a project's marks are read in, and the order a tab short of room
 * gives them up in: what a decision is waiting on, then what went wrong, then
 * what is going, then what has not started, then what is sitting there.
 *
 * `done` is not in it: a tab says what is *not* finished, and says `✓` when
 * nothing is left. A count of what is finished beside a count of what is not
 * is two numbers to subtract in your head, four times a second.
 */
const MARKS: readonly ProjectMark[] = [
  'needs-you',
  'failed',
  'working',
  'queued',
  'idle',
  'stopped',
  'parked',
]

/** What is happening in one project, as its tab says it. */
export interface ProjectStanding {
  /** How many of each. A mark with none of something is not drawn at all. */
  counts: Readonly<Record<ProjectMark, number>>
  /** Everything in it that is not finished, of every kind. */
  outstanding: number
  /**
   * Something here finished and nothing is left: the answer to "is everything
   * I asked for done in there?", which is the question a tab is here to save
   * you switching to ask.
   */
  settled: boolean
}

const noneYet = (): Record<ProjectMark, number> => ({
  working: 0,
  idle: 0,
  'needs-you': 0,
  failed: 0,
  done: 0,
  stopped: 0,
  parked: 0,
  queued: 0,
})

/**
 * What is happening in every project, in one pass over the panes.
 *
 * Derived and never kept: the panes are what status last said, so a tally held
 * anywhere would be a second answer to a question `deriveState` has already
 * answered, and wrong the moment an agent finished. One pass because this is
 * drawn every frame, for every project, whether or not you are in it.
 */
export function projectStandings(state: AppState): Map<string, ProjectStanding> {
  const tallies = new Map<string, Record<ProjectMark, number>>()
  for (const pane of state.panes) {
    const tally = tallies.get(pane.project) ?? noneYet()
    tallies.set(pane.project, tally)
    tally[projectMark(pane)] += 1
  }
  const standings = new Map<string, ProjectStanding>()
  for (const [project, counts] of tallies) {
    let outstanding = 0
    for (const mark of MARKS) outstanding += counts[mark]
    standings.set(project, {
      counts,
      outstanding,
      settled: outstanding === 0 && counts.done > 0,
    })
  }
  return standings
}

/**
 * What one task counts as. Queued work is what `markOf` cannot answer for — it
 * reads as stopped, which is why the queue draws its own glyph — so it is
 * named here: held, somebody has to decide about it, which is what `!` means
 * everywhere else and what `markOf` already says; paused, it has been set
 * aside, which is what `‖` means; otherwise it has not started.
 */
function projectMark(pane: AgentPane): ProjectMark {
  const mark = markOf(pane)
  if (!pane.queued || mark === 'needs-you') return mark
  return pane.queued.state.kind === 'paused' ? 'parked' : 'queued'
}

/** How much a project tab says about what is happening in it. */
type TabDetail = 'counts' | 'marks' | 'busiest' | 'none'

/**
 * A tab's label: the project, then what is not finished in it, `✓` where
 * nothing is left, and the name alone where nothing has been asked of it yet.
 *
 * The marks go inside the tab rather than beside it, which costs them their
 * colour — a tab is a painted block. That is the trade worth making: whose a
 * mark is, is the whole of what this change is for, and a glyph outside the
 * block that belongs to the tab on its left as much as the one on its right
 * would be the spinner problem again, one tab along. Shape carries the meaning
 * anyway, which is why every mark has a shape of its own.
 */
function tabLabel(
  shown: string,
  standing: ProjectStanding | undefined,
  detail: TabDetail,
  now: number,
): string {
  if (standing === undefined || detail === 'none') return shown
  const says = tabSays(standing, detail, now)
  return says === '' ? shown : `${shown} ${says}`
}

/**
 * What a tab says beside its name, in the detail there is room for: every mark
 * with its count, the marks alone, or the first of them — which is the most
 * urgent, because `MARKS` is in that order.
 *
 * One of something is the glyph on its own. `!1` and `!` say the same thing
 * and one of them costs a column in every tab; a number earns its place where
 * it is a number you could not have guessed.
 */
function tabSays(standing: ProjectStanding, detail: TabDetail, now: number): string {
  if (standing.settled) return detail === 'counts' ? counted('✓', standing.counts.done) : '✓'
  const present = MARKS.filter((mark) => standing.counts[mark] > 0)
  const first = present[0]
  if (first === undefined) return ''
  if (detail === 'busiest') return markGlyph(first, now)
  if (detail === 'marks') return present.map((mark) => markGlyph(mark, now)).join('')
  return present.map((mark) => counted(markGlyph(mark, now), standing.counts[mark])).join(' ')
}

const counted = (glyph: string, how: number): string => (how === 1 ? glyph : `${glyph}${how}`)

/**
 * Whose the figures at the right are.
 *
 * They are everybody's — `next-waiting` goes to the agent that wants you
 * wherever it is — and a total nobody can place is exactly the spinner this
 * started as. So with more than one project open it is said: the project,
 * where everything counted is in one of them, and how many otherwise. The
 * clause that makes a figure readable, the way `over 3 runs` does.
 *
 * It is not a step of the ladder, which is the point: a figure is drawn with
 * its clause or it is not drawn. What a narrow window gives up is the total —
 * the tabs are still counting, an inch to the left, and each of those says
 * whose it is by being on it.
 */
function whose(
  standings: Map<string, ProjectStanding>,
  marks: readonly ProjectMark[],
): string | null {
  const named: string[] = []
  for (const [project, standing] of standings)
    if (marks.some((mark) => standing.counts[mark] > 0)) named.push(project)
  const only = named[0]
  if (only === undefined) return null
  return named.length === 1 ? `in ${only}` : `in ${named.length} projects`
}

/** How much of the right-hand group is drawn: the fraction, the counts alone, or none. */
type Counts = 'full' | 'short' | 'waiting' | 'none'

/** Which marks a step of `Counts` actually counts, which is what the clause is about. */
const countedBy = (counts: Counts): readonly ProjectMark[] =>
  counts === 'waiting' ? ['needs-you'] : ['needs-you', 'working']

interface Fits {
  tabs: TabDetail
  /** Each tab's own `×` and `≡`, in the six columns kept for them. */
  manage: boolean
  search: boolean
  counts: Counts
  word: boolean
  /**
   * A tab with nowhere left to go may go in the `⋯` beside the `+` rather
   * than the row being cut off at the edge of the terminal. Only the bottom
   * rungs have it, for the reason in `LADDER`.
   */
  hide: boolean
}

/**
 * Room for the caps and nothing else, and a tab in the menu if even that will
 * not do. Dropping the word is the last thing left to drop, and it is the caps
 * that say what to press — a bar that gave up the talk key to keep the word
 * `talk` would have it backwards.
 */
const LAST: Fits = {
  tabs: 'none',
  manage: false,
  search: false,
  counts: 'none',
  word: false,
  hide: true,
}

/**
 * Everything along the top, in the order it gives ground.
 *
 * The talk key is the one thing here that must survive a narrow terminal;
 * search is next. The counts shorten, then go, and the very last thing to go
 * is the word beside the caps — never the caps.
 *
 * The tabs are in the same ladder, and their marks outlive the total at the
 * right: the total is a sum of them, and a sum nobody can place is what sent
 * somebody looking at this row in the first place. So the tabs say it for one
 * project each, all the way down to a single glyph, and the total is what a
 * narrow window does without. One ladder and not two, because two would fit
 * the two ends of one row against each other.
 */
const LADDER: readonly Fits[] = [
  { tabs: 'counts', manage: true, search: true, counts: 'full', word: true, hide: false },
  { tabs: 'counts', manage: true, search: true, counts: 'short', word: true, hide: false },
  { tabs: 'counts', manage: true, search: true, counts: 'waiting', word: true, hide: false },
  // Then the buttons, and giving them up buys the whole right-hand group
  // back — the same trade giving up the search key makes further down. They go
  // here, after the total at the right has shortened as far as it shortens and
  // before a tab gives up a single mark, because six columns *a tab* is the
  // most expensive thing on this row the moment more than one project is open,
  // and they are the only thing here that is a second way to something: the
  // menu is a right-click on the tab either way, and closing is in it. What a
  // mark says is not reachable any other way, so every mark outlives them.
  { tabs: 'counts', manage: false, search: true, counts: 'full', word: true, hide: false },
  { tabs: 'counts', manage: false, search: true, counts: 'short', word: true, hide: false },
  { tabs: 'counts', manage: false, search: true, counts: 'waiting', word: true, hide: false },
  { tabs: 'marks', manage: false, search: true, counts: 'waiting', word: true, hide: false },
  // Giving up search buys the working count back, as it always did: down here
  // the counts are worth more than a key that has a shortcut of its own.
  { tabs: 'marks', manage: false, search: false, counts: 'short', word: true, hide: false },
  { tabs: 'marks', manage: false, search: false, counts: 'waiting', word: true, hide: false },
  { tabs: 'busiest', manage: false, search: false, counts: 'waiting', word: true, hide: false },
  { tabs: 'busiest', manage: false, search: false, counts: 'none', word: true, hide: false },
  { tabs: 'none', manage: false, search: false, counts: 'none', word: true, hide: false },
  // The row at its poorest with every project still on it: names alone, and
  // the word beside the caps gone. `LAST` is this rung again at the bottom,
  // and the only thing between them is whether a tab may be put away.
  { tabs: 'none', manage: false, search: false, counts: 'none', word: false, hide: false },
  // Everything above here draws every project there is. Below it a tab goes in
  // the `⋯` beside the `+`, which says how many went and the most urgent thing
  // in any of them, and whose menu is the list of them.
  //
  // It is the last thing the row gives up — under the total at the right, under
  // the tabs' own counts and under their marks — because it is the only thing
  // here that takes something off the screen rather than shortening it. A row
  // of plain names that fits is still a row where every project is one click
  // away, and that is worth more than a mark.
  //
  // And then the first thing putting a tab away buys is the marks back, which
  // is why these three are the three above them again, in the same order: by
  // the time a tab has gone there is room for the rest to say something, and a
  // tab that says nothing in a row that is already not showing everything
  // would be giving up twice over.
  { tabs: 'busiest', manage: false, search: false, counts: 'none', word: true, hide: true },
  { tabs: 'none', manage: false, search: false, counts: 'none', word: true, hide: true },
  LAST,
]

/** What there is room for on the row, and what the `⋯` beside it holds. */
interface Strip {
  /** The tabs drawn, in the order the tabs are arranged in. */
  shown: readonly string[]
  /** The rest, in that same order: what the `⋯` menu lists. */
  hidden: readonly string[]
  /** Columns the left-hand group takes, the `⋯` and the `+` included. */
  used: number
  /** Whether that is room the rung being tried actually has. */
  fits: boolean
}

/**
 * Which projects keep a tab where there is not room for every one of them: the
 * ones arranged first, and the one you are in — which is never in the menu.
 *
 * Two rules, and deliberately not three. Where a tab sits is already somebody's
 * to arrange — `moveProject`, and Move left in a tab's own menu — so what is on
 * the row is that same arrangement read from the front, one answer to one
 * question. The other shape this could have had is recency, keeping the projects
 * you were in last: not taken, because it would be a second and silent answer to
 * the question the arrangement already answers, and a row whose tabs come and go
 * as you move about is a row you have to read again every time you look at it.
 *
 * Where you are is the one exception, and it is not a third rule but what makes
 * the first one safe: a row with no tab for the project you are standing in is
 * not a shortened row, it is a wrong one.
 */
export function tabsShown(
  order: readonly string[],
  active: string | null,
  how: number,
): readonly string[] {
  const keep = Math.max(1, Math.min(order.length, how))
  if (keep === order.length) return order
  const here = active !== null && order.includes(active) ? active : null
  const held = new Set(
    order.filter((project) => project !== here).slice(0, keep - (here === null ? 0 : 1)),
  )
  if (here !== null) held.add(here)
  return order.filter((project) => held.has(project))
}

/**
 * What the `⋯` says: how many projects have no tab, and the most urgent thing
 * happening in any of them.
 *
 * The count, because "is anything missing" is the question a row that does not
 * show everything raises, and a row that quietly showed eight of twelve would
 * never answer it. The mark, because the whole point of a tab is that an agent
 * wanting you in a project you are not looking at says so — and a project
 * whose marks went in a menu would be the one place that stopped being true.
 *
 * `✓` is not among them, for `tabSays`' reason: this is what is *not*
 * finished, and a tick standing for some of several projects says nothing.
 */
function moreLabel(
  hidden: readonly string[],
  standings: Map<string, ProjectStanding>,
  now: number,
): string {
  const mark = MARKS.find((one) =>
    hidden.some((project) => (standings.get(project)?.counts[one] ?? 0) > 0),
  )
  return mark === undefined ? `⋯${hidden.length}` : `⋯${hidden.length} ${markGlyph(mark, now)}`
}

/**
 * What a tab would have said beside its name, for a project with no tab: the
 * menu of them carries the same marks and counts the row does, so putting a
 * tab away never loses what it was saying.
 */
export function projectSays(standing: ProjectStanding | undefined, now: number): string {
  return standing === undefined ? '' : tabSays(standing, 'counts', now)
}

export function renderTop(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const now = frame.now ?? 0
  const standings = projectStandings(state)
  const open = projects(state)
  // One project is never ambiguous, and is never told whose its own figures
  // are: the clause would be a caveat on something nobody could misread.
  const many = open.length > 1
  // The same marks the list shows: an agent idle at its prompt is not waiting
  // on you. Added up out of the standings rather than counted again, so the
  // total at the right and the marks on the tabs can never disagree.
  let waiting = 0
  let working = 0
  for (const standing of standings.values()) {
    waiting += standing.counts['needs-you']
    working += standing.counts.working
  }

  // The wordmark, a tab per project, the `⋯` for any with no room, then the
  // `+` — one function per control, because what a thing costs is asked of the
  // thing that draws it. Working out what fits calls these exactly as the
  // drawing does, so the row can never be measured as one shape and drawn as
  // another.
  const wordmark = (r: Row): void => void r.space().mark('TADE').space(2)
  const plus = (r: Row): void =>
    void r.space().button(' + ', { kind: 'action', name: 'open-project' }, 'add')
  // A tab's own `×` and `≡` are drawn the way a terminal's are, and the
  // argument is that file's (`bottomTabs`, `view/foot.ts`): always there, so
  // the room is paid for once rather than taken out from under the hand
  // sweeping along the row, and the tab stays lit while the pointer is on
  // either of them, so reaching for a close is never leaving the tab.
  const tabOf = (r: Row, project: string, label: string, manage: boolean): void => {
    const target: Target = { kind: 'project', project }
    const menu: Target = { kind: 'menu', subject: { kind: 'project', project } }
    const close: Target = { kind: 'action', name: `close-project:${project}` }
    const within = manage && pointingIn(state.hover, [target, menu, close])
    r.tab(label, target, project === state.project, within)
    if (manage) r.icon('×', close, 'danger').icon('≡', menu)
  }
  // The one control that is a project you cannot see. A chip rather than a tab,
  // because it is not one of them and must never read as the project you are
  // in, and it carries the names so that the menu it opens is the list of them
  // — what fits is the drawing's to say, and this is the drawing saying it.
  const moreOf = (r: Row, hidden: readonly string[], label: string): void =>
    void r.chip(label, { kind: 'menu', subject: { kind: 'projects', hidden: [...hidden] } })

  const probed = (draw: (r: Row) => void): number => {
    const probe = new Row(width, skin)
    draw(probe)
    return probe.used
  }
  // The wordmark and the `+`, which no rung of the ladder changes.
  const chrome = probed(wordmark) + probed(plus)
  // Four labellings and six costings at most, and the ladder asks for them
  // fourteen times.
  const labelled = new Map<TabDetail, Map<string, string>>()
  const labels = (detail: TabDetail): Map<string, string> => {
    const already = labelled.get(detail)
    if (already) return already
    const made = new Map<string, string>()
    for (const project of open)
      made.set(project, tabLabel(shownProject(state, project), standings.get(project), detail, now))
    labelled.set(detail, made)
    return made
  }
  const measured = new Map<string, Map<string, number>>()
  const costs = (fits: Fits): Map<string, number> => {
    const key = `${fits.tabs}\u0000${fits.manage}`
    const already = measured.get(key)
    if (already) return already
    const label = labels(fits.tabs)
    const cost = new Map<string, number>()
    for (const project of open)
      cost.set(
        project,
        probed((r) => tabOf(r, project, label.get(project) ?? project, fits.manage)),
      )
    measured.set(key, cost)
    return cost
  }

  /** What one rung draws in the room it is left, and what it has to put away. */
  const stripFor = (fits: Fits, room: number): Strip => {
    const cost = costs(fits)
    const spent = (tabs: readonly string[]): number =>
      tabs.reduce((sum, project) => sum + (cost.get(project) ?? 0), 0)
    const every = chrome + spent(open)
    const all: Strip = { shown: open, hidden: [], used: every, fits: every <= room }
    if (all.fits || !fits.hide) return all
    for (let how = open.length - 1; how >= 1; how--) {
      const shown = tabsShown(open, state.project, how)
      const hidden = open.filter((project) => !shown.includes(project))
      // The `⋯` measured as it will be drawn, label and all, rather than at the
      // widest it could ever be: a column guessed high here is a whole tab put
      // away to make room for one that was never going to be used.
      const used =
        chrome + probed((r) => moreOf(r, hidden, moreLabel(hidden, standings, now))) + spent(shown)
      // One tab and the `⋯`, in a terminal with room for neither, is where this
      // gives out — and what to do about that is the caller's.
      if (used <= room || how === 1) return { shown, hidden, used, fits: used <= room }
    }
    return all
  }

  const right = (show: Fits) => (r: Row) => {
    if (waiting > 0 && show.counts !== 'none') {
      const label = show.counts === 'full' ? `! ${waiting} waiting` : `! ${waiting}`
      r.text(label, skin.waiting, { kind: 'action', name: 'next-waiting' }).space(2)
    }
    if (working > 0 && (show.counts === 'full' || show.counts === 'short')) {
      const turning = spinner(now)
      r.text(
        show.counts === 'full' ? `${turning} ${working} working` : `${turning} ${working}`,
        skin.busy,
      ).space(3)
    }
    const said = many && show.counts !== 'none' ? whose(standings, countedBy(show.counts)) : null
    if (said !== null) r.text(said, skin.hint).space(3)
    // Search, beside talking: the two keys that work from anywhere.
    if (show.search) {
      const search: Target = { kind: 'action', name: 'search' }
      r.keys(keyCaps(frame.bindings?.search ?? 'ctrl+k')).space()
      r.text('search', sameTarget(state.hover, search) ? skin.link : skin.hint, search).space(3)
    }
    // Beside the talk key, which is the other thing on this row that is true
    // of the window rather than of a project: whether the tools agents are
    // being handed are actually there.
    mcpLight(r, frame, skin, show.word)
    talkChip(r, state, frame, skin, show.word)
    r.space()
  }

  // Each rung tried once and kept, because the rung that fits is asked for its
  // strip again and the two answers have to be the one answer.
  const tried = new Map<Fits, Strip>()
  const stripOf = (show: Fits): Strip => {
    const already = tried.get(show)
    if (already) return already
    const probe = new Row(width, skin)
    right(show)(probe)
    // A column of clear between the two groups, which is what `Row` keeps for
    // a right-hand group of its own.
    const strip = stripFor(show, width - probe.used - 1)
    tried.set(show, strip)
    return strip
  }
  const found = LADDER.find((show) => stripOf(show).fits)
  const fits = found ?? LAST
  // Nothing fitted at all, and then the right-hand group is dropped whole
  // (`Row.build` keeps the row's width and lets its pinned group go) — so the
  // room the tabs have is the whole row, and they are measured against that
  // instead. A tab put away to make space for something that is not going to
  // be drawn is a tab given up for nothing, and that is what a very narrow
  // window got: one tab and a `⋯2` where three tabs fitted.
  const strip = found ? stripOf(found) : stripFor(LAST, width)
  const row = new Row(width, skin, pointer)
  wordmark(row)
  const label = labels(fits.tabs)
  for (const project of strip.shown) tabOf(row, project, label.get(project) ?? project, fits.manage)
  if (strip.hidden.length > 0) moreOf(row, strip.hidden, moreLabel(strip.hidden, standings, now))
  plus(row)
  row.right(right(fits))
  return stack([row.build(), { text: skin.chrome('━'.repeat(width)), hits: [] }])
}

/**
 * Which of however many servers the lamp is about: the worst of them.
 *
 * A light is one word, and the word somebody needs is the one they would have
 * to do something about. In this order, so a server that has stopped answering
 * is never hidden behind one that is merely off — and `off` only wins where
 * every one of them is off, which is then the whole of what there is to say.
 *
 * Derived every frame out of what the broker was handed, and never kept: a lamp
 * lit from a remembered answer says a server is up after it dropped, which is
 * the one failure this is here to stop.
 */
const WORST: readonly McpState[] = ['unreachable', 'broken', 'unknown', 'on', 'off']

function worstServer(states: readonly McpState[] | undefined): McpState | null {
  return WORST.find((state) => states?.includes(state)) ?? null
}

/**
 * What the lamp is in each state: a glyph, its tone, and what it says where
 * there is room for more than the label.
 *
 * Every state has a shape of its own, for the reason a tab's marks do — the row
 * is read at a glance, and on terminals with no colour in them. The two that
 * need somebody keep a word: a mark on its own says something is wrong, and
 * `broken` and `unreachable` are different jobs.
 */
function serverLook(
  state: McpState,
  skin: Skin,
): { glyph: string; tone: (text: string) => string; says: string } {
  switch (state) {
    // It was reachable and has stopped answering: the drop, and the one state
    // nobody had any way of seeing before this lamp.
    case 'unreachable':
      return { glyph: '✕', tone: skin.bad, says: 'down' }
    // Something has to be done before it could work at all: a program that is
    // not installed, a credential nothing has, an address nothing says.
    case 'broken':
      return { glyph: '!', tone: skin.waiting, says: 'broken' }
    // On, and nothing has asked it anything yet. Never drawn as healthy: the
    // warm-up happens after the window is up, and a green lamp before anybody
    // had spoken to the server is the reassurance this lamp exists to refuse.
    case 'unknown':
      return { glyph: '◌', tone: skin.hint, says: '' }
    case 'on':
      return { glyph: '●', tone: skin.done, says: '' }
    default:
      return { glyph: '○', tone: skin.chrome, says: '' }
  }
}

/**
 * The MCP servers, as one small light: on, off, broken or not answering, where
 * somebody can see it without opening the Extensions page — which is where it
 * goes when it is pressed, because the page is what can actually say why.
 *
 * Nothing at all where nobody has decided about a server, which is nearly
 * everybody: a dark lamp for software nobody here runs is a column spent on a
 * question nobody asked.
 */
function mcpLight(r: Row, frame: Frame, skin: Skin, word = true): void {
  const worst = worstServer(frame.mcp)
  if (worst === null) return
  const look = serverLook(worst, skin)
  const open: Target = { kind: 'action', name: 'extensions' }
  // The label stays at every width, even where the word beside it goes: a mark
  // on its own next to the talk key is a mark nobody can place, and this row
  // already has a `✕` on it for a muted speaker.
  const said = word && look.says !== '' ? `${look.glyph} mcp ${look.says}` : `${look.glyph} mcp`
  r.text(said, look.tone, open).space(3)
}

/**
 * The key you talk with, always on screen, in whatever state talking is in.
 * Red while the microphone is open: that is never something to have to infer.
 */
function talkChip(r: Row, state: AppState, frame: Frame, skin: Skin, word = true): void {
  const voice = frame.voice ?? { keys: ['ctrl', 'space'], available: false }
  const target: Target = { kind: 'action', name: 'voice' }
  if (state.talkingSince !== null && state.listening) {
    const seconds = Math.max(
      0,
      Math.floor(((frame.now ?? state.talkingSince) - state.talkingSince) / 1000),
    )
    r.text(` ● TX ${clock(seconds)} `, skin.transmit, target)
    return
  }
  if (state.hearing) {
    r.text('◌ transcribing…', skin.hint, target)
    return
  }
  if (frame.muted) {
    r.text('✕ muted', skin.bad, { kind: 'action', name: 'mute' }).space(2)
  }
  if (!voice.available) {
    // Said, not left to be discovered by holding a key that does nothing.
    r.text('× voice off', skin.bad, target).space()
    r.button('Set up', target)
    return
  }
  // Without the word the caps are the whole control, so they take the target:
  // a chip nobody can click is not a chip that survived.
  if (!word) return void r.keys(voice.keys, target)
  r.keys(voice.keys).space()
  r.text('talk', skin.hint, target)
}
