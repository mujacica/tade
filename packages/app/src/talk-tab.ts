import {
  type Machine,
  type Machines,
  type Missed,
  machineMark,
  type RemoteTalk,
} from './machines.ts'
import { type AppState, markGlyph, openLine } from './model.ts'
import { type Entry, emptyTranscript, type Transcript } from './transcript.ts'
import { dollars, tokens } from './view/text.ts'

// Another machine's orchestrator, in this window's lower pane (REMOTE-TADE.md
// §9.4): a tab per machine beside this one's own, its conversation as that
// machine's away view carries it, and the line you type on sending there.
//
// **A tab, not a second pane** (`change-the-window`'s lower pane): the
// orchestrator, the terminals, the chats and now each machine's orchestrator
// share one row, and everything the strip does — the line, scrolling back,
// selecting — works on whichever is in front. Its id is `talk:<machine>`,
// which no lane id can be (a lane is `<task>/<name>`, and a task has a
// project half).
//
// **What you type on its tab goes to that machine's orchestrator and nowhere
// else**, over the owner channel this machine holds there (`wire/remote-talk.ts`):
// never to this machine's own, even when that machine is down or refuses —
// a sentence meant for one orchestrator answered by another is the one
// mistake this tab may not make. Each orchestrator keeps its own one
// conversation (`ORCHESTRATOR_SESSION` is per home).
//
// Pure: the machines and the state in, rows of words out.

const TALK = 'talk:'

/** The tab of a machine's orchestrator. */
export function talkTab(machine: string): string {
  return `${TALK}${machine}`
}

export function isTalkTab(tab: string): boolean {
  return tab.startsWith(TALK)
}

/** The machine whose orchestrator's tab is in front, or null where it is this one's or a terminal. */
export function talkingTo(state: Pick<AppState, 'bottom'>): string | null {
  return isTalkTab(state.bottom) ? state.bottom.slice(TALK.length) : null
}

/** A machine's orchestrator's tab in front, with the line open to type on, as this one's is. */
export function showTalk(state: AppState, tab: string): AppState {
  return {
    ...openLine(state),
    bottom: tab,
    keyboard: 'pane',
    bottomMode: state.bottomMode === 'min' ? 'open' : state.bottomMode,
    transcriptScroll: 0,
  }
}

/** A machine's orchestrator's tab, in front: what the strip draws in place of this one's. */
export interface TalkShown {
  machine: string
  /** Its conversation, with what this window said about it (`talkTranscript`). */
  transcript: Transcript
  /** What it said happened while you were away, once its link came back; null for nothing. */
  missed: Missed | null
  /** Where a message typed here stands (`talkSays`). */
  says: { said: string; tone: 'hint' | 'waiting' }
}

/** One machine's tab, as the row of tabs draws it. */
export interface TalkTab {
  tab: string
  /** Its name, with what it is doing: `vps ⠙` on a turn, `vps •` with something unread, `○ vps` down. */
  label: string
}

/** Every machine's tab, in the config's order, wearing what each is doing. */
export function talkTabsOf(
  machines: Machines | undefined,
  unread: readonly string[],
  now: number,
): TalkTab[] {
  return (machines?.remotes ?? []).map((machine) => {
    const link = machineMark(machine)
    const mark =
      machine.link === 'live' && machine.talk?.busy
        ? markGlyph('working', now)
        : unread.includes(machine.name)
          ? '•'
          : ''
    return {
      tab: talkTab(machine.name),
      label: [link, machine.name, mark].filter((one) => one !== '').join(' '),
    }
  })
}

/**
 * That machine's conversation as this window draws one, with what this window
 * itself said about it beside its lines in time order — a message refused,
 * a machine that could not be reached. `own` is this machine's device there
 * (`device <id>`), so what was typed here reads as the person's.
 */
export function talkTranscript(
  talk: RemoteTalk | null,
  own: string | null,
  notes: readonly Entry[],
): Transcript {
  const lines = talk?.lines ?? []
  const entries = [...lines.map((line) => entryOf(line, own)), ...notes].sort(
    (one, other) => one.at - other.at,
  )
  const asked = lines.findLast((line) => line.kind === 'asked')
  return {
    ...emptyTranscript(),
    entries,
    thinking: talk?.busy ? (asked?.at ?? 0) : null,
  }
}

function entryOf(line: RemoteTalk['lines'][number], own: string | null): Entry {
  const at = line.at ?? 0
  switch (line.kind) {
    case 'asked':
      return {
        kind: 'you',
        text: line.text,
        images: [],
        at,
        // The person at that machine's keyboard, or at this one through its
        // link, is the person; anybody else is said as who they are.
        from: line.from === null || line.from === own ? 'you' : line.from,
      }
    case 'reply':
      return { kind: 'said', text: line.text, streaming: line.streaming, by: 'orchestrator', at }
    case 'tool':
      return {
        kind: 'tool',
        id: line.id,
        tool: line.tool ?? 'a tool',
        detail: '',
        state: line.outcome ?? 'ok',
        result: '',
        progress: null,
        at,
      }
    case 'tade':
      return { kind: 'tade', text: line.text, at }
    default:
      return { kind: 'problem', text: line.text, at }
  }
}

/** Where a message typed on a machine's tab stands, in a sentence, and how loudly to say it. */
export function talkSays(
  machine: Machine,
  own: string | null,
  sending: boolean,
): { said: string; tone: 'hint' | 'waiting' } {
  const name = machine.name
  if (machine.link !== 'live') {
    return {
      said: `${name} is not linked, so nothing typed here reaches its orchestrator until it is`,
      tone: 'waiting',
    }
  }
  const talk = machine.talk
  if (talk === null) {
    return {
      said: machine.heard
        ? `${name} takes no message from another screen: talking to Tade from away is off there (surfaces.web.orchestrator) — Settings › Remotes turns it on`
        : `nothing heard from ${name} yet`,
      tone: 'waiting',
    }
  }
  if (!talk.mine) {
    return { said: `${name} no longer lets this machine ask it anything (ask)`, tone: 'waiting' }
  }
  if (sending) return { said: `sending to ${name}…`, tone: 'hint' }
  if (talk.busy) {
    const whose = talk.whose === null || talk.whose === own ? 'you' : talk.whose
    return { said: `${name}'s orchestrator is answering ${whose} · esc stops it`, tone: 'hint' }
  }
  return { said: `what you type here goes to the orchestrator on ${name}`, tone: 'hint' }
}

/**
 * The card a machine's tab draws once its link came back: what that machine
 * says happened since the person was last there, a line a list and only the
 * lists with something in them. `clock` says a moment the way the window does.
 */
export function missedLines(missed: Missed, clock: (at: number) => string): string[] {
  const lines = [`Since you were here at ${clock(missed.since)} — on ${missed.machine}:`]
  const list = (label: string, one: Missed['finished'], join: string) => {
    if (one.rows.length === 0 && one.more === 0) return
    const rows = one.rows.map((row) =>
      row.said === '' ? row.task : `${row.task}${join}${row.said}`,
    )
    const more = one.more > 0 ? [`${one.more} more`] : []
    lines.push(`  ${label}: ${[...rows, ...more].join(' · ')}`)
  }
  list('waiting on you', missed.waiting, ' ')
  list('finished', missed.finished, ' — ')
  list('to read', missed.documents, ' — ')
  list('held', missed.held, ' — ')
  list('put to its orchestrator', missed.proposed, ' — ')
  if (missed.spend !== null) {
    const money = missed.spend.hasCost ? `${dollars(missed.spend.usd)} over ` : ''
    lines.push(`  spent: ${money}${tokens(missed.spend.tokens)}`)
  }
  return lines
}
