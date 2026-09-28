import type { Frame } from '../frame.ts'
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
}

/**
 * Room for the caps and nothing else. Dropping the word is the last thing left
 * to drop, and it is the caps that say what to press — a bar that gave up the
 * talk key to keep the word `talk` would have it backwards.
 */
const LAST: Fits = { tabs: 'none', manage: false, search: false, counts: 'none', word: false }

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
  { tabs: 'counts', manage: true, search: true, counts: 'full', word: true },
  { tabs: 'counts', manage: true, search: true, counts: 'short', word: true },
  { tabs: 'counts', manage: true, search: true, counts: 'waiting', word: true },
  // Then the buttons, and giving them up buys the whole right-hand group
  // back — the same trade giving up the search key makes further down. They go
  // here, after the total at the right has shortened as far as it shortens and
  // before a tab gives up a single mark, because six columns *a tab* is the
  // most expensive thing on this row the moment more than one project is open,
  // and they are the only thing here that is a second way to something: the
  // menu is a right-click on the tab either way, and closing is in it. What a
  // mark says is not reachable any other way, so every mark outlives them.
  { tabs: 'counts', manage: false, search: true, counts: 'full', word: true },
  { tabs: 'counts', manage: false, search: true, counts: 'short', word: true },
  { tabs: 'counts', manage: false, search: true, counts: 'waiting', word: true },
  { tabs: 'marks', manage: false, search: true, counts: 'waiting', word: true },
  // Giving up search buys the working count back, as it always did: down here
  // the counts are worth more than a key that has a shortcut of its own.
  { tabs: 'marks', manage: false, search: false, counts: 'short', word: true },
  { tabs: 'marks', manage: false, search: false, counts: 'waiting', word: true },
  { tabs: 'busiest', manage: false, search: false, counts: 'waiting', word: true },
  { tabs: 'busiest', manage: false, search: false, counts: 'none', word: true },
  { tabs: 'none', manage: false, search: false, counts: 'none', word: true },
  LAST,
]

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

  // The wordmark, a tab per project, then the `+`. Built as a function of how
  // much a tab says, because what fits is decided by trying, and neither end
  // of the row can be measured without the other.
  //
  // A tab's own `×` and `≡` are drawn the way a terminal's are, and the
  // argument is that file's (`bottomTabs`, `view/foot.ts`): always there, so
  // the room is paid for once rather than taken out from under the hand
  // sweeping along the row, and the tab stays lit while the pointer is on
  // either of them, so reaching for a close is never leaving the tab.
  const left = (fits: Pick<Fits, 'tabs' | 'manage'>) => (r: Row) => {
    r.space().mark('TADE').space(2)
    for (const project of open) {
      const target: Target = { kind: 'project', project }
      const menu: Target = { kind: 'menu', subject: { kind: 'project', project } }
      const close: Target = { kind: 'action', name: `close-project:${project}` }
      const label = tabLabel(shownProject(state, project), standings.get(project), fits.tabs, now)
      const within = fits.manage && pointingIn(state.hover, [target, menu, close])
      r.tab(label, target, project === state.project, within)
      if (fits.manage) r.icon('×', close, 'danger').icon('≡', menu)
    }
    r.space().button(' + ', { kind: 'action', name: 'open-project' }, 'add')
  }
  // Six widths at most, and the ladder asks for them thirteen times.
  const measured = new Map<string, number>()
  const leftWidth = (fits: Pick<Fits, 'tabs' | 'manage'>): number => {
    const key = `${fits.tabs}\u0000${fits.manage}`
    const already = measured.get(key)
    if (already !== undefined) return already
    const probe = new Row(width, skin)
    left(fits)(probe)
    measured.set(key, probe.used)
    return probe.used
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
    talkChip(r, state, frame, skin, show.word)
    r.space()
  }

  const fits =
    LADDER.find((show) => {
      const probe = new Row(width, skin)
      right(show)(probe)
      return leftWidth(show) + 1 + probe.used <= width
    }) ?? LAST
  const row = new Row(width, skin, pointer)
  left(fits)(row)
  row.right(right(fits))
  return stack([row.build(), { text: skin.chrome('━'.repeat(width)), hits: [] }])
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
