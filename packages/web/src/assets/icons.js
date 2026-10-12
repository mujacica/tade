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
  'workflows',
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

/**
 * One icon, as a node: `<svg class="ic"><use href="#i-name"/></svg>`.
 *
 * Without a sprite — a page some test built without the shell — an empty span
 * of the same size, so the layout holds and nothing throws.
 */
export function icon(name, extra = '') {
  const space = spaceOf()
  const klass = extra === '' ? `ic ic-${name}` : `ic ic-${name} ${extra}`
  if (space === null) {
    const none = document.createElement('span')
    none.className = klass
    none.setAttribute('aria-hidden', 'true')
    return none
  }
  const svg = document.createElementNS(space, 'svg')
  svg.setAttribute('class', klass)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const use = document.createElementNS(space, 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  return svg
}

/** Point an icon made by `icon` at another symbol, without rebuilding it. */
export function iconIn(node, name) {
  const use = node.firstChild
  if (use === null || use === undefined || typeof use.setAttribute !== 'function') return
  if (use.getAttribute('href') !== `#i-${name}`) use.setAttribute('href', `#i-${name}`)
}
