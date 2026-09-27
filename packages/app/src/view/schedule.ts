import { visibleWidth } from '@earendil-works/pi-tui'
import { describeLook, type WatchLook } from '@tade/core'
import type { Frame } from '../frame.ts'
import { type Hit, pointingIn, type Target } from '../hits.ts'
import { type AppState, glyph, projects, type ScheduleView, shownName } from '../model.ts'
import { scheduleMakes, schedulesEmptyMeans, schedulesEmptySays } from '../queue.ts'
import { wasHushed } from '../schedules-view.ts'
import type { Band, Skin } from '../skin.ts'
import { blank, type Drawn, type Pointer, Row, stack } from '../ui.ts'
import {
  type ListItem,
  QUEUE_ICONS,
  type Section,
  TAB_EDGES,
  tabbed,
  tabList,
  toneOf,
} from './rows.ts'
import { askedBy, capitalised, clockOf, inProject, shortened, wrapWords } from './text.ts'

// SCHEDULES: the standing rules — every ten minutes, hourly, every Monday —
// and what each does when it comes due.
//
// A section of its own, and this is the whole argument for the split. A piece
// of queued work is one thing that will start once, when what it waits on
// finishes: it has a place in a dependency tree, a reason it waits, and an
// agent that will be told something. A schedule is a rule that fires again and
// again, has no place in the tree, and nothing waits on it. They were listed
// together because both are "things that have not happened yet", which is the
// whole of what they share — and with eight schedules across two projects the
// queue was mostly not a queue.
//
// Down the side a schedule is a tab like the queue's, so the side stays one
// list: its mark, its name and when it next fires; under that how often, and
// whether firing makes work or tells somebody. A watch gets a row for its last
// look, because a watch looks and looking has an outcome — and one that could
// not look gets two instead, the second carrying the reason and a `×` to hush
// it. In front of you it is a page of its own: when it runs, what it does, what
// happens to runs Tade was closed for, and what it did each time.

/**
 * The trouble a watch's row has to say, or none: the last look that could not
 * look, unless you have read it and hushed it.
 *
 * The *last* look, always. One bad hour on Tuesday must not put a warning
 * beside a watch that has been looking happily ever since — which is the same
 * rule the strip's own line was fixed to, and why a watch that starts working
 * again needs nothing pressed to go quiet.
 */
function troubleWith(state: AppState, one: ScheduleView): string | null {
  if (one.paused) return null
  const problem = one.watch?.looks[0]?.problem
  if (!problem) return null
  return wasHushed(state, one.id, problem) ? null : problem
}

/** How many of the project's watches could not look, hushed or not. */
function failing(schedules: readonly ScheduleView[]): number {
  return schedules.filter((one) => !one.paused && one.watch?.looks[0]?.problem).length
}

/**
 * SCHEDULES: the standing rules in the project in front of you, under the
 * queue. Always drawn — folded, with its heading saying so, where the project
 * has none — so the clockwork is somewhere you can look rather than something
 * that appears once somebody sets one.
 *
 * No controls. There is nothing here to filter: the queue's scope is a position
 * in a dependency tree, and a standing rule has no place in one.
 */
export function schedulesSection(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
  here: readonly ScheduleView[],
  open: boolean,
): Section {
  const quiet = here.length === 0
  const broken = failing(here)
  // Whose rule each one is, where the window has more than one project: the same
  // watch runs in several of them under the same name, and a row saying only
  // "New Sentry errors" is a row nobody can place. On every row or on none — a
  // column that turns up on some of them reads as noise rather than as an answer
  // — so it wants room on the row with the longest rule, and where the side is
  // too narrow for that the project is what goes and never how often it fires.
  // The strip above and each rule's own card say the project too.
  const named =
    projects(state).length > 1 &&
    here.every((one) => visibleWidth(`${one.project} · ${one.when}`) <= cadenceRoom(one, width))
  return {
    id: 'schedules',
    label: 'SCHEDULES',
    count: here.length,
    banded: true,
    quiet,
    // A watch that cannot look is the one thing about this section a folded
    // heading must still say: a section is drawn at all so that trouble in it
    // is never invisible, and hushing a reason is not being told it is fine.
    ...(broken > 0
      ? { note: `${broken} not looking`, brief: `!${broken}` }
      : quiet && !open
        ? { note: schedulesEmptySays(), brief: 'none' }
        : {}),
    rows: (row) =>
      quiet
        ? [
            blank(width),
            ...wrapWords(schedulesEmptyMeans(), Math.max(10, width - 6))
              .slice(0, 3)
              .map((text) => row().space(3).text(text, skin.hint).build()),
            blank(width),
          ]
        : tabList(
            here.map((one) =>
              scheduleRow(width, skin, pointer, one, state.schedule === one.id, frame, {
                trouble: troubleWith(state, one),
                ...(named ? { project: one.project } : {}),
              }),
            ),
            width,
          ),
  }
}

/**
 * How a schedule is marked: once, on repeat, or a watch; paused, it is only
 * paused; a watch whose last look could not look needs you.
 */
export function scheduleMark(
  one: ScheduleView,
  skin: Skin,
): { glyph: string; tone: (text: string) => string } {
  if (one.paused) return { glyph: '‖', tone: skin.faded }
  if (one.watch?.looks[0]?.problem) return { glyph: '!', tone: skin.waiting }
  if (one.kind === 'watch') return { glyph: '◎', tone: skin.hint }
  return { glyph: one.once ? '◷' : '↻', tone: skin.hint }
}

/**
 * The columns a rule's second row has for how often it fires: what is left of it
 * beside what firing makes, which is pinned at its right. Here rather than in
 * the row, because the section decides whether the project fits on *every* row
 * and has to measure the row the same way the row will.
 */
function cadenceRoom(one: ScheduleView, width: number): number {
  return Math.max(1, width - TAB_EDGES - 3 - (visibleWidth(scheduleMakes(one)) + 2))
}

/** What a watch's last look came to, as short as a row down the side can have it. */
function lookShort(look: WatchLook): string {
  if (look.found === 0) return 'found nothing'
  return look.fresh === 0 ? 'nothing new' : `${look.fresh} new`
}

/**
 * A schedule down the side, as a tab.
 *
 * Its mark, its name and when it next fires; under that how often it fires and
 * — pinned at the right, so the list reads as a column of them — whether firing
 * makes work or tells somebody. That last is the fact worth its own columns on
 * every row: it is the difference between a watch queueing an agent at three in
 * the morning and one leaving you a sentence to read in the morning. It took the
 * columns who asked used to have, which is the one thing here the mark already
 * halves — `◎` is an extension's, `↻` and `◷` are a person's or the
 * orchestrator's — and which the card says in full.
 *
 * A watch gets a third row, because a watch looks and looking has an outcome:
 * when it last looked and what it came to. One that could not look gets two
 * instead — what happened and when, in Tade's own words, then as much of the
 * reason as the side has room for with a `×` to hush it. Both go when you press
 * it; the `!` on its mark and the count on the heading do not, because a broken
 * watch must never be invisible.
 *
 * Under the pointer, pause (or resume), remove and a menu take the place of
 * when it next fires.
 */
export function scheduleRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  one: ScheduleView,
  selected: boolean,
  frame: Frame,
  how: { trouble: string | null; project?: string } = { trouble: null },
): ListItem {
  const target: Target = { kind: 'action', name: `schedule-open:${one.id}` }
  const toggle: Target = {
    kind: 'action',
    name: `schedule-${one.paused ? 'resume' : 'pause'}:${one.id}`,
  }
  const remove: Target = { kind: 'action', name: `schedule-remove:${one.id}` }
  const hush: Target = { kind: 'action', name: `schedule-hush:${one.id}` }
  const menu: Target = { kind: 'menu', subject: { kind: 'schedule', id: one.id } }
  const pointed = pointingIn(pointer.hover, [target, toggle, remove, hush, menu])
  const band: Band | null = selected ? 'selected' : pointed ? 'hovered' : null
  const mark = scheduleMark(one, skin)
  const next = one.next[0]
  const when = one.paused ? 'paused' : next === undefined ? 'done' : clockOf(frame)(next)
  const edge = Math.max(0, width - TAB_EDGES)
  const inner = new Row(edge, skin, pointer).space()
  inner.text(mark.glyph, mark.tone, target).space()
  const right = pointed ? QUEUE_ICONS : visibleWidth(when) + 1
  const room = Math.max(1, inner.width - inner.used - right - 1)
  const nameTone = selected ? skin.you : one.paused ? skin.faded : (text: string) => text
  inner.text(shortened(one.name, room), nameTone, target)
  inner.right((r) => {
    if (pointed) {
      r.icon(one.paused ? '▶' : '‖', toggle)
        .icon('×', remove, 'danger')
        .icon('≡', menu)
        .space()
    } else {
      r.text(when, one.paused ? skin.faded : skin.hint, target).space()
    }
  })

  // How often, and what firing comes to. `agents` is the brand's amber, because
  // it is the one of the two that spends money while you are asleep.
  const makes = scheduleMakes(one)
  const rule = new Row(edge, skin, pointer).space(3)
  const cadence = how.project === undefined ? one.when : `${how.project} · ${one.when}`
  rule.text(
    shortened(cadence, cadenceRoom(one, width)),
    one.paused ? skin.faded : skin.hint,
    target,
  )
  rule.right((r) =>
    r
      .text(makes, one.paused ? skin.faded : makes === 'agents' ? skin.busy : skin.hint, target)
      .space(),
  )

  const rows = [
    tabbed(width, skin, band, inner.build(), target),
    tabbed(width, skin, band, rule.build(), target),
  ]
  const look = one.paused ? undefined : one.watch?.looks[0]
  if (how.trouble) {
    for (const said of troubleRows(edge, skin, pointer, one, how.trouble, frame, target, hush)) {
      rows.push(tabbed(width, skin, band, said, target))
    }
  } else if (look && !look.problem) {
    const said = new Row(edge, skin, pointer).space(3)
    said.text(
      shortened(
        `${clockOf(frame)(look.at)} · ${lookShort(look)}`,
        Math.max(1, said.width - said.used - 1),
      ),
      skin.hint,
      target,
    )
    rows.push(tabbed(width, skin, band, said.build(), target))
  }
  return { rows, band }
}

/**
 * The two rows a watch that could not look carries.
 *
 * What happened and when, in Tade's own words, and under it as much of the
 * reason as the side has room for with a `×` to hush it. Two rows rather than
 * one because a sidebar is twenty-odd columns wide: the words and the moment
 * fill one of them on their own, and a reason cut to what was left of that row
 * said nothing at all. The reason itself is the provider's and is all there is
 * to say — which is exactly why it must be possible to say "I have read that"
 * and have it stop being said.
 */
function troubleRows(
  edge: number,
  skin: Skin,
  pointer: Pointer,
  one: ScheduleView,
  problem: string,
  frame: Frame,
  target: Target,
  hush: Target,
): { text: string; hits: Hit[] }[] {
  const at = one.watch?.looks[0]?.at
  const said = new Row(edge, skin, pointer).space(3)
  const when = at === undefined ? '' : ` ${clockOf(frame)(at)}`
  said.text(
    shortened(`could not look${when}`, Math.max(1, said.width - said.used - 1)),
    skin.waiting,
    target,
  )
  const why = new Row(edge, skin, pointer).space(3)
  // `×` in its plain tone, never the red a remove wears: hushing a warning
  // takes nothing away, and the remove two rows above it does.
  // Four columns for the `×` and its margin, and one to keep it clear of the
  // words: `Row.right` drops what it cannot pin with a column to spare.
  why.text(shortened(problem, Math.max(1, why.width - why.used - 5)), skin.hint, target)
  why.right((r) => r.icon('×', hush).space())
  return [said.build(), why.build()]
}

/**
 * A schedule in front of you: when it runs and what it does each time, its
 * next runs, what happens to runs Tade was closed for, who made it, and what
 * it did each time it came due.
 */
export function renderSchedule(
  state: AppState,
  frame: Frame,
  one: ScheduleView,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  // Its runs are days apart: a time alone would say every one of them at once.
  const clock = frame.date ?? clockOf(frame)
  const mark = scheduleMark(one, skin)
  const run: Target = { kind: 'action', name: `schedule-run:${one.id}` }
  const toggle: Target = {
    kind: 'action',
    name: `schedule-${one.paused ? 'resume' : 'pause'}:${one.id}`,
  }
  const remove: Target = { kind: 'action', name: `schedule-remove:${one.id}` }
  const menu: Target = { kind: 'menu', subject: { kind: 'schedule', id: one.id } }
  const controls = (r: Row) => {
    r.button('Run now', run, 'primary')
      .space()
      .button(one.paused ? '▶ Resume' : '‖ Pause', toggle)
      .space()
      .button('≡', menu)
      .space()
      .button('×', remove, 'danger')
      .space()
  }
  const probe = new Row(width, skin)
  controls(probe)
  const header = new Row(width, skin, pointer).space()
  const title = `${one.project} › ${one.name}`
  const word = `${mark.glyph} ${one.paused ? 'paused' : one.when}`
  header
    .text(shortened(title, Math.max(8, Math.floor((width - probe.used) / 2))), skin.you)
    .space(2)
    .text(shortened(word, Math.max(1, width - probe.used - visibleWidth(title) - 6)), mark.tone)
  header.right(controls)
  const rows: { text: string; hits: Hit[] }[] = [
    header.build(),
    { text: skin.chrome('─'.repeat(width)), hits: [] },
    blank(width),
  ]
  const line = (build: (r: Row) => void) => {
    const r = new Row(width, skin, pointer).space(2)
    build(r)
    rows.push(r.build())
  }
  const said = (text: string) => shortened(text, Math.max(1, width - 16))
  for (const text of wrapWords(
    `${capitalised(one.when)}, it ${one.does}.`,
    Math.max(10, width - 6),
  ).slice(0, 2)) {
    line((r) => r.text(text, skin.you))
  }
  if (one.prompt.trim()) {
    rows.push(blank(width))
    line((r) => r.text(one.kind === 'ask' ? 'ASKS' : 'TELLS ITS AGENT', skin.label))
    const told = wrapWords(one.prompt.trim(), Math.max(10, width - 6))
    for (const text of told.slice(0, 6)) line((r) => r.text('│', skin.chrome).space().text(text))
    if (told.length > 6) line((r) => r.text('│', skin.chrome).space().text('…', skin.hint))
  }
  rows.push(blank(width))
  const fact = (label: string, value: string) =>
    line((r) => r.text(label.padEnd(10), skin.label).space().text(said(value), skin.hint))
  fact(
    'NEXT',
    one.paused
      ? 'paused'
      : one.next.length > 0
        ? one.next.map(clock).join(' · ')
        : 'nothing left to run',
  )
  fact('IF MISSED', one.missed === 'once' ? 'runs once when Tade opens' : 'skipped')
  const from = askedBy(one.by)
  const who = (name: string) =>
    name === 'you' ? 'you' : name === 'orchestrator' ? 'the orchestrator' : name
  const watch = one.watch
  if (watch) {
    const acts = watch.found === 'agent' ? (watch.most === 1 ? 'agent' : 'agents') : 'told'
    fact('AT MOST', `${watch.most} ${acts} a look`)
  }
  fact(
    'FROM',
    `${who(from)}${watch ? ` · turned on by ${who(askedBy(watch.turnedOnBy))}` : ''}${one.said ? ` · “${one.said}”` : ''}`,
  )
  if (watch) {
    const room = Math.max(1, width - 4 - 18)
    if (watch.findings.length > 0) {
      rows.push(blank(width))
      line((r) => r.text('FOUND', skin.label))
      for (const each of watch.findings.slice(0, 6)) {
        line((r) => {
          r.text(clock(each.at).padEnd(18), skin.hint)
          const task = each.task ? state.panes.find((pane) => pane.task === each.task) : null
          if (task) {
            r.text(glyph(task, frame.now ?? 0), toneOf(task, skin))
              .space()
              .text(shortened(`${shownName(task)} · ${each.title}`, Math.max(1, room - 2)))
          } else if (each.task) {
            r.text(
              shortened(`${inProject(one.project, each.task)} · ${each.title}`, room),
              skin.hint,
            )
          } else if (each.told) {
            r.text(shortened(`told ${who(each.told)} · ${each.title}`, room), skin.hint)
          } else {
            r.text(shortened(`could not start · ${each.title}`, room), skin.waiting)
          }
        })
        if (!each.task && !each.told && each.problem) {
          line((r) => r.text(' '.repeat(18)).text(shortened(each.problem ?? '', room), skin.hint))
        }
      }
    }
    if (watch.looks.length > 0) {
      rows.push(blank(width))
      line((r) => r.text('LOOKS', skin.label))
      for (const look of watch.looks.slice(0, 6)) {
        line((r) =>
          r
            .text(clock(look.at).padEnd(18), skin.hint)
            .text(shortened(describeLook(look), room), look.problem ? skin.waiting : skin.hint),
        )
      }
    }
  } else if (one.runs.length > 0) {
    rows.push(blank(width))
    line((r) => r.text('RUNS', skin.label))
    for (const each of one.runs.slice(0, 8)) {
      line((r) => {
        r.text(clock(each.due).padEnd(18), skin.hint)
        if (!each.ran) {
          r.text(`skipped ${each.missed} missed`, skin.faded)
          return
        }
        const task = each.task ? state.panes.find((pane) => pane.task === each.task) : null
        if (task)
          r.text(glyph(task, frame.now ?? 0), toneOf(task, skin))
            .space()
            .text(shownName(task))
        else
          r.text(
            each.task ? inProject(one.project, each.task) : 'ran',
            each.task ? skin.hint : (t) => t,
          )
        if (each.missed > 0) r.space(2).text(`${each.missed} missed before it`, skin.hint)
      })
    }
  }
  const shown = stack(rows.slice(0, height))
  const filled = [...shown.rows]
  while (filled.length < height) filled.push(' '.repeat(width))
  return { rows: filled, hits: shown.hits }
}
