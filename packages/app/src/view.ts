import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Turn } from '@wilco/voice-core'
import { type LayoutPrefs, resolveLayout } from './layout.ts'
import {
  type AppState,
  glyph,
  headline,
  isAction,
  matchActions,
  paneTitle,
  sidebar,
} from './model.ts'

// Drawing, as one pure function of state.
//
// The window is three fixed regions: the projects down the left, the focused
// agent's screen in the middle, and the orchestrator along the bottom, which
// is always there and cannot be closed — it is how you know what Wilco heard.
//
// Composition is done here rather than with a layout engine because the panes
// have to tail: an agent's newest output is the point, and a stack that clips
// from the bottom would show you the top of the screen instead.

export interface Frame {
  width: number
  height: number
  /** The focused lane's screen, as captured. May carry ANSI. */
  screen: string
  /** How to divide the window. Defaults when absent. */
  layout?: LayoutPrefs
}

/** The whole window, one string per row, each exactly as wide as the window. */
export function renderApp(state: AppState, frame: Frame): string[] {
  const { sidebarWidth, stripHeight, mainWidth, bodyHeight } = resolveLayout(
    frame.layout ?? {},
    frame,
  )
  // The clamped width, not the asked-for one: a terminal too narrow to hold a
  // readable sidebar and a pane still gets whole rows, just wider than itself.
  const width = sidebarWidth + mainWidth + 1

  const left = renderSidebar(state, sidebarWidth, bodyHeight)
  const right = renderMain(state, frame.screen, mainWidth, bodyHeight)

  const rows: string[] = []
  for (let i = 0; i < bodyHeight; i++) {
    rows.push(`${pad(left[i] ?? '', sidebarWidth)}│${pad(right[i] ?? '', mainWidth)}`)
  }
  rows.push(...renderStrip(state, width, stripHeight))
  rows.push(pad(headline(state) ? ` ${headline(state)}  ${HINTS}` : ` ${HINTS}`, width))
  return rows
}

const HINTS = 'tab switch · / commands · ctrl+space talk · ctrl+c quit'

function renderSidebar(state: AppState, width: number, height: number): string[] {
  const lines: string[] = []
  for (const group of sidebar(state)) {
    lines.push(clip(group.project, width))
    for (const task of group.tasks) {
      const marker = task.focused ? '▸' : ' '
      lines.push(clip(`${marker}${glyph(task)} ${task.name}`, width))
    }
  }
  if (lines.length === 0) lines.push(clip('no tasks yet', width))
  return lines.slice(0, height)
}

function renderMain(state: AppState, screen: string, width: number, height: number): string[] {
  const pane = state.panes.find((p) => p.task === state.focused)
  if (!pane) {
    // The window everybody sees first. It has to say what to do next, not
    // report that there is nothing to report.
    const lines = [
      clip(state.panes.length === 0 ? 'Nothing is running yet.' : 'Watching nothing.', width),
      '',
      clip('  /task      create a task and start work on it', width),
      clip('  /project   add a repository Wilco can work in', width),
      clip('  /settings  see and change what Wilco has been told', width),
      '',
      clip('Type / below for the rest, or just say what you want.', width),
    ]
    return lines.slice(0, height)
  }

  const title = pane.waiting ? `${paneTitle(pane)} — waiting on you` : paneTitle(pane)
  const lines = [clip(title, width), '─'.repeat(width)]
  const body = height - lines.length
  if (body <= 0) return lines.slice(0, height)

  if (!pane.lane) {
    lines.push(clip(`${pane.state}, no screen attached`, width))
    return lines
  }
  // The newest output is the point, so keep the tail.
  const screenLines = screen.split('\n')
  for (const line of screenLines.slice(-body)) lines.push(clip(line, width))
  return lines
}

function renderStrip(state: AppState, width: number, height: number): string[] {
  const here = state.focused === null ? ' ── here ' : ' '
  const title = state.listening ? '─ orchestrator ── ⏺ listening ' : `─ orchestrator${here}`
  const rows = [title.padEnd(width, '─').slice(0, width)]

  const body: string[] = []
  if (state.question) {
    body.push(clip(`? ${state.question.question}`, width))
    body.push(clip(`  ${state.question.candidates.join('  ·  ')}`, width))
  }
  for (const turn of state.turns) body.push(...renderTurn(turn, width))
  if (state.notice) body.push(clip(`· ${state.notice}`, width))
  if (body.length === 0) {
    body.push(clip('say what you want, or / for what Wilco can do', width))
  }

  // Reaching for a command: the list is more use than the transcript, so it
  // takes the room.
  if (isAction(state.dictation)) {
    const found = matchActions(state, state.dictation ?? '')
    const room = Math.max(1, height - 2)
    for (const action of found.slice(0, room)) {
      const mark = action.ready ? ' ' : '·'
      body.push(clip(`${mark} ${action.name.padEnd(10)} ${action.about}`, width))
    }
    if (found.length === 0) body.push(clip('  no command like that', width))
  }

  // Last, and with a cursor, because it is what you are doing right now.
  // `◉` while the microphone is open, `❯` while you type: the same line, and
  // which one it is matters, because one of them is recording you.
  if (state.dictation !== null) {
    body.push(clip(`${state.listening ? '◉' : '❯'} ${state.dictation}▏`, width))
  }
  // Typed at an agent, but held back because it might be meant for Wilco.
  if (state.held) body.push(clip(`◌ ${state.held}▏`, width))

  // The last thing said is what you need to see.
  for (const line of body.slice(-(height - 1))) rows.push(pad(line, width))
  while (rows.length < height) rows.push(' '.repeat(width))
  return rows
}

/**
 * One exchange: what was heard, where it went and why, then the answer. The
 * reasoning is shown so a wrong guess is obvious and can be corrected.
 */
export function renderTurn(turn: Turn, width: number): string[] {
  const lines = [clip(`❯ ${turn.utterance}`, width)]
  const parts: string[] = [turn.intent]
  if (turn.task) parts.push(turn.task)
  if (turn.why) parts.push(`"${turn.why}"`)
  lines.push(clip(`  → ${parts.join(' · ')}`, width))
  if (turn.reply) lines.push(clip(`  ${turn.reply}`, width))
  return lines
}

/** Cut to the visible width, leaving any ANSI in the line intact. */
function clip(text: string, width: number): string {
  return visibleWidth(text) > width ? truncateToWidth(text, width) : text
}

function pad(text: string, width: number): string {
  const short = clip(text, width)
  return short + ' '.repeat(Math.max(0, width - visibleWidth(short)))
}
