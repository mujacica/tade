import { describe, expect, it } from 'vitest'
import { fitOf, foldAt, SMALLEST, UPRIGHT_COLUMNS } from '../src/assets/full-fit.js'
import { safeLink } from '../src/assets/full-grid.js'
import { BYTES, bytesOf, ROW } from '../src/assets/full-keys.js'
import {
  defaultMode,
  MODES,
  modeFor,
  modesFrom,
  modesText,
  orientationOf,
} from '../src/assets/mode.js'
import { documentOf } from '../src/drawn.ts'
import { CSP } from '../src/headers.ts'

// The full view's rules (§10 T4 of the Duo plan), as tables: which mode a
// screen is in, how big the window is drawn on it and where the fold puts the
// sidebar's edge, what a key sends, which links a tap may open, and the
// document the full view is drawn in. What they look like on the glass is the
// browser harness's (`packages/app/scripts/browser-full.ts`).

/** A monospace face as Safari lays SF Mono out: 0.6 of the type a character. */
const SF = { ratio: 0.6, lead: 1.2 }

describe('which mode a screen is in', () => {
  it('is the overview upright and the full view sideways, until somebody chooses', () => {
    expect(orientationOf(466, 678)).toBe('upright')
    expect(orientationOf(951, 669)).toBe('sideways')
    expect(defaultMode('upright')).toBe('overview')
    expect(defaultMode('sideways')).toBe('full')
    expect(modeFor('sideways', {})).toBe('full')
  })

  it('keeps a choice per way up: overview sideways leaves upright as it was', () => {
    const modes = modesFrom(modesText({ sideways: 'overview' }))
    expect(modeFor('sideways', modes)).toBe('overview')
    expect(modeFor('upright', modes)).toBe('overview')
    const both = modesFrom(modesText({ upright: 'full', sideways: 'overview' }))
    expect(both).toEqual({ upright: 'full', sideways: 'overview' })
  })

  it('reads back only its own words, so nothing else rides in on the key', () => {
    expect(modesFrom('upright=full;sideways=javascript:x;nowhere=full')).toEqual({
      upright: 'full',
    })
    expect(modesFrom('__proto__=full;constructor=overview')).toEqual({})
    expect(modesFrom(null)).toEqual({})
    expect(modesFrom(42)).toEqual({})
  })

  it('draws each mode at its own page', () => {
    expect(MODES).toEqual({ overview: '/', full: '/draw/' })
  })
})

describe('how big the window is drawn', () => {
  it('is about 130 columns on the Duo’s large screen sideways, and its edge on the fold', () => {
    // The whole of the inner screen sideways, less the header and the keys.
    const fit = fitOf({
      width: 951,
      height: 669 - 21 - 96,
      screen: { width: 951, height: 669 },
      ...SF,
    })
    expect(fit.columns).toBeGreaterThanOrEqual(126)
    expect(fit.columns).toBeLessThanOrEqual(132)
    expect(fit.book).toBe(true)
    // The edge drawn at the sidebar's width, counted from nought: the centre column.
    expect(fit.sidebar).toBe(Math.floor(fit.columns / 2))
    expect(fit.rows).toBeGreaterThanOrEqual(30)
  })

  it('is about 80 on the small screen sideways, with the camera column taken', () => {
    const fit = fitOf({
      width: 678 - 84,
      height: 466 - 34 - 96,
      screen: { width: 678, height: 466 },
      ...SF,
    })
    expect(fit.columns).toBeGreaterThanOrEqual(78)
    expect(fit.columns).toBeLessThanOrEqual(82)
    expect(fit.book, 'the small screen does not fold').toBe(false)
    expect(fit.sidebar).toBeNull()
  })

  it('is the same type on a slab phone sideways, which never counts as folding', () => {
    for (const [width, height] of [
      [852, 393],
      [956, 440],
    ] as const) {
      const fit = fitOf({
        width: width - 118,
        height: height - 96,
        screen: { width, height },
        ...SF,
      })
      expect(fit.font, `${width}`).toBe(
        fitOf({ width: 594, height: 300, screen: { width: 678, height: 466 }, ...SF }).font,
      )
      expect(fit.book, `${width}`).toBe(false)
    }
  })

  it('brings the type down upright to fit the window, never below its floor', () => {
    const fit = fitOf({ width: 382, height: 500, ...SF })
    expect(fit.columns).toBeGreaterThanOrEqual(UPRIGHT_COLUMNS - 1)
    expect(fitOf({ width: 200, height: 500, ...SF }).font).toBe(SMALLEST)
  })

  it('stays sideways when the keyboard leaves an upright phone a wide room, by the screen', () => {
    const fit = fitOf({ width: 669, height: 400, screen: { width: 669, height: 951 }, ...SF })
    expect(fit.columns).toBeGreaterThanOrEqual(UPRIGHT_COLUMNS - 1)
    expect(fit.book).toBe(false)
  })

  it('brings the type down to keep the window’s fewest rows when the keyboard leaves less', () => {
    // The small screen sideways in a Safari tab, the keyboard taking 40% of it.
    const room = { width: 594, height: 120, screen: { width: 594, height: 368 }, ...SF }
    const fit = fitOf(room)
    expect(fit.rows).toBe(9)
    expect(fit.rows * fit.font * SF.lead).toBeLessThanOrEqual(room.height)
    expect(fit.font).toBeLessThan(fitOf({ ...room, height: 300 }).font)
  })

  it('puts the edge on the centre column of an odd and an even width alike', () => {
    expect(foldAt(129)).toBe(64)
    expect(foldAt(130)).toBe(65)
  })
})

describe('what a key sends', () => {
  it('is what a terminal sends the window, for the keys a phone has none of', () => {
    expect(bytesOf('Escape')).toBe('\x1b')
    expect(bytesOf('Tab')).toBe('\t')
    expect(bytesOf('Tab', { shift: true })).toBe('\x1b[Z')
    expect(bytesOf('ArrowUp')).toBe('\x1b[A')
    expect(bytesOf('F1')).toBe('\x1bOP')
    expect(bytesOf('c', { ctrl: true })).toBe('\x03')
    expect(bytesOf(']', { ctrl: true }), 'the leader').toBe('\x1d')
    expect(bytesOf('/', { ctrl: true }), 'the orchestrator').toBe('\x1b[47;5u')
    expect(bytesOf(',', { ctrl: true }), 'Settings').toBe('\x1b[44;5u')
  })

  it('leaves a letter to the field, and cmd to the browser', () => {
    expect(bytesOf('a')).toBeNull()
    expect(bytesOf('c', { meta: true })).toBeNull()
  })

  it('has every key the plan names in the row, each its own bytes', () => {
    const labels = ROW.map((one) => one.label)
    for (const label of ['esc', 'tab', 'ctrl', '←', '↑', '↓', '→', 'F1', '^/', '^,']) {
      expect(labels).toContain(label)
    }
    expect(ROW.find((one) => one.label === 'esc')?.bytes).toBe(BYTES.Escape)
    expect(ROW.find((one) => one.label === '^/')?.bytes).toBe(bytesOf('/', { ctrl: true }))
  })
})

describe('the links a tap opens', () => {
  it('opens the web and mail, and nothing an agent could make run', () => {
    expect(safeLink('https://example.com/x')).toBe('https://example.com/x')
    expect(safeLink('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(safeLink('javascript:alert(1)')).toBeNull()
    expect(safeLink('data:text/html,x')).toBeNull()
    expect(safeLink('file:///etc/passwd')).toBeNull()
    expect(safeLink(null)).toBeNull()
    expect(safeLink(`https://${'a'.repeat(3000)}`)).toBeNull()
  })
})

describe('the document the full view is drawn in', () => {
  const made = {
    version: 'v1',
    files: new Map(),
    importMap: { imports: { zod: '/draw/v1/pkg/zod/index.js' } },
    roots: ['/draw/v1/pkg/@tade/app/src/browser.js'],
    imports: new Map(),
  }

  it('loads the full view’s own sheet and module after the map, and allows only the map inline', () => {
    const { html, csp } = documentOf(made)
    const text = html.toString('utf8')
    const map = text.indexOf('<script type="importmap">')
    const page = text.indexOf('<script type="module" src="/assets/full.js">')
    expect(map).toBeGreaterThan(0)
    expect(page, 'the module after the map it needs').toBeGreaterThan(map)
    expect(text).toContain('<link rel="stylesheet" href="/assets/full.css">')
    expect(text).toContain('<link rel="stylesheet" href="/assets/tokens.css">')
    expect(text).toContain(
      '<meta name="tade-drawing" content="/draw/v1/pkg/@tade/app/src/browser.js">',
    )
    // The page's own policy, widened by the map's hash and nothing else.
    expect(csp).not.toBe(CSP)
    expect(csp.replace(/ 'sha256-[^']+'/, '')).toBe(CSP)
    expect(csp).not.toContain('unsafe-inline')
  })
})
