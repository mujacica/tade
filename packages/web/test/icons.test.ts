import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  drawIcons,
  ICONS,
  type Icon,
  manifestBytes,
  manifestOf,
  pixelsOf,
} from '../scripts/icons.ts'
import { assetsDir } from '../src/assets.ts'
import { MANIFEST_FILE } from '../src/installable.ts'

// The icons and the manifest, held to the drawing they are generated from.
//
// The same rule the README's pictures are held to, and for the same reason: a
// mark edited in one size and not the other three is four marks, and nothing
// anywhere would say so. So every committed PNG is **decoded** here and its
// pixels compared with what `pixelsOf` draws now — which also means a file
// somebody touched by hand fails, rather than quietly becoming the real
// drawing.
//
// Pixels rather than bytes, deliberately. `deflate`'s output is a property of
// the zlib that produced it, and this laptop's Node is not CI's: a byte
// comparison would be green here and red on a runner, which is the worst kind
// of test. What the file has to be is the right image.

const DIR = assetsDir()

/** A PNG, as much of one as this writes: 8-bit truecolour, filter 0. */
function decode(bytes: Buffer): { width: number; height: number; colour: number; pixels: Buffer } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let at = 8
  let head: Buffer | null = null
  const parts: Buffer[] = []
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at)
    const kind = bytes.subarray(at + 4, at + 8).toString('ascii')
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (kind === 'IHDR') head = Buffer.from(body)
    if (kind === 'IDAT') parts.push(Buffer.from(body))
    at += 12 + length
  }
  if (head === null) throw new Error('no IHDR')
  const width = head.readUInt32BE(0)
  const height = head.readUInt32BE(4)
  expect(head[8]).toBe(8) // bits per sample
  expect(head[12]).toBe(0) // no interlace, so the rows are the rows
  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * 3
  const pixels = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row += 1) {
    // Filter 0 on every line, which is what the encoder writes. Anything else
    // would mean undoing a predictor here, and the file is flat colour.
    expect(raw[row * (stride + 1)]).toBe(0)
    raw.copy(pixels, row * stride, row * (stride + 1) + 1, (row + 1) * (stride + 1))
  }
  return { width, height, colour: head[9] ?? -1, pixels }
}

/** A colour out of `tokens.css`, so the icons cannot be a second palette. */
function tone(name: string): [number, number, number] {
  const css = readFileSync(join(DIR, 'tokens.css'), 'utf8')
  const found = new RegExp(`--${name}:\\s*#([0-9a-f]{6})`).exec(css)
  if (found === null) throw new Error(`no --${name} in tokens.css`)
  const hex = found[1] ?? ''
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ]
}

/** Every distinct colour in an image, as `rr,gg,bb`. */
function coloursIn(pixels: Buffer): Set<string> {
  const out = new Set<string>()
  for (let at = 0; at < pixels.length; at += 3) out.add([...pixels.subarray(at, at + 3)].join(','))
  return out
}

/** The box the amber covers, which is the mark. */
function markBox(icon: Icon, pixels: Buffer): { x: number; y: number; to: number; down: number } {
  const amber = tone('amber').join(',')
  let x = icon.size
  let y = icon.size
  let to = 0
  let down = 0
  for (let row = 0; row < icon.size; row += 1) {
    for (let col = 0; col < icon.size; col += 1) {
      const at = (row * icon.size + col) * 3
      if ([...pixels.subarray(at, at + 3)].join(',') !== amber) continue
      x = Math.min(x, col)
      y = Math.min(y, row)
      to = Math.max(to, col + 1)
      down = Math.max(down, row + 1)
    }
  }
  return { x, y, to, down }
}

describe('every icon is the drawing, redrawn', () => {
  for (const icon of ICONS) {
    it(`${icon.name} is what the generator draws now`, () => {
      const file = decode(readFileSync(join(DIR, icon.name)))
      expect(file.width).toBe(icon.size)
      expect(file.height).toBe(icon.size)
      expect(file.pixels.equals(pixelsOf(icon))).toBe(true)
    })
  }

  it('has no alpha channel anywhere, which iOS would fill with black', () => {
    // Colour type 2 is truecolour without alpha. A transparent apple-touch
    // icon is filled with black by iOS, which against `--ground` reads as a
    // mistake rather than a choice — so the ground is painted in and the
    // channel is not there to get wrong.
    for (const icon of ICONS) {
      expect(decode(readFileSync(join(DIR, icon.name))).colour, icon.name).toBe(2)
    }
  })

  it('is two colours, and both of them are the window’s own', () => {
    const wanted = new Set([tone('ground').join(','), tone('amber').join(',')])
    for (const icon of ICONS) {
      expect(coloursIn(decode(readFileSync(join(DIR, icon.name))).pixels), icon.name).toEqual(
        wanted,
      )
    }
  })

  it('is the mark: two quadrants of a centred box, on the diagonal', () => {
    // The box is square and centred, and exactly half of it is amber — which
    // is what `▞` is. A drawing that drifted into a logo would fail here
    // before anybody had to look at four files.
    for (const icon of ICONS) {
      const pixels = pixelsOf(icon)
      const box = markBox(icon, pixels)
      expect(box.to - box.x, icon.name).toBe(box.down - box.y)
      expect(box.x, icon.name).toBe(icon.size - box.to)
      expect(box.y, icon.name).toBe(icon.size - box.down)
      expect([...coloursIn(pixels)].length).toBe(2)
      const side = box.to - box.x
      expect(countAmber(pixels), icon.name).toBe((side * side) / 2)
    }
  })

  it('keeps the maskable one inside the circle a platform may crop it to', () => {
    // A maskable icon is cropped to whatever shape the platform likes, and the
    // only part guaranteed to survive is a circle of 80% of the width. The
    // mark's corners have to be inside it, which is the arithmetic the
    // generator's `fills` is chosen by — asserted rather than trusted.
    for (const icon of ICONS.filter((one) => one.purpose === 'maskable')) {
      const box = markBox(icon, pixelsOf(icon))
      const middle = icon.size / 2
      const far = Math.hypot(box.x - middle, box.y - middle)
      expect(far, icon.name).toBeLessThanOrEqual((icon.size * 0.8) / 2)
    }
  })

  it('is what `node packages/web/scripts/icons.ts` would write', () => {
    for (const { name, bytes } of drawIcons()) {
      const committed = readFileSync(join(DIR, name))
      expect(decode(committed).pixels.equals(decode(bytes).pixels), name).toBe(true)
    }
  })
})

/** How many pixels are the mark, which for `▞` is half its box. */
function countAmber(pixels: Buffer): number {
  const amber = tone('amber').join(',')
  let found = 0
  for (let at = 0; at < pixels.length; at += 3) {
    if ([...pixels.subarray(at, at + 3)].join(',') === amber) found += 1
  }
  return found
}

describe('the manifest', () => {
  const manifest = JSON.parse(readFileSync(join(DIR, MANIFEST_FILE), 'utf8'))

  it('is what the generator writes, so its icons cannot drift from the folder', () => {
    expect(readFileSync(join(DIR, MANIFEST_FILE))).toEqual(manifestBytes())
    expect(manifest).toEqual(manifestOf())
  })

  it('says its scope rather than inheriting `/assets/` from where it is served', () => {
    // The default scope is the manifest's own URL with the last segment taken
    // off. Served out of `/assets/`, that would put `start_url: "/"` outside
    // its own scope — which the spec answers by ignoring the manifest and
    // using the document's URL instead. An install that works from `/` and is
    // broken from every deep link, and nothing says so.
    expect(manifest.scope).toBe('/')
    expect(manifest.start_url).toBe('/')
    expect(String(manifest.start_url).startsWith(manifest.scope)).toBe(true)
  })

  it('is a web app rather than a bookmark', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.id).toBe('/')
  })

  it('paints the page’s own ground behind it', () => {
    const ground = `#${tone('ground')
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('')}`
    expect(manifest.background_color).toBe(ground)
    expect(manifest.theme_color).toBe(ground)
  })

  it('names only icons that are in the folder, at the size they really are', () => {
    // A manifest naming an icon a browser gets a `404` for is an install that
    // falls back to a screenshot of the page, silently.
    for (const icon of manifest.icons) {
      const name = String(icon.src).replace('/assets/', '')
      const file = decode(readFileSync(join(DIR, name)))
      expect(icon.sizes, name).toBe(`${file.width}x${file.height}`)
      expect(icon.type, name).toBe('image/png')
    }
    expect(manifest.icons.some((one: { purpose: string }) => one.purpose === 'maskable')).toBe(true)
  })
})

describe('the shell asks for them', () => {
  const html = readFileSync(join(DIR, 'index.html'), 'utf8')

  it('links the manifest', () => {
    expect(html).toContain(`<link rel="manifest" href="/assets/${MANIFEST_FILE}" />`)
  })

  it('links an apple-touch-icon, because Safari reads nothing else', () => {
    // Safari ignores the manifest's icons for a home screen. Without this tag
    // an iPhone shows a screenshot of the page where the icon should be — and
    // it has to be a PNG, which is the whole reason there is no SVG here.
    const found = /<link rel="apple-touch-icon" href="\/assets\/([^"]+)"/.exec(html)
    expect(found).not.toBeNull()
    const name = found?.[1] ?? ''
    expect(name.endsWith('.png')).toBe(true)
    const file = decode(readFileSync(join(DIR, name)))
    expect(file.width).toBe(180)
    expect(file.colour).toBe(2)
  })
})
