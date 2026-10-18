import { afterEach, describe, expect, it } from 'vitest'
import { StillDocument } from '../scripts/still-dom.ts'
import { docksOn } from '../src/assets/docks.js'
import { shell } from '../src/assets/shell.js'

// Every press in the frame is named by what it shows (WCAG 2.5.3, label in
// name), so somebody who says what they see to a voice control reaches it.
//
// `scripts/browser.ts` asks axe this in Chromium, where it is
// `label-content-name-mismatch` — but that harness needs a browser nobody's CI
// has, and the frame's presses had drifted from their words on every screen
// before anybody ran it. This asks the one property offline, in the stand-in
// document: a press with an `aria-label` carries every word it draws, in every
// state its docks can put it in.

/** Words only, as axe compares them: case, punctuation and symbols are not what a person says. */
const words = (said: string) =>
  said
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

describe('the frame’s presses', () => {
  const was = { document: Reflect.get(globalThis, 'document') }
  afterEach(() => {
    Object.defineProperty(globalThis, 'document', {
      value: was.document,
      configurable: true,
      writable: true,
    })
  })

  it('name every press by the words it draws, folded and open', () => {
    const doc = new StillDocument()
    Object.defineProperty(globalThis, 'document', {
      value: doc,
      configurable: true,
      writable: true,
    })
    const shown = shell()
    doc.body.append(...shown.parts)
    // A count on the phone's agents tab is a word it draws too.
    for (const one of shown.links) one.figure.textContent = '3'
    const docks = docksOn(shown)

    const mismatched = () =>
      [...doc.querySelectorAll('button[aria-label], a[aria-label]')]
        .map((press) => ({
          name: press.getAttribute('aria-label') ?? '',
          drawn: press.textContent ?? '',
        }))
        .filter((one) => !words(one.name).includes(words(one.drawn)))

    const presses = Object.entries(shown.folds).flatMap(([which, all]) =>
      all.map((press) => ({ which, press })),
    )
    expect(presses.length).toBeGreaterThan(3)
    expect(mismatched()).toEqual([])
    for (const { which, press } of presses) {
      docks.toggle(which, press)
      expect(mismatched(), `${which}, pressed`).toEqual([])
      docks.toggle(which, press)
      expect(mismatched(), `${which}, pressed again`).toEqual([])
    }
    // The command bar is still named, and by its own words.
    expect(words(shown.asks[0]?.getAttribute('aria-label') ?? '')).toBe('go anywhere or ask tade k')
  })

  it('leaves a tab that draws its own word named by it, with its state said by aria-expanded', () => {
    const doc = new StillDocument()
    Object.defineProperty(globalThis, 'document', {
      value: doc,
      configurable: true,
      writable: true,
    })
    const shown = shell()
    doc.body.append(...shown.parts)
    docksOn(shown)
    const tabs = shown.folds.side.filter((press) => press.classList.contains('tab'))
    expect(tabs.length).toBe(1)
    for (const tab of [...tabs, ...shown.folds.tade]) {
      expect(tab.getAttribute('aria-label')).toBeNull()
      expect(tab.getAttribute('aria-expanded')).toBe('false')
      expect(words(tab.textContent ?? '')).not.toBe('')
    }
  })
})
