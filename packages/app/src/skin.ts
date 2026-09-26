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
  /**
   * The other half of `danger`: the press that turns back on what a red one
   * turns off. The two are a pair and are drawn as one — the same weight, the
   * same dark letters, a stop and a go — so a control that is one of them in
   * one state and the other in the next says which by its colour alone.
   */
  | 'go'
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

  /**
   * One cell of the same column beside something that scrolls *itself*: the
   * track's own ground, with a dashed rule on it rather than a thumb.
   *
   * A thumb is a claim about where you are, and here there is nobody to ask —
   * so the column says the one thing that is true, which is that this is not
   * a bar the window is driving. Dashed rather than solid, and never lit,
   * because nothing here can be taken hold of. Exactly one column, like the
   * two above it: the gutter is the same gutter whoever is scrolling.
   */
  scrollElsewhere(): string

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
 * two something is says what it is for before any of it is read. Which of the
 * two inks a ground takes is not written down beside each one — it is
 * `inkOn`'s to answer, for the reason written there.
 *
 * The green plays both parts. As *text* it means finished; as the *ground* of
 * the button that turns something back on it is the same 114 (`#87d787`),
 * light enough to read on the window's near-black and bright enough to take
 * the dark ink, which is what lets it stand beside the red at the same weight
 * — a stop and a go are one pair or they are nothing. The muted green (65,
 * `#5f875f`) is a third part again: the ground of the press the window would
 * merely *like* you to make, dark enough to sit quietly beside the amber and
 * the red without competing with them.
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
  /** Done, as text; and the ground of the press that turns something back on. */
  green: 114,
  /** The same green under the pointer: the same hue with the light turned up. */
  greenLit: 157,
  /** The press the window would like next: a muted green, as a ground. */
  greenMuted: 65,
  /** The same under the pointer. */
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
 * mark, the setup screen's wordmark and the empty project's are the same
 * brand, so they are the same five steps.
 */
export const WORDMARK_SHADES = [223, 221, TONE.amber, 208, 166]

/** The wordmark, in half blocks: curves in five rows rather than a wall of them. */
const WORDMARK_LETTERS: Record<string, string[]> = {
  T: [
    '\u2588'.repeat(8),
    '   \u2588\u2588   ',
    '   \u2588\u2588   ',
    '   \u2588\u2588   ',
    '   \u2588\u2588   ',
  ],
  A: [
    ' \u2584\u2588\u2588\u2588\u2588\u2584 ',
    '\u2588\u2588\u2580  \u2580\u2588\u2588',
    '\u2588'.repeat(8),
    '\u2588\u2588    \u2588\u2588',
    '\u2588\u2588    \u2588\u2588',
  ],
  D: [
    '\u2588\u2588\u2588\u2588\u2588\u2588\u2584 ',
    '\u2588\u2588   \u2580\u2588\u2588',
    '\u2588\u2588    \u2588\u2588',
    '\u2588\u2588   \u2584\u2588\u2588',
    '\u2588\u2588\u2588\u2588\u2588\u2588\u2580 ',
  ],
  E: [
    '\u2588'.repeat(8),
    '\u2588\u2588      ',
    '\u2588\u2588\u2588\u2588\u2588\u2588  ',
    '\u2588\u2588      ',
    '\u2588'.repeat(8),
  ],
}

/**
 * The wordmark drawn large, one string per row.
 *
 * One drawing of it, here beside the shades it is painted in and beside
 * `markLabel`, which is the same four letters spelt out small: a second set of
 * block letters somewhere else is a second brand, and it is the one that
 * stops being changed when this one is. The setup screen draws it, and so does
 * a project with no agents in it.
 */
export const WORDMARK: readonly string[] = [0, 1, 2, 3, 4].map((i) =>
  [...'TADE'].map((letter) => WORDMARK_LETTERS[letter]?.[i] ?? '').join('  '),
)

/** How wide the wordmark is drawn, so a layout can ask before it asks for it. */
export const WORDMARK_WIDTH = WORDMARK[0]?.length ?? 0

/**
 * The six levels of the xterm colour cube, and what a number in it is worth.
 *
 * The window paints in numbers, so nothing here can tell by looking whether a
 * label can be read on the ground under it. The 256 are a fixed table, which
 * is what makes that a question with an answer: 16–231 are a 6×6×6 cube of
 * these levels and 232–255 a grey ramp. The first sixteen are not in it, and
 * are not in the palette either, for the same reason — they are whatever the
 * terminal's theme says they are, so their colour is not ours to compute.
 */
const CUBE = [0, 95, 135, 175, 215, 255]

function rgbOf(tone: number): [number, number, number] {
  if (tone >= 232) {
    const step = 8 + 10 * (tone - 232)
    return [step, step, step]
  }
  const at = tone - 16
  const level = (n: number) => CUBE[n] ?? 0
  return [level(Math.floor(at / 36)), level(Math.floor(at / 6) % 6), level(at % 6)]
}

/** Relative luminance, the WCAG one: 0 for black, 1 for white. */
function luminance(tone: number): number {
  const channel = (value: number) => {
    const part = value / 255
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = rgbOf(tone)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** How far apart two tones are, as the WCAG ratio: 1 for the same, 21 at most. */
export function contrast(a: number, b: number): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

/**
 * The ink a label takes on a ground: whichever of the palette's two inks can
 * be read on it — the dark one on a bright ground, the light one on a dark.
 *
 * It is computed rather than written down beside each control, because a
 * choice made once per button is a choice that gets made wrong. It was: the
 * one green ground in the palette wore the white label at 4.1:1, under the
 * 4.5 that counts as readable, three paragraphs below a comment saying dark
 * ink goes on the green — and nothing anywhere could have noticed, because
 * nothing anywhere was comparing the two. Now the ground decides, and the
 * only way to get it wrong is to say so out loud (`ink` on a `Paint`, which
 * two looks do and both say why).
 */
export function inkOn(ground: number): number {
  return contrast(ground, TONE.ink) >= contrast(ground, TONE.inkLight) ? TONE.ink : TONE.inkLight
}

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

/**
 * How a block is painted: the ground, and whether its label is bold.
 *
 * The ink is not in here unless it has to be, because the ground already
 * answers it — see `inkOn`. A look that names one is a look whose label is
 * not ordinary text on a ground, and says which it is.
 */
interface Paint {
  ground: number
  bold?: boolean
  /** Ink the ground does not decide. Only ever for a reason written beside it. */
  ink?: number
}

/** A block in the control's own colour, label centred on its ground. */
function block(label: string, paint: Paint, pad = '  '): string {
  const ink = paint.ink ?? inkOn(paint.ground)
  return `${bg(paint.ground)}${fg(ink)}${paint.bold === true ? BOLD : ''}${pad}${label}${pad}${RESET}`
}

const LOOKS: Record<Look, Paint> = {
  rest: { ground: GREY.control },
  hover: { ground: GREY.hovered },
  pressed: { ground: GREY.pressed },
  primary: { ground: TONE.amber, bold: true },
  attention: { ground: TONE.greenMuted, bold: true },
  go: { ground: TONE.green, bold: true },
  danger: { ground: TONE.red, bold: true },
  // The one control meant to be hard to read: it cannot be pressed, and a
  // label the ground can carry would say it could.
  off: { ground: GREY.raised, ink: GREY.chrome },
  // The label *is* the signal here, so it is the brand's amber rather than
  // ink at all: a `+` that has to be found at a glance on a grey block.
  add: { ground: GREY.control, ink: TONE.amber, bold: true },
}

/**
 * The same looks under the pointer, for the ones whose colour is their
 * meaning: a shade lighter, the way every other control lights. A look not in
 * here lights by becoming `hover`, and `off` never lights at all.
 */
const LIT: Partial<Record<Look, Paint>> = {
  primary: { ground: TONE.amberLight, bold: true },
  attention: { ground: TONE.greenMutedLight, bold: true },
  go: { ground: TONE.greenLit, bold: true },
  danger: { ground: TONE.redLight, bold: true },
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
  if (on) return block(label, { ground: TONE.amber, bold: true })
  if (hover) return block(label, { ground: GREY.control })
  return paint(fg(GREY.tab))(`  ${label}  `)
}

/** The grounds of a lit tab down the side: pointed at, and the one you are on. */
const TAB_GROUNDS: Record<Band, number> = { selected: GREY.control, hovered: GREY.raised }

const ICONS: Record<IconState, [ground: number | null, ink: number, bold: boolean]> = {
  // The two with no ground are glyphs on the window's own near-black, so
  // their ink is a text tone; the three with one take what the ground gives.
  rest: [null, GREY.tab, false],
  signal: [null, TONE.amber, true],
  hover: [GREY.hovered, inkOn(GREY.hovered), false],
  danger: [TONE.red, inkOn(TONE.red), true],
  pressed: [GREY.pressed, inkOn(GREY.pressed), false],
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
  // The same rule, dashed: what a bar looks like where there is no thumb to
  // draw and never will be.
  scrollElsewhere: () => '┆',
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
  cursor: paint(`${bg(GREY.bright)}${fg(inkOn(GREY.bright))}`),
  found: (text, on) =>
    paint(
      on
        ? `${bg(TONE.amber)}${fg(inkOn(TONE.amber))}`
        : `${bg(GREY.control)}${fg(inkOn(GREY.control))}`,
    )(text),
  // The track is the ground a step up from the window, quiet enough to sit
  // beside a divider without competing with it; the thumb is the grey the
  // window's rules are drawn in, and while you hold it the grey of anything
  // said out loud — a handle you have taken hold of should say so.
  scrollTrack: () => solid(GREY.raised, '▕'),
  scrollThumb: (lit) => solid(lit ? GREY.quiet : GREY.chrome, '█'),
  // The track's own ground with a dashed rule over it: the same column,
  // visibly not a handle. The ink is the grey things are said quietly in
  // rather than the thumb's, because a thumb is a filled cell and this is a
  // few strokes of one — at the thumb's tone the dashes all but disappear,
  // and a mark too faint to notice is a bar that looks broken, which is the
  // thing this is here to stop being.
  scrollElsewhere: () => `${bg(GREY.raised)}${fg(GREY.quiet)}┆${RESET}`,
  button: (label, look, lit) => block(label, (lit === true ? LIT[look] : undefined) ?? LOOKS[look]),
  chip: (label, look, lit) =>
    block(label, (lit === true ? LIT[look] : undefined) ?? LOOKS[look], ' '),
  tabbed: tabBlock,
  keycap: (label, hover) => {
    const ground = hover === true ? GREY.bright : GREY.pressed
    return `${bg(ground)}${fg(inkOn(ground))}${BOLD} ${label} ${RESET}`
  },
  // A count, not a label: it keeps a quiet grey of its own rather than the
  // ink the ground would give it, so a number beside a heading or a button
  // reads as a remark about it and not as a second control.
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
  // The microphone open, said on the red: dark letters, because that is what
  // the red carries. White on it is 3:1 and was the worst-read thing drawn.
  transmit: paint(`${bg(TONE.red)}${fg(inkOn(TONE.red))}${BOLD}`),
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
