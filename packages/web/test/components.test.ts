import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assetsDir } from '../src/assets.ts'
import { scripts, sheets } from './asset-files.ts'

// The components (`ui.css`, `ui.js`), held to being the one place a look is
// defined.
//
// **The ratchet this is**: a panel, a pill, a count and a meter were each
// written out again in every file that drew one — twenty-seven panels, a
// count in five shapes — so a change to how one looks was a hunt. Now each is
// one rule, and what this file fails on is a screen growing its own copy
// again, or a class a script names that no sheet defines (which draws as
// nothing at all and no other test would see).

const DIR = assetsDir()
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')
// The two component sheets: the looks (`ui.css`) and the charts (`charts.css`).
const UI = `${read('ui.css')}\n${read('charts.css')}`
const SCRIPTS = scripts(DIR).map((name) => ({ name, text: read(name) }))
const SHEETS = sheets(DIR)
  .filter((name) => !['ui.css', 'charts.css', 'tokens.css'].includes(name))
  .map((name) => ({ name, text: read(name) }))

/** Every `ui-*` class a script puts on an element, by the file that does. */
function namedIn(text: string): string[] {
  return [...text.matchAll(/['` ](ui-[a-z-]+)/g)].map((one) => one[1] ?? '')
}

/** The base components `ui.css` defines: `.ui-x {`, not a modifier or a descendant. */
const DEFINED = new Set([...UI.matchAll(/^\.(ui-[a-z-]+)\s*\{/gm)].map((one) => one[1]))

/**
 * Rules outside `ui.css` allowed to build a panel's ground and hairline.
 *
 * Both are a state's wash over the panel ground — the status pill and the
 * page-wide bars — whose border and background are rewritten per tone in the
 * rules after them, so the panel is where they start and not what they are.
 */
const OWN_GROUND = ['.fresh', '.bar']

describe('the components', () => {
  it('are loaded right after the tokens, so a screen’s own rule always wins', () => {
    const links = [...read('index.html').matchAll(/href="\/assets\/([a-z/]+\.css)"/g)].map(
      (one) => one[1],
    )
    expect(links.slice(0, 3)).toEqual(['tokens.css', 'ui.css', 'charts.css'])
  })

  it('define every component a script asks for', () => {
    const missing = SCRIPTS.flatMap(({ name, text }) =>
      namedIn(text)
        .filter((klass) => !DEFINED.has(klass) && !UI.includes(`.${klass}`))
        .map((klass) => `${name}: ${klass}`),
    )
    expect(missing).toEqual([])
  })

  it('are each made by something, so none is a rule nothing draws', () => {
    const made = new Set(SCRIPTS.flatMap(({ text }) => namedIn(text)))
    expect([...DEFINED].filter((klass) => !made.has(klass ?? ''))).toEqual([])
  })

  it('are not written out again: no other sheet builds a panel’s ground and hairline', () => {
    const copies = SHEETS.flatMap(({ name, text }) =>
      [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(
          (rule) =>
            (rule[2] ?? '').includes('background: var(--panel)') &&
            (rule[2] ?? '').includes('border: var(--border)'),
        )
        .map((rule) => (rule[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
        .filter((selector) => !OWN_GROUND.includes(selector))
        .map((selector) => `${name}: ${selector}`),
    )
    expect(copies).toEqual([])
  })

  it('draw a count the one way, empty at nought rather than a 0', () => {
    expect(UI).toMatch(/\.ui-count:empty\s*\{\s*display: none;/)
    const ui = read('ui.js')
    expect(ui).toMatch(/n === 0 \? '' : n > 99 \? '99\+' : String\(n\)/)
  })
})
