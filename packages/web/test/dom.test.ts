import { describe, expect, it } from 'vitest'
import { keyed } from '../src/assets/dom.js'

// The one algorithm in the page that a wrong line makes quietly destructive.
//
// `keyed` is what the whole focus-and-selection claim rests on: a delta
// arrives twice a second, and a row that was **rebuilt** rather than filled
// takes the keyboard's place, a half-made text selection and the row somebody
// was about to press with it. Re-inserting a node blurs what is focused inside
// it in some browsers, so it must also not *move* a node that is already in
// the right place.
//
// **This runs against a stand-in for a node, not against a browser**, and the
// reason is worth saying: there is no DOM in this repository's `lib` and no
// jsdom in its lockfile, and what is being asked here is not "does Chrome
// append" — it is "given these rows before and after, which nodes were reused,
// which were created, which moved and which went". That is a property of the
// algorithm. The stand-in models the two bits of real behaviour it leans on —
// `append` and `insertBefore` **move** a node that is already a child, and
// `children` is live — and if it modelled those wrongly this test would lie,
// which is why `scripts/browser.ts` drives the same code in a real browser
// with a real delta and watches a real focus survive it.

/** The six things `keyed` asks of a node, and nothing else. */
class Node {
  readonly children: Node[] = []
  readonly attrs: Record<string, string> = {}
  parent: Node | null = null
  /** How many times this node was handed to `fill`, which is the point. */
  filled = 0
  /** How many times it was moved, which is what must not happen needlessly. */
  moved = 0

  append(child: Node): void {
    child.detach()
    child.parent = this
    this.children.push(child)
    child.moved += 1
  }

  insertBefore(child: Node, before: Node): void {
    child.detach()
    child.parent = this
    this.children.splice(this.children.indexOf(before), 0, child)
    child.moved += 1
  }

  remove(): void {
    this.detach()
  }

  detach(): void {
    const at = this.parent?.children.indexOf(this) ?? -1
    if (at >= 0) this.parent?.children.splice(at, 1)
    this.parent = null
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null
  }
}

interface Row {
  id: string
  said?: string
}

let born = 0

function run(parent: Node, rows: readonly Row[]) {
  const made: Node[] = []
  keyed(
    parent as never,
    rows,
    (row: Row) => row.id,
    () => {
      born += 1
      const one = new Node()
      made.push(one)
      return one as never
    },
    (node: Node, row: Row) => {
      node.filled += 1
      node.setAttribute('said', row.said ?? row.id)
    },
  )
  return made
}

const ids = (parent: Node) => parent.children.map((one) => one.getAttribute('data-key'))
const rows = (...names: string[]) => names.map((id) => ({ id }))

describe('reconciling a list by key', () => {
  it('creates a node per row, in order, keyed by its id', () => {
    const parent = new Node()
    run(parent, rows('a', 'b', 'c'))
    expect(ids(parent)).toEqual(['a', 'b', 'c'])
    expect(parent.children.every((one) => one.filled === 1)).toBe(true)
  })

  it('fills a row it already has rather than building it again', () => {
    // The whole point: a row that is still here keeps its node, so whatever is
    // focused or selected inside it is still focused and selected.
    const parent = new Node()
    run(parent, rows('a', 'b', 'c'))
    const held = [...parent.children]
    const fresh = run(parent, [{ id: 'a', said: 'changed' }, { id: 'b' }, { id: 'c' }])
    expect(fresh).toEqual([])
    expect(parent.children).toEqual(held)
    expect(held[0]?.filled).toBe(2)
    expect(held[0]?.getAttribute('said')).toBe('changed')
  })

  it('moves nothing when the order did not change', () => {
    // Re-inserting a node blurs what is focused inside it in some browsers, so
    // a list that reordered nothing must not touch the DOM at all — otherwise
    // the row somebody is on loses focus twice a second, for ever.
    const parent = new Node()
    run(parent, rows('a', 'b', 'c'))
    const before = parent.children.map((one) => one.moved)
    run(parent, rows('a', 'b', 'c'))
    expect(parent.children.map((one) => one.moved)).toEqual(before)
  })

  it('inserts a new row in its place without rebuilding its neighbours', () => {
    const parent = new Node()
    run(parent, rows('a', 'c'))
    const [a, c] = parent.children
    const moved = c?.moved
    run(parent, rows('a', 'b', 'c'))
    expect(ids(parent)).toEqual(['a', 'b', 'c'])
    expect(parent.children[0]).toBe(a)
    expect(parent.children[2]).toBe(c)
    // `a` was already right and `c` only shifts because something went in
    // front of it — neither is rebuilt.
    expect(a?.filled).toBe(2)
    expect(c?.moved).toBe(moved)
  })

  it('removes a row that went, and only that one', () => {
    const parent = new Node()
    run(parent, rows('a', 'b', 'c'))
    const [a, b, c] = parent.children
    run(parent, rows('a', 'c'))
    expect(ids(parent)).toEqual(['a', 'c'])
    expect(b?.parent).toBeNull()
    expect(parent.children).toEqual([a, c])
  })

  it('reorders without losing or duplicating a row', () => {
    const parent = new Node()
    run(parent, rows('a', 'b', 'c', 'd'))
    const held = new Map(parent.children.map((one) => [one.getAttribute('data-key'), one]))
    run(parent, rows('d', 'b', 'a', 'c'))
    expect(ids(parent)).toEqual(['d', 'b', 'a', 'c'])
    // Every node is the one it was: a reorder is a move, never a rebuild.
    for (const [id, one] of held) expect(parent.children).toContain(one)
    expect(new Set(parent.children).size).toBe(4)
  })

  it('empties the list when every row went', () => {
    const parent = new Node()
    run(parent, rows('a', 'b'))
    run(parent, [])
    expect(parent.children).toEqual([])
  })

  it('fills a list that was empty', () => {
    const parent = new Node()
    run(parent, [])
    expect(parent.children).toEqual([])
    run(parent, rows('a'))
    expect(ids(parent)).toEqual(['a'])
  })

  it('never removes a child that is not one of its rows, but does move it past them', () => {
    // **The parent is the list and holds nothing else**, and this is why: a
    // child with no `data-key` is left in the document — it is not mistaken for
    // a row that went — but the rows are placed at the front, so it ends up
    // after them, which is almost never what somebody who put it there meant.
    // Pinned so it is a decision rather than a surprise; a sentence that
    // belongs beside a list goes next to the list's parent, not inside it.
    const parent = new Node()
    const sentence = new Node()
    parent.append(sentence)
    run(parent, rows('a', 'b'))
    expect(ids(parent)).toEqual(['a', 'b', null])
    run(parent, rows('a'))
    expect(parent.children).toContain(sentence)
  })

  it('replaces the whole list when every key changed', () => {
    const parent = new Node()
    run(parent, rows('a', 'b'))
    const old = [...parent.children]
    run(parent, rows('x', 'y'))
    expect(ids(parent)).toEqual(['x', 'y'])
    for (const one of old) expect(one.parent).toBeNull()
  })
})
