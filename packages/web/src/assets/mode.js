// Which of the page's two modes a device is in: the **overview**, the page as it
// has always been, or the **full view**, the window itself drawn by the phone
// from the state the machine sends (§10 T4 of the Duo plan). Both pages read
// this — the overview at `/` and the full view at `/draw/` — and the switch in
// each one's header writes it.
//
// **The default follows the orientation**: upright is the overview, sideways is
// the full view, because a phone held upright is a column of 53 to 92 cells and
// the window wants a terminal's width, which a phone only has sideways (the
// plan's §1). A choice somebody makes is kept **per orientation, per device**:
// the Overview pressed while sideways is the overview sideways from then on,
// and upright is still the overview until somebody chooses otherwise there.
//
// **The second thing this page keeps in `localStorage`**, beside the docks'
// folds (`docks.js`), and like those it is words the page wrote itself — two
// orientations and two modes, read back through `modesFrom`, which knows no
// other word, so nothing else can ride in on the key. Nothing about anybody's
// work. Every read and write is in a `try`: a browser that lends no store (a
// private window, a blocked site) gets the defaults, which is a page that
// still works.
//
// Pure but for those two functions, so a test reads the rules as a table.

/** The key the choices are kept under. */
const MODE_KEY = 'tade.mode'

/** The two modes, and the paths they are drawn at. */
export const MODES = { overview: '/', full: '/draw/' }

/** The two ways up a screen is held. */
export const ORIENTATIONS = ['upright', 'sideways']

/** How a screen of this size is held: wider than tall is sideways. */
export function orientationOf(width, height) {
  return width > height ? 'sideways' : 'upright'
}

/** The mode a way up is in when nobody has chosen: the overview upright, the full view sideways. */
export function defaultMode(orientation) {
  return orientation === 'sideways' ? 'full' : 'overview'
}

/**
 * The choices out of what the key holds: `upright=full;sideways=overview`, each
 * part a known orientation and a known mode, or it is not read at all.
 */
export function modesFrom(text) {
  const modes = {}
  if (typeof text !== 'string') return modes
  for (const part of text.split(';')) {
    const [orientation, mode] = part.split('=')
    if (!ORIENTATIONS.includes(orientation) || !Object.hasOwn(MODES, mode)) continue
    modes[orientation] = mode
  }
  return modes
}

/** The choices as the key holds them, in a fixed order. */
export function modesText(modes) {
  return ORIENTATIONS.filter((one) => modes[one] !== undefined)
    .map((one) => `${one}=${modes[one]}`)
    .join(';')
}

/** The mode this way up is in: what was chosen here, or the default. */
export function modeFor(orientation, modes) {
  return modes[orientation] ?? defaultMode(orientation)
}

/** What this device kept, or nothing where it kept nothing or cannot say. */
export function keptModes() {
  try {
    return modesFrom(globalThis.localStorage?.getItem(MODE_KEY) ?? null)
  } catch {
    return {}
  }
}

/** Keep a choice for this way up, or quietly do not: a device that forgets gets the default. */
export function keepMode(orientation, mode) {
  const modes = { ...keptModes(), [orientation]: mode }
  try {
    globalThis.localStorage?.setItem(MODE_KEY, modesText(modes))
  } catch {
    // Nothing to do about a store this browser will not lend; the press still
    // goes where it said, and the next visit starts from the default.
  }
}

/** The mode this screen is in now, as this device has it. */
export function modeNow(width, height) {
  return modeFor(orientationOf(width, height), keptModes())
}
