import { describe, expect, it } from 'vitest'
import { chips, hitAt, rowHit } from '../src/hits.ts'

// Where things are, which is the whole of what a click can know.
//
// The rule these tests exist for: a chip is clickable exactly where it is
// written. Positions are worked out from the labels alone, so painting one
// cannot shift the next one's target by the length of an escape code.

describe('chips', () => {
  it('puts each one where it is drawn', () => {
    const { text, hits } = chips(
      0,
      [
        { label: 'new task', target: { kind: 'action', name: '/task ' } },
        { label: 'quit', target: { kind: 'action', name: '/quit' } },
      ],
      40,
    )
    for (const hit of hits) {
      expect(hitAt(hits, hit.from, 0)).toEqual(hit.target)
      expect(hitAt(hits, hit.to, 0)).toEqual(hit.target)
    }
    expect(text.slice(hits[0]?.from, (hits[0]?.to ?? 0) + 1)).toBe(' new task ')
    expect(text.slice(hits[1]?.from, (hits[1]?.to ?? 0) + 1)).toBe(' quit ')
  })

  it('is unmoved by colour', () => {
    const items = [
      { label: 'checkout', target: { kind: 'project' as const, project: 'checkout' } },
      { label: 'search', target: { kind: 'project' as const, project: 'search' } },
    ]
    const plain = chips(0, items, 40)
    const painted = chips(0, items, 40, (label) => `\x1b[1m${label}\x1b[0m`)
    expect(painted.hits).toEqual(plain.hits)
  })

  it('stops rather than spilling past the edge', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      label: `tab-${i}`,
      target: { kind: 'project' as const, project: `p${i}` },
    }))
    const { hits, width } = chips(0, many, 30)
    expect(hits.length).toBeLessThan(many.length)
    expect(width).toBeLessThanOrEqual(30)
    for (const hit of hits) expect(hit.to).toBeLessThan(30)
  })
})

describe('hitAt', () => {
  it('finds nothing where nothing was drawn', () => {
    expect(hitAt([rowHit(2, 10, { kind: 'orchestrator' })], 4, 3)).toBeNull()
    expect(hitAt([], 0, 0)).toBeNull()
  })

  it('answers with what is on top, because that is what you clicked', () => {
    const under = rowHit(1, 20, { kind: 'orchestrator' })
    const over = { row: 1, from: 2, to: 5, target: { kind: 'file' as const, path: 'src/' } }
    expect(hitAt([under, over], 3, 1)).toEqual(over.target)
    expect(hitAt([under, over], 9, 1)).toEqual(under.target)
  })
})
