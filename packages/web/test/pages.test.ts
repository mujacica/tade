import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAGE_OF } from '../src/assets/routes.js'
import { assetsDir } from '../src/assets.ts'
import { scripts, sheets } from './asset-files.ts'

// Every page is its own files, and a page's files are about that page alone.
//
// **Why this is a rule and not a habit.** The pages are redesigned one at a
// time, often by several agents in one checkout, each owning one page. That
// only works if a page's work never has to touch another page or a shared
// file: so a page is `pages/<page>.js` (and its `pages/<page>-*.js` helpers)
// and `pages/<page>.css`, no page imports another page, nothing shared
// imports a page but the router, and every rule in a page's sheet can only
// ever match that page's own elements. A look two pages want is a component
// in `ui.css` or `charts.css`, asked for rather than copied (DESIGN.md beside
// the add-away-surface skill).

const DIR = assetsDir()
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')
const PAGES = [...new Set(Object.values(PAGE_OF))].sort()
const PAGE_SCRIPTS = scripts(DIR).filter((name) => name.startsWith('pages/'))
const PAGE_SHEETS = sheets(DIR).filter((name) => name.startsWith('pages/'))

/** Which page a file under `pages/` belongs to: `agent-pane.js` is the agent's. */
const pageOf = (name: string) =>
  posix
    .basename(name)
    .replace(/\.(js|css)$/, '')
    .split('-')[0]

/** The relative imports of a module, resolved to the paths they name. */
function importsOf(name: string): string[] {
  return [...read(name).matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((one) =>
    posix.join(posix.dirname(name), one[1] ?? ''),
  )
}

/** The classes a selector names, without what is inside an attribute test. */
const classesIn = (selector: string) =>
  [...selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.([a-zA-Z][\w-]*)/g)].map(
    (one) => one[1] ?? '',
  )

/** Every selector in a sheet, comma lists split, comments and at-rule heads dropped. */
function selectorsIn(text: string): string[] {
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...bare.matchAll(/([^{};]+)\{/g)]
    .map((one) => (one[1] ?? '').trim())
    .filter((head) => head !== '' && !head.startsWith('@') && !/^(from|to|\d+%)/.test(head))
    .flatMap((head) => head.split(/,(?![^(]*\))/).map((one) => one.trim()))
}

describe('every page is its own files', () => {
  it('has a module and a sheet for every page the router names, and no other', () => {
    expect([...new Set(PAGE_SCRIPTS.map(pageOf))].sort()).toEqual(PAGES)
    expect(PAGE_SHEETS.map(pageOf).sort()).toEqual(PAGES)
    // One sheet per page: a helper module is fine, a second sheet is a second
    // place a page's look could be.
    for (const page of PAGES) expect(PAGE_SHEETS).toContain(`pages/${page}.css`)
    for (const page of PAGES) expect(PAGE_SCRIPTS).toContain(`pages/${page}.js`)
  })

  it('links every page’s sheet, after every shared one', () => {
    const html = read('index.html')
    const linked = [...html.matchAll(/href="\/assets\/([\w/-]+\.css)"/g)].map((one) => one[1])
    const first = linked.findIndex((one) => one?.startsWith('pages/'))
    expect(linked.slice(first)).toEqual(PAGE_SHEETS)
    expect(linked.slice(0, first).every((one) => !one?.startsWith('pages/'))).toBe(true)
  })

  it('imports no other page, and is imported by nothing shared but the router', () => {
    for (const name of PAGE_SCRIPTS) {
      for (const target of importsOf(name).filter((one) => one.startsWith('pages/'))) {
        expect(pageOf(target), `${name} imports ${target}`).toBe(pageOf(name))
      }
    }
    for (const name of scripts(DIR).filter((one) => !one.startsWith('pages/'))) {
      const reached = importsOf(name).filter((one) => one.startsWith('pages/'))
      if (name === 'boot.js') continue
      expect(reached, `${name} imports a page`).toEqual([])
    }
  })
})

describe('a page’s sheet is about that page alone', () => {
  /** The pages whose modules put a class on an element. */
  const ownersOf = (klass: string) => {
    const pattern = new RegExp(`(?<![\\w-])${klass.replace(/-/g, '\\-')}(?![\\w-])`)
    return scripts(DIR).filter((name) => pattern.test(read(name)))
  }

  for (const sheet of PAGE_SHEETS) {
    const page = pageOf(sheet)
    it(`${sheet}: every rule names .page-${page} or a class only this page draws`, () => {
      const strays: string[] = []
      for (const selector of selectorsIn(read(sheet))) {
        const classes = classesIn(selector)
        if (classes.includes(`page-${page}`)) continue
        const own = classes.some((klass) => {
          const owners = ownersOf(klass)
          return (
            owners.length > 0 &&
            owners.every((one) => one.startsWith('pages/') && pageOf(one) === page)
          )
        })
        if (!own) strays.push(selector)
      }
      expect(strays, `scope these under .page-${page}`).toEqual([])
    })
  }

  it('names no motion of its own and overrules nothing', () => {
    // A keyframe is `motion.css`'s and a colour the palette's — `design.test.ts`
    // holds both for every sheet, pages included — and a page's rule wins by
    // coming last, never by `!important`.
    for (const sheet of PAGE_SHEETS) {
      const text = read(sheet)
      expect(text, sheet).not.toContain('@keyframes')
      expect(text, sheet).not.toContain('!important')
    }
  })
})
