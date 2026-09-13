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
  /** The key you hold to talk, by its name. `ctrl+space` unless you chose another. */
  talk?: string
  /** Press to start and press to stop, even where holding would work. */
  toggle?: boolean
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

  if (key === (ctx.talk ?? TALK)) {
    // Held, where the terminal can tell us and you have not asked otherwise;
    // one press opens and the next closes everywhere else. Both end up as the
    // same pair of events for the model.
    if (ctx.kitty && !ctx.toggle) return released ? 'talk-up' : 'talk-down'
    if (released) return null
    return ctx.listening ? 'talk-up' : 'talk-down'
  }

  // Releases of anything else are protocol noise: the shell acts on presses.
  if (released) return null

  if (key === 'tab' || key === 'shift+tab' || key === 'ctrl+c' || key === '?') return key
  // Only ever claimed while a pane is actually waiting, which the model knows.
  if (key === 'a' || key === 'd') return key
  return null
}

/** Keys that belong to something you would lose by giving them to Wilco. */
const TAKEN: Record<string, string> = {
  'ctrl+c': 'ctrl+c closes Wilco, and stops a running command everywhere else',
  'ctrl+d': 'pi and shells exit on ctrl+d',
  'ctrl+o': 'pi shows more with ctrl+o',
  escape: 'pi interrupts the agent on escape',
  enter: 'enter sends what you typed',
  tab: 'Wilco moves between agents with tab',
  'shift+tab': 'Wilco moves between agents with shift+tab',
  'ctrl+r': 'pi and most shells search history with ctrl+r',
  'ctrl+a': 'shells jump to the start of the line with ctrl+a',
  'ctrl+e': 'shells jump to the end of the line with ctrl+e',
  'ctrl+k': 'shells delete to the end of the line with ctrl+k',
  'ctrl+u': 'shells delete to the start of the line with ctrl+u',
  'ctrl+w': 'shells delete the word before the cursor with ctrl+w',
  'ctrl+l': 'shells clear the screen with ctrl+l',
  'ctrl+z': 'shells suspend what is running with ctrl+z',
}

/** Keys worth suggesting: nothing an agent or a shell already wants. */
export const TALK_SUGGESTIONS = ['ctrl+space', 'f5', 'ctrl+t'] as const

export type TalkKeyCheck =
  | { ok: true; warning: null }
  | { ok: true; warning: string }
  | { ok: false; reason: string }

/**
 * Whether a key can be the one you talk with. A key that types a character is
 * refused outright — you would never type it into your agent again. A key
 * something else uses is allowed with a warning that names what you would lose.
 */
export function checkTalkKey(name: string): TalkKeyCheck {
  const key = name.trim().toLowerCase()
  if (key === '') return { ok: false, reason: 'Press a key.' }
  if (key === 'space' || [...key].length === 1 || /^shift\+.$/.test(key)) {
    return {
      ok: false,
      reason: 'That types a character, and you have to be able to type it into your agent.',
    }
  }
  const taken = TAKEN[key]
  if (taken) {
    if (key === 'ctrl+c' || key === 'enter') return { ok: false, reason: `${key} ${taken}.` }
    return {
      ok: true,
      warning: `${key}: ${taken}. While Wilco holds it, your agents never see it.`,
    }
  }
  return { ok: true, warning: null }
}

/** `ctrl+space` as the key caps it is drawn with. */
export function keyCaps(name: string): string[] {
  // Function keys are written as they are printed on the key: F5, not f5.
  return name.split('+').map((part) => (/^f\d{1,2}$/.test(part) ? part.toUpperCase() : part))
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
