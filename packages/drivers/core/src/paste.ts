// What a paste is, as bytes a program reads.
//
// A terminal hands a program pasted text one of two ways, and which is the
// program's to choose: wrapped in `ESC [ 200 ~` … `ESC [ 201 ~` while it has
// turned bracketed paste on (DECSET 2004), so it can tell text from keys, and
// as plain keystrokes otherwise. A program that never asked reads the markers
// as keys — macOS's nano prints `~text~` — so the wrapping is never assumed:
// it comes from what the driver watched the program ask for, as the wheel's
// encoding does.
//
// Unwrapped, a line break goes as the Enter key, `\r`, which is what every
// terminal sends for one: a bare `\n` is ctrl+j, which nano reads as Justify.
// Wrapped, the text goes as it came, because the program is reading a paste
// and not keys.

const ESC = String.fromCharCode(27)
const START = `${ESC}[200~`
const END = `${ESC}[201~`

/** Either marker, inside pasted text: a terminal takes them out, so a paste cannot end itself early. */
const MARKERS = new RegExp(`${ESC}\\[20[01]~`, 'g')
const BREAKS = /\r\n|\n/g

/** The bytes a program reads for pasted text, wrapped only where it turned bracketed paste on. */
export function pasteBytes(text: string, bracketed: boolean): Uint8Array {
  const clean = text.replace(MARKERS, '')
  return new TextEncoder().encode(
    bracketed ? `${START}${clean}${END}` : clean.replace(BREAKS, '\r'),
  )
}

/**
 * Whether a program has bracketed paste on after this much of its output,
 * given whether it had before: the last `ESC [ ? … 2004 h` or `l` in it wins.
 * For a driver that reads its lanes' output on the way past.
 */
export function bracketedAfter(output: string, was: boolean): boolean {
  let now = was
  for (const [, params, set] of output.matchAll(PRIVATE_MODE)) {
    if ((params ?? '').split(';').includes('2004')) now = set === 'h'
  }
  return now
}

/** A private mode being turned on or off, as a program says it. */
const PRIVATE_MODE = new RegExp(`${ESC}\\[\\?([0-9;]+)([hl])`, 'g')
