import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { judged } from '../scripts/browser-stills.ts'
import { stillsOf, type Visit } from '../scripts/still.ts'
import { mediaAt, sheetFor } from '../scripts/still-css.ts'
import { HTML, StillDocument, SVG } from '../scripts/still-dom.ts'
import { parseSelectors } from '../scripts/still-selectors.ts'
import { xhtmlOf } from '../scripts/still-xhtml.ts'

// The stand-in the README's pictures of the away view are drawn in.
//
// `packages/app/test/pictures.test.ts` holds the pictures to their bytes, which
// says a picture moved; this says the stand-in itself still does what the page
// leans on — and, first, that every selector the page asks is one it can read,
// so a page that starts asking a new kind fails here, offline, with the
// selector named, rather than as a picture missing a region.

const ASSETS = fileURLToPath(new URL('../src/assets/', import.meta.url))

/** Every page script, as text. */
function scripts(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  for (const file of readdirSync(ASSETS, { recursive: true, encoding: 'utf8' }))
    if (file.endsWith('.js')) out.push({ file, text: readFileSync(join(ASSETS, file), 'utf8') })
  return out
}

describe("the still's document", () => {
  it('reads every selector the page asks of its own document', () => {
    const asked: string[] = []
    // A template's hole stands for one name, which is what it is filled with.
    for (const { text } of scripts())
      for (const found of text.matchAll(
        /\b(?:querySelector(?:All)?|closest|matches)\(\s*(['`])([^'`]*)\1/g,
      ))
        asked.push((found[2] ?? '').replace(/\$\{[^}]*\}/g, 'x'))
    expect(asked.length).toBeGreaterThan(20)
    const unread = asked.filter((one) => {
      try {
        parseSelectors(one)
        return false
      } catch {
        return true
      }
    })
    expect(unread).toEqual([])
  })

  it('matches the way a browser does, for the shapes the page uses', () => {
    const doc = new StillDocument()
    const list = doc.createElement('ul')
    const item = doc.createElement('li')
    const link = doc.createElement('a')
    link.setAttribute('href', '/plans')
    link.className = 'card-link'
    const hidden = doc.createElement('button')
    hidden.hidden = true
    const box = doc.createElement('input')
    box.setAttribute('type', 'checkbox')
    box.checked = true
    item.append(link, hidden, box)
    list.append(item)
    doc.body.append(list)
    expect(doc.querySelectorAll('li > a').length).toBe(1)
    expect(doc.querySelectorAll('ul > a').length).toBe(0)
    expect(doc.querySelectorAll('ul a.card-link').length).toBe(1)
    expect(doc.querySelectorAll('button:not([hidden]), a[href]').length).toBe(1)
    expect(doc.querySelector('input:checked')).toBe(box)
    expect(link.closest('li')).toBe(item)
    expect(() => doc.querySelector('li + a')).toThrow(/sibling/)
    expect(() => doc.querySelector('a:hover')).toThrow(/cannot read/)
  })

  it('keeps the tree the way the page leans on it', () => {
    const doc = new StillDocument()
    const a = doc.createElement('div')
    const b = doc.createElement('div')
    const child = doc.createElement('span')
    a.append(child)
    b.append(child)
    // Appending moves a node rather than copying it.
    expect(a.children.length).toBe(0)
    expect(child.parentNode).toBe(b)
    b.textContent = 'said'
    expect(b.childNodes.length).toBe(1)
    b.textContent = ''
    expect(b.childNodes.length).toBe(0)
    b.classList.add('one', 'two')
    b.classList.toggle('one', false)
    expect(b.getAttribute('class')).toBe('two')
    b.style.setProperty('--w', '42%')
    b.style.setProperty('height', '2px')
    expect(b.getAttribute('style')).toBe('--w: 42%; height: 2px;')
    b.dataset.someKey = 'k'
    expect(b.getAttribute('data-some-key')).toBe('k')
    expect(b.clientWidth).toBe(0)
    doc.measured = { '.two': 510 }
    expect(b.clientWidth).toBe(510)
  })
})

describe('writing it out', () => {
  it('writes XHTML that says what a person sees, and nothing that draws nothing', () => {
    const doc = new StillDocument()
    const root = doc.createElement('div')
    const words = doc.createElement('p')
    words.setAttribute('title', 'a "quoted" <word> & more')
    words.textContent = 'Tom & Jerry <3'
    const typed = doc.createElement('input')
    typed.value = 'typed here'
    const ticked = doc.createElement('input')
    ticked.setAttribute('type', 'checkbox')
    ticked.checked = true
    const area = doc.createElement('textarea')
    area.value = 'a draft'
    const icon = doc.createElementNS(SVG, 'svg')
    const use = doc.createElementNS(SVG, 'use')
    use.setAttribute('href', '#i-mark')
    icon.append(use)
    const sprite = doc.createElementNS(SVG, 'svg')
    sprite.setAttribute('class', 'sprite')
    const script = doc.createElement('script')
    root.append(words, typed, ticked, area, icon, sprite, script)
    expect(xhtmlOf(root, HTML)).toBe(
      '<div><p title="a &quot;quoted&quot; &lt;word&gt; &amp; more">Tom &amp; Jerry &lt;3</p>' +
        '<input value="typed here"/><input type="checkbox" checked=""/>' +
        '<textarea>a draft</textarea>' +
        `<svg xmlns="${SVG}"><use href="#i-mark"/></svg></div>`,
    )
  })
})

describe("the page's stylesheets, pinned to one size", () => {
  const desk = { width: 1280, height: 800, pointer: 'fine' as const, scope: 'still-desk' }
  const phone = { width: 360, height: 744, pointer: 'coarse' as const, scope: 'still-phone' }

  it('answers a media query for the size the picture is of, and leaves motion to the reader', () => {
    expect(mediaAt('(min-width: 1100px)', desk)).toBe(true)
    expect(mediaAt('(min-width: 1100px)', phone)).toBe(false)
    expect(mediaAt('(max-width: 479px)', phone)).toBe(true)
    expect(mediaAt('(min-width: 1100px) and (pointer: fine)', desk)).toBe(true)
    expect(mediaAt('(min-width: 1100px) and (pointer: fine)', phone)).toBe(false)
    expect(mediaAt('(prefers-reduced-motion: reduce)', desk)).toBe(null)
    expect(() => mediaAt('(orientation: portrait)', desk)).toThrow(/cannot answer/)
  })

  it('pins the viewport, renames the root, scopes every rule and leaves out what moves', () => {
    const sheet = sheetFor(desk, new Set(['.frame', '.top', '.enter']))
    expect(sheet).toContain('.still-html.still-desk{')
    expect(sheet).toContain('.still-desk .still-body{')
    expect(sheet).toContain('height: 800px')
    expect(sheet).not.toMatch(/\d(dvh|vh|vw)\b/)
    expect(sheet).not.toMatch(/(^|[{;])\s*(animation|transition)[\w-]*:/)
    expect(sheet).not.toContain('@starting-style')
    expect(sheet).not.toContain('@keyframes')
    // A rule naming a class no frame has is gone; one naming only what is there stays.
    expect(sheet).not.toContain('.page-spend')
    expect(sheet).toContain('.still-desk .frame')
  })
})

describe('asking a browser whether the picture is the page', () => {
  it('tells the same document, a document that differs only in layout, and one that differs', () => {
    const page = '<div class="a"><svg viewBox="0 0 510 30" width="510"><path d="M1 2"/></svg></div>'
    expect(judged('x /', page, page).verdict).toBe('same')
    const narrow = page.replace(/510/g, '198').replace('M1 2', 'M1 3')
    expect(judged('x /', narrow, page).verdict).toBe('layout')
    expect(judged('x /', page.replace('class="a"', 'class="b"'), page).verdict).toBe('differs')
  })
})

describe('a visit', () => {
  const at = { module: new URL('./still-world.ts', import.meta.url).href, name: 'TEST_WORLD' }
  const visit: Visit = {
    device: 'dev_7f3a9c21',
    width: 1280,
    height: 800,
    pointer: 'fine',
    paths: ['/'],
  }

  it('is a page load: the page drew itself, and drew the same thing twice from nothing', async () => {
    const [one, two] = await stillsOf(at, [visit, visit])
    expect(one?.body).toContain('<header class="top">')
    expect(one?.title).toMatch(/Overview/)
    // The page numbers its headings in its modules; a visit that carried on
    // from the last one would number them from where that one stopped.
    expect(two?.body).toBe(one?.body)
  })

  it('refuses a screen the page could not draw, rather than taking a picture of it', async () => {
    await expect(stillsOf(at, [{ ...visit, paths: ['/nowhere-at-all'] }])).rejects.toThrow(
      /Nothing here/,
    )
    await expect(stillsOf(at, [{ ...visit, device: 'nobody' }])).rejects.toThrow(/no device/)
  })
})
