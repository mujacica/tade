import { visibleWidth } from '@earendil-works/pi-tui'
import { duration } from '@tade/core'
import type { ListRowView } from '../frame.ts'
import { type Hit, pointingIn, rowHit, type Target } from '../hits.ts'
import type { Band, Skin } from '../skin.ts'
import { type Pointer, Row } from '../ui.ts'
import { type ListItem, MENU_ICON, TAB_EDGES, tabbed, toneFor } from './rows.ts'
import { shortened } from './text.ts'

// The rows an extension keeps, drawn: a review, and whatever else somebody
// writes a list for.
//
// Two rows, which is what every other item down the side is — an agent, a
// note, a schedule, a piece of queued work. A row was one, and the name and
// the marks then fought for the same columns in a side twenty-eight wide:
// `#418  …     draft ✗ checks` is what a review looked like, which is a row
// that has given up the only thing on it nobody could guess.
//
// So the contract is which half a thing goes in, and the extension declares
// it: `marks` are what the thing *is* and sit beside the name, `figures` are
// what it *counts* and sit under it, and `age` is a moment rather than a
// figure so that an elapsed time is worked out at the moment of drawing and
// not at the poll a minute ago.
//
// Here rather than in the sidebar because two regions draw one of these — the
// side, and the ACTIONS page's review — and a drawing left where the first of
// them needed it is how the two come to disagree about what a row says.

/** What clicking a row means: its section and its own id, for the one handler. */
export function rowTarget(one: ListRowView): Target {
  return { kind: 'action', name: `list-row:${one.section}\u0000${one.id}` }
}

/**
 * The rows of a list that belong where you are standing.
 *
 * An extension polls everything it watches at once, because one poll serving
 * every reader is the whole design of a list — so what comes back is every
 * project's, and the side drew all of it in every project. A review open on
 * `tade` has no business in `zahlenzauber`'s side, and the match is the row's
 * own answer about which project's work it is (read, for a review, off its
 * repository), never a second list kept per project.
 *
 * A row that names no project is drawn **wherever you are**, because absent
 * means nobody could say: for reviews that is a repository no project here is
 * on, which `include` makes an ordinary case, and a row hidden in every
 * project is a row nobody can find. Standing in no project at all is the same
 * answer from the other side — nothing to narrow by, so nothing is narrowed.
 */
export function rowsHere(
  rows: readonly ListRowView[],
  project: string | null,
): readonly ListRowView[] {
  if (!project) return rows
  return rows.filter((one) => one.project === undefined || one.project === project)
}

/** The link a row offers, when it offers one: what `↗` on it opens. */
function linkOf(one: ListRowView): Target | null {
  const url = one.links?.[0]?.url
  return url ? { kind: 'link', url } : null
}

/**
 * How long it has been whatever it is — `3h open` — or nothing where the row
 * does not say. Worked out here, from the frame's own `now`: a figure computed
 * when the list was polled is as stale as the poll, and the side redraws four
 * times a second.
 */
export function ageOf(one: ListRowView, now: number): string {
  if (!one.age) return ''
  return `${duration(Math.max(0, now - one.age.since))} ${one.age.says}`
}

/**
 * A run of marks into whatever room is left, each in its own colour, and a `…`
 * where one would not fit.
 *
 * Painted one at a time rather than joined and cut, because the colour is the
 * fastest thing on the row to read — `✗ checks` in red is the whole of why
 * somebody looked — and a joined string cut to width is one colour or none.
 * What it could not draw it says it could not draw: a strip that silently held
 * the green ones and dropped the red one is the single worst thing this could
 * do.
 *
 * `keep` is which end of the run matters, because the two rows differ about it
 * and neither of them is "whichever came first". A row's **figures** read
 * forwards — `✗ checks` before what else is true of it — so what goes is the
 * tail. Its **marks** are pinned at the right and the last of them is the one
 * worth the columns: in a section called REVIEWS, `open` is the answer nobody
 * needed and `ready` and `you` are the whole reason to look, so `open · ready`
 * in six columns is `…ready` and never `open…`.
 *
 * One mark too wide for the room on its own is shortened rather than dropped:
 * `checks runn…` says something and a bare `…` says nothing at all.
 */
export function marksInto(
  r: Row,
  marks: readonly { text: string; tone?: 'quiet' | 'good' | 'warning' | 'bad' }[],
  room: number,
  skin: Skin,
  target?: Target,
  keep: 'first' | 'last' = 'first',
): void {
  if (marks.length === 0 || room <= 0) return
  // Which of them fit, taken from the end that matters. The `…` costs a column
  // of its own wherever any were left out.
  const order = keep === 'first' ? [...marks] : [...marks].reverse()
  const taken: { text: string; tone?: 'quiet' | 'good' | 'warning' | 'bad' }[] = []
  let used = 0
  for (const mark of order) {
    const wide = visibleWidth(mark.text) + (taken.length > 0 ? 3 : 0)
    if (used + wide + (taken.length === marks.length - 1 ? 0 : 1) > room) break
    taken.push(mark)
    used += wide
  }
  const shown = keep === 'first' ? taken : [...taken].reverse()
  const cut = taken.length < marks.length
  if (cut && keep === 'last') r.text('…', skin.chrome, target)
  // Nothing fitted whole: the one that matters most, shortened, in its colour.
  if (shown.length === 0) {
    const only = keep === 'first' ? marks[0] : marks[marks.length - 1]
    if (only) r.text(shortened(only.text, room), toneFor(only.tone, skin), target)
    return
  }
  shown.forEach((mark, i) => {
    if (i > 0) r.text(' · ', skin.chrome, target)
    r.text(mark.text, toneFor(mark.tone, skin), target)
  })
  if (cut && keep === 'first') r.text('…', skin.chrome, target)
}

/** How many columns a run of marks takes in the room it is given. */
export function marksWide(
  marks: readonly { text: string; tone?: 'quiet' | 'good' | 'warning' | 'bad' }[],
  skin: Skin,
  room: number,
  pointer: Pointer,
  keep: 'first' | 'last' = 'first',
): number {
  const probe = new Row(Math.max(1, room), skin, pointer)
  marksInto(probe, marks, room, skin, undefined, keep)
  return probe.used
}

/**
 * The fewest columns a row's title keeps, whatever its marks would like.
 *
 * The marks used to take what they wanted and the title whatever was left,
 * which in a side twenty-eight columns wide is how `retry refunds once` came
 * out `retr…` to make room for the word `open`. A name is the one column that
 * cannot be abbreviated without lying, so it is the one that is guaranteed.
 */
const TITLE_LEAST = 10

/**
 * A row an extension keeps, down the side, as a tab of two rows.
 *
 * Its name and what it is on top — the number apart from the title, so a long
 * title is cut and the number never is — and under it what its checks and
 * verdicts came to, with how long it has been open pinned at the right. Under
 * the pointer the age gives way to `↗`, which opens it where it lives: the one
 * act on the row that is not the row itself, and the age is the thing here it
 * is cheapest to lose for a moment.
 */
export function listItem(
  width: number,
  skin: Skin,
  pointer: Pointer,
  one: ListRowView,
  now: number,
): ListItem {
  const target = rowTarget(one)
  const link = linkOf(one)
  const pointed = pointingIn(pointer.hover, link ? [target, link] : [target])
  const band: Band | null = pointed ? 'hovered' : null
  const edge = Math.max(0, width - TAB_EDGES)
  const marks = one.marks ?? []
  const figures = one.figures ?? []
  const age = ageOf(one, now)

  const top = new Row(edge, skin, pointer).space()
  if (one.label) top.text(one.label, skin.hint, target).space()
  // The title first: what is left over after it goes to the marks, which give
  // ground at their own left end.
  const between = Math.max(0, top.width - top.used - 2)
  const right = marksWide(marks, skin, Math.max(0, between - TITLE_LEAST), pointer, 'last')
  top.text(shortened(one.title, Math.max(1, between - right)), (text) => text, target)
  if (right > 0) {
    top.right((g) => {
      marksInto(g, marks, right, skin, target, 'last')
    })
  }

  const under = new Row(edge, skin, pointer).space(3)
  const tail = pointed && link ? MENU_ICON : age ? visibleWidth(age) + 1 : 0
  marksInto(under, figures, Math.max(0, under.width - under.used - tail - 1), skin, target)
  under.right((g) => {
    if (pointed && link) g.icon('↗', link).space()
    else if (age) g.text(age, skin.hint, target).space()
  })

  return {
    rows: [
      tabbed(width, skin, band, top.build(), target),
      tabbed(width, skin, band, under.build(), target),
    ],
    band,
  }
}

/**
 * The same row on the ACTIONS page, where the pane is wide: two plain rows
 * under the branch, in the indents the rest of that page uses.
 *
 * Wide enough that the second row has room for where the review lives as well
 * as its figures, which the side never does — so the note is drawn here and
 * drops first, the way everything on that page gives ground from the back.
 *
 * The same two acts as the row down the side, for the same reason: the row
 * opens the review in front of you, and `↗` under the pointer opens it where
 * it lives. The number used to be the link here and the whole row the link
 * nowhere, so the one blue thing on screen meant two different acts on two
 * pages — and in a side twenty-five columns wide, four of them being "leave
 * Tade" is a mis-click waiting to happen.
 */
export function reviewRows(
  width: number,
  skin: Skin,
  pointer: Pointer,
  one: ListRowView,
  now: number,
): { text: string; hits: Hit[] }[] {
  const target = rowTarget(one)
  const link = linkOf(one)
  const marks = one.marks ?? []
  const figures = one.figures ?? []
  const age = ageOf(one, now)

  const pointed = pointingIn(pointer.hover, link ? [target, link] : [target])
  const top = new Row(width, skin, pointer).space(2)
  if (one.label) top.text(one.label, skin.hint, target).space()
  const icon = pointed && link ? MENU_ICON : 0
  const between = Math.max(0, top.width - top.used - 4 - icon)
  const right = marksWide(marks, skin, Math.max(0, between - TITLE_LEAST), pointer, 'last')
  top.text(shortened(one.title, Math.max(6, between - right)), (text) => text, target)
  if (right > 0 || icon > 0) {
    top.right((g) => {
      if (pointed && link) g.icon('↗', link)
      marksInto(g, marks, right, skin, target, 'last')
      g.space(2)
    })
  }

  const under = new Row(width, skin, pointer).space(4)
  const tail = age ? visibleWidth(age) + 3 : 0
  marksInto(under, figures, Math.max(0, under.width - under.used - tail), skin, target)
  // Where it lives, after what it adds up to, in whatever the figures left: the
  // first thing a narrower pane gives up, because a branch is one `git` away
  // and a red check is not. Measured off the row itself rather than worked out
  // a second time — the figures have already been drawn into it.
  const left = under.width - under.used - tail
  if (one.note && left > visibleWidth(one.note) + 4) {
    under.space(2).text(one.note, skin.hint, target)
  }
  if (age) under.right((g) => g.text(age, skin.hint, target).space(2))

  // Each row's hits stay at row nought: the page that pushes them shifts them
  // as it appends, the way it does for every other row it draws.
  return [top.build(), under.build()].map((row) => ({
    text: row.text,
    hits: [rowHit(0, width, target), ...row.hits],
  }))
}
