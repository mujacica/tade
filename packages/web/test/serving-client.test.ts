import { afterEach, describe, expect, it } from 'vitest'
import { StillDocument } from '../scripts/still-dom.ts'
import { servedAt, servedBy, servingIn } from '../src/assets/serving.js'

// The pages an agent's dev servers serve, as the page links them: ports off
// the wire, and the host the page itself was opened at.

describe('servedBy', () => {
  it('is every port the tasks serve on, once each and in order', () => {
    const tasks = [{ servers: [5173, 3000] }, { servers: [3000] }, { servers: [] }, {}]
    expect(servedBy(tasks)).toEqual([3000, 5173])
  })

  it('is nothing for tasks that serve nothing', () => {
    expect(servedBy([])).toEqual([])
    expect(servedBy([{ servers: [] }])).toEqual([])
  })
})

describe('servedAt', () => {
  it('opens the port on the host the page was opened at, at the top', () => {
    expect(servedAt(5173, 'http://localhost:7654/a/checkout/web')).toBe('http://localhost:5173/')
    expect(servedAt(5173, 'http://192.168.1.20:7654/')).toBe('http://192.168.1.20:5173/')
    expect(servedAt(5173, 'http://[::1]:7654/?x#y')).toBe('http://[::1]:5173/')
  })

  it('is plain http where the page came over https, which is what a dev server speaks', () => {
    expect(servedAt(3000, 'https://box.example.ts.net/')).toBe('http://box.example.ts.net:3000/')
  })

  it('is nothing where the page knows no address of its own', () => {
    expect(servedAt(3000, '')).toBeNull()
    expect(servedAt(3000, undefined)).toBeNull()
  })
})

describe('servingIn', () => {
  // Read off the global rather than named: these tests have no DOM's types.
  const was = {
    document: Reflect.get(globalThis, 'document'),
    location: Reflect.get(globalThis, 'location'),
  }
  afterEach(() => {
    for (const [name, value] of Object.entries(was))
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  })

  /** The page's document, opened at `href`, and the bar's tools in it. */
  function opened(href?: string) {
    const doc = new StillDocument()
    const at = { document: doc, location: href === undefined ? {} : { href } }
    for (const [name, value] of Object.entries(at))
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    const tools = doc.createElement('div')
    return { tools, serving: servingIn(tools) }
  }

  const links = (tools: { querySelectorAll(selector: string): Iterable<unknown> }) =>
    [...tools.querySelectorAll('a')].map((one) => {
      const a = one as { getAttribute(name: string): string | null; textContent: string }
      return [a.textContent, a.getAttribute('href'), a.getAttribute('target')]
    })

  it('draws a press per port out of the page, and keeps it in step', () => {
    const { tools, serving } = opened('http://localhost:7654/a/checkout/web')
    serving.update([5173, 6006])
    expect(links(tools)).toEqual([
      [':5173', 'http://localhost:5173/', '_blank'],
      [':6006', 'http://localhost:6006/', '_blank'],
    ])
    serving.update([6006])
    expect(links(tools)).toEqual([[':6006', 'http://localhost:6006/', '_blank']])
    serving.update([])
    expect(links(tools)).toEqual([])
  })

  it('draws nothing where the page knows no address of its own', () => {
    const { tools, serving } = opened()
    serving.update([5173])
    expect(links(tools)).toEqual([])
  })
})
