import { getKeybindings, isKeyRelease, parseKey, TUI_KEYBINDINGS } from '@earendil-works/pi-tui'

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
  /** The rest of the window's keys, by what they do: `surfaces.window.keys`. */
  bindings?: Readonly<Record<string, string>>
}

/** What each binding is called once pressed, for the model to give meaning to. */
const PRESSED: Record<string, string> = {
  search: 'search',
  next_agent: 'tab',
  previous_agent: 'shift+tab',
  orchestrator: 'orchestrator',
  next_waiting: 'next-waiting',
  new_agent: 'new-agent',
  new_terminal: 'new-terminal',
  open_project: 'open-project',
  mute: 'mute',
  extensions: 'extensions',
  settings: 'settings',
  fill_bottom: 'bottom-max',
  keys_sheet: 'keys',
  reload: 'reload',
  approve: 'a',
  deny: 'd',
}

/** The defaults, for a caller that has no config: what `surfaces.window.keys` starts as. */
export const DEFAULT_BINDINGS: Readonly<Record<string, string>> = {
  search: 'ctrl+k',
  next_agent: 'tab',
  previous_agent: 'shift+tab',
  orchestrator: 'ctrl+/',
  next_waiting: 'ctrl+q',
  new_agent: 'ctrl+n',
  new_terminal: 'ctrl+t',
  open_project: 'ctrl+o',
  mute: 'ctrl+m',
  extensions: 'ctrl+shift+e',
  settings: 'ctrl+,',
  fill_bottom: 'ctrl+shift+f',
  keys_sheet: 'f1',
  reload: 'ctrl+shift+r',
  approve: 'a',
  deny: 'd',
  agent_by_number: 'ctrl',
  project_by_number: 'ctrl+shift',
}

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'super']

/**
 * A key name with its modifiers in one order, so `ctrl+shift+1`, as you would
 * write it, and `shift+ctrl+1`, as the terminal reports it, are the same key.
 */
export function normalKey(name: string): string {
  const parts = name.trim().toLowerCase().split('+')
  // A key that is itself a plus: `ctrl++`.
  const key = name.endsWith('++') ? '+' : (parts.pop() ?? '')
  const mods = parts
    .filter((part) => part !== '')
    .sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  return [...new Set(mods), key].join('+')
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

  if (key === 'ctrl+c') return key
  // Escape is named, never claimed here: what it means depends on where you
  // are (`escapeMeans`), and everywhere but Tade's own line it is handed
  // straight on — pi interrupts its agent with it, and a shell's editor wants
  // it too.
  if (key === 'escape') return key
  // Search. Cmd+K arrives as super+k only where the terminal reports the Cmd
  // key at all; Terminal.app and most others keep Cmd for themselves.
  if (key === 'super+k') return 'search'
  const pressed = normalKey(key)
  const bound = boundBy(ctx.bindings)
  // A number held with its modifiers: that agent, or that project.
  const number = /^(.*)\+([1-9])$/.exec(pressed)
  if (number) {
    if (number[1] === bound.agent) return `agent-${number[2]}`
    if (number[1] === bound.project) return `project-${number[2]}`
  }
  // Letters are only ever claimed while they mean something, which the model knows.
  return bound.pressed.get(pressed) ?? null
}

/** The window's keys as `appKey` looks a keystroke up in them. */
interface Bound {
  /** What each binding means, by the key it is pressed with: the first binding a key has wins. */
  pressed: ReadonlyMap<string, string>
  /** The modifiers a number is held with to mean an agent, or a project; null where that is off. */
  agent: string | null
  project: string | null
}

/** Worked out once per set of bindings, which is once per config (`boundBy`). */
const BOUND = new WeakMap<object, Bound>()

/**
 * The bindings, laid out for looking a key up in — once per set of them
 * rather than once per keystroke.
 *
 * Asked every key, it was a copy of every binding and a `normalKey` of each,
 * about twenty splits, sorts and joins to decide that `x` is not one of the
 * window's keys — 4.4µs a keystroke, which is two thirds of what a 2 KB paste
 * cost the window to hand to a lane. Keyed by the bindings object itself, so a
 * config read again is laid out again and nothing is kept past it.
 */
function boundBy(bindings: Readonly<Record<string, string>> | undefined): Bound {
  const owner = bindings ?? DEFAULT_BINDINGS
  const kept = BOUND.get(owner)
  if (kept) return kept
  const all = { ...DEFAULT_BINDINGS, ...bindings }
  const pressed = new Map<string, string>()
  for (const [what, key] of Object.entries(all)) {
    const meaning = PRESSED[what]
    if (!meaning) continue
    const name = normalKey(key)
    if (!pressed.has(name)) pressed.set(name, meaning)
  }
  const held = (to: string | undefined) => (to === 'off' ? null : normalKey(`${to}+x`).slice(0, -2))
  const made = { pressed, agent: held(all.agent_by_number), project: held(all.project_by_number) }
  BOUND.set(owner, made)
  return made
}

/** Keys that belong to something you would lose by giving them to Tade. */
const TAKEN: Record<string, string> = {
  'ctrl+c': 'ctrl+c discards what you typed, then closes Tade',
  'ctrl+d': 'pi and shells exit on ctrl+d',
  'ctrl+o': 'pi shows more with ctrl+o',
  escape: 'escape stops what is thinking: Tade’s orchestrator, or the agent you are at',
  enter: 'enter sends what you typed',
  tab: 'Tade moves between agents with tab',
  'shift+tab': 'Tade moves between agents with shift+tab',
  'ctrl+r': 'pi and most shells search history with ctrl+r',
  'ctrl+a': 'shells jump to the start of the line with ctrl+a',
  'ctrl+e': 'shells jump to the end of the line with ctrl+e',
  'ctrl+k': 'Tade opens Search with ctrl+k',
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
export function checkTalkKey(name: string, printable = false): TalkKeyCheck {
  const key = name.trim().toLowerCase()
  if (key === '') return { ok: false, reason: 'Press a key.' }
  if (!printable && (key === 'space' || [...key].length === 1 || /^shift\+.$/.test(key))) {
    return {
      ok: false,
      reason: 'That types a character, and you have to be able to type it into your agent.',
    }
  }
  const taken = TAKEN[key]
  if (taken) {
    if (key === 'ctrl+c' || key === 'enter') return { ok: false, reason: `${capital(taken)}.` }
    return {
      ok: true,
      warning: `${capital(taken)}. While Tade holds it, your agents never see it.`,
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

/**
 * The alternate screen claims page up and down, home and end, ctrl+up and
 * down and ctrl+shift+f to scroll and search a viewport of its own — before any
 * listener sees them. Tade draws exactly one screen and never scrolls one, so
 * those keys belong to the panel that is open or the agent you are typing at.
 */
export function freeViewportKeys(): void {
  const bindings = getKeybindings()
  const freed: Record<string, never[]> = {}
  for (const id of Object.keys(TUI_KEYBINDINGS)) {
    if (id.startsWith('tui.altScreen.')) freed[id] = []
  }
  bindings.setUserBindings({ ...bindings.getUserBindings(), ...freed })
}

/** Kitty's modifier bits, once its one is taken off. */
const SHIFT = 1
const ALT = 2
const CTRL = 4
/** Super, hyper and meta: nothing a legacy terminal has a byte for. */
const BEYOND = 8 | 16 | 32
/** Caps lock and num lock, which say how a key was pressed and change no byte of it. */
const LOCKS = 64 | 128

/** What follows `ESC [` in a key kitty sends as `CSI u`: the key, its alternates, the modifiers and event, the text. */
const CSI_U = /^(\d+)(?::(\d*))?(?::\d+)?(?:;(\d*)(?::([123]))?)?(?:;[\d:]*)?u$/
/** What follows `ESC [` in a key kitty sends in its legacy form with an event on it: `1;1:3A`, `3;5:2~`. */
const LEGACY_EVENT = /^(\d+);(\d+):([123])([~A-DHFPQS])$/
/**
 * What follows `ESC [` under xterm's modifyOtherKeys, which pi-tui asks for
 * where a terminal speaks no kitty: `27 ; modifiers ; key ~`, so ctrl+v is
 * `27;5;118~`. The same key kitty would spell `118;5u`, with the two swapped.
 */
const OTHER_KEYS = /^27;(\d+);(\d+)~$/
/** What follows `ESC [` in a key as `CSI u` or modifyOtherKeys spells one, which is all `pasteKey` need read. */
const SPELT = /^[\d;:]+[u~]$/

/**
 * Whether a key asks for the clipboard, captured from Ghostty 1.3.1 and
 * Terminal 2.15 on 2026-10-16 (`test/keys.test.ts` holds the bytes):
 * ctrl+v however it is spelt — `0x16` from Terminal, `ESC [ 118 ; 5 u` from
 * Ghostty under kitty — and Cmd+V reaching the window as a key, which is what
 * Ghostty sends (`ESC [ 118 ; 9 u`) when the clipboard holds no text, where
 * Terminal sends nothing at all. A release asks for nothing.
 */
export function pasteKey(data: string): 'ctrl+v' | 'cmd+v' | null {
  if (data === '\x16') return 'ctrl+v'
  if (!data.startsWith('\x1b[') || !SPELT.test(data.slice(2)) || isKeyRelease(data)) return null
  const key = parseKey(data)
  const named = key === undefined ? null : normalKey(key)
  return named === 'ctrl+v' ? 'ctrl+v' : named === 'super+v' ? 'cmd+v' : null
}

/**
 * The keys xterm sends a control byte for with ctrl held, past the letters:
 * `ctrl+@` and `ctrl+space` are NUL, `ctrl+[` is escape, and so on, and the
 * digits two to eight stand in for the punctuation above them.
 */
const CONTROLS: Readonly<Record<string, number>> = {
  ' ': 0,
  '@': 0,
  '2': 0,
  '[': 27,
  '3': 27,
  '\\': 28,
  '4': 28,
  ']': 29,
  '5': 29,
  '^': 30,
  '6': 30,
  _: 31,
  '7': 31,
  '/': 31,
  '?': 127,
  '8': 127,
}

/**
 * A key as the window read it, in the bytes a program in a lane reads it as:
 * what a terminal that has never heard of the kitty keyboard protocol sends,
 * or nothing for what such a terminal never sends at all.
 *
 * The window asks its own terminal for the protocol, so a held key can be let
 * go of (`kitty`, above), and Ghostty does what it is asked: every key comes
 * with a release (`ESC [ 103 ; 1 : 3 u` after a `g`), and ctrl, alt and escape
 * come as `ESC [ … u` too (`ctrl+c` is `ESC [ 99 ; 5 u`). A lane's emulator
 * never offers that protocol to the program in it, so a shell there printed
 * every release as text after every letter and took ctrl+c for more of it —
 * where Terminal, which offers none, sent `g` and `\x03`. So a release is
 * dropped, a repeat is a press, and a press goes back to its legacy bytes.
 *
 * A key legacy has no bytes for — shift+enter, ctrl+enter, anything with super
 * — goes on as kitty spelt it: there is nothing truer to send, and it is the
 * one way an agent in the lane can still tell shift+enter from enter.
 */
export function forLane(data: string): string {
  if (!data.startsWith('\x1b[')) return data
  const rest = data.slice(2)
  const other = OTHER_KEYS.exec(rest)
  if (other) return forLane(`\x1b[${other[2]};${other[1]}u`)
  const legacy = LEGACY_EVENT.exec(rest)
  if (legacy) {
    const [, number, mods, event, final] = legacy
    if (event === '3') return ''
    if (mods !== '1') return `\x1b[${number};${mods}${final}`
    if (final === '~') return `\x1b[${number}~`
    // F1 to F4 unmodified are `ESC O P` and its neighbours; the rest `ESC [ A`.
    return 'PQS'.includes(final ?? '') ? `\x1bO${final}` : `\x1b[${final}`
  }
  const key = CSI_U.exec(rest)
  if (!key) return data
  const [, code, shifted, mods, event] = key
  if (event === '3') return ''
  const asPressed = `\x1b[${code}${mods && mods !== '1' ? `;${mods}` : ''}u`
  const held = (Number(mods || '1') - 1) & ~LOCKS
  if (held & BEYOND) return asPressed
  const point = Number(code)
  const alt = held & ALT ? '\x1b' : ''
  const ctrl = (held & CTRL) !== 0
  const shift = (held & SHIFT) !== 0
  switch (point) {
    case 13:
      return held === 0 ? '\r' : held === ALT ? '\x1b\r' : asPressed
    case 9:
      return held === 0 ? '\t' : held === SHIFT ? '\x1b[Z' : held === ALT ? '\x1b\t' : asPressed
    case 127:
      return ctrl ? (held === CTRL ? '\b' : asPressed) : `${alt}\x7f`
    case 27:
      return held === 0 ? '\x1b' : held === ALT ? '\x1b\x1b' : asPressed
  }
  // Kitty's own codes for keys Unicode has no character for — the keypad,
  // media keys — and anything not a character at all: as kitty spelt them.
  if (point < 32 || point >= 0xe000) return asPressed
  const typed = shift && shifted ? Number(shifted) : point
  let char = String.fromCodePoint(typed)
  if (shift && !shifted) char = char.toUpperCase()
  if (!ctrl) return `${alt}${char}`
  const lower = char.toLowerCase()
  if (lower >= 'a' && lower <= 'z')
    return `${alt}${String.fromCharCode(lower.charCodeAt(0) & 0x1f)}`
  const control = CONTROLS[char] ?? CONTROLS[String.fromCodePoint(point)]
  return control === undefined ? asPressed : `${alt}${String.fromCharCode(control)}`
}
