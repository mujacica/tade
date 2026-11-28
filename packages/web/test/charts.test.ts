import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sparkPath, TONES } from '../src/assets/charts.js'
import { assetsDir } from '../src/assets.ts'

// The charts' arithmetic, which is the half of a chart a test can hold: where a
// sparkline goes. What it looks like is the browser harness's, and a person's.

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

describe('the tones', () => {
  it('are each a rule in the charts’ sheet, and the sheet names no other', () => {
    const sheet = readFileSync(join(assetsDir(), 'charts.css'), 'utf8')
    const defined = [...sheet.matchAll(/\.tone-([a-z]+)\s*[,{]/g)].map((one) => one[1])
    expect([...new Set(defined)].sort()).toEqual([...TONES].sort())
  })
})
