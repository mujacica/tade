// The one line `tade` says before the window has a screen to draw on.
//
// Opening is most of a second of loading Tade's own code before anything can
// be drawn, and the terminal used to sit blank for all of it — which reads as
// a command that did nothing. So the first thing `bin.ts` does, before it
// loads anything, is say `opening…` where the window is about to be, and the
// window takes it back once it has gone again: on the way out, or before
// anything else is written instead of a window (an invalid config, a home
// another window holds, setup).
//
// No dependency of its own, like the other two files `bin.ts` imports at the
// top: anything here runs before the check that says this Node can run Tade.

/** Back to the start of the line, and the line cleared: what was said there is gone. */
const ERASE = '\r\x1b[2K'

/** What the window says while it opens. */
export const OPENING = 'opening…'

let said = false

/** The flags that answer instead of opening a window. */
const ANSWERS = new Set(['-h', '--help', '-V', '--version'])

/**
 * Whether these arguments open the window: no command, or `app`, and no
 * asking for help or the version. A guess made before the parser is loaded,
 * so it errs towards saying nothing — `tade -c x` opens the window and is not
 * told so early, which costs a line nobody missed.
 */
export function opensWindow(args: readonly string[]): boolean {
  if (args.some((arg) => ANSWERS.has(arg))) return false
  const command = args.find((arg) => !arg.startsWith('-'))
  return command === undefined || command === 'app'
}

/** Say it, where there is a terminal to say it on. Once. */
export function sayOpening(out: NodeJS.WriteStream = process.stdout): void {
  if (said || !out.isTTY) return
  said = true
  out.write(OPENING)
}

/** Take it back. Safe to call whether or not it was said, and twice. */
export function unsayOpening(out: NodeJS.WriteStream = process.stdout): void {
  if (!said) return
  said = false
  out.write(ERASE)
}
