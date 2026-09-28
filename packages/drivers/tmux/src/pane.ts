import type { LanePointing, LaneScrolling, WheelEncoding } from '@tade/drivers-core'

// What tmux says about a pane, read.
//
// The part of driving tmux that asks nothing of the world: strings in, answers
// out. It lives apart from the driver because it is what every question about
// a pane goes through — whose the scrolling is, how much of the pointer the
// program wanted, where a capture ends — and because none of it needs a tmux
// to test.

/**
 * What a pane is like, in one ask: where the cursor is, how tall it is, and
 * what its program has done to the screen and the mouse.
 *
 * One `display-message` for all of it, because every one of these is a
 * process, and the window asks for a pane four times a second.
 */
export const PANE_FORMAT =
  '#{cursor_x} #{cursor_y} #{pane_height} #{alternate_on} ' +
  '#{mouse_any_flag} #{mouse_button_flag} #{mouse_standard_flag} #{mouse_sgr_flag} ' +
  '#{mouse_all_flag}'

/** What `PANE_FORMAT` came back with. */
export interface Pane {
  x: number
  y: number
  height: number
  /** The program took the whole screen for itself, so tmux keeps no history of it. */
  own: boolean
  /** It asked for the mouse, in any of the ways there are to ask. */
  mouse: boolean
  /**
   * It asked to be told about movement, not only about presses. Never
   * `mouse_any_flag`, which is tmux's word for "in any of the mouse modes"
   * rather than for mode 1003 — that one is `mouse_all_flag`, and read the
   * other way it says a pane that asked only about presses wants movement
   * too, which is a program typed at rather than pointed at.
   */
  drag: boolean
  encoding: WheelEncoding
}

export function readPane(said: string): Pane {
  const fields = said.trim().split(/\s+/).map(Number)
  const [x = 0, y = 0, height = 0, alternate = 0, any = 0, button = 0] = fields
  const [standard = 0, sgr = 0, all = 0] = fields.slice(6)
  return {
    x,
    y,
    height,
    own: alternate === 1,
    mouse: any === 1 || button === 1 || standard === 1,
    drag: button === 1 || all === 1,
    encoding: sgr === 1 ? 'sgr' : 'legacy',
  }
}

/**
 * The rows a capture draws, out of the rows tmux printed.
 *
 * Under the last line with anything on it is screen the program has not used,
 * and drawing it would spend the pane on blanks — on the normal screen. On the
 * alternate screen those blanks are the picture: a program that took the
 * screen is drawing a rectangle exactly `pane_height` tall and chose what to
 * leave empty in it, the space under a short menu, the gap above a status bar,
 * the blank last line every full-screen editor keeps. Trimmed, that rectangle
 * comes back shorter than the pane it is drawn into, and shorter by a
 * different amount every frame as the content changes, so the whole screen
 * slides up and down under itself. The same rule as `lastWritten` in the pty
 * driver, held by the same conformance test.
 */
export function drawn(all: readonly string[], own: boolean): string[] {
  const rows = [...all]
  if (own) return rows
  while (rows.length > 0 && rows.at(-1)?.trim() === '') rows.pop()
  return rows
}

/**
 * Whose the scrolling is, from what the pane's program has done to it.
 *
 * The alternate screen is what decides, because it is what says there is no
 * history: a program that prints keeps every line it printed whether or not
 * it also wants the mouse, and those lines are the window's to move.
 */
export function scrollingOf(pane: Pane): LaneScrolling {
  if (!pane.own) return 'window'
  return pane.mouse ? 'lane' : 'nobody'
}

/**
 * How much of the pointer the pane's program has asked for. tmux keeps a flag
 * per way of asking, so this is a reading of its answer rather than a guess:
 * the standard flag is presses, and either of the other two is movement with
 * a button held — `any` asks for movement with none, which the window never
 * sends and so is handed over as the same thing.
 */
export function pointingOf(pane: Pane): LanePointing {
  if (pane.drag) return 'drag'
  return pane.mouse ? 'press' : 'nobody'
}
