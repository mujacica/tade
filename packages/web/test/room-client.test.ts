import { afterEach, describe, expect, it } from 'vitest'
import { roomOn } from '../src/assets/room.js'

// The shell fitted to the room the keyboard leaves (`room.js`), held without a
// browser: a visual viewport that shrinks as iOS's does, and the root's class
// and `--room` read back. What the shell looks like in that room is
// `scripts/browser-duo.ts`'s, in WebKit at the Duo's four sizes.

const KEPT = {
  visualViewport: Object.getOwnPropertyDescriptor(globalThis, 'visualViewport'),
  innerHeight: Object.getOwnPropertyDescriptor(globalThis, 'innerHeight'),
  scrollY: Object.getOwnPropertyDescriptor(globalThis, 'scrollY'),
  scrollTo: Object.getOwnPropertyDescriptor(globalThis, 'scrollTo'),
}

afterEach(() => {
  for (const [name, kept] of Object.entries(KEPT)) {
    if (kept === undefined) Reflect.deleteProperty(globalThis, name)
    else Object.defineProperty(globalThis, name, kept)
  }
})

/** A phone whose window is `tall`; `shows` says how much of it is on the glass. */
function phone(tall: number) {
  const view = Object.assign(new EventTarget(), { height: tall, offsetTop: 0, scale: 1 })
  const scrolled: number[] = []
  Object.defineProperty(globalThis, 'visualViewport', { configurable: true, value: view })
  Object.defineProperty(globalThis, 'innerHeight', { configurable: true, value: tall })
  Object.defineProperty(globalThis, 'scrollY', { configurable: true, value: 0, writable: true })
  Object.defineProperty(globalThis, 'scrollTo', {
    configurable: true,
    value: (_x: number, y: number) => scrolled.push(y),
  })
  const classes = new Set<string>()
  const props = new Map<string, string>()
  const root = {
    classList: {
      toggle: (name: string, on: boolean) => {
        if (on) classes.add(name)
        else classes.delete(name)
        return on
      },
    },
    style: {
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => {
        props.delete(name)
        return ''
      },
    },
  }
  const shows = (shown: number, over: Partial<{ offsetTop: number; scale: number }> = {}) => {
    Object.assign(view, { height: shown, offsetTop: 0, scale: 1, ...over })
    view.dispatchEvent(new Event('resize'))
  }
  return { root, classes, props, shows, scrolled }
}

describe('the room the keyboard leaves', () => {
  it('is the screen until the keyboard comes up', () => {
    const at = phone(678)
    roomOn(at.root)
    expect(at.classes.has('keyboard-up')).toBe(false)
    expect(at.props.has('--room')).toBe(false)
  })

  it('is the glass above the keyboard while it is up, and the screen again once it goes', () => {
    const at = phone(678)
    roomOn(at.root)
    at.shows(342)
    expect(at.classes.has('keyboard-up')).toBe(true)
    expect(at.props.get('--room')).toBe('342px')
    expect(at.props.get('--keys')).toBe('336px')
    at.shows(678)
    expect(at.classes.has('keyboard-up')).toBe(false)
    expect(at.props.has('--room')).toBe(false)
    expect(at.props.has('--keys')).toBe(false)
  })

  it('puts back a page Safari slid up to show the box', () => {
    const at = phone(466)
    roomOn(at.root)
    at.shows(257, { offsetTop: 209 })
    expect(at.scrolled).toEqual([0])
  })

  it('is not a keyboard when a toolbar takes a strip, or when the page is pinched in', () => {
    const at = phone(951)
    roomOn(at.root)
    at.shows(951 - 60)
    expect(at.classes.has('keyboard-up')).toBe(false)
    at.shows(951 / 2, { scale: 2 })
    expect(at.classes.has('keyboard-up')).toBe(false)
    expect(at.scrolled).toEqual([])
  })

  it('does nothing where the browser has no visual viewport', () => {
    Object.defineProperty(globalThis, 'visualViewport', { configurable: true, value: undefined })
    const at = {
      classList: { toggle: () => true },
      style: { setProperty: () => {}, removeProperty: () => '' },
    }
    expect(() => roomOn(at)).not.toThrow()
  })
})
