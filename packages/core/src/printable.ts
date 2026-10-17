// Text somebody else wrote, made safe to put on a terminal.
//
// A terminal reads its input as instructions as well as words: an escape
// sequence in a task title can set the window's title, move the cursor and
// draw over what is there, colour the rest of the screen, make a link whose
// words say one thing and whose address is another, or — on some terminals —
// answer back into the input as if it had been typed. So text that was written
// anywhere this program does not control is reduced to text before it is
// drawn: what another machine's Tade says about its work, most of all, because
// that arrives with nothing between it and the window but this.
//
// **Whole sequences go, not only their first byte.** Taking out the ESC alone
// leaves `[31m` in the title, which is harmless and reads as a bug; a sequence
// is recognised by its own grammar (ECMA-48: CSI, the four string commands,
// the two-byte escapes) and taken out to its end, in the seven-bit spelling
// and the eight-bit one — `U+009B` is a CSI by itself on a terminal that reads
// C1 controls, and most of them do.
//
// **Then everything that is not text** (`isText`): every other control, and
// the marks that reorder or hide what is drawn around them. Pure, and the one
// rule — the away view's screen reader (`@tade/web`'s `screen.ts`) asks this
// same question of every character it lets through.

const ESC = 0x1b
const BEL = 0x07
/** The eight-bit string terminator, and the two-byte one's second half (`ESC \`). */
const ST = 0x9c
const BACKSLASH = 0x5c
/** The eight-bit Control Sequence Introducer. */
const CSI = 0x9b
/** What follows ESC to open a control sequence. */
const OPEN_CSI = 0x5b
/** What follows ESC to open a string: OSC, DCS, SOS, PM, APC. */
const OPEN_STRING = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f])
/** The same five strings, opened by one eight-bit byte. */
const STRING = new Set([0x9d, 0x90, 0x98, 0x9e, 0x9f])

/**
 * Whether a character is text: not a control, and not one of the marks that
 * reorder or hide what is drawn around it.
 *
 * The second half is the one that matters on a page. A bidirectional override
 * makes a row read differently from the bytes it is made of — the trick that
 * hides a line of code inside a comment — and a zero-width joiner hides a word
 * from anything that looks for it.
 */
export function isText(point: number): boolean {
  if (point < 0x20 || (point >= 0x7f && point <= 0x9f)) return false
  if (point === 0xad || point === 0x61c || point === 0x180e || point === 0xfeff) return false
  if (point >= 0x200b && point <= 0x200f) return false
  if (point >= 0x202a && point <= 0x202e) return false
  return point < 0x2060 || point > 0x2069
}

/**
 * One line of somebody else's text, as text: every escape sequence taken out
 * whole, every line break and tab a space, and every other character that is
 * not text gone. Never longer than it came in.
 */
export function printable(text: string): string {
  // Nothing to do is the commonest answer by far: a title is letters.
  if (isPlain(text)) return text
  const points = Array.from(text, (one) => one.codePointAt(0) ?? 0)
  let out = ''
  let at = 0
  while (at < points.length) {
    const point = points[at] ?? 0
    if (point === ESC) at = afterEscape(points, at + 1)
    else if (point === CSI) at = afterControl(points, at + 1)
    else if (STRING.has(point)) at = afterString(points, at + 1)
    else {
      if (point === 0x09 || point === 0x0a || point === 0x0d || point === 0x0b || point === 0x0c)
        out += ' '
      else if (isText(point)) out += String.fromCodePoint(point)
      at += 1
    }
  }
  return out
}

/**
 * Somebody else's text of many lines — a request's body, a comment, an answer
 * — as text: each line `printable`, and the breaks between them kept, because
 * a surface that quotes or wraps it needs to know where its paragraphs are.
 */
export function printableLines(text: string): string {
  return text.split(/\r?\n/).map(printable).join('\n')
}

/** Whether every character of it is text already, so it can be handed back as it is. */
function isPlain(text: string): boolean {
  for (const one of text) if (!isText(one.codePointAt(0) ?? 0)) return false
  return true
}

/** Where an escape sequence that began just before `at` ends. */
function afterEscape(points: readonly number[], at: number): number {
  const next = points[at]
  if (next === undefined) return at
  if (next === OPEN_CSI) return afterControl(points, at + 1)
  if (OPEN_STRING.has(next)) return afterString(points, at + 1)
  // `ESC ( B` and its kind: intermediates, then one final byte.
  let end = at
  while (inRange(points[end], 0x20, 0x2f)) end += 1
  return inRange(points[end], 0x30, 0x7e) ? end + 1 : end
}

/** Where a control sequence's parameters, intermediates and final byte end. */
function afterControl(points: readonly number[], at: number): number {
  let end = at
  while (inRange(points[end], 0x30, 0x3f)) end += 1
  while (inRange(points[end], 0x20, 0x2f)) end += 1
  return inRange(points[end], 0x40, 0x7e) ? end + 1 : end
}

/**
 * Where a string command ends: at BEL, at ST in either spelling, or at the end
 * of the text — an unterminated one takes the rest with it, because a terminal
 * would have taken the rest as its argument too.
 */
function afterString(points: readonly number[], at: number): number {
  let end = at
  while (end < points.length) {
    const point = points[end]
    if (point === BEL || point === ST) return end + 1
    if (point === ESC) return points[end + 1] === BACKSLASH ? end + 2 : end
    end += 1
  }
  return end
}

function inRange(point: number | undefined, low: number, high: number): boolean {
  return point !== undefined && point >= low && point <= high
}
