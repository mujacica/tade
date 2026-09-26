import type { Frame } from '../frame.ts'
import type { Hit } from '../hits.ts'
import { promptWidth } from '../layout.ts'
import { type AppState, linePlace } from '../model.ts'
import { type Skin, WORDMARK, WORDMARK_SHADES, WORDMARK_WIDTH } from '../skin.ts'
import { blank, type Drawn, fit, type Pointer, Row, stack } from '../ui.ts'
import { inputBox, inputRows } from './line.ts'

// The screen with no agent in front of you: the wordmark, a line to type on,
// and the two things there are to press.
//
// A project you closed the last agent in is a place, not a gap — the window
// stays in it — so this is what that place looks like, and it is the first
// thing anybody sees on a machine where nothing has been started yet.
//
// **Typing here goes to the orchestrator**, which is the thing that makes
// tasks: it reads what you asked for, decides how many agents it wants and
// where they work, and starts them. Starting one directly is the other
// reading and it is still here, as the button it already was — `+ New agent`
// makes `agent-N` and opens it, which is the right act when you have no
// sentence to say. Nothing new is claimed for either: a printable key on a
// screen with no agent focused already opened the orchestrator's line
// (`wire/keyboard.ts`), so this screen only had to *show* the line it was
// already typing into, and enter, ctrl+space and ctrl+k still mean what they
// mean everywhere else.
//
// So the line is drawn here rather than copied here: `linePlace` says which of
// the two regions owns it, the foot draws none while this one does, and the
// editor behind it is the same single editor. See `view/line.ts`.

/** What is drawn, richest first: the ladder's own vocabulary. */
interface Shown {
  /** The wordmark: block letters, the spelt-out mark, or nothing. */
  logo: 'block' | 'mark' | 'none'
  /** `said, and done.` under it. */
  tagline: boolean
  /** The two things to press, and the project they are in. */
  buttons: boolean
}

/**
 * How the screen gives ground, richest first.
 *
 * The same shape the top strip's `LADDER` has, and for the same reason: what
 * fits is decided by trying, and a drawing that clips instead of stepping down
 * shows half a letter and calls it a logo. The logo gives ground first because
 * it is the one thing here that is only decoration — it becomes the same
 * spelt-out mark the project tabs sit beside rather than a second, smaller set
 * of block letters, since two drawings of a wordmark are two brands.
 *
 * The line is in no step. It is this screen's talk key: the one thing that
 * must survive a window with four rows in it, because it is the only way off
 * this screen that does not need a mouse.
 */
const LADDER: readonly Shown[] = [
  { logo: 'block', tagline: true, buttons: true },
  { logo: 'block', tagline: false, buttons: true },
  { logo: 'mark', tagline: true, buttons: true },
  { logo: 'mark', tagline: false, buttons: true },
  { logo: 'mark', tagline: false, buttons: false },
  { logo: 'none', tagline: false, buttons: false },
]

/** The last step: the line, and nothing else at all. */
const LAST: Shown = { logo: 'none', tagline: false, buttons: false }

/**
 * Rows a step takes, including the clear row under each part and the rules
 * either side of the line. Counted rather than sliced off at the bottom: a
 * step that does not fit gives up a part, where cutting takes the buttons off
 * a screen that still says it has them.
 */
function rowsFor(shown: Shown, box: number): number {
  const logo = shown.logo === 'block' ? WORDMARK.length + 1 : shown.logo === 'mark' ? 2 : 0
  return logo + (shown.tagline ? 2 : 0) + box + (shown.buttons ? 2 : 0)
}

/** Whether a step has the columns it needs: only the block letters ask for any. */
function fitsWidth(shown: Shown, width: number): boolean {
  return shown.logo !== 'block' || WORDMARK_WIDTH + 2 <= width
}

/** A row of text placed in the middle of the pane, and its hits moved with it. */
function centred(built: { text: string; hits: Hit[] }, used: number, width: number) {
  const left = Math.max(0, Math.floor((width - used) / 2))
  return {
    text: fit(`${' '.repeat(left)}${built.text}`, width),
    hits: built.hits.map((hit) => ({ ...hit, from: hit.from + left, to: hit.to + left })),
  }
}

export function renderEmpty(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const project = state.project
  const voice = frame.voice ?? { keys: ['ctrl', 'space'], available: false }
  // The line, where this screen is the one holding it. A project with agents
  // in it that you have merely stepped off keeps its line at the foot, where
  // every other screen has it.
  const mine = linePlace(state) === 'splash'
  const lineWidth = promptWidth(width)
  // Its top rule, the lines the editor drew, and the rule that closes it.
  const boxHeight = mine ? inputRows(state, frame).length + 2 : 0
  // The step is chosen against a *closed* line, so the picture stays where it
  // is while you type: a block centred on its own height rises half a row for
  // every line you add, under a pointer that is not moving.
  const shut = mine ? 3 : 0
  const fits =
    LADDER.find(
      (shown) =>
        fitsWidth(shown, width) &&
        rowsFor(shown, shut) <= height &&
        rowsFor(shown, boxHeight) <= height,
    ) ?? LAST

  const rows: { text: string; hits: Hit[] }[] = []
  if (fits.logo === 'block') {
    const left = Math.max(0, Math.floor((width - WORDMARK_WIDTH) / 2))
    WORDMARK.forEach((line, i) => {
      const shade = WORDMARK_SHADES[i] ?? WORDMARK_SHADES[0]
      // Painted here rather than through the skin: the shades are a gradient
      // down one drawing, which is not a look any control has.
      const painted = skin.colour ? `\x1b[38;5;${shade}m${line}\x1b[0m` : line
      rows.push({ text: fit(`${' '.repeat(left)}${painted}`, width), hits: [] })
    })
    rows.push(blank(width))
  } else if (fits.logo === 'mark') {
    const row = new Row(width, skin).mark('TADE')
    rows.push(centred(row.build(), row.used, width))
    rows.push(blank(width))
  }

  if (fits.tagline) {
    const row = new Row(width, skin).text('said, and done.', skin.hint)
    rows.push(centred(row.build(), row.used, width))
    rows.push(blank(width))
  }

  if (mine) {
    const left = Math.max(0, Math.floor((width - lineWidth) / 2))
    // What typing here does, said where the question is asked: the
    // orchestrator is what makes tasks, so an agent is the first thing it
    // offers and the general case is still the general case.
    const box = inputBox(
      state,
      frame,
      lineWidth,
      boxHeight - 1,
      skin,
      pointer,
      voice.keys,
      0,
      'Ask Tade for an agent, or anything',
    )
    // Its bottom rule: at the foot the footer's own rule closes the box, and
    // out here there is nothing under it to do that.
    const closed = [
      ...box.rows,
      state.dictation !== null
        ? skin.signal('─'.repeat(lineWidth))
        : skin.chrome('─'.repeat(lineWidth)),
    ]
    closed.forEach((line, i) => {
      rows.push({
        text: fit(`${' '.repeat(left)}${line}`, width),
        hits: box.hits
          .filter((hit) => hit.row === i)
          .map((hit) => ({ ...hit, row: 0, from: hit.from + left, to: hit.to + left })),
      })
    })
  }

  if (fits.buttons) {
    rows.push(blank(width))
    const row = new Row(width, skin, pointer)
      .button('+ New agent', { kind: 'action', name: 'new-agent' }, project ? 'primary' : 'off')
      .space(2)
      .button(
        'Open project',
        { kind: 'action', name: 'open-project' },
        project ? 'rest' : 'primary',
      )
    if (project) row.space(3).text(`in ${project}`, skin.hint)
    rows.push(centred(row.build(), row.used, width))
  }

  // A picture sits a little above the middle of what it is in: dead centre in
  // a tall window reads as low, because the eye takes the top of the pane as
  // the top of the page. Measured against a closed line and then held off the
  // bottom, so a message that wraps grows downwards into the room under it
  // rather than lifting the wordmark a half-row at a time.
  const above = Math.max(
    0,
    Math.min(Math.floor((height - rowsFor(fits, shut)) * 0.42), height - rowsFor(fits, boxHeight)),
  )
  const drawn = stack([...Array.from({ length: above }, () => blank(width)), ...rows])
  const room = drawn.rows.slice(0, height)
  return {
    rows: [
      ...room,
      ...Array.from({ length: Math.max(0, height - room.length) }, () => ' '.repeat(width)),
    ],
    hits: drawn.hits.filter((hit) => hit.row < height),
  }
}
