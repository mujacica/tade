import type { Hit } from '../hits.ts'
import type { AppState } from '../model.ts'
import { type Skin, WORDMARK, WORDMARK_SHADES, WORDMARK_WIDTH } from '../skin.ts'
import { blank, type Drawn, fit, type Pointer, Row, stack } from '../ui.ts'

// The screen with no agent in front of you: the wordmark, and the two things
// there are to press.
//
// A project you closed the last agent in is a place, not a gap — the window
// stays in it — so this is what that place looks like, and it is the first
// thing anybody sees on a machine where nothing has been started yet.
//
// **The line you type on is not here.** It is the orchestrator's, it lives in
// the orchestrator's own pane at the foot, and it stays there on every screen
// including this one: a prompt that moves is a prompt you have to look for.
// Typing here still reaches it — a printable key with no agent focused opens
// the line (`wire/keyboard.ts`) — and enter, ctrl+space and ctrl+k mean what
// they mean everywhere else. What this screen offers is the other reading,
// the one a mouse can take: `+ New agent` makes `agent-N` and opens it.

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
 * The buttons give ground last, and are in every step but the empty one. They
 * are the only thing on this screen that *does* anything, and the only way off
 * it for somebody using the mouse — a keyboard reaches the line at the foot,
 * which this screen never takes away.
 */
const LADDER: readonly Shown[] = [
  { logo: 'block', tagline: true, buttons: true },
  { logo: 'block', tagline: false, buttons: true },
  { logo: 'mark', tagline: true, buttons: true },
  { logo: 'mark', tagline: false, buttons: true },
  { logo: 'none', tagline: false, buttons: true },
]

/** The last step, for a pane with no rows to give at all. */
const LAST: Shown = { logo: 'none', tagline: false, buttons: false }

/**
 * Rows a step takes. Each part above the buttons brings the clear row under
 * itself, so the buttons are the one row they are and the screen never holds
 * two blank rows in a stack. Counted rather than sliced off at the bottom: a
 * step that does not fit gives up a part, where cutting takes the buttons off
 * a screen that still says it has them.
 */
function rowsFor(shown: Shown): number {
  const logo = shown.logo === 'block' ? WORDMARK.length + 1 : shown.logo === 'mark' ? 2 : 0
  return logo + (shown.tagline ? 2 : 0) + (shown.buttons ? 1 : 0)
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
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const project = state.project
  const fits = LADDER.find((shown) => fitsWidth(shown, width) && rowsFor(shown) <= height) ?? LAST

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

  if (fits.buttons) {
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
  // the top of the page.
  const above = Math.max(0, Math.floor((height - rowsFor(fits)) * 0.42))
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
