// How the window is coloured.
//
// A function per role, like the setup screen's palette, and separate from it
// on purpose: that one names the roles a form has — questions, answers, marks
// against a checklist — and this one names the roles a window has. Sharing a
// palette between them would mean naming a colour after neither.
//
// Colour is decoration. Every row has to read correctly without it, so the
// plain skin is the identity function throughout and nothing downstream knows
// which one it has.

export interface Skin {
  /** The rules and dividers the window is built from. */
  chrome(text: string): string
  /** The Wilco mark. */
  brand(text: string): string
  /** A tab or row you are not on. */
  tab(text: string): string
  /** The tab or row you are on. */
  here(text: string): string
  /** A section heading: AGENTS, FILES. */
  label(text: string): string
  /** Something wants a human. */
  waiting(text: string): string
  /** Something is working. */
  busy(text: string): string
  /** Something went wrong. */
  bad(text: string): string
  /** Something finished and is worth looking at. */
  done(text: string): string
  /** What you are typing right now. */
  you(text: string): string
  /** Anything said quietly: hints, paths, keys. */
  hint(text: string): string
}

const plain = (text: string) => text
export const PLAIN: Skin = {
  chrome: plain,
  brand: plain,
  tab: plain,
  here: plain,
  label: plain,
  waiting: plain,
  busy: plain,
  bad: plain,
  done: plain,
  you: plain,
  hint: plain,
}

const paint = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`
const COLOUR: Skin = {
  chrome: paint('2;36'),
  brand: paint('1;36'),
  tab: paint('2'),
  // Reverse video, which is what a selected tab looks like everywhere else.
  here: paint('1;7;36'),
  label: paint('1;2'),
  waiting: paint('1;33'),
  busy: paint('36'),
  bad: paint('31'),
  done: paint('32'),
  you: paint('1'),
  hint: paint('2'),
}

/**
 * Colour, where the terminal is one that shows it. The same rules as the
 * setup screen: `NO_COLOR` is honoured, a dumb terminal and a pipe get none.
 */
export function skinFor(env: NodeJS.ProcessEnv = process.env, tty = true): Skin {
  if (!tty) return PLAIN
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return PLAIN
  if (env.TERM === 'dumb' || !env.TERM) return PLAIN
  return COLOUR
}
