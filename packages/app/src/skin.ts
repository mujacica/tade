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

/** How a list item is lit: the one you are on, or the one under the pointer. */
export type Band = 'selected' | 'hovered'

/** A small glyph button's state: at rest, under the pointer, under it and destructive, held down. */
export type IconState = 'rest' | 'hover' | 'danger' | 'pressed'

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
  /** The Tade mark. */
  brand(text: string): string
  /**
   * The wordmark as a block, for the corner it lives in: exactly label + 4
   * columns, painted or not, so nothing shifts when colour goes away.
   */
  mark(label: string): string
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

  /**
   * A list item as a tab: its row on a ground between two ends, when lit, and
   * the same columns blank when not — so nothing moves as it lights. The one
   * you are on has an accent for its left end. Exactly the row's width + 2.
   */
  item(row: string, band: Band | null): string
  /** A glyph as a button that takes no room of a pill: ` × `, exactly label + 2 columns. */
  icon(label: string, state: IconState): string

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
  primary: [214, 233, true],
  attention: [141, 233, true],
  danger: [167, 233, true],
  off: [236, 240, false],
  add: [238, 214, true],
}

const identity = (text: string) => text

/**
 * How the wordmark is spelt: letters apart, so the corner reads as a mark and
 * not as one more tab. Shared, because the layout measures what the skins draw.
 */
export const markLabel = (label: string) => [...label].join(' ')

/** The grounds of a lit tab down the side: pointed at, and the one you are on. */
const TAB_GROUNDS: Record<Band, number> = { selected: 238, hovered: 236 }

const ICONS: Record<IconState, [ground: number | null, ink: number, bold: boolean]> = {
  rest: [null, 246, false],
  hover: [241, 231, false],
  danger: [167, 233, true],
  pressed: [250, 233, false],
}

export const PLAIN: Skin = {
  colour: false,
  chrome: identity,
  edge: identity,
  brand: identity,
  // The same glyphs the painted mark uses, unpainted: stripped of colour, the
  // two renders are identical, which is what the setup screen's test asserts.
  mark: (label) => `▐ ${markLabel(label)} ▌`,
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
  // Without colour the one you are on is marked the way focus is marked everywhere else.
  item: (row, band) => (band === 'selected' ? `▌${row} ` : ` ${row} `),
  icon: (label) => ` ${label} `,
  selected: identity,
  hovered: identity,
  surface: identity,
}

export const COLOUR: Skin = {
  colour: true,
  chrome: paint(fg(240)),
  edge: paint(fg(245)),
  brand: paint(`${fg(214)}${BOLD}`),
  // Amber on dark, where a lit tab is dark on amber: the mark is the one thing
  // in the top row that is not something you can press.
  mark: (label) =>
    `${fg(214)}▐${RESET}${bg(236)}${fg(214)}${BOLD} ${markLabel(label)} ${RESET}${fg(214)}▌${RESET}`,
  signal: paint(`${fg(214)}${BOLD}`),
  tab: paint(fg(246)),
  label: paint(`${fg(248)}${BOLD}`),
  waiting: paint(fg(141)),
  busy: paint(fg(214)),
  bad: paint(fg(203)),
  done: paint(fg(114)),
  you: paint(`${fg(255)}${BOLD}`),
  hint: paint(fg(244)),
  faded: paint(fg(239)),
  link: paint(`${fg(214)}${ESC}4m`),
  button: (label, look) => {
    const [ground, ink, bold] = LOOKS[look]
    return pill(label, ground, ink, bold)
  },
  tabbed: (label, on, hover) => {
    if (on) return pill(label, 214, 233, true)
    if (hover) return pill(label, 238, 255)
    return paint(fg(246))(`  ${label}  `)
  },
  keycap: (label) =>
    `${fg(250)}▐${RESET}${bg(250)}${fg(233)}${BOLD}${label}${RESET}${fg(250)}▌${RESET}`,
  badge: paint(`${bg(238)}${fg(250)}`),
  field: (text, hint) => paint(`${bg(236)}${fg(hint ? 244 : 255)}`)(text),
  transmit: paint(`${bg(203)}${fg(231)}${BOLD}`),
  item: (row, band) => {
    if (!band) return ` ${row} `
    const ground = TAB_GROUNDS[band]
    // Half-width ends, which a terminal draws the full height of the row they are on.
    const left = band === 'selected' ? fg(80) : fg(ground)
    return `${left}▐${RESET}${under(ground)(row)}${fg(ground)}▌${RESET}`
  },
  icon: (label, state) => {
    const [ground, ink, bold] = ICONS[state]
    return `${ground === null ? '' : bg(ground)}${fg(ink)}${bold ? BOLD : ''} ${label} ${RESET}`
  },
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
