import type { Frame } from '../frame.ts'
import { type Hit, rowHit, sameTarget, shift } from '../hits.ts'
import { type AppState, activeTerminal, isAction, matchActions } from '../model.ts'
import { BAR } from '../scrollbar.ts'
import type { Regions } from '../selection.ts'
import type { Skin } from '../skin.ts'
import { terminalSplitShown } from '../split.ts'
import { type Line, transcriptLines } from '../transcript-view.ts'
import { blank, type Drawn, fit, type Pointer, Row, shiftRegions } from '../ui.ts'
import { bottomTabs, terminalBody } from './foot.ts'
import { pointedIn, typingIn } from './lane.ts'
import { inputBox, inputRows } from './line.ts'
import { barBeside } from './rows.ts'
import { splitView } from './split.ts'
import { clock } from './text.ts'

// The orchestrator's line: what it is thinking, what it last said, and the
// box you talk to it in.
//
// It runs along the window above the tabs and is never closeable — it is how
// you know what Tade heard.

export function renderStrip(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const voice = frame.voice ?? { keys: ['ctrl', 'space'], available: false }
  let bar: string
  let barHits: Hit[] = []
  const talking = state.listening && state.talkingSince !== null
  const terminal = talking ? null : activeTerminal(state)
  if (talking) {
    const seconds = Math.max(0, Math.floor(((frame.now ?? 0) - (state.talkingSince ?? 0)) / 1000))
    const left = new Row(width, skin)
      .text('━ ', skin.chrome)
      .text(' ● TX ', skin.transmit)
      .space()
      .text('listening', skin.you)
      .space()
      .text(clock(seconds), skin.hint)
      .space()
    const tail = ' release to send · esc cancels ━'
    left.text('━'.repeat(Math.max(0, width - left.used - tail.length)), skin.chrome)
    left.text(tail, skin.chrome)
    bar = left.build().text
  } else {
    const tabs = bottomTabs(state, width, skin, pointer, frame.now ?? 0)
    bar = tabs.text
    barHits = tabs.hits
  }

  const rows = [fit(bar, width)]
  const hits: Hit[] = talking ? [rowHit(0, width, { kind: 'orchestrator' })] : barHits
  if (height <= 1) return { rows: rows.slice(0, height), hits }
  // A row of room under the tabs, so what is below them is not pressed against them.
  rows.push(' '.repeat(width))
  const room = height - 2
  if (room <= 0) return { rows: rows.slice(0, height), hits }

  if (terminal) {
    const split = terminalSplitShown(state)
    // A lane that took the whole screen and asked for the mouse gets none of
    // Tade's own reading of its text: on such a lane the program's meaning for
    // a cell is the one that counts, and a path that lights up and then hands
    // the click over is a worse lie than not offering it.
    const linkers =
      !split && pointedIn(frame.terminal?.view ?? null, typingIn(state) === 'terminal')
        ? null
        : frame.linkers
    const drawn = split
      ? splitView({
          width,
          height: room,
          split,
          edge: 'terminal-split',
          lit:
            state.resizing === 'terminal-split' ||
            sameTarget(state.hover, { kind: 'divider', edge: 'terminal-split' }),
          focus: state.splitFocus,
          label: state.terminals.find((one) => one.id === split.lane)?.name ?? 'terminal',
          actions: 'terminal-split',
          skin,
          pointer,
          first: (w, h) =>
            terminalBody({
              terminal: frame.terminal,
              width: w,
              room: h,
              skin,
              scroll: state.terminalScroll,
              pointer,
              linkers,
            }),
          second: (w, h) =>
            terminalBody({
              terminal: frame.splitTerminal,
              width: w,
              room: h,
              skin,
              pointer,
              side: 'split',
              linkers,
            }),
        })
      : terminalBody({
          terminal: frame.terminal,
          width,
          room,
          skin,
          scroll: state.terminalScroll,
          pointer,
          state,
          linkers,
          held: frame.held?.get('terminal'),
        })
    return {
      rows: [...rows, ...drawn.rows],
      hits: [...hits, ...shift(drawn.hits, 2)],
      regions: shiftRegions(drawn.regions, 2),
    }
  }

  if (frame.orchestrator !== undefined && !isAction(state.dictation)) {
    for (const line of frame.orchestrator.split('\n').slice(-room)) {
      hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
      rows.push(fit(line, width))
    }
    while (rows.length < height) rows.push(' '.repeat(width))
    return { rows: rows.slice(0, height), hits }
  }

  if (talking) {
    // What the microphone hears, as it hears it — only where the recorder can
    // tell. A meter that moves on its own would be a lie about the one thing
    // you need to trust while talking.
    const meter = state.levels.length > 0 ? levelMeter(state.levels, Math.min(width - 6, 48)) : null
    const lines = [
      ' '.repeat(width),
      meter ? `   ${skin.busy(meter.heard)}${skin.chrome(meter.rest)}` : ' '.repeat(width),
      ' '.repeat(width),
      `${skin.transmit(' ◉ ')} ${skin.hint('speak — Tade hears you until you let go')}`,
    ]
    for (let gap = room - lines.length; gap > 0; gap--) rows.push(' '.repeat(width))
    for (const line of lines.slice(-room)) {
      hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
      rows.push(fit(line, width))
    }
    return { rows: rows.slice(0, height), hits }
  }

  // A column down the right of the conversation belongs to its scrollbar.
  const inner = width - BAR
  const body: Line[] = transcriptLines(
    state.transcript,
    inner,
    skin,
    pointer,
    frame.now ?? 0,
    frame.linkers,
    frame.orchestratorOffers?.interrupt.shown ?? false,
  )
  const quiet = (text: string): Line => ({ text: fit(text, inner), hits: [] })
  if (state.question) {
    body.push(quiet(skin.waiting(` ? ${state.question.question}`)))
    body.push(quiet(skin.hint(`   ${state.question.candidates.join('  ·  ')}`)))
  }

  // Choosing a command: the commands that fit, best first, in place of the conversation.
  const commands: Line[] = []
  if (isAction(state.dictation)) {
    const found = matchActions(state, state.dictation ?? '')
    for (const action of found) {
      const line = ` ${action.name.padEnd(10)} ${action.about}`
      commands.push(quiet(action.ready ? line : skin.hint(line)))
    }
    if (found.length === 0) commands.push(quiet(skin.hint('  no command like that')))
  }

  // The line you type on, boxed as pi boxes its own — a rule above and below
  // — and always there, so opening it moves nothing. Text that wraps grows
  // the box upward into the conversation, never off the edge.
  // Its bottom rule is the footer's, just below.
  //
  // It is here on every screen, including the one an empty project draws: the
  // line is the orchestrator's and this is the orchestrator's pane, so there
  // is one box, in one place, and nothing above it ever borrows it.
  const inputHeight = Math.min(Math.max(2, room - 1), inputRows(state, frame).length + 1)
  const bodyRoom = Math.max(0, room - inputHeight)
  // Scrolled back through the conversation, the newest lines wait below; the
  // box's top rule says so, and takes you back to them.
  const scroll = isAction(state.dictation)
    ? 0
    : Math.min(state.transcriptScroll, Math.max(0, body.length - bodyRoom))

  const end = body.length - scroll
  const shown = isAction(state.dictation)
    ? commands.slice(0, bodyRoom)
    : body.slice(Math.max(0, end - bodyRoom), end)
  const conversation: { text: string; hits: Hit[] }[] = []
  for (let gap = bodyRoom - shown.length; gap > 0; gap--) conversation.push(blank(inner))
  for (const line of shown) conversation.push({ text: line.text, hits: [...line.hits] })
  // Listing commands is not reading the conversation: there is nothing to
  // scroll through, and the bar says so.
  const lines = isAction(state.dictation) ? bodyRoom : body.length
  // The conversation's own lines, so a selection dragged over it is anchored
  // in them rather than in the rows on screen: what scrolls away then stays
  // selected, and copying gives the whole of it. Never while the commands are
  // listed — that is a list of what you could type, not something to read.
  const region: Regions = isAction(state.dictation)
    ? {}
    : {
        transcript: {
          lines: body.map((line) => line.text),
          first: 0,
          offset: Math.max(0, end - bodyRoom),
          row: rows.length + Math.max(0, bodyRoom - shown.length),
          rows: shown.length,
        },
      }
  for (const row of barBeside(
    conversation,
    {
      total: Math.max(lines, bodyRoom),
      shown: bodyRoom,
      offset: Math.max(0, lines - bodyRoom - scroll),
      rows: bodyRoom,
    },
    'transcript',
    inner,
    state,
    skin,
  )) {
    // Under everything, the wheel; over that, the strip; over that, links.
    hits.push(rowHit(rows.length, width, { kind: 'scroll', area: 'transcript' }))
    hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
    hits.push(...shift(row.hits, rows.length))
    rows.push(row.text)
  }
  const box = inputBox(state, frame, width, inputHeight, skin, pointer, voice.keys, scroll)
  for (let i = 0; i < box.rows.length; i++) {
    hits.push(rowHit(rows.length + i, width, { kind: 'orchestrator' }))
  }
  hits.push(...shift(box.hits, rows.length))
  rows.push(...box.rows)
  return { rows: rows.slice(0, height), hits, regions: region }
}

/**
 * Recent loudness as a row of bars, newest on the right, padded on the left
 * with the floor so the meter keeps its width from the first moment.
 */
export function levelMeter(
  levels: readonly number[],
  cells: number,
): { heard: string; rest: string } {
  const bars = '▁▂▃▄▅▆▇█'
  const recent = levels.slice(-cells)
  const heard = recent
    .map((level) => bars[Math.max(0, Math.min(7, Math.round(level * 7)))])
    .join('')
  return { heard, rest: '▁'.repeat(Math.max(0, cells - recent.length)) }
}
