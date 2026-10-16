import { type AppState, activeTerminal } from './model.ts'
import { typingLane } from './split.ts'

// What ctrl+v means, by where the keyboard is.
//
// A terminal pastes text when you press Cmd+V, and nothing else ever reads the
// clipboard but the program that is asked to. So ctrl+v is two things: in a
// lane it is what a terminal with no kitty protocol sends (`0x16`, `forLane`),
// because the program there reads its own clipboard — pi pastes files, a
// picture or text on it, Claude Code a picture, and a shell keeps its
// quoted-insert. On one of Tade's own lines nothing reads it but Tade, so the
// window does: the orchestrator's line takes a picture first, as pi does at an
// agent's prompt beside it, and every line takes the text — handed in as the
// terminal's own paste, so a field takes ctrl+v exactly as it takes Cmd+V.
//
// Cmd+V with no text on the clipboard is the same question asked another way:
// Terminal sends nothing for it, Ghostty sends the key (`pasteKey`'s `cmd+v`),
// and some terminals paste nothing at all, which is the empty paste.

/** What asked for the clipboard: ctrl+v, Cmd+V reaching the window as a key, or a paste with nothing in it. */
export type PasteAsk = 'ctrl+v' | 'cmd+v' | 'nothing'

/**
 * Where it goes: Tade reads the clipboard (a picture first where one can be
 * attached), a lane is sent `0x16`, or nothing is sent at all.
 */
export type PasteGoes =
  | { to: 'tade'; picture: boolean }
  | { to: 'lane'; lane: string }
  | { to: 'nowhere' }

/**
 * Where a request for the clipboard goes, or undefined where it is an
 * ordinary key and goes wherever keys go — which, for ctrl+v into a lane, is
 * `forLane`, and for an empty paste into a shell is the shell.
 */
export function pasteGoes(state: AppState, asked: PasteAsk | null): PasteGoes | undefined {
  if (asked === null) return undefined
  if (state.panel) {
    // Choosing a key, ctrl+v is the key being chosen.
    if (state.panel.kind === 'settings' && state.panel.capture) return undefined
    return { to: 'tade', picture: false }
  }
  if (state.dictation !== null) return { to: 'tade', picture: true }
  if (state.keyboard === 'terminal' && activeTerminal(state))
    return asked === 'cmd+v' ? { to: 'nowhere' } : undefined
  const pane = state.panes.find((one) => one.task === state.focused)
  const lane = pane ? typingLane(state, pane) : null
  if (!lane) return { to: 'tade', picture: true }
  return asked === 'ctrl+v' ? undefined : { to: 'lane', lane }
}

/**
 * Where typing lands, as one string to compare: what the clipboard answers is
 * typed only where it was asked for, and the keyboard can move in between.
 */
export function typingAt(state: AppState): string {
  const { panel, dictation, focused, keyboard, bottom } = state
  return [panel?.kind ?? '', dictation !== null, focused ?? '', keyboard, bottom].join('\0')
}
