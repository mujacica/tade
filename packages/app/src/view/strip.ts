import type { Frame } from '../frame.ts'
import { type Hit, rowHit, sameTarget, shift } from '../hits.ts'
import {
  type AppState,
  isAction,
  matchActions,
  somethingTyped,
  terminalSplitShown,
} from '../model.ts'
import { BAR } from '../scrollbar.ts'
import type { Skin } from '../skin.ts'
import { type Line, transcriptLines } from '../transcript-view.ts'
import { blank, type Drawn, fit, type Pointer, Row } from '../ui.ts'
import { bottomTabs, terminalBody } from './foot.ts'
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
  const terminal = talking ? null : state.terminals.find((one) => one.id === state.bottom)
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
    const tabs = bottomTabs(state, width, skin, pointer)
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
            }),
          second: (w, h) =>
            terminalBody({
              terminal: frame.splitTerminal,
              width: w,
              room: h,
              skin,
              pointer,
              side: 'split',
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
        })
    return { rows: [...rows, ...drawn.rows], hits: [...hits, ...shift(drawn.hits, 2)] }
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
  return { rows: rows.slice(0, height), hits }
}

/** What the input box holds, one row each: the editor's lines while typing, or one line saying what it is. */
export function inputRows(state: AppState, frame: Frame): string[] {
  const typing = state.dictation !== null && !state.historySearch && frame.input
  // The editor draws its own rules; the box draws them here, with what they carry.
  return typing ? (frame.input?.lines ?? []).slice(1, -1) : ['']
}

export function inputBox(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
  talkKeys: readonly string[],
  newer: number,
): Drawn {
  const open = state.dictation !== null
  const rule = open ? skin.signal : skin.chrome
  const hits: Hit[] = []

  // The top rule: pictures going with the message on the left, and the way
  // back to the newest line on the right.
  const top = new Row(width, skin, pointer)
  // Open to hear you, where there is no microphone to hold: said on the rule.
  if (state.listening) top.text('─ ', rule).text('◉ listening', skin.bad).text(' ', rule)
  // A picture on the clipboard, offered: Cmd+V pastes only text, so it is attached here.
  if (open && frame.clipboardImage && state.attached.length === 0) {
    top
      .text('─ ', rule)
      .button('▣ Attach the screenshot on the clipboard', {
        kind: 'action',
        name: 'attach-clipboard',
      })
      .text(' ctrl+v ', skin.hint)
      .button('×', { kind: 'action', name: 'dismiss-clipboard' })
      .text(' ', rule)
  }
  if (state.attached.length > 0) {
    top.text('─ ', rule)
    for (const path of state.attached) {
      top
        .text(`▣ ${path.split('/').at(-1) ?? path}`, skin.busy)
        .button('×', { kind: 'action', name: `detach-image:${path}` })
        .text(' ─ ', rule)
    }
  }
  const controls = (r: Row) => {
    if (newer > 0) {
      r.button(`↓ ${newer} newer`, { kind: 'action', name: 'transcript-end' }).text('─', rule)
    } else if (open && !state.historySearch) {
      // What the two keys people reach for do *now*: with something on the
      // line ctrl+c is what throws it away, and what you said before is
      // reached from an empty one anyway. Escape is said where it does
      // something — beside the spinner — and never here, because here it
      // leaves the line alone.
      const last = somethingTyped(state) ? 'ctrl+c clears, again quits ' : '↑ ctrl+r history '
      r.text(` enter sends · shift+enter new line · ${last}`, skin.hint).text('─', rule)
    }
  }
  const probe = new Row(width, skin)
  controls(probe)
  // One short of meeting them: a right-hand group needs a column of room to sit in.
  top.text('─'.repeat(Math.max(0, width - top.used - probe.used - 1)), rule)
  top.right(controls)

  const content: string[] = []
  const typed = inputRows(state, frame)
  if (open && !state.historySearch && frame.input) {
    // Every line the editor drew, and which of its own lines each one is:
    // clicking one puts the caret where the click landed, as a text box does.
    const drawn = typed.slice(-(height - 1))
    const from = typed.length - drawn.length
    drawn.forEach((line, i) => {
      // The box's own rows: its top rule, then one per line the editor drew.
      hits.push(rowHit(i + 1, width, { kind: 'input', line: from + i }))
      content.push(fit(line, width))
    })
  } else {
    const line = new Row(width, skin, pointer).space()
    if (state.historySearch) {
      // As a shell shows it: what you are looking for, then what it found.
      const { query, missing } = state.historySearch
      line.text(`search: ${query}▏`, missing ? skin.waiting : skin.signal).space(2)
      line.text(missing ? 'nothing said like that' : (state.dictation ?? ''), skin.hint)
      line.right((r) => r.text('ctrl+r older · enter sends · → keeps · esc', skin.hint).space())
    } else if (state.listening) {
      line.text('◉ ', skin.bad).text(state.dictation ?? '', skin.you)
    } else if (open) {
      line.text(`${state.dictation}▏`, skin.you)
    } else if (state.held) {
      line.text(`◌ ${state.held}▏`, skin.hint)
    } else {
      line.text('Ask Tade anything', skin.hint)
      line.right((r) => r.text('type, or hold ', skin.hint).keys(talkKeys).space())
    }
    const built = line.build()
    hits.push(...shift(built.hits, content.length + 1))
    content.push(built.text)
  }
  while (content.length < height - 1) content.push(' '.repeat(width))

  const builtTop = top.build()
  return { rows: [builtTop.text, ...content], hits: [...builtTop.hits, ...hits] }
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
