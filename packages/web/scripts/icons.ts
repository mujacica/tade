import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { assetsDir } from '../src/assets.ts'
import { MANIFEST_FILE } from '../src/installable.ts'

// The icons a phone puts on its home screen, **drawn from the Tade mark rather
// than by hand**.
//
//   node packages/web/scripts/icons.ts        # rewrite them under src/assets/
//
// The same rule the README's pictures are held to (`redraw-the-pictures`): a
// mark drawn once per size is four marks, and three of them stop being changed
// when the first one is. Here the mark is arithmetic — `▞` is two squares of a
// 2×2 grid, which is a rectangle fill and nothing else — so every size is the
// same drawing at a different scale, and `test/icons.test.ts` redraws them all
// and holds the committed files to the pixels.
//
// **PNG, and no SVG.** Two reasons, and the first is not ours to argue with:
// Safari ignores the manifest's icons for a home screen and reads
// `apple-touch-icon`, which it expects to be a PNG — so a vector-only icon is
// an iPhone showing a screenshot of the page. The second is this repository's
// own: an SVG carries `xmlns="http://www.w3.org/2000/svg"`, and
// `test/assets.test.ts` refuses a URL off this machine in any text asset. That
// rule is worth more than an icon format.
//
// **Opaque, with the page's own ground painted in.** iOS fills a transparent
// apple-touch-icon with black, which is near enough to `--ground` to look like
// a mistake rather than a choice; Android's maskable shape fills it with
// whatever the manifest's `background_color` says. Painting the ground means
// every platform shows the same two colours, and the alpha channel is simply
// not there to be got wrong.
//
// **The two colours are the window's own tones**, named here as the literals
// `tokens.css` holds and read back out of that file by the test — the same
// treatment `glyphs.js` gets for the domain's words. A third colour, a
// gradient or a border would be a second brand.

/** `--ground`: the page, and the icon's ground. */
const GROUND = [0x12, 0x12, 0x12] as const

/** `--amber`: Tade itself. The mark, and nothing else on the icon. */
const AMBER = [0xff, 0xaf, 0x00] as const

/**
 * One icon to draw: how big, and how much of it the mark fills.
 *
 * `fills` is the mark's side as a fraction of the icon's, and the maskable one
 * is much smaller on purpose. A maskable icon is cropped by whatever shape the
 * platform likes, and the only part guaranteed to survive is a circle of 80%
 * of the icon's width — so the mark has to sit inside the largest square that
 * fits in that circle, which is 80/√2 ≈ 56%. Half is inside it with room to
 * spare, and the arithmetic is here rather than in a comment on a magic
 * number.
 *
 * 180 is the one Safari asks for by name. 192 and 512 are the two sizes the
 * manifest wants for a launcher and a splash screen.
 */
export interface Icon {
  name: string
  size: number
  fills: number
  /** What it is for, in the words the manifest and the test both use. */
  purpose: 'any' | 'maskable'
}

export const ICONS: readonly Icon[] = [
  { name: 'icon-180.png', size: 180, fills: 0.64, purpose: 'any' },
  { name: 'icon-192.png', size: 192, fills: 0.64, purpose: 'any' },
  { name: 'icon-512.png', size: 512, fills: 0.64, purpose: 'any' },
  { name: 'icon-maskable-512.png', size: 512, fills: 0.5, purpose: 'maskable' },
]

/**
 * The mark, as rows of RGB bytes.
 *
 * `▞` is the quadrants upper-right and lower-left, so the whole drawing is:
 * ground everywhere, amber in two of the four squares of a centred box. The
 * box's side is rounded to an even number of pixels so that both halves and
 * both margins are whole pixels — an odd one puts a half-pixel seam down the
 * middle of the mark, which at 180px is visible and at 512px is a grey line.
 */
export function pixelsOf(icon: Icon): Buffer {
  const side = even(Math.round(icon.size * icon.fills))
  const half = side / 2
  const from = (icon.size - side) / 2
  const rows = Buffer.alloc(icon.size * icon.size * 3)
  for (let y = 0; y < icon.size; y += 1) {
    for (let x = 0; x < icon.size; x += 1) {
      const colour = marked(x - from, y - from, half) ? AMBER : GROUND
      const at = (y * icon.size + x) * 3
      rows[at] = colour[0]
      rows[at + 1] = colour[1]
      rows[at + 2] = colour[2]
    }
  }
  return rows
}

/** Whether a pixel of the mark's own box is one of its two filled quadrants. */
function marked(x: number, y: number, half: number): boolean {
  if (x < 0 || y < 0 || x >= half * 2 || y >= half * 2) return false
  const right = x >= half
  const low = y >= half
  // Upper right, lower left: the two that are not the diagonal.
  return right !== low
}

/** The nearest even number, so halves and margins are whole pixels. */
function even(n: number): number {
  return n % 2 === 0 ? n : n + 1
}

/**
 * A PNG of those pixels: 8-bit truecolour, one IDAT, no ancillary chunks.
 *
 * Hand-written because the alternative is a dependency, and a dependency here
 * would be the one thing `test/assets.test.ts` refuses in this folder — a
 * third-party file the generated notices cannot see. What it takes is four
 * chunks and a CRC, and the image is flat colour, so `deflate` turns three
 * quarters of a megabyte into about a kilobyte.
 *
 * Every scanline carries filter 0 (none). A filter that predicted from the
 * pixel to the left would compress a flat image better still, and it would
 * make the decoder in the test a decoder rather than twenty lines — which is
 * the wrong trade for a file that is already small enough to read.
 */
export function encodePng(icon: Icon, pixels: Buffer): Buffer {
  const stride = icon.size * 3
  const raw = Buffer.alloc((stride + 1) * icon.size)
  for (let y = 0; y < icon.size; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(icon.size, 0)
  head.writeUInt32BE(icon.size, 4)
  head[8] = 8 // bits per sample
  head[9] = 2 // truecolour, no alpha
  head[10] = 0 // deflate
  head[11] = 0 // the only filter method there is
  head[12] = 0 // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(kind: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  const named = Buffer.concat([Buffer.from(kind, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(named), 0)
  return Buffer.concat([length, named, crc])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * The manifest, which is the icon list plus four strings.
 *
 * Generated here rather than written by hand for the reason the icons are: the
 * `icons` array **is** `ICONS`, so a size added above is a size the manifest
 * offers, and a size deleted cannot be left behind pointing at a file that is
 * not there. A manifest naming an icon a browser gets a `404` for is an
 * install that silently falls back to a screenshot of the page.
 *
 * **`scope` and `start_url` are written out, and that is not belt and
 * braces.** The manifest is served out of `/assets/`, and a manifest's default
 * scope is its own URL with the last segment taken off — `/assets/`. A
 * `start_url` of `/` would then be outside its own scope, which the manifest
 * spec answers by falling back to the document's URL and ignoring the rest:
 * an install that works from `/` and is broken from every deep link, which is
 * not a thing anybody notices until a phone has one.
 *
 * `display: standalone` is what makes it a web app rather than a bookmark on
 * iOS 16.4 to 18 — since iOS 26 every added site opens as one — and it is what
 * the Push API looks for on that platform later.
 *
 * The two colours are `--ground`: `background_color` is what Android paints
 * behind a maskable icon and under a splash screen, and `theme_color` is the
 * system bar. Anything else there would be a second palette, which is the one
 * thing `tokens.css` exists to prevent.
 */
export function manifestOf(): Record<string, unknown> {
  return {
    id: '/',
    name: 'Tade',
    short_name: 'Tade',
    description:
      'What is working, what is queued, what is stopped and what it cost, from the machine Tade is open on.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#121212',
    theme_color: '#121212',
    icons: ICONS.map((icon) => ({
      src: `/assets/${icon.name}`,
      sizes: `${icon.size}x${icon.size}`,
      type: 'image/png',
      purpose: icon.purpose,
    })),
  }
}

/** The manifest's bytes, formatted the way every other file here is. */
export function manifestBytes(): Buffer {
  return Buffer.from(`${JSON.stringify(manifestOf(), null, 2)}\n`, 'utf8')
}

/** Every icon, as the bytes that should be on disk. */
export function drawIcons(): { name: string; bytes: Buffer }[] {
  return ICONS.map((icon) => ({ name: icon.name, bytes: encodePng(icon, pixelsOf(icon)) }))
}

/** Write them and the manifest into `src/assets/`, which is all this does. */
export function writeIcons(dir = assetsDir()): string[] {
  const written: string[] = []
  for (const { name, bytes } of [...drawIcons(), { name: MANIFEST_FILE, bytes: manifestBytes() }]) {
    writeFileSync(join(dir, name), bytes)
    written.push(`${name}  ${bytes.length} bytes`)
  }
  return written
}

// Run directly this writes them; imported it writes nothing. The one importer
// is `test/icons.test.ts`, which redraws every icon and holds the committed
// file to the pixels — so a guard is the difference between a test and a test
// that rewrites what it is checking. `process.argv[1]` is the script Node was
// handed, resolved, which is the one thing that distinguishes the two.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const line of writeIcons()) process.stdout.write(`${line}\n`)
}
