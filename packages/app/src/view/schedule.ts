import { visibleWidth } from '@earendil-works/pi-tui'
import { describeLook } from '@tade/core'
import type { Frame } from '../frame.ts'
import { type Hit, pointingIn, type Target } from '../hits.ts'
import { type AppState, glyph, type ScheduleView, shownName } from '../model.ts'
import type { Band, Skin } from '../skin.ts'
import { blank, type Drawn, type Pointer, Row, stack } from '../ui.ts'
import { type ListItem, QUEUE_ICONS, secondRow, TAB_EDGES, tabbed, toneOf } from './rows.ts'
import {
  askedBy,
  askedMark,
  capitalised,
  clockOf,
  inProject,
  shortened,
  wrapWords,
} from './text.ts'

// A schedule: a rule, and what to do each time it comes due.
//
// Down the side it is a tab among the queued work, because that is what it is
// — work that has not started, waiting for its time rather than for another
// agent. In front of you it is a page of its own: when it runs, what it does,
// what happens to runs Tade was closed for, and what it did each time.

/** How many schedules the project in front of you has, whatever the filter. */
export function schedulesHere(state: AppState, frame: Frame): number {
  return (frame.schedules ?? []).filter((one) => one.project === (state.project ?? one.project))
    .length
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
 * A schedule down the side, as a tab: its mark, its name and when it next
 * runs; under it, who made it and when it runs. Under the pointer, pause (or
 * resume), remove and a menu take the place of when.
 */
export function scheduleRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  one: ScheduleView,
  selected: boolean,
  frame: Frame,
): ListItem {
  const target: Target = { kind: 'action', name: `schedule-open:${one.id}` }
  const toggle: Target = {
    kind: 'action',
    name: `schedule-${one.paused ? 'resume' : 'pause'}:${one.id}`,
  }
  const remove: Target = { kind: 'action', name: `schedule-remove:${one.id}` }
  const menu: Target = { kind: 'menu', subject: { kind: 'schedule', id: one.id } }
  const pointed = pointingIn(pointer.hover, [target, toggle, remove, menu])
  const band: Band | null = selected ? 'selected' : pointed ? 'hovered' : null
  const mark = scheduleMark(one, skin)
  const next = one.next[0]
  const when = one.paused ? 'paused' : next === undefined ? 'done' : clockOf(frame)(next)
  const inner = new Row(Math.max(0, width - TAB_EDGES), skin, pointer).space()
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
  const by = askedMark(one.by)
  const failing = one.paused ? null : (one.watch?.looks[0]?.problem ?? null)
  const said = `${[...by].length === 1 ? `${by} ` : `${by} · `}${failing ? 'could not look' : one.when}`
  return {
    rows: [
      tabbed(width, skin, band, inner.build(), target),
      secondRow(width, skin, pointer, band, said, target, 3),
    ],
    band,
  }
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
  fact('IF MISSED', one.missed === 'once' ? 'runs once when Tade next opens' : 'skipped')
  const from = askedBy(one.by)
  const who = (name: string) =>
    name === 'you' ? 'you' : name === 'orchestrator' ? 'the orchestrator' : name
  const watch = one.watch
  if (watch) {
    const acts = watch.found === 'agent' ? (watch.most === 1 ? 'agent' : 'agents') : 'told'
    fact('AT MOST', `${watch.most} ${acts} from one look; the rest wait for the next`)
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
          r.text(`skipped ${each.missed} missed while Tade was closed`, skin.faded)
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
