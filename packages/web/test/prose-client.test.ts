import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StillDocument, type StillElement } from '../scripts/still-dom.ts'
import { proseOf } from '../src/assets/dom.js'

// Free text somebody wrote, as the page draws it: **whole**. Every text crosses
// whole (`BUDGET` in `page.ts`), so the page draws all of it, wraps it, and a
// very long one scrolls in its own box (`.said.whole`) — and there is no line
// saying more was written somewhere, because nothing was left behind.

const was = { document: Reflect.get(globalThis, 'document') }
let doc: StillDocument

beforeEach(() => {
  doc = new StillDocument()
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'document', {
    value: was.document,
    configurable: true,
    writable: true,
  })
})

const LONG = `${Array.from({ length: 600 }, (_, n) => `line ${n} of what was said — 🔧`).join('\n')}\nthe end`

const drawn = (said: { words: string; more: boolean } | null, folded = false) =>
  proseOf(said, folded) as unknown as StillElement

describe('prose, drawn', () => {
  it('draws a text of over ten thousand characters whole, in a box of its own', () => {
    expect(LONG.length).toBeGreaterThan(10_000)
    const node = drawn({ words: LONG, more: false })
    const body = node.children[0]
    expect(body?.textContent).toBe(LONG)
    expect(body?.className).toBe('said whole')
    expect(node.textContent).toBe(LONG)
  })

  it('says nothing about more being written, whatever the flag', () => {
    const node = drawn({ words: LONG, more: true })
    expect(node.textContent).toBe(LONG)
    expect(node.textContent).not.toMatch(/more than|written down|not shown/)
  })

  it('folds only on this page, and one press opens all of it', () => {
    const node = drawn({ words: LONG, more: false }, true)
    const [body, more] = node.children
    expect(body?.className).toBe('said whole folded')
    expect(body?.textContent).toBe(LONG)
    more?.click()
    expect(body?.className).toBe('said whole')
    expect(node.textContent).toBe(`${LONG}shown in full`)
  })

  it('draws nothing for nothing said', () => {
    expect(proseOf(null)).toBeNull()
  })
})
