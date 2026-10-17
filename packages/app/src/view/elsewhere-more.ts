import { SOURCE_NEEDS_YOU, type SourceState } from '@tade/core'
import type { Frame } from '../frame.ts'
import type { Hit } from '../hits.ts'
import { inboxStateMark } from '../intake-view.ts'
import { type DocumentThere, lookSaid, type ProducedThere } from '../machine-there.ts'
import { type Machine, type Place, placeIn } from '../machines.ts'
import { MARK_TONES, markGlyph } from '../model.ts'
import type { Skin } from '../skin.ts'
import type { Row } from '../ui.ts'
import type { Section } from './rows.ts'
import { clockOf, shortened } from './text.ts'

// The rest of the side while you stand in a project on another machine, under
// its agents and its queue (`elsewhere.ts`): the requests handed to it there
// and its doors, its checks and how each has been answering, its schedules and
// watches with their last looks, and the documents its work produced — each
// out of `Machine.detail`, so every word is text another machine wrote and
// `machine-there.ts` reduced. A document is read on a press: copied here over
// the link and opened in the viewer (`remote-document`).
//
// **Each section is that machine's**, which the top row and the AGENTS heading
// already say, and while its link is down each says as of when it last heard —
// never an empty list where the machine simply has not said.

/** How many of one list are drawn before the rest are counted. */
const MOST = 8

/** INTAKE, CHECKS, SCHEDULES and DOCUMENTS for the project you stand in there. */
export function thereSections(frame: Frame, place: Place, width: number, skin: Skin): Section[] {
  const found = placeIn(frame.machines, place)
  if (found === null) return []
  const { machine } = found
  const clock = clockOf(frame)
  const stale =
    machine.link === 'live' || machine.asOf === null ? undefined : `as of ${clock(machine.asOf)}`
  const room = Math.max(1, width - 5)
  const said = (row: () => Row, text: string, tone = skin.hint) => [
    row().space(3).text(shortened(text, room), tone).build(),
  ]
  const more = (row: () => Row, all: number) =>
    all > MOST ? said(row, `and ${all - MOST} more there`) : []
  const head = (id: string, label: string, count: number): Section => ({
    id,
    label,
    count,
    quiet: count === 0,
    ...(stale === undefined ? {} : { note: stale, brief: stale }),
    rows: () => [],
  })
  const requests = machine.detail.requests.filter((one) => one.project === place.project)
  const doors = machine.detail.doors
  const checks = machine.detail.checks.filter((one) => one.project === place.project)
  const here = checks.filter((one) => one.task === null)
  const trees = new Set(checks.filter((one) => one.task !== null).map((one) => one.task)).size
  const about = machine.detail.about
  const schedules = (about?.schedules ?? []).filter((one) => one.project === place.project)
  const documents = documentsOf(machine, place.project)
  return [
    {
      ...head('there-intake', 'INTAKE', requests.length),
      rows: (row) => [
        ...(requests.length === 0
          ? said(row, `nothing handed to ${machine.name} for this project`)
          : requests.slice(0, MOST).flatMap((one) => {
              const mark = inboxStateMark(one.state)
              const tone = mark === 'queued' ? skin.hint : skin[MARK_TONES[mark]]
              const title = row()
                .space()
                .text(markGlyph(mark, frame.now ?? 0), tone)
                .space()
              title.text(shortened(one.title ?? one.item, Math.max(1, room - one.state.length - 2)))
              title.right((r) => r.text(one.state, tone).space())
              const who = [one.who === null ? '' : `@${one.who}`, one.source, one.because]
              return [title.build(), ...said(row, who.filter(Boolean).join(' · '))]
            })),
        ...more(row, requests.length),
        // The doors are the machine's, not the project's: one line each, so a
        // request that never came is told apart from a door that is shut.
        ...doors.flatMap((door) =>
          said(row, `${door.source}: ${door.state} · ${door.because}`, doorTone(door.state, skin)),
        ),
      ],
    },
    {
      ...head('there-checks', 'CHECKS', here.length),
      rows: (row) => [
        ...(here.length === 0
          ? said(row, 'nothing has run in its checkout there yet')
          : here.slice(0, MOST).flatMap((one) => {
              const streak = one.streak
              const glyph = streak === null ? '·' : streak.state === 'pass' ? '✓' : '✗'
              const tone =
                streak === null ? skin.hint : streak.state === 'pass' ? skin.done : skin.bad
              const since = streak?.since == null ? '' : ` since ${clock(streak.since)}`
              const runs = streak === null ? 0 : streak.runs
              const how =
                streak === null
                  ? 'no run said either way'
                  : `${streak.state === 'pass' ? 'passing' : 'failing'}${since} · ${runs} ${runs === 1 ? 'run' : 'runs'}`
              const top = row().space().text(glyph, tone).space().text(shortened(one.check, room))
              return [top.build(), ...said(row, one.required ? how : `${how} · not required`)]
            })),
        ...more(row, here.length),
        ...(trees === 0
          ? []
          : said(row, `and runs in ${trees} ${trees === 1 ? 'worktree' : 'worktrees'} there`)),
      ],
    },
    {
      ...head('there-schedules', 'SCHEDULES', schedules.length),
      rows: (row) => [
        ...(about === null
          ? said(row, machine.detail.aboutSaid ?? `${machine.name} has not said what it runs yet`)
          : schedules.length === 0
            ? said(row, `nothing on a clock for this project on ${machine.name}`)
            : schedules.slice(0, MOST).flatMap((one) => {
                const mark = one.paused ? '‖' : one.kind === 'watch' ? '◎' : '↻'
                const look = lookSaid(one, clock)
                const tone = look.startsWith('!') ? skin.waiting : skin.hint
                const top = row().space().text(mark, skin.hint).space()
                top.text(shortened(`${one.name} · ${one.when}`, room))
                return [top.build(), ...(look === '' ? [] : said(row, look, tone))]
              })),
        ...more(row, schedules.length),
      ],
    },
    {
      ...head('there-documents', 'DOCUMENTS', documents.length),
      rows: (row) => [
        ...(documents.length === 0
          ? said(row, `no document produced for this project on ${machine.name}`)
          : documents.slice(0, MOST).flatMap((one) => documentRows(row, one, machine, room, skin))),
        ...more(row, documents.length),
      ],
    },
  ]
}

/**
 * The project's documents there: what that machine's journal says its work
 * produced, where it has said what it is — and before that, what its tasks say
 * they produce, out of the projection, which is all a machine that has not been
 * asked yet has said.
 */
function documentsOf(machine: Machine, project: string): (DocumentThere | ProducedThere)[] {
  const about = machine.detail.about
  if (about !== null) return about.documents.filter((one) => one.project === project)
  return machine.detail.produced.filter((one) => one.project === project)
}

/** One document's two rows: its name, then its task and whether it can be read now — a press, if so. */
function documentRows(
  row: () => Row,
  one: DocumentThere | ProducedThere,
  machine: Machine,
  room: number,
  skin: Skin,
): { text: string; hits: Hit[] }[] {
  const written = 'state' in one ? one.state === 'written' : one.written
  const readable = written && machine.link === 'live'
  const press = readable
    ? { kind: 'action' as const, name: `remote-document:${machine.name} ${one.task} ${one.name}` }
    : undefined
  const top = row()
    .space()
    .text('▤', written ? skin.you : skin.hint)
    .space()
  top.text(shortened(one.name, room), written ? undefined : skin.hint, press)
  const state = 'state' in one ? one.state : one.written ? 'written' : 'not written yet'
  const how = readable
    ? 'press to read it here'
    : written
      ? `read once ${machine.name} is linked`
      : state
  const under = row().space(3)
  under.text(shortened(`${one.task} · ${how}`, room), skin.hint, press)
  return [top.build(), under.build()]
}

/** A door's state, loud exactly where the domain says somebody must fix it (`SOURCE_NEEDS_YOU`). */
function doorTone(state: SourceState, skin: Skin): (text: string) => string {
  return SOURCE_NEEDS_YOU.includes(state) ? skin.waiting : skin.hint
}
