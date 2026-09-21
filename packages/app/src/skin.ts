// How the window is coloured, and what its controls look like.
//
// The window draws with xterm's 256 colours rather than true colour, because
// Terminal.app shows those and not the other: the values here are the ones the
// design was drawn in, so what was designed is what you get.
//
// Every control has a fixed width that does not depend on colour. A button is
// `  label  ` on its own ground painted and `[ label ]` plain, both label + 4
// columns, so the layout and the map of what is clickable are identical with or
// without it — the plain skin is not a degraded layout, only an unpainted one.
// A chip is the same block with a column of ground instead of two, `[label]`
// plain: label + 2 either way, so a row of small controls beside a button reads
// as the same set without taking a button's width.
//
// A control is a plain block: no half-block end caps. They were decoration, and
// decoration on every button in the window reads as noise rather than as shape.
// The columns they took are kept and filled with the control's own ground, so
// removing them squared the ends off without moving anything.
//
// Separate from the setup screen's palette on purpose: that one names the roles
// a form has, this one the roles a window has.

/** How a list item is lit: the one you are on, or the one under the pointer. */
export type Band = 'selected' | 'hovered'

/**
 * A small glyph button's state: at rest, at rest and worth acting on, under
 * the pointer, under it and destructive, held down.
 */
export type IconState = 'rest' | 'signal' | 'hover' | 'danger' | 'pressed'

/** A switch's state under the pointer: the same three every block control has. */
export type SwitchState = 'rest' | 'hover' | 'pressed'

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
   * The wordmark as a block, for the corner it lives in: the project tab you
   * are on, spelt out. Exactly label + 4 columns, painted or not, so nothing
   * shifts when colour goes away.
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

  /**
   * A block with the label centred: `  label  `, exactly label + 4 columns.
   *
   * `lit` is the pointer on it. A look that carries meaning keeps its colour
   * and takes a lighter shade of it, because a button that says what it does
   * must not stop saying it to say it is being pointed at.
   */
  button(label: string, look: Look, lit?: boolean): string
  /**
   * The same block a column narrower each side: ` label `, exactly label + 2.
   * For the small controls that sit beside a button without being one its size.
   */
  chip(label: string, look: Look, lit?: boolean): string
  /** A tab: filled when on, `  label  ` when not. Label + 4 either way. */
  tabbed(label: string, on: boolean, hover: boolean): string
  /** One key as a key cap: a block, label + 2. Pass the spaces you want inside. */
  keycap(label: string, hover?: boolean): string
  /** A count: ` 3 `. */
  badge(text: string): string
  /** A field's body, already padded to its width by the caller. */
  field(text: string, hint: boolean, hover?: boolean): string
  /**
   * A switch: a knob in a four-cell track, at the end it is thrown to, then
   * the word for it. Exactly 8 columns, painted or not, so a column of them
   * lines up whatever the skin — and the word is there because a colour is
   * not an answer to "is this on?".
   */
  toggle(on: boolean, state: SwitchState): string
  /** The microphone is open. */
  transmit(text: string): string

  /**
   * A list item as a tab: its row on a ground with a blank column either side,
   * when lit, and the same columns blank when not — so nothing moves as it
   * lights. The one you are on is marked down its left. Exactly the row's
   * width + 2.
   */
  item(row: string, band: Band | null): string

  /**
   * The bar that marks the row you are on — a selected item, the focused line
   * of a form, the choice a menu is at. Exactly one column, and the whole of
   * it: the cell is filled edge to edge rather than given a glyph to draw, so
   * a marked row is one clean line down its left and never a stack of little
   * boxes with a hairline between them. The same reasoning as the scrollbar's,
   * and for the same reason — see `scrollThumb`.
   */
  marker(): string

  /** A glyph as a button that takes no room of a block: ` × `, exactly label + 2 columns. */
  icon(label: string, state: IconState): string

  /**
   * One cell of a scrollbar's track, and one of its thumb — `lit` while the
   * thumb is held or pointed at. Exactly one column each.
   *
   * A bar is one object down the side of a pane, so its cells have to tile:
   * a glyph on the window's own ground is at the mercy of the font, and the
   * fonts that draw `█` or `▕` short of the cell leave a hairline between
   * every row — which reads as a stack of little boxes rather than as a
   * thumb. So the cell itself is painted, with the block laid on its own
   * colour: filled where colour exists, still a block where it does not.
   */
  scrollTrack(): string
  scrollThumb(lit: boolean): string

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
 * Tade's colour is amber, and what the others keep is its *mood*: full
 * saturation at half lightness — a dark yellow, not a bright one — so every
 * accent is the same colour at another hue and the window reads as one
 * design. The violet that marks something waiting on you is that amber turned
 * round the wheel: xterm 176, `#d787d7`, light enough to read on the window's
 * own ground, which is the only place it is ever used.
 *
 * Every value here is one of the 256, for the reason at the top of this file,
 * so a colour picked anywhere else arrives as the nearest one to it.
 *
 * A tone plays two parts, and which part it plays decides what else has to be
 * true of it.
 *
 * As *text* on the window's near-black ground it has to be light enough to
 * read, so the text tones sit near the amber's own value — in relative
 * luminance, the WCAG one from 0 to 1: amber .52, green .55, cyan .56, the
 * violet that marks something waiting on you (176) .41 — none of them under
 * 7:1 against the window's ground or 4:1 against the row you are on. A ground
 * shade would be a smudge there, which is why the two tones that are also
 * grounds are written down separately.
 *
 * As the *ground* of a button it is the colour itself, and the ink is
 * whatever can be read on it: dark ink on the amber, on the red and on the
 * green, light ink on the greys. A coloured button is a light block with dark
 * letters and a grey one is a dark block with light letters, and which of the
 * two something is says what it is for before any of it is read.
 *
 * The green plays both parts, and takes a different shade for each. As *text*
 * it means finished and is the light one (114, `#87d787`). As the *ground* of
 * the button the window would like you to press it is the muted one (65,
 * `#5f875f`) with a light label on it: dark enough to sit quietly beside the
 * amber and the red without competing with them, and the one green in the 256
 * that is neither a pure green nor a pale one. Under the pointer it lightens
 * past what white letters can be read on, so the letters go dark — which is
 * what a grey button does when it is held, for the same reason.
 *
 * Red is the one exception, and deliberately: something that has gone wrong is
 * allowed to be darker and louder than the rest, because it is not decoration.
 */
const TONE = {
  /** Tade itself, and anything Tade is doing: the brand, work in progress, links. */
  amber: 214,
  /** The same amber under the pointer: a primary button lit, a switch thrown. */
  amberLight: 222,
  /** The same amber with the light taken out of it: a switch held down. */
  amberDark: 94,
  /** Waiting on you, as text: light enough to be read on the window's ground. */
  violetText: 176,
  /** Done, as text. */
  green: 114,
  /** The press the window would like next: a muted green, as a ground. */
  greenMuted: 65,
  /** The same under the pointer: lighter, and past what a light label survives. */
  greenMutedLight: 71,
  /** Where you are. The one complement in the palette, at the amber's own value. */
  cyan: 80,
  /** Gone wrong, or about to: the exception to the rule above. */
  red: 203,
  /** The same, under the pointer. */
  redLight: 210,
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

/**
 * One cell filled: a glyph laid on its own colour, so the cell is that colour
 * edge to edge whatever the font does with the glyph. The glyph still matters
 * — it is what the screen says when the colour is stripped off it, which is
 * how the golden screens read a bar — but nothing of it is seen.
 */
const solid = (tone: number, glyph: string) => `${bg(tone)}${fg(tone)}${glyph}${RESET}`

/**
 * The one cell a marked row is marked with: the dark amber, filled edge to
 * edge. Amber because that is Tade's own colour and what the rest of the
 * chrome is lit with, and the dark step of it because a bar beside every
 * selected row is always on screen — the bright one would shout over the row
 * it is pointing at.
 */
const MARKER = solid(TONE.amberDark, '▌')

/** A block in the control's own colour, label centred on its ground. */
function block(label: string, ground: number, ink: number, bold = false, pad = '  '): string {
  return `${bg(ground)}${fg(ink)}${bold ? BOLD : ''}${pad}${label}${pad}${RESET}`
}

const LOOKS: Record<Look, [ground: number, ink: number, bold: boolean]> = {
  rest: [GREY.control, GREY.bright, false],
  hover: [GREY.hovered, TONE.inkLight, false],
  pressed: [GREY.pressed, TONE.ink, false],
  primary: [TONE.amber, TONE.ink, true],
  attention: [TONE.greenMuted, TONE.inkLight, true],
  danger: [TONE.red, TONE.ink, true],
  off: [GREY.raised, GREY.chrome, false],
  add: [GREY.control, TONE.amber, true],
}

/**
 * The same looks under the pointer, for the ones whose colour is their
 * meaning: a shade lighter, the way every other control lights. A look not in
 * here lights by becoming `hover`, and `off` never lights at all.
 */
const LIT: Partial<Record<Look, [ground: number, ink: number, bold: boolean]>> = {
  primary: [TONE.amberLight, TONE.ink, true],
  attention: [TONE.greenMutedLight, TONE.ink, true],
  danger: [TONE.redLight, TONE.ink, true],
}

const identity = (text: string) => text

/**
 * How the wordmark is spelt: letters apart, so the corner reads as a mark and
 * not as one more tab. Shared, because the layout measures what the skins draw.
 */
export const markLabel = (label: string) => [...label].join(' ')

/**
 * A tab, painted: filled in the brand's amber when it is the one you are on,
 * lit under the pointer, quiet otherwise.
 *
 * Its own function because the corner mark is drawn with it — the mark *is*
 * this block, spelt out — and two hand-styled amber blocks in one row are two
 * things that drift apart the first time the palette moves.
 */
function tabBlock(label: string, on: boolean, hover: boolean): string {
  if (on) return block(label, TONE.amber, TONE.ink, true)
  if (hover) return block(label, GREY.control, GREY.bright)
  return paint(fg(GREY.tab))(`  ${label}  `)
}

/** The grounds of a lit tab down the side: pointed at, and the one you are on. */
const TAB_GROUNDS: Record<Band, number> = { selected: GREY.control, hovered: GREY.raised }

const ICONS: Record<IconState, [ground: number | null, ink: number, bold: boolean]> = {
  rest: [null, GREY.tab, false],
  signal: [null, TONE.amber, true],
  hover: [GREY.hovered, TONE.inkLight, false],
  danger: [TONE.red, TONE.ink, true],
  pressed: [GREY.pressed, TONE.ink, false],
}

export const PLAIN: Skin = {
  colour: false,
  chrome: identity,
  edge: identity,
  brand: identity,
  // The same columns the painted mark uses, unpainted: stripped of colour, the
  // two renders are identical, which is what the setup screen's test asserts.
  // Not `[ T A D E ]` the way a tab you are on is written here, because the
  // brackets are this skin's word for something you can press, and the mark
  // is the one thing in the top row that is not.
  mark: (label) => `  ${markLabel(label)}  `,
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
  // Nothing can be filled without colour, so the bar is the two glyphs that
  // come closest: the thinnest rule there is for the track, the fullest block
  // for the thumb.
  scrollTrack: () => '▕',
  scrollThumb: () => '█',
  button: (label) => `[ ${label} ]`,
  // A chip that is on has to say so in its shape here, because the colour that
  // says it elsewhere is gone: `<H>` switched on against `[H]` at rest, the
  // same label + 2 either way. `primary` is the one look whose whole meaning
  // is being on — everything else keeps the square brackets every control has.
  chip: (label, look) => (look === 'primary' ? `<${label}>` : `[${label}]`),
  tabbed: (label, on) => (on ? `[ ${label} ]` : `  ${label}  `),
  keycap: (label) => `[${label}]`,
  badge: (text) => `(${text.trim()})`.padEnd(text.length),
  field: (text) => text,
  // The same 8 columns and the same shape the painted switch has: a knob in a
  // track, at the right for on and at the left for off, with the word saying
  // which without reading the picture.
  toggle: (on) => (on ? '[ █] on ' : '[█ ] off'),
  transmit: identity,
  // Without colour the one you are on is marked the way focus is marked everywhere else.
  item: (row, band) => (band === 'selected' ? `▌${row} ` : ` ${row} `),
  marker: () => '▌',
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
  // The tab of the project you are on, spelt out: the same block, the same
  // bright amber, the same ink, the same two columns of ground either side —
  // drawn by the very function the tabs are, so the corner and the project
  // beside it can never come to disagree about what the brand looks like. The
  // spelling is the whole difference, and is what keeps the mark from reading
  // as one more tab you could press.
  mark: (label) => tabBlock(markLabel(label), true, false),
  signal: paint(`${fg(TONE.amber)}${BOLD}`),
  tab: paint(fg(GREY.tab)),
  label: paint(`${fg(GREY.heading)}${BOLD}`),
  waiting: paint(fg(TONE.violetText)),
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
  // The track is the ground a step up from the window, quiet enough to sit
  // beside a divider without competing with it; the thumb is the grey the
  // window's rules are drawn in, and while you hold it the grey of anything
  // said out loud — a handle you have taken hold of should say so.
  scrollTrack: () => solid(GREY.raised, '▕'),
  scrollThumb: (lit) => solid(lit ? GREY.quiet : GREY.chrome, '█'),
  button: (label, look, lit) => {
    const [ground, ink, bold] = (lit === true ? LIT[look] : undefined) ?? LOOKS[look]
    return block(label, ground, ink, bold)
  },
  chip: (label, look, lit) => {
    const [ground, ink, bold] = (lit === true ? LIT[look] : undefined) ?? LOOKS[look]
    return block(label, ground, ink, bold, ' ')
  },
  tabbed: tabBlock,
  keycap: (label, hover) =>
    `${bg(hover === true ? GREY.bright : GREY.pressed)}${fg(TONE.ink)}${BOLD} ${label} ${RESET}`,
  badge: paint(`${bg(GREY.control)}${fg(GREY.pressed)}`),
  field: (text, hint, hover) =>
    paint(
      `${bg(hover === true ? GREY.hovered : GREY.raised)}${fg(hint ? GREY.quiet : GREY.bright)}`,
    )(text),
  // A knob in a track: two cells of solid knob at the end the switch is thrown
  // to, and the two cells it is not at are the track, with a rule along them.
  //
  // The knob is what says the state, and it says it twice — by which end it is
  // at, and by its colour: Tade's amber for on, the grey of a key cap for off,
  // both of them about five to one against the track, so off is as easy to
  // read as on and the word beside it confirms the control rather than
  // carrying it.
  //
  // The track keeps its own colour whichever way the switch is thrown, which
  // is what makes a column of them scan: the same housing every time, with the
  // knob at one end or the other. Colouring the track instead — which this did
  // — made on a block of amber with a dot in it and off a dark block with a
  // dot in it, two controls of quite different weight and neither of them
  // reading as a switch.
  //
  // The track is one step off the ground of the row you are on, so on that one
  // row the paint alone all but disappears and would leave a knob with no ends
  // to be at. Hence the rule: the track is painted *and* drawn, so where the
  // paint cannot be told from the row under it the line still says how far the
  // switch reaches. Both parts are otherwise cells painted in their own
  // colour, for the reason written beside `solid`.
  //
  // Held down, the knob is drawn mid-track: while you are pressing it, it is
  // on its way from one end to the other.
  toggle: (on, state) => {
    const rest = state === 'rest'
    const track = rest ? GREY.control : GREY.hovered
    const rule = rest ? GREY.quiet : GREY.heading
    const knob = on ? (rest ? TONE.amber : TONE.amberLight) : rest ? GREY.pressed : GREY.bright
    const groove = (cells: number) => `${bg(track)}${fg(rule)}${'─'.repeat(cells)}${RESET}`
    const held = `${bg(knob)}${fg(knob)}██${RESET}`
    const shown =
      state === 'pressed'
        ? `${groove(1)}${held}${groove(1)}`
        : on
          ? `${groove(2)}${held}`
          : `${held}${groove(2)}`
    const word = on
      ? `${fg(GREY.bright)}${BOLD}on ${RESET}`
      : `${fg(rest ? GREY.tab : GREY.bright)}off${RESET}`
    return `${shown} ${word}`
  },
  transmit: paint(`${bg(TONE.red)}${fg(TONE.inkLight)}${BOLD}`),
  item: (row, band) => {
    if (!band) return ` ${row} `
    const ground = TAB_GROUNDS[band]
    // No end pieces: the ground is what says how far the row reaches, and the
    // columns the half-blocks took are kept and filled with it, so squaring
    // the ends off moved nothing. The one you are on is marked down its left
    // by the same bar every other marked row in the window gets.
    const left = band === 'selected' ? MARKER : solid(ground, ' ')
    return `${left}${under(ground)(row)}${solid(ground, ' ')}`
  },
  marker: () => MARKER,
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
