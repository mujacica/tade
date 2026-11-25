import type { Frame } from '../frame.ts'
import { linkWords, type Machine, type Place, placeIn, type RemoteProject } from '../machines.ts'
import { type AppState, sectionOpen } from '../model.ts'
import type { Skin } from '../skin.ts'
import { paneThere, queuedThere, refOf, schedulesThere } from '../there.ts'
import { blank, type Drawn, fit, NO_POINTER, type Pointer, Row, stack } from '../ui.ts'
import { thereSections } from './elsewhere-more.ts'
import { queueRow } from './queue.ts'
import { renderRemoteAgent } from './remote-agent.ts'
import { type Section, tabList, taskRow } from './rows.ts'
import { renderSchedule, schedulesSection } from './schedule.ts'
import { type ProjectMark, remoteStanding } from './standing.ts'
import { clockOf, shortened } from './text.ts'

// Standing in a project on another machine: the side lists its agents and its
// queued work — and under them its requests, checks, schedules and documents
// (`elsewhere-more.ts`) — and the pane says what the project is, where, and how it stands.
// Both draw from `machines.ts`, which is the only thing
// that ever read what that machine wrote, so every word here is text.
//
// **A row here is a row of this machine's**: its agents, its queued work and
// its schedules are folded into the panes and views this machine's are
// (`there.ts`) and drawn by the same `taskRow`, `queueRow` and
// `schedulesSection`, so they look, light, offer `×` and `≡` and answer a
// right-click exactly as here. What differs is only where a press goes, which
// the id each control carries says: `@machine␟id`, read by `refOf` at the one
// place a press becomes an act (`wire/remote-agent.ts`).
//
// **Pressing an agent looks at it** — its screen there, streamed over the link,
// and what may be asked of it from here (`view/remote-agent.ts`) — and
// pressing it again lets go. While the link is down the rows stay, and the
// heading says as of when.

/** The sections the side draws while you stand in a project on another machine. */
export function elsewhereSections(
  state: AppState,
  frame: Frame,
  place: Place,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Section[] {
  const found = placeIn(frame.machines, place)
  const now = frame.now ?? 0
  const words = found ? linkWords(found.machine, clockOf(frame)) : null
  const project = found?.project ?? null
  const machine = found?.machine ?? null
  const agents = project?.agents.filter((agent) => !agent.queued) ?? []
  const queued = project?.agents.filter((agent) => agent.queued) ?? []
  const line = (row: () => Row, said: string) => [row().space(3).text(said, skin.hint).build()]
  // The rows are this machine's own (`taskRow`, `queueRow`), drawn from panes
  // whose ids carry the machine (`there.ts`), so every control on them —
  // the click, `×`, `≡`, a right-click — is the one a row here has.
  const agentRows = (project: RemoteProject, machine: Machine) =>
    tabList(
      agents.map((agent) =>
        taskRow(
          width,
          skin,
          pointer,
          { ...paneThere(agent, project, machine), focused: place.agent === agent.id },
          undefined,
          now,
        ),
      ),
      width,
    )
  const queueRows = (project: RemoteProject, machine: Machine) =>
    tabList(
      queued.map((agent) =>
        queueRow(
          width,
          skin,
          pointer,
          {
            pane: { ...queuedThere(agent, project, machine), focused: place.agent === agent.id },
            depth: 0,
            parent: null,
            says: agent.reason,
          },
          { stem: '', bars: '' },
          frame,
          { wide: 0, shown: 0, across: 0 },
        ),
      ),
      width,
    )
  const stale =
    machine === null || machine.link === 'live' || machine.asOf === null
      ? null
      : `as of ${clockOf(frame)(machine.asOf)}`
  const clocks = machine === null ? [] : schedulesThere(machine, place)
  const clockwork = schedulesSection(
    state,
    frame,
    width,
    skin,
    pointer,
    clocks,
    sectionOpen(state, 'schedules', clocks.length === 0),
  )
  // Where that machine has not said what it runs, the heading says so rather
  // than *none*; where its link is down, as of when.
  const unsaid = machine !== null && machine.detail.about === null
  const schedules: Section =
    unsaid || (stale !== null && clocks.length > 0)
      ? {
          ...clockwork,
          note: unsaid ? `not said yet` : (stale ?? ''),
          brief: unsaid ? '…' : (stale ?? ''),
          ...(unsaid
            ? {
                rows: (row: () => Row) =>
                  line(
                    row,
                    machine.detail.aboutSaid ?? `${machine.name} has not said what it runs yet`,
                  ),
              }
            : {}),
        }
      : clockwork
  return [
    {
      id: 'agents',
      label: 'AGENTS',
      count: agents.length,
      ...(words ? { note: words.note, brief: words.brief } : {}),
      banded: true,
      rows: (row) =>
        project === null || machine === null
          ? [blank(width), ...line(row, missing(machine, place)), blank(width)]
          : agents.length === 0
            ? [blank(width), ...line(row, 'none there'), blank(width)]
            : [
                ...agentRows(project, machine),
                ...(project.more > 0
                  ? line(row, `and ${project.more} more ${place.machine} did not send`)
                  : []),
              ],
    },
    {
      id: 'queue',
      label: 'SMART QUEUE',
      count: queued.length,
      ...(queued.length === 0 ? { note: 'none' } : {}),
      quiet: queued.length === 0,
      banded: queued.length > 0,
      rows: (row) =>
        queued.length === 0 || project === null || machine === null
          ? line(row, 'nothing waiting there')
          : queueRows(project, machine),
    },
    schedules,
    ...thereSections(frame, place, width, skin),
  ]
}

/** Why there is nothing to list, where the project is not in what is held. */
function missing(machine: Machine | null, place: Place): string {
  if (machine === null) return `${place.machine} is not a remote here any more`
  if (!machine.heard) return machine.said ?? `linking to ${machine.name}…`
  return `${place.project} is not open on ${machine.name}`
}

/** What a project's tab counts, in words: `1 wants you · 2 working`. */
const COUNTED: readonly [ProjectMark, string][] = [
  ['needs-you', 'want you'],
  ['failed', 'failed'],
  ['working', 'working'],
  ['queued', 'queued'],
  ['idle', 'idle'],
  ['stopped', 'not running'],
  ['parked', 'parked'],
]

function standingSaid(project: RemoteProject | null): string | null {
  if (project === null) return null
  const standing = remoteStanding(project)
  if (standing === undefined) return 'nothing asked of it there yet'
  if (standing.settled) return 'everything asked of it there is done'
  return COUNTED.filter(([mark]) => standing.counts[mark] > 0)
    .map(([mark, word]) => {
      const many = standing.counts[mark]
      return `${many} ${mark === 'needs-you' && many === 1 ? 'wants you' : word}`
    })
    .join(' · ')
}

/** Where it is and how the link to it stands, in the pane's one line for it. */
function whereSaid(machine: Machine | null, place: Place, clock: (at: number) => string): string {
  if (machine === null) return `was on ${place.machine}`
  if (machine.link === 'live') return `on ${machine.name}`
  if (machine.link === 'linking') return `on ${machine.name} · linking…`
  if (machine.link === 'ended') return `on ${machine.name} · it signed this machine out`
  return machine.asOf === null
    ? `on ${machine.name} · down`
    : `on ${machine.name} · down · as of ${clock(machine.asOf)}`
}

/**
 * The pane, standing in a project on another machine: its name, where it is
 * and how the link stands, how its agents stand, and why the link is down
 * where it is — a few centred lines, the most important first, and only as
 * many as the pane has rows for. The list is the side's, which scrolls.
 */
export function renderElsewhere(
  state: AppState,
  frame: Frame,
  place: Place,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer = NO_POINTER,
): Drawn {
  const found = placeIn(frame.machines, place)
  const machine = found?.machine ?? null
  const agent = found?.project?.agents.find((one) => one.id === place.agent)
  if (machine !== null && agent !== undefined) {
    return renderRemoteAgent(state, frame, machine, agent, width, height, skin, pointer)
  }
  // A schedule there in front of you is its card, drawn as one here is: its
  // controls carry its machine in its id, so they are this card's own.
  const opened = state.schedule === null ? null : refOf(state.schedule)
  if (machine !== null && opened?.machine === machine.name) {
    const one = schedulesThere(machine, place).find((each) => each.id === state.schedule)
    if (one) return renderSchedule(state, frame, one, width, height, skin, pointer)
  }
  const lines: { text: string; tone: (text: string) => string }[] = [
    { text: found?.project?.title ?? place.project, tone: skin.you },
    { text: whereSaid(machine, place, clockOf(frame)), tone: skin.hint },
  ]
  const standing = standingSaid(found?.project ?? null)
  if (standing !== null) lines.push({ text: standing, tone: (text) => text })
  if (machine?.said) lines.push({ text: machine.said, tone: skin.bad })
  const room = Math.max(0, width - 2)
  const kept = lines.slice(0, Math.max(0, Math.floor((height + 1) / 2)))
  const rows = kept.flatMap((one, at) => {
    const said = shortened(one.text, room)
    const row = new Row(width, skin).text(said, one.tone)
    const left = Math.max(0, Math.floor((width - row.used) / 2))
    const centred = fit(`${' '.repeat(left)}${row.build().text}`, width)
    return at === kept.length - 1 ? [centred] : [centred, ' '.repeat(width)]
  })
  // A little above the middle, as the empty project's screen sits.
  const above = Math.max(0, Math.floor((height - rows.length) * 0.42))
  const drawn = stack([
    ...Array.from({ length: above }, () => blank(width)),
    ...rows.map((text) => ({ text, hits: [] })),
  ])
  // Never more than the pane: `kept` is as many lines as there are rows for.
  const shown = [...drawn.rows]
  while (shown.length < height) shown.push(' '.repeat(width))
  return { rows: shown, hits: [] }
}
