import type { Still } from '../../web/scripts/still.ts'
import { type Size, sheetFor, spriteOf } from '../../web/scripts/still-css.ts'
import { cuts, FONT_STACK, framed } from './ansi-svg.ts'
import { THEME } from './terminal.ts'

// The away view's page, as a picture: what the page built (`still.ts`), with
// its own stylesheets (`still-css.ts`), in an SVG's `<foreignObject>`.
//
// **The reader's browser lays it out**, which is what makes it a picture of the
// page rather than a drawing of one: the markup is the page's, the rules are
// the page's, the fonts are the system's — the page loads no webfont either —
// and the browser showing the README does what the browser on a phone would.
// So the bytes are the same on every machine that draws them, and what they
// look like is what the page looks like.
//
// The frame around it is the window's own, the same as the reel at the top of
// the README (`ansi-svg.ts`): a dark border, three dots, a caption. The caption
// is the address the frame is a picture of.

/** One frame: a desk is one still; a phone frame is several phones side by side. */
export interface PageFrame {
  stills: readonly Still[]
  /** Seconds it stays. */
  hold: number
  /** The caption in the frame's bar while it shows. */
  caption: string
  /** What it is, for anyone reading the source. */
  about: string
}

export interface PageReelOptions {
  /** The room for the page, in CSS pixels: a desk frame is a still exactly this size. */
  width: number
  height: number
  /** What a screen reader says for the whole picture. */
  label: string
}

const PAD = 12
const BAR = 28
/** Between phones, and around a phone's screen: its bezel. */
const GAP = 40
const BEZEL = 8
const XHTML = 'http://www.w3.org/1999/xhtml'

const escaped = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const sizeOf = (still: Still): Size => ({
  width: still.width,
  height: still.height,
  pointer: still.pointer,
  scope: `still-${still.width}x${still.height}`,
})

/** Every class and id a still's markup carries, as `.name` and `#name`. */
function namesIn(still: Still): string[] {
  const out = [...`${still.rootClass} ${still.bodyClass}`.split(/\s+/).map((one) => `.${one}`)]
  for (const found of still.body.matchAll(/ class="([^"]*)"/g))
    for (const one of (found[1] ?? '').split(/\s+/)) if (one !== '') out.push(`.${one}`)
  for (const found of still.body.matchAll(/ id="([^"]*)"/g)) out.push(`#${found[1]}`)
  return out
}

/** One still as the stand-ins for its `<html>` and `<body>`, at its own size. */
function page(still: Still): string {
  const size = sizeOf(still)
  return (
    `<div xmlns="${XHTML}" class="still-html ${size.scope}${still.rootClass === '' ? '' : ` ${escaped(still.rootClass)}`}"` +
    ` style="width:${still.width}px;height:${still.height}px">` +
    `<div class="still-body${still.bodyClass === '' ? '' : ` ${escaped(still.bodyClass)}`}">${still.body}</div></div>`
  )
}

/** Several phones, centred in the room, each in a bezel. */
function phones(stills: readonly Still[], opts: PageReelOptions, top: number): string {
  const across =
    stills.reduce((sum, one) => sum + one.width + 2 * BEZEL, 0) + GAP * (stills.length - 1)
  let x = PAD / 2 + (opts.width - across) / 2
  const out: string[] = []
  for (const still of stills) {
    const tall = still.height + 2 * BEZEL
    const y = top + (opts.height - tall) / 2
    out.push(
      `<rect x="${x}" y="${y}" width="${still.width + 2 * BEZEL}" height="${tall}" rx="22" fill="${THEME.frame}" stroke="#3a3a3a"/>`,
      `<foreignObject x="${x + BEZEL}" y="${y + BEZEL}" width="${still.width}" height="${still.height}">${page(still)}</foreignObject>`,
    )
    x += still.width + 2 * BEZEL + GAP
  }
  return out.join('')
}

/** A reel of the page: each frame shown in turn, forever, cut the way the window's reel is. */
export function pageReel(frames: readonly PageFrame[], opts: PageReelOptions): string {
  const width = opts.width + PAD
  const height = opts.height + BAR + PAD / 2
  // One stylesheet per size, cut to the classes its frames carry, scoped under
  // the size so a phone's rules never reach a desk's frame.
  const sizes = new Map<string, { size: Size; names: Set<string> }>()
  for (const frame of frames)
    for (const still of frame.stills) {
      const size = sizeOf(still)
      const held = sizes.get(size.scope) ?? { size, names: new Set<string>() }
      for (const name of namesIn(still)) held.names.add(name)
      sizes.set(size.scope, held)
    }
  const sheets = [...sizes.values()].map(({ size, names }) => sheetFor(size, names))
  // The stand-in for a viewport: what `position: fixed` and the body's height
  // are measured against, as a window would be. And **no scrollbar**, last so
  // it wins over the page's `thin`: a phone never draws one at rest and nor
  // does a Mac, so one in a picture is a moment of scrolling nobody is doing —
  // and the room it took was a word cut from the side.
  const viewport =
    '.still-html{position:relative;contain:layout paint;overflow:hidden}' +
    '.still-html,.still-html *{scrollbar-width:none}'
  const style = [
    ...cuts(
      frames.map((one) => one.hold),
      '.still-html',
    ),
    ...sheets,
    viewport,
  ].join('')
  if (style.includes(']]>')) throw new Error('a stylesheet the pictures carry ends a CDATA section')
  const drawn = frames.map((frame, i) => {
    const caption = `<text x="${width / 2}" y="${BAR / 2 + 4}" fill="${THEME.caption}" font-family="${FONT_STACK}" font-size="12" text-anchor="middle">${escaped(frame.caption)}</text>`
    const only = frame.stills.length === 1 ? frame.stills[0] : undefined
    const inside =
      only !== undefined && only.width === opts.width && only.height === opts.height
        ? `<foreignObject x="${PAD / 2}" y="${BAR}" width="${opts.width}" height="${opts.height}">${page(only)}</foreignObject>`
        : phones(frame.stills, opts, BAR)
    return framed(i, `${caption}${inside}`, frame.about)
  })
  const dots = ['#5a5a5a', '#484848', '#3a3a3a']
    .map((fill, i) => `<circle cx="${18 + i * 16}" cy="${BAR / 2}" r="4.5" fill="${fill}"/>`)
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escaped(opts.label)}">` +
    `<style><![CDATA[${style}]]></style>` +
    `<defs>${spriteOf()}</defs>` +
    `<rect width="${width}" height="${height}" rx="8" fill="${THEME.frame}"/>` +
    `<rect x="${PAD / 2}" y="${BAR}" width="${opts.width}" height="${opts.height}" rx="5" fill="${THEME.background}"/>` +
    dots +
    drawn.join('') +
    '</svg>\n'
  )
}
