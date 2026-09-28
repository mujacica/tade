import type { Frame } from '../frame.ts'
import { type Hit, rowHit, shift } from '../hits.ts'
import { type AppState, somethingTyped } from '../model.ts'
import type { Skin } from '../skin.ts'
import { type Drawn, fit, type Pointer, Row } from '../ui.ts'

// The line you type to Tade on, and the box drawn around it.
//
// It is the orchestrator's, and it is drawn in the orchestrator's own pane at
// the foot — on every screen, including the one an empty project draws, where
// nothing above it borrows it. There is exactly one of these and one editor
// behind it, and a prompt that moves about the window is a prompt somebody has
// to look for before they can say anything.
//
// Its own file because the box is a subject of its own: what a rule carries,
// what an empty line invites, and where a click in it puts the caret — none of
// which is the conversation above it (`view/strip.ts`).

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
  // One short of meeting them: a right-hand group needs a column of room to
  // sit in — and only where there is one, or the rule stops a column short of
  // the edge for nothing. That column shows: with the line closed it left a
  // notch above the footer's own full-width rule, just below.
  const gap = probe.used > 0 ? 1 : 0
  top.text('─'.repeat(Math.max(0, width - top.used - probe.used - gap)), rule)
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
