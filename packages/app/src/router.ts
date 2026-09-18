// Saying something to Tade without leaving the agent you are typing at.
//
// Keystrokes go straight through to the focused agent, which is what makes its
// own keybindings work. That leaves a tension: to notice a line addressed to
// Tade, it cannot already have been forwarded.
//
// So keystrokes are held back only at the start of a line, and only while they
// still spell a prefix of "tade ". At most six characters are ever held, and
// the moment they diverge they are flushed in order. What is held is shown, so
// those six characters are never simply missing from the screen.

export const PREFIX = 'tade '

export interface RouterState {
  /** Held back while it might still become "tade ". */
  held: string
  /** The prefix completed: everything now goes to Tade until Enter. */
  capturing: boolean
  /** At the start of a line, which is the only place the prefix counts. */
  atLineStart: boolean
}

export function initialRouter(): RouterState {
  return { held: '', capturing: false, atLineStart: true }
}

export interface Routed {
  state: RouterState
  /** Bytes the agent should receive. */
  toLane: string
  /** A finished line for Tade, once Enter closed it. */
  toTade: string | null
}

const ENTER = /^[\r\n]$/
const BACKSPACE = /^(\x7f|\b)$/

/**
 * Decide where each keystroke goes. Pure: the whole point is that this can be
 * exercised character by character without a terminal or an agent.
 */
export function route(state: RouterState, data: string): Routed {
  let { held, capturing, atLineStart } = state
  let toLane = ''
  let toTade: string | null = null

  for (const char of data) {
    if (capturing) {
      if (ENTER.test(char)) {
        toTade = held.slice(PREFIX.length).trim()
        held = ''
        capturing = false
        atLineStart = true
        continue
      }
      if (BACKSPACE.test(char)) {
        held = held.slice(0, -1)
        // Rubbed out back past "tade ", so it is a candidate again.
        capturing = held.toLowerCase().startsWith(PREFIX)
        continue
      }
      held += char
      continue
    }

    if (held !== '' && BACKSPACE.test(char)) {
      held = held.slice(0, -1)
      continue
    }

    // Only ever a candidate at the start of a line.
    if (held !== '' || atLineStart) {
      const candidate = held + char
      const lower = candidate.toLowerCase()
      if (lower === PREFIX) {
        held = candidate
        capturing = true
        continue
      }
      if (PREFIX.startsWith(lower)) {
        held = candidate
        continue
      }
      // Not for Tade after all: the agent gets it all, in the order it was typed.
      toLane += candidate
      held = ''
      atLineStart = ENTER.test(char)
      continue
    }

    toLane += char
    atLineStart = ENTER.test(char)
  }

  return { state: { held, capturing, atLineStart }, toLane, toTade }
}

/** What is being held, as the window should show it. */
export function pending(state: RouterState): string | null {
  return state.held === '' ? null : state.held
}
