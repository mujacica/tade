import { visibleWidth } from '@earendil-works/pi-tui'
import { duration } from '@tade/core'
import type { ActionsView, CheckView, CommitView, Frame } from '../frame.ts'
import { type Hit, rowHit, sameTarget, type Target } from '../hits.ts'
import { type AgentPane, type AppState, spinner } from '../model.ts'
import type { Skin } from '../skin.ts'
import { blank, type Pointer, Row } from '../ui.ts'
import { shortened, shortPath, spell, tailOf, wrapWords } from './text.ts'

// What an agent did, and whether it holds up: one page.
//
// Its own commits, read out of the `Tade-Task:` trailer and drawn apart from
// everybody else's; what is changed and not committed, which in a shared
// checkout is nobody's to attribute; the review it is out for; and every check
// that ran — when, against which commit, how long it took, what it counted,
// and the tail of what it printed.
//
// Everything here is a query somebody else answered. Nothing in this file
// reads a file or asks a forge, and `unknown` is drawn as `unknown`.

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

  /**
   * A section: its name, a rule to where what it adds up to begins, and the
   * controls that act on it pinned to the edge. Three sections a page, each
   * announced the same way — the grouping is the whole of the design here.
   */
  const heading = (label: string, note: ((r: Row) => void) | null, controls?: (r: Row) => void) => {
    const whole = (r: Row) => {
      if (note) {
        note(r)
        r.space(controls ? 2 : 1)
      }
      if (controls) controls(r)
    }
    const measure = (build: (r: Row) => void) => {
      const probe = new Row(width, skin)
      build(probe)
      return probe.used
    }
    const left = 2 + visibleWidth(label) + 1
    // Short of room a heading gives up what it adds up to before it gives up
    // the button that acts on it — and the rule is drawn to whatever is left,
    // never to a group that will not fit and is dropped, which leaves the
    // heading with a stub of a line and a hole after it.
    const group =
      left + measure(whole) + 2 <= width
        ? whole
        : controls && left + measure(controls) + 2 <= width
          ? controls
          : null
    const r = new Row(width, skin, pointer).space(2).text(label, skin.label).space()
    r.text('─'.repeat(Math.max(1, width - r.used - (group ? measure(group) : 0) - 2)), skin.chrome)
    if (group) r.right(group)
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
  if (view.review) {
    const review = view.review
    line((r) => {
      const marks = review.marks.map((mark) => mark.text).join(' ')
      r.text(review.number, skin.link, { kind: 'link', url: review.url })
        .space()
        .text(shortened(review.title, Math.max(6, width - 12 - visibleWidth(marks))))
      r.right((g) => {
        for (const mark of review.marks) g.text(mark.text, toneFor(mark.tone, skin)).space()
        g.space()
      })
    })
  }

  // ── What this agent committed, and what it has not ─────────────────────
  rows.push(blank(width))
  const added = view.mine.reduce((sum, one) => sum + (one.added ?? 0), 0)
  const removed = view.mine.reduce((sum, one) => sum + (one.removed ?? 0), 0)
  heading('THIS AGENT’S COMMITS', (g) => {
    if (view.mine.length === 0) return void g.text('none yet', skin.hint)
    g.text(`${view.mine.length}`, skin.hint)
    if (added > 0) g.text(` +${added}`, skin.done)
    if (removed > 0) g.text(` −${removed}`, skin.bad)
  })
  if (view.mine.length === 0) {
    line(
      (r) =>
        r.text(
          said('No commit carries this task’s trailer yet, so none of these are its own.'),
          skin.hint,
        ),
      4,
    )
  }
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
    line((r) =>
      r.text('◌', skin.chrome).space().text('Nothing changed and not committed.', skin.hint),
    )
  } else {
    const files = `${view.dirty} file${view.dirty === 1 ? '' : 's'} not committed`
    const whose = view.shared
      ? 'shared checkout — Tade cannot say which are this agent’s'
      : 'in its own worktree, so all of them are its own'
    line((r) => {
      r.text('◌', skin.waiting).space().text(files, skin.you)
      r.right((g) => g.text(shortened(whose, Math.max(10, width - 30)), skin.hint).space(2))
    })
  }

  // ── How it stands ──────────────────────────────────────────────────────
  rows.push(blank(width))
  const run: Target = { kind: 'action', name: `checks-run:${pane.task}` }
  const adopt: Target = { kind: 'action', name: `checks-adopt:${pane.task}` }
  const going = view.running
  const at = view.commit ? view.commit.slice(0, 7) : 'no commit'
  const rollup = (g: Row) => {
    // A run going on says how far along it is; otherwise the rollup, in the
    // one word the whole page is about — and `unknown` is one of the three.
    if (going) {
      g.meter(going.total === 0 ? 0 : going.done / going.total, 6, skin.busy)
        .space()
        .text(`${going.done} of ${going.total}`, skin.busy)
        .space()
        .text(spell((now - going.since) / 1000), skin.hint)
      return
    }
    if (!view.commit) return void g.text('no commit to check yet', skin.waiting)
    const word =
      view.rollup === 'pass' ? 'green' : view.rollup === 'fail' ? 'red' : 'nobody has run these'
    const tone =
      view.rollup === 'pass' ? skin.done : view.rollup === 'fail' ? skin.bad : skin.waiting
    g.text(word, tone).text(` at ${at}`, skin.hint)
  }
  heading('CHECKS', rollup, (r) => {
    // Adoption is the act that makes these runnable, so it sits where the
    // thing it unlocks is — and `Run all` stays primary, because once a
    // project has adopted them that is the only button that matters.
    if (view.adoptable) r.chip('Adopt from CI', adopt).space()
    r.button(going ? 'Running…' : 'Run all', run, going ? 'rest' : 'primary').space()
  })
  // Where they came from is load-bearing in exactly two cases: there are none,
  // and there are some that nothing here may run. Anywhere else it is a row
  // spent saying `.tade/checks.yaml` to somebody who wrote it.
  if (view.checks.length === 0 || view.adoptable) {
    line((r) => r.text(said(view.source), skin.hint))
  }
  // Said once, where it is the whole answer: absent is not fine, and a page
  // that leaves `unknown` looking like a quiet green is the bug this rule is
  // for. Not said where the row above already explains why nothing has run.
  if (!going && view.rollup === 'unknown' && view.checks.length > 0 && !view.adoptable) {
    line((r) =>
      r.text(
        said(
          view.commit
            ? 'Nobody has run these over this commit, which is not the same as their passing.'
            : 'Nothing is committed here yet, and a check is always about a commit.',
        ),
        skin.hint,
      ),
    )
  }
  for (const check of view.checks) {
    rows.push(...checkRows(check, pane.task, state, now, width, skin, pointer))
  }
  // ── What else landed on this branch ────────────────────────────────────
  if (view.others.length > 0) {
    rows.push(blank(width))
    heading('ALSO ON THIS BRANCH', (g) =>
      g.text(`${view.others.length}, not this agent’s`, skin.hint),
    )
    for (const commit of view.others.slice(0, OTHER_COMMITS)) {
      line((r) => commitRow(r, commit, now, skin, false))
    }
    if (view.others.length > OTHER_COMMITS) {
      line((r) => r.text(`and ${view.others.length - OTHER_COMMITS} more`, skin.hint), 4)
    }
  }

  for (const note of view.notes) {
    rows.push(blank(width))
    for (const part of wrapWords(note, Math.max(20, width - 6))) {
      line((r) => r.text(part, skin.hint))
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
 * One check, as two or three rows: how it went and what it counted on the
 * line you scan, the command it ran under it, and where it went wrong under
 * that. Open — clicked — it also shows the last of what it printed, which is
 * what a red check is opened for and the reason this page exists.
 */
export function checkRows(
  check: CheckView,
  task: string,
  state: AppState,
  now: number,
  width: number,
  skin: Skin,
  pointer: Pointer,
): { text: string; hits: Hit[] }[] {
  const rows: { text: string; hits: Hit[] }[] = []
  const target: Target = { kind: 'check', task, check: check.id }
  const open = state.openCheck[task] === check.id
  const red = check.state === 'failed' || check.state === 'timed out'
  const going = check.state === 'running' || check.state === 'queued'
  const tone = check.state === 'passed' ? skin.done : red ? skin.bad : going ? skin.busy : skin.hint
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
  const when =
    check.state === 'running'
      ? 'going now'
      : check.state === 'queued'
        ? 'waiting its turn'
        : check.at
          ? `${duration(Math.max(0, now - check.at))} ago`
          : check.skip
            ? 'cannot run here'
            : 'nobody has run it'
  const hovered = sameTarget(pointer.hover, target)
  // The line you scan: what it is, how it went, how long it took, when — and
  // what it counted, pinned right, which is the answer somebody came for.
  const head = new Row(width, skin, pointer).space(2)
  head
    .text(check.state === 'running' ? spinner(now) : glyphFor(check.state), tone)
    .space()
    .text(check.id.padEnd(8), hovered ? skin.you : (text) => text)
    .space()
    .text(check.state.padEnd(8), tone)
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
    g.space(2)
  })
  const built = head.build()
  rows.push({
    text: hovered ? skin.hovered(built.text) : built.text,
    hits: [rowHit(0, width, target), ...built.hits],
  })
  // What actually ran, which is the question a green tick never answers —
  // and, beside it, the way into what it printed.
  const under = (text: string, paint: (text: string) => string) =>
    line((r) => {
      const chip = check.tail.length > 0 ? (open ? '▴ hide' : '▾ what it printed') : ''
      const room = Math.max(8, width - 8 - (chip ? visibleWidth(chip) + 5 : 0))
      r.text(shortened(text, room), paint)
      if (chip) r.right((g) => g.chip(chip, target).space(2))
    })
  const after = check.needs.length > 0 ? `  (after ${check.needs.join(', ')})` : ''
  if (check.skip) under(check.skip, skin.hint)
  else if (check.run) under(`${check.run}${after}`, skin.chrome)
  // What it ran at, where that is not the commit in hand: a run carries to a
  // later commit only over the very bytes it read, and is never silent about it.
  if (check.carried && check.commit) {
    line((r) => r.text(`ran at ${check.commit?.slice(0, 7)}, over these very bytes`, skin.hint))
  }
  const places = open ? check.places : check.places.slice(0, 1)
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
  if (rest > 0) line((r) => r.text(`and ${rest} more`, skin.hint))
  if (open && check.tail.length > 0) {
    for (const text of check.tail) {
      line((r) =>
        r
          .text('│', skin.chrome)
          .space()
          .text(shortened(text, Math.max(8, width - 12))),
      )
    }
    line((r) =>
      r
        .chip('the whole log', { kind: 'action', name: `check-log:${task}\u0000${check.id}` })
        .space()
        .text('in the conversation', skin.hint),
    )
  }
  return rows
}

/** A mark's tone, as the skin says it. Quiet by default: most marks are facts. */
export function toneFor(
  tone: 'quiet' | 'good' | 'warning' | 'bad' | undefined,
  skin: Skin,
): (text: string) => string {
  if (tone === 'bad') return skin.bad
  if (tone === 'good') return skin.done
  if (tone === 'warning') return skin.waiting
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
