import { afterEach, describe, expect, it } from 'vitest'
import { agentPresses } from '../src/assets/agent-menu.js'
import { icon, iconIn } from '../src/assets/icons.js'

// The drawn glyph follows the verb.
//
// An agent row's start/stop button said "Stop <name>" under a ▷: `iconIn` was
// handed the button and set the `href` on its first child, the `<svg>`, which
// draws nothing, so the `<use>` — and the `ic-play` class — stayed as built.
//
// **A stand-in document, not a browser**, for the reason `dom.test.ts` gives:
// there is no DOM in this repository's `lib` and no jsdom in its lockfile, and
// what is asked here is which element carries which `href` and class after a
// redraw — a property of the code, not of Chrome. The stand-in models what
// the code leans on: an element's children, its attributes, its class list,
// and a sprite the namespace is read off (`spaceOf`).

const SVG = 'http://www.w3.org/2000/svg'

class Classes {
  readonly #names: string[] = []
  set(value: string): void {
    this.#names.splice(0, this.#names.length, ...value.split(/\s+/).filter((one) => one !== ''))
  }
  get value(): string {
    return this.#names.join(' ')
  }
  contains(name: string): boolean {
    return this.#names.includes(name)
  }
  add(name: string): void {
    if (!this.contains(name)) this.#names.push(name)
  }
  remove(name: string): void {
    const at = this.#names.indexOf(name)
    if (at >= 0) this.#names.splice(at, 1)
  }
  toggle(name: string, on?: boolean): void {
    if (on ?? !this.contains(name)) this.add(name)
    else this.remove(name)
  }
  [Symbol.iterator](): Iterator<string> {
    return [...this.#names][Symbol.iterator]()
  }
}

class Element {
  readonly children: Element[] = []
  readonly classList = new Classes()
  readonly #attrs = new Map<string, string>()
  hidden = false
  title = ''
  textContent = ''
  readonly tagName: string
  readonly namespaceURI: string | null
  constructor(tagName: string, namespaceURI: string | null) {
    this.tagName = tagName
    this.namespaceURI = namespaceURI
  }
  get firstChild(): Element | null {
    return this.children[0] ?? null
  }
  set className(value: string) {
    this.classList.set(value)
  }
  setAttribute(name: string, value: string): void {
    if (name === 'class') this.classList.set(value)
    else this.#attrs.set(name, value)
  }
  getAttribute(name: string): string | null {
    if (name === 'class') return this.classList.value
    return this.#attrs.get(name) ?? null
  }
  removeAttribute(name: string): void {
    this.#attrs.delete(name)
  }
  append(...nodes: Element[]): void {
    this.children.push(...nodes)
  }
  addEventListener(): void {}
}

/** A document with the shell's sprite in it, or without one. */
function documentWith(sprite: boolean) {
  return {
    createElement: (tag: string) => new Element(tag, null),
    createElementNS: (space: string, tag: string) => new Element(tag, space),
    querySelector: (selector: string) =>
      sprite && selector === 'svg.sprite' ? new Element('svg', SVG) : null,
  }
}

const g = globalThis as { document?: unknown }
afterEach(() => {
  delete g.document
})

/** What an icon draws: the symbol its `<use>` points at, and its `ic-` classes. */
function drawnOf(node: unknown): { href: string | null; marks: string[] } {
  const svg = node as Element
  return {
    href: svg.firstChild?.getAttribute('href') ?? null,
    marks: [...svg.classList].filter((one) => one.startsWith('ic-')),
  }
}

/** An agent row's presses, on a device granted the agents scope. */
function agentRow() {
  const acting = {
    ctx: { session: () => null },
    menu: { open: () => {} },
    rowOf: () => null,
  }
  const presses = agentPresses(acting, () => new Element('p', null)) as {
    node: Element
    update(row: unknown, acts: unknown): void
  }
  const toggle = presses.node.children[0] as Element
  const redraw = (verb: 'stop' | 'start') =>
    presses.update({ id: 't1', name: 'fixer', can: [{ verb }] }, { agents: true })
  return { toggle, redraw }
}

describe('the drawn glyph follows the verb', () => {
  it('draws ■ on an agent row whose press is Stop, and ▷ again when it is Start', () => {
    g.document = documentWith(true)
    const { toggle, redraw } = agentRow()

    redraw('stop')
    expect(toggle.getAttribute('aria-label')).toBe('Stop fixer')
    expect(drawnOf(toggle.firstChild)).toEqual({ href: '#i-stop', marks: ['ic-stop'] })
    // The `<svg>` itself is never pointed at anything: that is what drew nothing.
    expect(toggle.firstChild?.getAttribute('href')).toBeNull()

    redraw('start')
    expect(toggle.getAttribute('aria-label')).toBe('Start fixer')
    expect(drawnOf(toggle.firstChild)).toEqual({ href: '#i-play', marks: ['ic-play'] })
  })

  it('moves an icon handed itself, as the palette and pairing hand theirs', () => {
    g.document = documentWith(true)
    const made = icon('bolt', 'pal-mark')
    iconIn(made, 'check')
    expect(drawnOf(made)).toEqual({ href: '#i-check', marks: ['ic-check'] })
    // A class the caller added is the caller's, and stays.
    expect((made as unknown as Element).classList.contains('pal-mark')).toBe(true)
  })

  it('moves an icon handed what holds it, rather than the svg', () => {
    g.document = documentWith(true)
    const holder = new Element('button', null)
    holder.append(icon('play') as unknown as Element)
    iconIn(holder, 'stop')
    expect(drawnOf(holder.firstChild)).toEqual({ href: '#i-stop', marks: ['ic-stop'] })
    expect(holder.getAttribute('href')).toBeNull()
  })

  it('moves only the class where there is no sprite, and never throws', () => {
    g.document = documentWith(false)
    const made = icon('play') as unknown as Element
    expect(made.tagName).toBe('span')
    iconIn(made, 'stop')
    expect([...made.classList]).toEqual(['ic', 'ic-stop'])
    expect(() => iconIn(new Element('span', null), 'stop')).not.toThrow()
  })
})
