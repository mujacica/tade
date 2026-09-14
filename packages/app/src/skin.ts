// How the window is coloured, and what its controls look like.
//
// The window draws with xterm's 256 colours rather than true colour, because
// Terminal.app shows those and not the other: the values here are the ones the
// design was drawn in, so what was designed is what you get.
//
// Every control has a fixed width that does not depend on colour. A button is
// `▐ label ▌` painted and `[ label ]` plain, both label + 4 columns, so the
// layout and the map of what is clickable are identical with or without it —
// the plain skin is not a degraded layout, only an unpainted one.
//
// Separate from the setup screen's palette on purpose: that one names the roles
// a form has, this one the roles a window has.

/** A button's look. Hover and pressed are the pointer's; the rest are meaning. */
export type Look =
  | 'rest'
  | 'hover'
  | 'pressed'
  | 'primary'
  | 'attention'
  | 'danger'
  | 'off'
  /** Makes another of something: a `+` that has to be found at a glance. */
  | 'add'

export interface Skin {
  readonly colour: boolean
  /** Rules and borders the window is built from. */
  chrome(text: string): string
  /** A panel's own border, a step brighter than the chrome it floats over. */
  edge(text: string): string
  /** The Wilco mark. */
  brand(text: string): string
  /** Something you can act on that is not a button: `+`, a link. */
  signal(text: string): string
  /** A tab or row you are not on. */
  tab(text: string): string
  /** A section heading: AGENTS, CHANGES. */
  label(text: string): string
  waiting(text: string): string
  busy(text: string): string
  bad(text: string): string
  done(text: string): string
  /** What you are typing right now, and the names that matter. */
  you(text: string): string
  /** Anything said quietly: hints, paths, prices. */
  hint(text: string): string
  /** The window behind a panel: there, but not asking for attention. */
  faded(text: string): string
  /** A link under the pointer. */
  link(text: string): string

  /** `▐ label ▌`, exactly label + 4 columns. */
  button(label: string, look: Look): string
  /** A tab: filled when on, `  label  ` when not. Label + 4 either way. */
  tabbed(label: string, on: boolean, hover: boolean): string
  /** One key as a key cap: `▐ctrl▌`, label + 2. Pass the spaces you want inside. */
  keycap(label: string): string
  /** A count: ` 3 `. */
  badge(text: string): string
  /** A field's body, already padded to its width by the caller. */
  field(text: string, hint: boolean): string
  /** The microphone is open. */
  transmit(text: string): string

  /** A whole row laid on the selection colour, resets and all. */
  selected(row: string): string
  /** A whole row under the pointer: a shade lighter than the ground, and less than selected. */
  hovered(row: string): string
  /** A whole row laid on a panel's surface. */
  surface(row: string): string
}

const ESC = '\x1b['
const RESET = `${ESC}0m`
const fg = (n: number) => `${ESC}38;5;${n}m`
const bg = (n: number) => `${ESC}48;5;${n}m`
const BOLD = `${ESC}1m`

const paint =
  (code: string) =>
  (text: string): string =>
    text === '' ? '' : `${code}${text}${RESET}`

/**
 * Lay a background under a whole row. Every reset inside it would otherwise
 * end the background part-way along, so each one puts it back.
 */
const under =
  (n: number) =>
  (row: string): string =>
    `${bg(n)}${row.replaceAll(RESET, `${RESET}${bg(n)}`)}${RESET}`

/** A pill: half-block caps in the button's own colour, label on its ground. */
function pill(label: string, ground: number, ink: number, bold = false): string {
  return `${fg(ground)}▐${RESET}${bg(ground)}${fg(ink)}${bold ? BOLD : ''} ${label} ${RESET}${fg(ground)}▌${RESET}`
}

const LOOKS: Record<Look, [ground: number, ink: number, bold: boolean]> = {
  rest: [238, 255, false],
  hover: [241, 231, false],
  pressed: [250, 233, false],
  primary: [80, 233, true],
  attention: [179, 233, true],
  danger: [167, 233, true],
  off: [236, 240, false],
  add: [238, 80, true],
}

const identity = (text: string) => text

export const PLAIN: Skin = {
  colour: false,
  chrome: identity,
  edge: identity,
  brand: identity,
  signal: identity,
  tab: identity,
  label: identity,
  waiting: identity,
  busy: identity,
  bad: identity,
  done: identity,
  you: identity,
  hint: identity,
  faded: identity,
  link: identity,
  button: (label) => `[ ${label} ]`,
  tabbed: (label, on) => (on ? `[ ${label} ]` : `  ${label}  `),
  keycap: (label) => `[${label}]`,
  badge: (text) => `(${text.trim()})`.padEnd(text.length),
  field: (text) => text,
  transmit: identity,
  selected: identity,
  hovered: identity,
  surface: identity,
}

export const COLOUR: Skin = {
  colour: true,
  chrome: paint(fg(30)),
  edge: paint(fg(73)),
  brand: paint(`${fg(80)}${BOLD}`),
  signal: paint(`${fg(80)}${BOLD}`),
  tab: paint(fg(246)),
  label: paint(`${fg(248)}${BOLD}`),
  waiting: paint(fg(179)),
  busy: paint(fg(80)),
  bad: paint(fg(203)),
  done: paint(fg(114)),
  you: paint(`${fg(255)}${BOLD}`),
  hint: paint(fg(244)),
  faded: paint(fg(239)),
  link: paint(`${fg(80)}${ESC}4m`),
  button: (label, look) => {
    const [ground, ink, bold] = LOOKS[look]
    return pill(label, ground, ink, bold)
  },
  tabbed: (label, on, hover) => {
    if (on) return pill(label, 80, 233, true)
    if (hover) return pill(label, 238, 255)
    return paint(fg(246))(`  ${label}  `)
  },
  keycap: (label) =>
    `${fg(250)}▐${RESET}${bg(250)}${fg(233)}${BOLD}${label}${RESET}${fg(250)}▌${RESET}`,
  badge: paint(`${bg(238)}${fg(250)}`),
  field: (text, hint) => paint(`${bg(236)}${fg(hint ? 244 : 255)}`)(text),
  transmit: paint(`${bg(203)}${fg(231)}${BOLD}`),
  selected: under(237),
  hovered: under(236),
  surface: under(235),
}

/**
 * Colour, where the terminal is one that shows it. `NO_COLOR` is honoured, and
 * a dumb terminal or a pipe gets none: escape codes in a log are worse than
 * plain text.
 */
export function skinFor(env: NodeJS.ProcessEnv = process.env, tty = true): Skin {
  if (!tty) return PLAIN
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return PLAIN
  if (env.TERM === 'dumb' || !env.TERM) return PLAIN
  return COLOUR
}

/**
 * Whether the terminal lets a program choose the mouse pointer (`OSC 22`).
 *
 * Only terminals known to support it are asked: kitty, foot and xterm document
 * it, and WezTerm and Ghostty take the same sequence. Anywhere else hover still
 * lights up, which is what the design promises; a hand is a bonus, not a
 * dependency. Unknown sequences are ignored by conforming terminals, but a
 * terminal that is not conforming prints them, so this does not guess.
 */
export function pointerShapes(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') return true
  if (env.TERM?.startsWith('foot')) return true
  if (env.XTERM_VERSION) return true
  return env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'ghostty'
}

/** Ask for a pointer shape, by its CSS name. */
export function pointerSequence(shape: 'pointer' | 'default' | 'ew-resize' | 'ns-resize'): string {
  return `\x1b]22;${shape}\x1b\\`
}
