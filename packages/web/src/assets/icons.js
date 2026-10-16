// The icons: one `<use>` of a symbol in the shell's sprite (`index.html`).
//
// **Why a sprite in the document and not a file or a string.** The content
// policy has no `unsafe-inline` and no module may build markup, so an icon is
// two elements made with `createElementNS` and an `href` — and the namespace
// they are made in is read off the sprite the HTML parser already put in the
// SVG namespace, so no file here spells a URL (`test/assets.test.ts` holds
// that nothing on the page names anything off this machine).
//
// **An icon is never the only statement of anything.** Every one sits beside a
// word, or is inside a button whose `aria-label` is the word, and every one is
// `aria-hidden` so a screen reader reads the word once rather than the drawing.

/** Every symbol in the sprite, so a name nobody drew is caught by a test rather than a blank. */
export const ICONS = [
  'overview',
  'inbox',
  'queue',
  'runs',
  'agents',
  'talk',
  'spend',
  'checks',
  'evals',
  'workflows',
  'land',
  'reviews',
  'findings',
  'notes',
  'devices',
  'settings',
  'more',
  'refresh',
  'help',
  'search',
  'spark',
  'send',
  'chevron',
  'back',
  'close',
  'stop',
  'folder',
  'bolt',
  'pause',
  'play',
  'check',
  'alert',
  'clock',
  'flag',
  'arrow',
  'laptop',
  'scan',
  'mark',
]

/** The sprite's namespace, read once off the element the parser made. */
function spaceOf() {
  return document.querySelector('svg.sprite')?.namespaceURI ?? null
}

/** One icon, as a node: `<svg class="ic"><use href="#i-name"/></svg>`. */
export function icon(name, extra = '') {
  const klass = extra === '' ? `ic ic-${name}` : `ic ic-${name} ${extra}`
  return drawn(`i-${name}`, klass, '0 0 24 24')
}

/**
 * The wordmark's word, a box of its own in the sprite (`#w-tade`): tade-web's
 * `T A D E` in Tade Mono Bold, black on amber. The page is Tade, as the window
 * is — what it is for is said by what is on it, not by a second word.
 *
 * **Drawn, not typed**, because the page loads no webfont and the system face
 * is not that one. The letters are the outlines of Iosevka Term Bold 34.8.1
 * (what Tade Mono is cut from), read out of tade-web's `build/font` in font
 * units and moved, unscaled, to where tade-web's rule for `.mk` puts them — a
 * column of tracking between letters, two of ground before them, one after —
 * with the cap height centred in the line. `test/mark.test.ts` holds every
 * point to its letter's column.
 */
export const WORDS = ['tade']

/** A word's box in the sprite's units: 5.5em by 1.5em, of a 1000-unit em. */
const WORD_BOX = '0 0 5500 1500'

/**
 * Tade's mark: the favicon's two squares, then the words.
 *
 * One image with one name, so a screen reader says *Tade* once rather than
 * two drawings; inside a link that names itself, the link's word wins.
 */
export function wordmark() {
  const node = document.createElement('span')
  node.className = 'wordmark'
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', 'Tade')
  node.append(
    icon('mark', 'mark'),
    ...WORDS.map((word) => drawn(`w-${word}`, `word word-${word}`, WORD_BOX)),
  )
  return node
}

/**
 * One `<use>` of a symbol: `<svg class="…"><use href="#id"/></svg>`.
 *
 * Without a sprite — a page some test built without the shell — an empty span
 * of the same size, so the layout holds and nothing throws.
 */
function drawn(id, klass, box) {
  const space = spaceOf()
  if (space === null) {
    const none = document.createElement('span')
    none.className = klass
    none.setAttribute('aria-hidden', 'true')
    return none
  }
  const svg = document.createElementNS(space, 'svg')
  svg.setAttribute('class', klass)
  svg.setAttribute('viewBox', box)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const use = document.createElementNS(space, 'use')
  use.setAttribute('href', `#${id}`)
  svg.append(use)
  return svg
}

/**
 * An element in the SVG namespace, for the charts (`charts.js`) — the
 * namespace read off the sprite as every icon's is — or null where there is no
 * sprite, so a chart degrades to the words beside it rather than throwing.
 */
export function svgOf(tag, attrs = {}) {
  const space = spaceOf()
  if (space === null) return null
  const node = document.createElementNS(space, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value))
  return node
}

/** Point an icon made by `icon` at another symbol, without rebuilding it. */
export function iconIn(node, name) {
  const use = node.firstChild
  if (use === null || use === undefined || typeof use.setAttribute !== 'function') return
  if (use.getAttribute('href') !== `#i-${name}`) use.setAttribute('href', `#i-${name}`)
}
