import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  donutParts,
  flowGeometry,
  layered,
  levelsOf,
  placeOf,
  sparkPath,
  TONES,
} from '../src/assets/charts.js'
import { assetsDir } from '../src/assets.ts'

// The charts' arithmetic, which is the half of a chart a test can hold: where a
// line goes, where a part of a ring starts, which layer a step is in. What
// they look like is the browser harness's, and a person's.

describe('a sparkline', () => {
  it('breaks the line where nobody looked, rather than dropping it to nought', () => {
    const drawn = sparkPath([1, 2, null, 3, 4])
    expect(drawn.lines).toHaveLength(2)
    expect(drawn.areas).toHaveLength(2)
    // Nothing is ever drawn at the floor for the gap.
    for (const line of drawn.lines) expect(line).not.toContain('NaN')
  })

  it('draws nothing at all for a series nobody could read', () => {
    expect(sparkPath([null, null])).toEqual({ lines: [], areas: [], last: null })
    expect(sparkPath([])).toEqual({ lines: [], areas: [], last: null })
  })

  it('puts a flat series through the middle, and the dot on the last known value', () => {
    const drawn = sparkPath([5, 5, 5, null], 100, 32)
    expect(drawn.lines[0]).toBe('M0 16L33.33 16L66.67 16')
    expect(drawn.last).toEqual({ x: 66.67, y: 50 })
  })

  it('keeps the highest point inside the box and the lowest above the floor', () => {
    const drawn = sparkPath([0, 10], 100, 32)
    expect(drawn.lines[0]).toBe('M0 31L100 1')
  })
})

describe('a donut', () => {
  it('divides a hundred by the parts, with a gap between neighbours', () => {
    const parts = donutParts([3, 1], 2)
    expect(parts).toEqual([
      { start: 0, length: 72 },
      { start: 74, length: 24 },
    ])
  })

  it('draws a single part whole, with no gap', () => {
    expect(donutParts([0, 5, null])).toEqual([null, { start: 0, length: 100 }, null])
  })

  it('draws nothing when there is nothing, rather than an arc of nought', () => {
    expect(donutParts([0, 0])).toEqual([null, null])
    expect(donutParts([null])).toEqual([null])
  })
})

describe('a place on a track', () => {
  it('is a percentage of the stretch, kept on the track', () => {
    expect(placeOf(150, 100, 200)).toBe(50)
    expect(placeOf(50, 100, 200)).toBe(0)
    expect(placeOf(250, 100, 200)).toBe(100)
  })

  it('is unknown when the moment or the stretch is', () => {
    expect(placeOf(null, 0, 10)).toBeNull()
    expect(placeOf(5, 10, 10)).toBeNull()
  })
})

describe('a flow’s layers', () => {
  it('puts each node one layer past the deepest thing it waits on', () => {
    const { at, layers, rows } = layered(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'a', to: 'c' },
        { from: 'a', to: 'd' },
      ],
    )
    expect(at.get('a')?.layer).toBe(0)
    expect(at.get('b')?.layer).toBe(1)
    expect(at.get('c')?.layer).toBe(2)
    expect(at.get('d')?.layer).toBe(1)
    expect(layers).toBe(3)
    expect(rows).toBe(2)
  })

  it('survives a cycle, which a file anybody can edit may have', () => {
    const { at } = layered(
      [{ id: 'a' }, { id: 'b' }],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    )
    expect(at.size).toBe(2)
    for (const one of at.values()) expect(Number.isFinite(one.layer)).toBe(true)
  })

  it('ignores an edge to a node that is not there, and one to itself', () => {
    const { at, layers } = layered(
      [{ id: 'a' }],
      [
        { from: 'gone', to: 'a' },
        { from: 'a', to: 'a' },
      ],
    )
    expect(at.get('a')).toEqual({ layer: 0, row: 0 })
    expect(layers).toBe(1)
  })

  it('orders a layer by what it waits on, so edges cross as little as they can', () => {
    // x waits on the second root and y on the first; drawn in input order
    // their edges would cross.
    const { at } = layered(
      [{ id: 'r1' }, { id: 'r2' }, { id: 'x' }, { id: 'y' }],
      [
        { from: 'r2', to: 'x' },
        { from: 'r1', to: 'y' },
      ],
    )
    expect(at.get('y')?.row).toBe(0)
    expect(at.get('x')?.row).toBe(1)
  })
})

describe('a flow’s drawing', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }]
  const edges = [{ from: 'a', to: 'b' }]

  it('lays layers left to right, and ends each edge on the side of the box it names', () => {
    const drawn = flowGeometry(nodes, edges, 'right')
    const { w, h, gapX } = drawn.size
    expect(drawn.boxes.get('b')).toEqual({ x: w + gapX, y: 0 })
    expect(drawn.width).toBe(2 * w + gapX)
    expect(drawn.height).toBe(h)
    expect(drawn.paths[0]?.d.startsWith(`M${w} ${h / 2}`)).toBe(true)
    expect(drawn.paths[0]?.d.endsWith(`${w + gapX - 1} ${h / 2}`)).toBe(true)
  })

  it('lays layers top to bottom on a phone', () => {
    const drawn = flowGeometry(nodes, edges, 'down')
    const { w, h, gapY } = drawn.size
    expect(drawn.boxes.get('b')).toEqual({ x: 0, y: h + gapY })
    expect(drawn.width).toBe(w)
    expect(drawn.paths[0]?.d.startsWith(`M${w / 2} ${h}`)).toBe(true)
  })

  it('is an empty canvas for an empty graph', () => {
    const drawn = flowGeometry([], [])
    expect(drawn.width).toBe(0)
    expect(drawn.height).toBe(0)
  })
})

describe('a heat strip’s levels', () => {
  it('scales by the largest, keeps nought at nought, and unknown unknown', () => {
    expect(levelsOf([0, 1, 2, 4, null])).toEqual([0, 1, 2, 4, null])
    expect(levelsOf([0, 0])).toEqual([0, 0])
    expect(levelsOf([3, 100], 4)).toEqual([1, 4])
  })
})

describe('the tones', () => {
  it('are each a rule in the charts’ sheet, and the sheet names no other', () => {
    const sheet = readFileSync(join(assetsDir(), 'charts.css'), 'utf8')
    const defined = [...sheet.matchAll(/\.tone-([a-z]+)\s*[,{]/g)].map((one) => one[1])
    expect([...new Set(defined)].sort()).toEqual([...TONES].sort())
  })
})
