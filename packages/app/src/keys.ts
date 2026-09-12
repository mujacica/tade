import { isKeyRelease, parseKey } from '@earendil-works/pi-tui'

// Which keystrokes the shell claims, and what it calls them.
//
// Everything the shell does not claim is typed into the focused agent, so the
// set is deliberately small: an agent's own keybindings have to keep working.
// That rules out plain space for push-to-talk — you could never type a space
// into your agent again — so talk is ctrl+space, which is never a character.

/** Held to talk. Not a printable character, so an agent never wanted it. */
export const TALK = 'ctrl+space'

export interface KeyContext {
  /**
   * The terminal reports key releases (Kitty protocol), so talk can be held.
   * Without it we only ever see presses, and talk has to toggle instead.
   */
  kitty: boolean
  /** Talk is currently open, which is what a toggle press would close. */
  listening: boolean
}

/**
 * Name a keystroke the way the model does, or null to let the focused agent
 * have it.
 */
export function appKey(data: string, ctx: KeyContext): string | null {
  const key = parseKey(data)
  if (!key) return null
  const released = isKeyRelease(data)

  if (key === TALK) {
    // Held, where the terminal can tell us; otherwise one press opens and the
    // next closes. Both end up as the same pair of events for the model.
    if (ctx.kitty) return released ? 'talk-up' : 'talk-down'
    return ctx.listening ? 'talk-up' : 'talk-down'
  }

  // Releases of anything else are protocol noise: the shell acts on presses.
  if (released) return null

  if (key === 'tab' || key === 'shift+tab' || key === 'ctrl+c' || key === '?') return key
  // Only ever claimed while a pane is actually waiting, which the model knows.
  if (key === 'a' || key === 'd') return key
  return null
}
