import { type AgentMark, duration } from '@tade/core'
import type { Frame } from '../frame.ts'
import {
  ageThere,
  linkWords,
  type Machine,
  type Place,
  placeIn,
  type RemoteAgent,
  type RemoteProject,
} from '../machines.ts'
import { MARK_TONES, markGlyph } from '../model.ts'
import type { Skin } from '../skin.ts'
import { blank, type Drawn, fit, Row, stack } from '../ui.ts'
import { type ListItem, type Section, TAB_EDGES, tabList } from './rows.ts'
import { type ProjectMark, remoteStanding } from './standing.ts'
import { clockOf, shortened } from './text.ts'

// Standing in a project on another machine: the side lists its agents and its
// queued work, and the pane says what the project is, where, and how it stands
// (REMOTE-TADE.md §9.4). Both draw from `machines.ts`, which is the only thing
// that ever read what that machine wrote, so every word here is text.
//
// **A row here looks like a row of this machine's**, mark for mark — the mark
// is the one the remote drew (`RemoteAgent.mark`), in this window's glyphs and
// tones — and carries its age, from that machine's own moments. While the link
// is down the rows stay, their ages as of the last time it answered, and the
// heading says so: `○ vps · as of 14:02`.
//
// Nothing here is a control yet. Opening a remote agent's screen is the next
// piece of work, and a row that looked pressable and did nothing would be a
// promise the window cannot keep.

/** The sections the side draws while you stand in a project on another machine. */
export function elsewhereSections(
  frame: Frame,
  place: Place,
  width: number,
  skin: Skin,
): Section[] {
  const found = placeIn(frame.machines, place)
  const now = frame.now ?? 0
  const words = found ? linkWords(found.machine, clockOf(frame)) : null
  const project = found?.project ?? null
  const agents = project?.agents.filter((agent) => !agent.queued) ?? []
  const queued = project?.agents.filter((agent) => agent.queued) ?? []
  const line = (row: () => Row, said: string) => [row().space(3).text(said, skin.hint).build()]
  const items = (list: readonly RemoteAgent[]) =>
    tabList(
      list.map((agent) => remoteItem(width, skin, agent, found?.machine ?? null, now)),
      width,
    )
  return [
    {
      id: 'agents',
      label: 'AGENTS',
      count: agents.length,
      ...(words ? { note: words.note, brief: words.brief } : {}),
      banded: true,
      rows: (row) =>
        project === null
          ? [blank(width), ...line(row, missing(found?.machine ?? null, place)), blank(width)]
          : agents.length === 0
            ? [blank(width), ...line(row, 'none there'), blank(width)]
            : [
                ...items(agents),
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
      rows: (row) => (queued.length === 0 ? line(row, 'nothing waiting there') : items(queued)),
    },
  ]
}

/** Why there is nothing to list, where the project is not in what is held. */
function missing(machine: Machine | null, place: Place): string {
  if (machine === null) return `${place.machine} is not a remote here any more`
  if (!machine.heard) return machine.said ?? `linking to ${machine.name}…`
  return `${place.project} is not open on ${machine.name}`
}

/** A mark's own word, for a row whose remote said no clause of its own. */
const MARK_WORDS: Readonly<Record<AgentMark, string>> = {
  working: 'working',
  idle: 'idle',
  'needs-you': 'wants you',
  failed: 'failed',
  done: 'done',
  stopped: 'not running',
  parked: 'parked',
}

/**
 * An agent there, as two rows of the side: its mark and its name, then its age
 * and the remote's clause. Drawn as a tab is drawn, with no ground and no hit.
 */
function remoteItem(
  width: number,
  skin: Skin,
  agent: RemoteAgent,
  machine: Machine | null,
  now: number,
): ListItem {
  const queued = agent.queued && agent.mark !== 'needs-you'
  const tone = queued ? skin.hint : skin[MARK_TONES[agent.mark]]
  const inner = new Row(Math.max(0, width - TAB_EDGES), skin).space()
  inner.text(markGlyph(queued ? 'queued' : agent.mark, now), tone).space()
  inner.text(shortened(agent.title ?? agent.name, Math.max(1, inner.width - inner.used - 1)))
  const age = machine === null ? null : ageThere(agent, machine, now)
  const said = [age === null ? '' : duration(age), agent.reason || MARK_WORDS[agent.mark]]
  const under = new Row(Math.max(0, width - TAB_EDGES), skin).space(3)
  under.text(shortened(said.filter(Boolean).join(' · '), Math.max(1, under.width - 4)), skin.hint)
  const tab = (built: { text: string }) => ({ text: ` ${skin.item(built.text, null)} `, hits: [] })
  return { rows: [tab(inner.build()), tab(under.build())], band: null }
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
  frame: Frame,
  place: Place,
  width: number,
  height: number,
  skin: Skin,
): Drawn {
  const found = placeIn(frame.machines, place)
  const machine = found?.machine ?? null
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
