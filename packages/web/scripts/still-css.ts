import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The page's own stylesheets, made to mean in a picture what they mean on a
// screen of one size.
//
// A picture of the page is an SVG whose `<foreignObject>` holds what the page
// built (`still.ts`), and the browser showing the README lays it out. Four
// things in a stylesheet mean something else there, and each is pinned here
// rather than left to whatever size the README happens to be read at:
//
// - **A media query asks about the picture, not the screen.** An SVG drawn at
//   880 pixels wide in a README would read `(min-width: 1100px)` as false and
//   fold the menu of a 1280-pixel desk. So every query about width or pointer
//   is answered here, for the size the picture is of, and a rule that does not
//   apply is gone. `prefers-reduced-motion` is the reader's, and is left to them.
// - **A viewport unit is the picture's viewport**, which is the same mistake
//   again, so `100dvh` becomes the height in pixels.
// - **`:root`, `html` and `body` are the outer SVG's**, or nothing, so they are
//   renamed to the two elements that stand in for them (`.still-html`,
//   `.still-body`), and every rule is scoped under the size it was resolved
//   for — a phone and a desk can then be one picture.
// - **Movement is a moment the picture is not.** A thumbnailer, a PDF and
//   WebKit draw an SVG at its first instant, where a screen still rising in
//   (`.enter`) is a blank one — so every `animation` and `transition` is left
//   out, and `@starting-style`, which only says where a transition starts, and
//   the picture is the page at rest. `prefers-reduced-motion` asks about the
//   same thing and is left to the reader, with nothing left to reduce.
//
// What is cut is what could not match anything in the picture: a rule is kept
// unless every one of its selectors names a class or an id that no frame of its
// size has, read outside any parentheses so a `:not(.x)` is never the reason.
// Nothing else is touched. Every value, every colour and every rule that could
// apply is the page's, as it is served.

const ASSETS = fileURLToPath(new URL('../src/assets/', import.meta.url))

/** The stylesheets the shell links, in the order it links them — which is the cascade. */
export function sheetsLinked(): string[] {
  const shell = readFileSync(`${ASSETS}index.html`, 'utf8')
  return [...shell.matchAll(/<link rel="stylesheet" href="\/assets\/([^"]+)"/g)].map(
    (one) => one[1] ?? '',
  )
}

/** The sprite's symbols, which a picture draws once for every frame to `<use>`. */
export function spriteOf(): string {
  const shell = readFileSync(`${ASSETS}index.html`, 'utf8')
  const found = /<svg class="sprite"[^>]*>([\s\S]*?)<\/svg>\s*<main/.exec(shell)
  if (found === null) throw new Error('index.html has no sprite for the pictures to draw from')
  return (found[1] ?? '').trim()
}

/** The size a set of frames is drawn at, and the class its rules are scoped under. */
export interface Size {
  width: number
  height: number
  pointer: 'fine' | 'coarse'
  /** The class on every frame of this size, which every rule for it is scoped under. */
  scope: string
}

type Node =
  | { kind: 'rule'; selector: string; body: string }
  | { kind: 'block'; name: string; prelude: string; inside: Node[] }
  | { kind: 'raw'; text: string }

/** Every rule in the page's stylesheets, for one size and only the classes its frames have. */
export function sheetFor(size: Size, has: ReadonlySet<string>): string {
  const out: string[] = []
  for (const file of sheetsLinked()) {
    const parsed = parse(stripped(readFileSync(`${ASSETS}${file}`, 'utf8')))
    out.push(written(parsed, size, has))
  }
  return out.filter((one) => one !== '').join('')
}

function stripped(text: string): string {
  let out = ''
  let at = 0
  let quote = ''
  while (at < text.length) {
    const ch = text[at] ?? ''
    if (quote !== '') {
      out += ch
      if (ch === '\\') out += text[++at] ?? ''
      else if (ch === quote) quote = ''
      at++
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    if (ch === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2)
      at = end < 0 ? text.length : end + 2
      continue
    }
    out += ch
    at++
  }
  return out
}

/** Where the `}` closing the block opened at `open` is. */
function closing(text: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let at = open; at < text.length; at++) {
    const ch = text[at]
    if (quote !== '') {
      if (ch === '\\') at++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return at
  }
  throw new Error('a stylesheet the pictures read has a block that never closes')
}

function parse(text: string): Node[] {
  const out: Node[] = []
  let at = 0
  while (at < text.length) {
    while (at < text.length && /\s/.test(text[at] ?? '')) at++
    if (at >= text.length) break
    const open = text.indexOf('{', at)
    const semi = text.indexOf(';', at)
    if (text[at] === '@' && semi >= 0 && (open < 0 || semi < open)) {
      out.push({ kind: 'raw', text: text.slice(at, semi + 1).trim() })
      at = semi + 1
      continue
    }
    if (open < 0) break
    const end = closing(text, open)
    const head = text.slice(at, open).trim()
    const inside = text.slice(open + 1, end)
    if (head.startsWith('@keyframes')) {
      out.push({ kind: 'raw', text: `${head}{${minified(inside)}}` })
    } else if (head.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(head)?.[1] ?? ''
      out.push({
        kind: 'block',
        name,
        prelude: head.slice(name.length + 1).trim(),
        inside: parse(inside),
      })
    } else {
      out.push({ kind: 'rule', selector: head, body: inside.trim() })
    }
    at = end + 1
  }
  return out
}

/** Runs of white space made one, outside a quoted string, and none beside a brace or a `;`. */
function minified(body: string): string {
  let out = ''
  let quote = ''
  for (let at = 0; at < body.length; at++) {
    const ch = body[at] ?? ''
    if (quote !== '') {
      out += ch
      if (ch === '\\') out += body[++at] ?? ''
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    if (/\s/.test(ch)) {
      const next = body[at + 1] ?? ''
      const last = out[out.length - 1] ?? ''
      if (/\s/.test(next) || '{};'.includes(next) || '{};'.includes(last) || out === '') continue
      out += ' '
      continue
    }
    out += ch
  }
  return out.replace(/;}/g, '}').replace(/;$/, '').trim()
}

/** Whether a media query is true at this size: `true`, `false`, or `null` for the reader's to answer. */
export function mediaAt(prelude: string, size: Size): boolean | null {
  const answers = prelude.split(',').map((one) => {
    const features = [...one.matchAll(/\(([^)]+)\)/g)].map((found) => found[1] ?? '')
    if (features.length === 0)
      throw new Error(`the pictures cannot read the media query ${prelude}`)
    let truth: boolean | null = true
    for (const feature of features) {
      const [name = '', value = ''] = feature.split(':').map((part) => part.trim())
      const px = Number.parseFloat(value)
      if (name === 'min-width') truth = truth === false ? false : truth && size.width >= px
      else if (name === 'max-width') truth = truth === false ? false : truth && size.width <= px
      else if (name === 'min-height') truth = truth === false ? false : truth && size.height >= px
      else if (name === 'max-height') truth = truth === false ? false : truth && size.height <= px
      else if (name === 'pointer') truth = truth === false ? false : truth && value === size.pointer
      else if (name === 'hover')
        truth = truth === false ? false : truth && (value === 'hover') === (size.pointer === 'fine')
      else if (name === 'prefers-reduced-motion' || name === 'prefers-color-scheme')
        truth = truth === false ? false : null
      else throw new Error(`the pictures cannot answer (${feature}) in ${prelude}`)
    }
    return truth
  })
  if (answers.includes(true)) return true
  return answers.includes(null) ? null : false
}

/** A declaration that moves something, which a picture at rest leaves out. */
const MOVES = /^\s*(animation|transition)(-[a-z-]+)?\s*:/

/**
 * A declaration block at rest and at this size: what moves left out, and every
 * viewport unit made the pixels it is.
 */
function pinned(body: string, size: Size): string {
  const still = splitTop(minified(body), ';')
    .filter((one) => !MOVES.test(one))
    .join(';')
  return still.replace(
    /(-?\d*\.?\d+)(dvh|svh|lvh|vh|dvw|svw|lvw|vw|vmin|vmax)\b/g,
    (_, n: string, unit: string) => {
      const of = unit.endsWith('h')
        ? size.height
        : unit.endsWith('w')
          ? size.width
          : unit === 'vmin'
            ? Math.min(size.width, size.height)
            : Math.max(size.width, size.height)
      return `${Math.round(Number.parseFloat(n) * of) / 100}px`
    },
  )
}

/** One selector list, each of its selectors renamed onto the stand-ins and scoped to the size. */
function scoped(list: string, size: Size, has: ReadonlySet<string>): string {
  const kept: string[] = []
  for (const raw of splitTop(list)) {
    let one = raw
      .trim()
      .replace(/:root\b/g, '.still-html')
      .replace(/(^|[\s>+~(])html(?=$|[\s.:#[>+~),])/g, '$1.still-html')
      .replace(/(^|[\s>+~(])body(?=$|[\s.:#[>+~),])/g, '$1.still-body')
    if (!couldMatch(one, has)) continue
    one = /^\.still-html(?![\w-])/.test(one)
      ? one.replace(/^\.still-html/, `.still-html.${size.scope}`)
      : `.${size.scope} ${one}`
    kept.push(one)
  }
  return kept.join(',')
}

/** A list split at the separators outside every bracket, parenthesis and quoted string. */
function splitTop(list: string, by = ','): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let from = 0
  for (let at = 0; at < list.length; at++) {
    const ch = list[at]
    if (quote !== '') {
      if (ch === '\\') at++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === by && depth === 0) {
      out.push(list.slice(from, at))
      from = at + 1
    }
  }
  out.push(list.slice(from))
  return out
}

/** Whether a selector could match: false only when it names a class or id no frame has. */
function couldMatch(selector: string, has: ReadonlySet<string>): boolean {
  // Read outside every bracket and parenthesis, so a `:not(.x)` or an
  // attribute's value is never the reason a rule goes.
  let outside = ''
  let depth = 0
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (depth === 0) outside += ch
  }
  for (const found of outside.matchAll(/([.#])([A-Za-z_][\w-]*)/g)) {
    const name = found[2] ?? ''
    if (name === 'still-html' || name === 'still-body') continue
    if (!has.has(`${found[1]}${name}`)) return false
  }
  return true
}

function written(nodes: Node[], size: Size, has: ReadonlySet<string>): string {
  const out: string[] = []
  for (const node of nodes) {
    if (node.kind === 'raw') {
      // Nothing in a picture moves, so nothing is named to move it.
      if (!node.text.startsWith('@keyframes')) out.push(node.text)
      continue
    }
    if (node.kind === 'rule') {
      const selector = scoped(node.selector, size, has)
      const body = pinned(node.body, size)
      if (selector !== '' && body !== '') out.push(`${selector}{${body}}`)
      continue
    }
    if (node.name === 'media') {
      const truth = mediaAt(node.prelude, size)
      if (truth === false) continue
      const inside = written(node.inside, size, has)
      if (inside === '') continue
      out.push(truth === true ? inside : `@media ${node.prelude}{${inside}}`)
      continue
    }
    if (node.name === 'starting-style') continue
    const inside = written(node.inside, size, has)
    if (inside === '') continue
    out.push(`@${node.name}${node.prelude === '' ? '' : ` ${node.prelude}`}{${inside}}`)
  }
  return out.join('')
}
