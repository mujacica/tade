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
  /**
   * The block where what you type lands: one cell, the character under it kept
   * so the cursor never hides what it sits on. Exactly one cell wide either
   * way — a cursor that changes a row's width tears the screen it is on.
   */
  cursor(text: string): string
  /**
   * A span of text a find turned up: the one you are on, and the rest. Exactly
   * the columns it was given either way — a match is laid over the line it is
   * in, and a line that changes width tears the file it is in.
   */
  found(text: string, on: boolean): string

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

/**
 * The palette, as xterm-256 numbers.
 *
 * Tade's colour is amber, and the rule the others keep is *value*: every tone
 * that carries meaning is as light as that amber, so no accent shouts over
 * another and the window reads as one design. In relative luminance — the
 * WCAG one, 0 to 1 — amber is .56, violet .57, green .56, cyan .56. The violet
 * was xterm 141 at .35, a third darker than everything it sat beside, which is
 * what made the extensions button look borrowed from somewhere else.
 *
 * Red is the one exception, and deliberately: something that has gone wrong is
 * allowed to be darker and louder than the rest, because it is not decoration.
 */
const TONE = {
  /** Tade itself, and anything Tade is doing: the brand, work in progress, links. */
  amber: 214,
  /** The mark's letters, and the crown of the wordmark. */
  amberLight: 222,
  /** The mark's ground: the same amber with the light taken out of it. */
  amberDark: 94,
  /** Waiting on you, and the press the window would like next. */
  violet: 183,
  /** Done. */
  green: 114,
  /** Where you are. The one complement in the palette, at the amber's own value. */
  cyan: 80,
  /** Gone wrong, or about to: the exception to the rule above. */
  red: 203,
  /** Ink for anything laid on a light ground. */
  ink: 233,
  /** Ink for anything laid on a mid ground. */
  inkLight: 231,
} as const

/** Greys, darkest first: the window is built from these and lit by the tones. */
const GREY = {
  /** A panel's own surface. */
  surface: 235,
  /** A ground a step up from the window: a field, a control at rest. */
  raised: 236,
  /** The row you are on. */
  chosen: 237,
  /** A button at rest. */
  control: 238,
  /** Behind a panel: there, but not asking for anything. */
  faded: 239,
  /** Rules and borders. */
  chrome: 240,
  /** A control under the pointer. */
  hovered: 241,
  /** Said quietly: hints, paths, prices. */
  quiet: 244,
  /** A panel's edge, a step brighter than the chrome it floats over. */
  edge: 245,
  /** A tab you are not on. */
  tab: 246,
  /** A section heading. */
  heading: 248,
  /** A control held down, and the key caps. */
  pressed: 250,
  /** What you are typing, and the names that matter. */
  bright: 255,
} as const

/**
 * The amber the big wordmark is shaded with, light at the crown: the corner
 * mark and the setup screen's wordmark are the same brand, so they are the
 * same five steps.
 */
export const WORDMARK_SHADES = [223, 221, TONE.amber, 208, 166]

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
  rest: [GREY.control, GREY.bright, false],
  hover: [GREY.hovered, TONE.inkLight, false],
  pressed: [GREY.pressed, TONE.ink, false],
  primary: [TONE.amber, TONE.ink, true],
  attention: [TONE.violet, TONE.ink, true],
  danger: [TONE.red, TONE.ink, true],
  off: [GREY.raised, GREY.chrome, false],
  add: [GREY.control, TONE.amber, true],
}

const identity = (text: string) => text

/**
 * How the wordmark is spelt: letters apart, so the corner reads as a mark and
 * not as one more tab. Shared, because the layout measures what the skins draw.
 */
export const markLabel = (label: string) => [...label].join(' ')

/** The grounds of a lit tab down the side: pointed at, and the one you are on. */
const TAB_GROUNDS: Record<Band, number> = { selected: GREY.control, hovered: GREY.raised }

const ICONS: Record<IconState, [ground: number | null, ink: number, bold: boolean]> = {
  rest: [null, GREY.tab, false],
  hover: [GREY.hovered, TONE.inkLight, false],
  danger: [TONE.red, TONE.ink, true],
  pressed: [GREY.pressed, TONE.ink, false],
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
  // Without colour nothing can be laid under a letter, so only an empty cell
  // can show the cursor — which is where it is nine times in ten.
  cursor: (text) => (text.trim() === '' ? '█' : text),
  // A match is left as it was, for the same reason: the bar says how many
  // there are and which one you are on, and the line it is on is marked.
  found: (text) => text,
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
  chrome: paint(fg(GREY.chrome)),
  edge: paint(fg(GREY.edge)),
  brand: paint(`${fg(TONE.amber)}${BOLD}`),
  // A badge of the brand's own colour: light amber letters on amber with the
  // light taken out, capped in the ground so the ends round off. Deliberately
  // the inverse of a lit tab — which is dark ink on bright amber — because the
  // mark is the one thing in the top row that is not something you can press,
  // and the corner should still be the warmest thing on the screen.
  mark: (label) =>
    `${fg(TONE.amberDark)}▐${RESET}${bg(TONE.amberDark)}${fg(TONE.amberLight)}${BOLD} ${markLabel(label)} ${RESET}${fg(TONE.amberDark)}▌${RESET}`,
  signal: paint(`${fg(TONE.amber)}${BOLD}`),
  tab: paint(fg(GREY.tab)),
  label: paint(`${fg(GREY.heading)}${BOLD}`),
  waiting: paint(fg(TONE.violet)),
  busy: paint(fg(TONE.amber)),
  bad: paint(fg(TONE.red)),
  done: paint(fg(TONE.green)),
  you: paint(`${fg(GREY.bright)}${BOLD}`),
  hint: paint(fg(GREY.quiet)),
  faded: paint(fg(GREY.faded)),
  link: paint(`${fg(TONE.amber)}${ESC}4m`),
  cursor: paint(`${bg(GREY.bright)}${fg(TONE.ink)}`),
  found: (text, on) =>
    paint(on ? `${bg(TONE.amber)}${fg(TONE.ink)}` : `${bg(GREY.control)}${fg(GREY.bright)}`)(text),
  button: (label, look) => {
    const [ground, ink, bold] = LOOKS[look]
    return pill(label, ground, ink, bold)
  },
  tabbed: (label, on, hover) => {
    if (on) return pill(label, TONE.amber, TONE.ink, true)
    if (hover) return pill(label, GREY.control, GREY.bright)
    return paint(fg(GREY.tab))(`  ${label}  `)
  },
  keycap: (label) =>
    `${fg(GREY.pressed)}▐${RESET}${bg(GREY.pressed)}${fg(TONE.ink)}${BOLD}${label}${RESET}${fg(GREY.pressed)}▌${RESET}`,
  badge: paint(`${bg(GREY.control)}${fg(GREY.pressed)}`),
  field: (text, hint) => paint(`${bg(GREY.raised)}${fg(hint ? GREY.quiet : GREY.bright)}`)(text),
  transmit: paint(`${bg(TONE.red)}${fg(TONE.inkLight)}${BOLD}`),
  item: (row, band) => {
    if (!band) return ` ${row} `
    const ground = TAB_GROUNDS[band]
    // Half-width ends, which a terminal draws the full height of the row they are on.
    const left = band === 'selected' ? fg(TONE.cyan) : fg(ground)
    return `${left}▐${RESET}${under(ground)(row)}${fg(ground)}▌${RESET}`
  },
  icon: (label, state) => {
    const [ground, ink, bold] = ICONS[state]
    return `${ground === null ? '' : bg(ground)}${fg(ink)}${bold ? BOLD : ''} ${label} ${RESET}`
  },
  selected: under(GREY.chosen),
  hovered: under(GREY.raised),
  surface: under(GREY.surface),
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
export function pointerSequence(
  shape: 'pointer' | 'default' | 'text' | 'ew-resize' | 'ns-resize',
): string {
  return `\x1b]22;${shape}\x1b\\`
}
