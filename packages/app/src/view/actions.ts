import { visibleWidth } from '@earendil-works/pi-tui'
import { duration } from '@tade/core'
import type { ActionsView, CheckView, CommitView, Frame } from '../frame.ts'
import { type Hit, rowHit, sameTarget, type Target } from '../hits.ts'
import { type AgentPane, type AppState, sectionOpen, spinner } from '../model.ts'
import type { Skin } from '../skin.ts'
import { blank, type Pointer, Row } from '../ui.ts'
import { reviewRows } from './list.ts'
import { shortened, shortPath, spell, tailOf } from './text.ts'

// What an agent did, and whether it holds up: one page.
//
// Its own commits, read out of the `Tade-Task:` trailer and drawn apart from
// everybody else's; what is changed and not committed, which in a shared
// checkout is nobody's to attribute; the review it is out for; and every check
// that ran — when, against which commit, how long it took, what it counted,
// and the tail of what it printed.
//
// The checks are two categories and not one list, because a project's checks
// are read out of its own CI and its own commit hook now and the reading says
// which of them cannot run *here*. Drawn together, every row carried a sentence
// about where it came from and why it does or does not run, each one true and
// all of them a wall. So: what Tade runs here, in full; and what it does not,
// folded away with the reason a click from being read, in the shape the sidebar
// already uses for the same thing. Which category a check is in is a person's
// to change, from the row itself (`choice.ts` in the checks port).
//
// Everything here is a query somebody else answered. Nothing in this file
// reads a file or asks a forge, and `unknown` is drawn as `unknown`.

/** The fold that holds what Tade does not run here. One name, so it stays where you left it. */
export const NOT_HERE = 'checks-not-here'

/**
 * What an agent has actually done, where its screen would be: the commits it
 * made itself, kept apart from everybody else's; what it has changed and not
 * committed; the review it is out for; and how the project's own checks stand
 * at the commit in hand — what each one ran, how long it took, what it
 * counted, and what it printed.
 *
 * Everything here is a query somebody else answered: the rows are drawn from
 * the frame, and nothing in this function reads a file or asks a forge. The
 * page is laid out in full and handed back; the pane windows it and puts a
 * bar beside it, because a page that folds itself up is a page that hides the
 * failure you opened it for.
 */
export function actionRows(
  view: ActionsView | null,
  pane: AgentPane,
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): { text: string; hits: Hit[] }[] {
  const rows: { text: string; hits: Hit[] }[] = []
  const now = frame.now ?? 0
  const line = (build: (r: Row) => void, indent = 2) => {
    const r = new Row(width, skin, pointer).space(indent)
    build(r)
    rows.push(r.build())
  }
  const said = (text: string, from = 6) => shortened(text, Math.max(1, width - from))
  if (!view) {
    rows.push(blank(width))
    line((r) => r.text('Nothing is known about this work yet.', skin.hint))
    return rows
  }

  const measure = (build: (r: Row) => void) => measured(build, width, skin)

  /**
   * A section: its name, how many are in it, a rule to where what it adds up
   * to begins, and the controls that act on it pinned to the edge. Each
   * section a page is announced the same way — the grouping is the whole of the
   * design here — and one that folds carries the same `▸`/`▾` and the same
   * count beside it the sidebar's sections do, because it is the same act and
   * nobody should have to learn it twice.
   *
   * What it says about itself gives ground one clause at a time, from the back:
   * the caveat before the rollup, the rollup before the button that runs them.
   * A caveat that is true under every row of a section belongs on that
   * section's heading — never a footnote under each row — and the last thing a
   * narrow window may take away is the control.
   */
  const heading = (
    label: string,
    notes: readonly ((r: Row) => void)[],
    controls?: (r: Row) => void,
    fold?: { section: string; open: boolean; count: number },
  ) => {
    const shown = fold ? `${fold.open ? '▾' : '▸'} ${label}` : label
    const badge = fold ? ` ${fold.count} ` : ''
    const left = 2 + visibleWidth(shown) + visibleWidth(badge) + (badge ? 1 : 0) + 1
    const group = (many: number) => (r: Row) => {
      notes.slice(0, many).forEach((note, i) => {
        if (i > 0) r.text(' · ', skin.chrome)
        note(r)
      })
      if (many > 0) r.space(controls ? 2 : 1)
      if (controls) controls(r)
    }
    let said: ((r: Row) => void) | null = null
    for (let many = notes.length; many >= 0; many--) {
      const next = group(many)
      // The rule is drawn to whatever is left, never to a group that will not
      // fit and is dropped, which leaves the heading with a stub of a line and
      // a hole after it.
      if (left + measure(next) + 2 <= width) {
        said = next
        break
      }
    }
    const r = new Row(width, skin, pointer).space(2)
    if (fold) {
      r.text(shown, skin.label, { kind: 'section', section: fold.section, quiet: true }).space()
      r.badge(fold.count)
    } else {
      r.text(shown, skin.label)
    }
    r.space()
    r.text('─'.repeat(Math.max(1, width - r.used - (said ? measure(said) : 0) - 2)), skin.chrome)
    if (said) r.right(said)
    rows.push(r.build())
  }

  // ── Where the work is ──────────────────────────────────────────────────
  rows.push(blank(width))
  const ahead = view.ahead ?? 0
  const standing =
    ahead === 0 && view.mine.length === 0
      ? 'nothing committed yet'
      : [
          `${ahead} ahead${view.base ? ` of ${view.base}` : ''}`,
          view.behind ? `${view.behind} behind` : '',
        ]
          .filter(Boolean)
          .join(' · ')
  line((r) => {
    r.text(
      tailOf(view.branch ?? 'no branch yet', Math.max(8, width - standing.length - 8)),
      skin.you,
    )
    r.right((g) => g.text(standing, skin.hint).space(2))
  })
  // The review this branch is out for, drawn the way it is drawn down the
  // side: its number and title over what its checks and verdicts came to and
  // how long it has been open. One drawing, so the page and the side can never
  // come to two readings of one answer — which is what taking this row apart
  // out of the side's drawn title used to risk.
  if (view.review) {
    rows.push(...reviewRows(width, skin, pointer, view.review, now))
  }

  // ── What this agent committed, and what it has not ─────────────────────
  rows.push(blank(width))
  const added = view.mine.reduce((sum, one) => sum + (one.added ?? 0), 0)
  const removed = view.mine.reduce((sum, one) => sum + (one.removed ?? 0), 0)
  heading('THIS AGENT’S COMMITS', [
    (g) => {
      if (view.mine.length === 0) return void g.text('none yet', skin.hint)
      g.text(`${view.mine.length}`, skin.hint)
      if (added > 0) g.text(` +${added}`, skin.done)
      if (removed > 0) g.text(` −${removed}`, skin.bad)
    },
  ])
  for (const commit of view.mine.slice(0, OWN_COMMITS)) {
    line((r) => commitRow(r, commit, now, skin, true))
  }
  if (view.mine.length > OWN_COMMITS) {
    line((r) => r.text(`and ${view.mine.length - OWN_COMMITS} more`, skin.hint), 4)
  }
  // Uncommitted work is this agent's outstanding work — except where it is
  // not, which is every shared checkout, and is said rather than counted as
  // its own.
  if (view.dirty === 0) {
    line((r) => r.text('◌', skin.chrome).space().text('Nothing uncommitted.', skin.hint))
  } else {
    const files = `${view.dirty} file${view.dirty === 1 ? '' : 's'} not committed`
    const whose = view.shared ? 'shared checkout — nobody’s to attribute' : 'its own worktree'
    line((r) => {
      r.text('◌', skin.waiting).space().text(files, skin.you)
      r.right((g) => g.text(shortened(whose, Math.max(10, width - 30)), skin.hint).space(2))
    })
  }

  // ── How it stands ──────────────────────────────────────────────────────
  //
  // Two categories, and which a check is in is one question: does Tade run it
  // on this machine? `skip` is the whole of the answer, whether it was the
  // reading that said so or a person.
  rows.push(blank(width))
  const here = view.checks.filter((check) => check.skip === null)
  const not = view.checks.filter((check) => check.skip !== null)
  const run: Target = { kind: 'action', name: `checks-run:${pane.task}` }
  const going = view.running
  const at = view.commit ? view.commit.slice(0, 7) : 'no commit'
  // The longest run on the page, which is what every other one's mark is a
  // share of: a bar against a number somebody picked says nothing. With one
  // run there is nothing to be a share of either, so nothing is drawn — a full
  // bar beside `2.2s` says slow, and it would be the only run there was.
  const timed = here.filter((check) => check.seconds !== null)
  const longest = timed.length > 1 ? Math.max(...timed.map((check) => check.seconds ?? 0)) : 0
  /** What the required checks add up to, in a word — and `unknown` is one of the three. */
  const words = (g: Row) => {
    if (going) {
      g.text(`${going.done} of ${going.total}`, skin.busy)
        .space()
        .text(spell((now - going.since) / 1000), skin.hint)
      return
    }
    if (here.length === 0) return void g.text('nothing runs here', skin.waiting)
    if (!view.commit) return void g.text('no commit to check yet', skin.waiting)
    const word =
      view.rollup === 'pass' ? 'green' : view.rollup === 'fail' ? 'red' : 'nobody has run these'
    const tone =
      view.rollup === 'pass' ? skin.done : view.rollup === 'fail' ? skin.bad : skin.waiting
    g.text(word, tone).text(` at ${at}`, skin.hint)
  }
  const button = (r: Row) => {
    r.button(going ? 'Running…' : 'Run all', run, going ? 'rest' : 'primary').space()
  }
  // One cell per check, in its own tone: the whole gate at a glance, and the
  // same strip while a run goes with the one that is going turning. Never
  // shortened, because a strip that hid the red one would be the one thing
  // worse than no strip — so where a long gate leaves no room for both, the
  // picture goes and the word it is a picture of stays.
  const strip =
    here.length > 0 &&
    here.length + 2 <=
      width - (2 + visibleWidth('CHECKS') + 1) - measure(words) - measure(button) - 5
  const rollup = (g: Row) => {
    if (strip) {
      for (const check of here) {
        g.text(
          check.state === 'running' ? spinner(now) : glyphFor(check.state),
          toneOf(check.state, skin),
        )
      }
      g.space(2)
    }
    words(g)
  }
  heading(
    'CHECKS',
    [
      rollup,
      // What this cannot say, beside what it adds up to: a local run is the
      // commands CI runs and never CI's matrix, which is true of every row
      // under it and so is said once, here, or not at all.
      ...(view.notes.length > 0
        ? [(g: Row) => g.text(shortened(view.notes.join(' · '), 44), skin.hint)]
        : []),
    ],
    button,
  )
  // Where they came from is load-bearing in exactly one case: there are none,
  // and then the sentence *is* the answer — nothing in this project says what
  // checking it means.
  if (view.checks.length === 0) {
    line((r) => r.text(said(view.source), skin.hint))
  }
  // The id column is sized from the longest id on the page, not from a number
  // somebody picked: ids are the names of steps in somebody's CI now, so
  // `integration-tests` is as ordinary as `types`, and a fixed width shoves
  // every column after it out of line on exactly the row that is longest. Both
  // categories share it, so the two read as one list folded in half.
  const pad = Math.max(8, ...view.checks.map((check) => visibleWidth(check.id)))
  for (const check of here) {
    rows.push(...checkRows(check, pane.task, state, now, width, skin, pointer, pad, longest))
  }
  // ── And what it does not run ───────────────────────────────────────────
  if (not.length + view.unread.length > 0) {
    const open = sectionOpen(state, NOT_HERE, true)
    heading('NOT RUN HERE', [], undefined, {
      section: NOT_HERE,
      open,
      count: not.length + view.unread.length,
    })
    if (open) {
      for (const check of not) {
        rows.push(...skippedRow(check, pane.task, width, skin, pointer, pad))
      }
      // A step the reading could not place as a check at all: named, because
      // Tade checking less than CI does is only safe while it says so, and
      // with nothing to run there is nothing here to turn on.
      for (const problem of view.unread) {
        line((r) => r.text('·', skin.chrome).space().text(said(problem, 8), skin.hint), 4)
      }
    }
  }
  // ── What else landed on this branch ────────────────────────────────────
  if (view.others.length > 0) {
    rows.push(blank(width))
    heading('ALSO ON THIS BRANCH', [
      (g) => g.text(`${view.others.length}, not this agent’s`, skin.hint),
    ])
    for (const commit of view.others.slice(0, OTHER_COMMITS)) {
      line((r) => commitRow(r, commit, now, skin, false))
    }
    if (view.others.length > OTHER_COMMITS) {
      line((r) => r.text(`and ${view.others.length - OTHER_COMMITS} more`, skin.hint), 4)
    }
  }
  return rows
}

/** How many of each kind of commit the page shows before it says how many more. */
const OWN_COMMITS = 5
const OTHER_COMMITS = 2

/** One commit: whose it is in the glyph, what it touched on the right. */
export function commitRow(r: Row, commit: CommitView, now: number, skin: Skin, own: boolean): void {
  const touched = [
    commit.files === null ? '' : `${commit.files} file${commit.files === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join('')
  const when = commit.at > 0 ? `${duration(Math.max(0, now - commit.at))} ago` : ''
  const group = (g: Row) => {
    if (!own && commit.task) g.text(shortened(commit.task, 22), skin.hint).space(2)
    if (touched) g.text(touched, skin.hint).space()
    if (commit.added) g.text(`+${commit.added}`, skin.done).space()
    if (commit.removed) g.text(`−${commit.removed}`, skin.bad).space()
    if (when) g.space().text(when, skin.hint)
    g.space()
  }
  const probe = new Row(r.width, skin)
  group(probe)
  r.text(own ? '●' : '·', own ? skin.done : skin.chrome)
    .space()
    .text(commit.sha.slice(0, 7), skin.hint)
    .space()
  const room = Math.max(6, r.width - r.used - probe.used - 2)
  r.text(shortened(commit.subject, room), own ? (text) => text : skin.hint)
  r.right(group)
}

/**
 * One check Tade runs here, as one row: how it went, a mark for how long it
 * took beside the figure, when, and what it counted, pinned right — which is
 * the answer somebody came for. A failure keeps the first file it named,
 * because that is what the page is opened for.
 *
 * Opened — clicked — it adds what it actually ran, the rest of the files, the
 * last of what it printed, and the two acts that belong to one check: the
 * whole log, and not running it here any more.
 */
export function checkRows(
  check: CheckView,
  task: string,
  state: AppState,
  now: number,
  width: number,
  skin: Skin,
  pointer: Pointer,
  /** How wide the id column is: the longest id on the page, so they line up. */
  pad = 8,
  /** The longest run on the page, which the mark beside each figure is a share of. */
  longest = 0,
): { text: string; hits: Hit[] }[] {
  const rows: { text: string; hits: Hit[] }[] = []
  const target: Target = { kind: 'check', task, check: check.id }
  const open = state.openCheck[task] === check.id
  const red = check.state === 'failed' || check.state === 'timed out'
  const tone = toneOf(check.state, skin)
  const line = (build: (r: Row) => void, indent = 6) => {
    const r = new Row(width, skin, pointer).space(indent)
    build(r)
    rows.push(r.build())
  }
  const took =
    check.state === 'running' && check.startedAt
      ? spell((now - check.startedAt) / 1000)
      : check.seconds === null
        ? ''
        : spell(check.seconds)
  // A run carried to this commit says where it ran instead of when, because
  // when it ran is a fact about that other commit: it stood over the very
  // bytes this one holds, and a tick nobody can place is a tick nobody owes.
  const when =
    check.state === 'running'
      ? 'going now'
      : check.state === 'queued'
        ? 'waiting its turn'
        : check.carried && check.commit
          ? `ran at ${check.commit.slice(0, 7)}`
          : check.at
            ? `${duration(Math.max(0, now - check.at))} ago`
            : 'never run'
  const hovered = sameTarget(pointer.hover, target)
  const head = new Row(width, skin, pointer).space(2)
  head
    .text(check.state === 'running' ? spinner(now) : glyphFor(check.state), tone)
    .space()
    .text(check.id.padEnd(pad), hovered ? skin.you : (text) => text)
    .space(2)
    .text(spark(check.seconds, longest), skin.hint)
    .space()
    .text(took.padStart(6), skin.hint)
    .space(2)
    .text(when, skin.hint)
  head.right((g) => {
    if (check.counts.length > 0) {
      check.counts.forEach((count, i) => {
        if (i > 0) g.text(' · ', skin.chrome)
        const paint =
          count.tone === 'good' ? skin.done : count.tone === 'bad' ? skin.bad : skin.hint
        g.text(`${count.count} ${count.label}`, count.count === 0 ? skin.hint : paint)
      })
    } else if (check.summary && check.state !== 'passed') {
      g.text(shortened(check.summary, Math.max(8, Math.floor(width / 2))), skin.hint)
    } else if (!check.required) {
      g.text('not required', skin.hint)
    }
    // What is under the row, as the sidebar says it: one column, quiet, and
    // the whole row is what opens it. Never a block of colour on every row of
    // a list — the thing to read here is which check is red.
    g.space(2)
      .text(open ? '▴' : '▾', open ? skin.signal : skin.chrome)
      .space()
  })
  const built = head.build()
  rows.push({
    text: hovered ? skin.hovered(built.text) : built.text,
    hits: [rowHit(0, width, target), ...built.hits],
  })
  // What actually ran, which is the question a green tick never answers, and
  // is asked for rather than printed at you.
  if (open && check.run) {
    const after = check.needs.length > 0 ? `after ${check.needs.join(', ')}` : ''
    line((r) => {
      r.text('$', skin.chrome)
        .space()
        .text(shortened(check.run ?? '', Math.max(8, width - 12 - visibleWidth(after))), skin.you)
      if (after) r.right((g) => g.text(after, skin.hint).space(2))
    })
  }
  const places = open ? check.places : red ? check.places.slice(0, 1) : []
  for (const place of places) {
    line((r) => {
      r.text(shortPath(place.path, Math.max(12, width - 24)), red ? skin.you : skin.hint)
      if (place.at) r.text(`:${place.at}`, skin.hint)
      if (place.note) {
        r.space(2).text(shortened(place.note, Math.max(6, width - r.used - 8)), skin.hint)
      }
    })
  }
  const rest = check.more + (check.places.length - places.length)
  if (rest > 0 && (open || red)) line((r) => r.text(`and ${rest} more`, skin.hint))
  if (open && check.tail.length > 0) {
    for (const text of check.tail) {
      line((r) =>
        r
          .text('│', skin.chrome)
          .space()
          .text(shortened(text, Math.max(8, width - 12))),
      )
    }
  }
  // The two acts that belong to one check, where a person has asked to see it.
  // On two rows rather than one where a narrow pane leaves no room for both: a
  // chip cut off at the edge is a control nobody can press.
  if (open) {
    const log = (r: Row) =>
      r
        .chip('the whole log', { kind: 'action', name: `check-log:${task}\u0000${check.id}` })
        .space()
        .text('in the conversation', skin.hint)
    const off = (r: Row) => r.chip('don’t run here', hereTarget(task, check.id))
    const both = (r: Row) => {
      log(r)
      r.space(2)
      off(r)
    }
    if (check.tail.length === 0) line(off)
    else if (6 + measured(both, width, skin) + 2 <= width) line(both)
    else {
      line(log)
      line(off)
    }
  }
  return rows
}

/** What a group would take, drawn nowhere: for a layout that has to know before it places. */
function measured(build: (r: Row) => void, width: number, skin: Skin): number {
  const probe = new Row(width, skin)
  build(probe)
  return probe.used
}

/**
 * One check Tade does not run here: what it is, why not in the reading's own
 * words or the person's, and the one act that changes it.
 *
 * The reason is a value beside a name and never a sentence under one — the
 * heading above it has already said that none of these run — and it is here at
 * all only because somebody opened the fold.
 */
export function skippedRow(
  check: CheckView,
  task: string,
  width: number,
  skin: Skin,
  pointer: Pointer,
  pad = 8,
): { text: string; hits: Hit[] }[] {
  const r = new Row(width, skin, pointer).space(4)
  const control = (g: Row) => g.chip('run here', hereTarget(task, check.id)).space()
  const probe = new Row(width, skin)
  control(probe)
  r.text(check.chosen === false ? '⊘' : '–', skin.hint)
    .space()
    .text(check.id.padEnd(pad), skin.hint)
    .space(2)
  // The reason gives way to the control rather than the other way round: with
  // the control pushed off the edge the row says why and offers no way to
  // change it, which is the worse half to lose.
  const room = width - r.used - probe.used - 4
  if (room > 2) r.text(shortened(check.skip ?? '', room), skin.hint)
  r.right(control)
  return [r.build()]
}

/** The control that moves a check between the two categories, on either side of the fold. */
function hereTarget(task: string, check: string): Target {
  return { kind: 'action', name: `check-here:${task}\u0000${check}` }
}

/**
 * How long a run took, as one cell: eight steps of a share of the longest run
 * on the page, and blank for a run that has not happened.
 *
 * A picture of the figure beside it, in the room a picture of one figure is
 * worth — which check on this page is the expensive one, answered without
 * reading three numbers and comparing them.
 */
export function spark(seconds: number | null, longest: number): string {
  if (seconds === null || longest <= 0) return ' '
  const steps = '▁▂▃▄▅▆▇█'
  const at = Math.max(0, Math.min(steps.length - 1, Math.round((seconds / longest) * 7)))
  return steps[at] ?? ' '
}

/** A check's state as a colour: one answer, so the glyph and the strip agree. */
export function toneOf(state: string, skin: Skin): (text: string) => string {
  if (state === 'passed') return skin.done
  if (state === 'failed' || state === 'timed out') return skin.bad
  if (state === 'running' || state === 'queued') return skin.busy
  return skin.hint
}

/** A check's state as one character, the same one the CLI prints. */
export function glyphFor(state: string): string {
  if (state === 'passed') return '✓'
  if (state === 'failed' || state === 'timed out') return '✗'
  if (state === 'skipped' || state === 'cancelled') return '–'
  if (state === 'not run') return '◦'
  return '⋯'
}
