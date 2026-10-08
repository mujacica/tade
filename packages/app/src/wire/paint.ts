import type { Terminal, TuiAltScreen } from '@earendil-works/pi-tui'

// Two things about the terminal itself, rather than about anything the window
// draws in it.
//
// They were in `app.ts`, which is wiring, and neither is: one is a technique
// for recovering from a screen somebody else wiped, and the other is a
// question about what this terminal can report. Both are facts about the
// terminal, and both have exactly one sentence of reasoning that belongs
// beside the code rather than beside the fortieth subject.

/**
 * Write the whole screen again, over itself.
 *
 * The terminal can wipe it without telling us: ⌘K is "clear" in Terminal.app,
 * iTerm2 and VS Code, and never reaches Tade at all. Rendering only sends what
 * changed, so a wiped screen stayed dark until something moved. Every row is
 * written in place — no clear first, so on a screen that was not wiped nothing
 * visibly happens.
 */
export function repaintScreen(tui: TuiAltScreen, terminal: Terminal): void {
  const shown = (tui as unknown as { previousScreen?: unknown }).previousScreen
  if (!Array.isArray(shown) || shown.length === 0) return
  let buffer = '\x1b[?2026h\x1b7'
  shown.forEach((line, row) => {
    if (typeof line === 'string') buffer += `\x1b[${row + 1};1H${line}`
  })
  terminal.write(`${buffer}\x1b8\x1b[?2026l`)
}

/** Only some terminals report key releases, which is what holding a key needs. */
export function kittyActive(terminal: Terminal): boolean {
  return (terminal as { kittyProtocolActive?: boolean }).kittyProtocolActive === true
}
