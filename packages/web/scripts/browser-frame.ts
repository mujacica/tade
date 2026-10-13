import { READY, said } from '../test/browser-plan.ts'
import { until } from './browser-until.ts'

// The frame pinned to the screen's edges, in a real browser.
//
// **The document never scrolls; the screen, the menu and the side each scroll
// themselves** (`frame.css`). It used to be the document that scrolled, with
// the header, the menu, the side and Tade held in view by `sticky` — which
// carried every one of them away once the page grew past the frame, and let it
// be scrolled on past the end of the work into nothing. Only a laid-out page
// can say where a box is, so this is a browser's to answer:
//
// - every part of the frame this width draws is at the screen's own edge — the
//   header at the top, the menu and the side running to the bottom, Tade and
//   the tab bar at the foot;
// - nothing makes the document move: not setting its scroll, not a wheel over
//   the header, not a wheel over the screen run on past the screen's end, and
//   not the keyboard's PageDown on the screen;
// - each region scrolls on its own, and scrolling one moves no other — the
//   screen, the menu from a tablet up, and the side's list, docked at a desk
//   and in its drawer below one.
//
// **Every region is made longer than its room first**, by a block appended for
// the check and taken away after it, so this asks the frame and not whether
// the fixtures happen to fill a 900px screen.

type Verdict = 'pass' | 'fail' | 'unrun'
type Found = (check: string, where: string, verdict: Verdict, what: string) => void

/** What of Playwright's page this file uses, and nothing else. */
interface Page {
  goto: (url: string, opts?: object) => Promise<unknown>
  waitForSelector: (selector: string, opts?: object) => Promise<unknown>
  evaluate: (body: string) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
  keyboard?: { press: (key: string) => Promise<void> }
  mouse?: {
    move: (x: number, y: number) => Promise<void>
    wheel: (dx: number, dy: number) => Promise<void>
  }
}

/** A box, to the pixel. */
interface Box {
  top: number
  bottom: number
  left: number
  right: number
}

/** Where the frame stands: each part's box, each region's scroll, and the document's. */
interface Stands {
  parts: Record<string, Box | null>
  scrolled: Record<string, number>
  /** How far the document could scroll if anything asked it to. */
  over: number
  room: { width: number; height: number }
}

/** The regions that scroll, by the selector of the box that does. */
const REGIONS = {
  screen: 'main',
  menu: 'nav.rail',
  side: 'aside.side .side-projects',
} as const

type Region = keyof typeof REGIONS

/** Longer than Chromium keeps a run of wheel events latched to the scroller it started on. */
const LATCH_MS = 600

const STANDS = `(() => {
  const box = (selector) => {
    const one = document.querySelector(selector)
    if (one === null || one.hidden || getComputedStyle(one).display === 'none') return null
    const at = one.getBoundingClientRect()
    return { top: Math.round(at.top), bottom: Math.round(at.bottom),
      left: Math.round(at.left), right: Math.round(at.right) }
  }
  const page = document.scrollingElement
  const regions = ${JSON.stringify(REGIONS)}
  // The window's own figure, whichever element the page's mode says scrolls it.
  const scrolled = { page: scrollY }
  for (const [name, selector] of Object.entries(regions)) {
    scrolled[name] = document.querySelector(selector)?.scrollTop ?? 0
  }
  return {
    parts: { header: box('header.top'), menu: box('nav.rail'), side: box('aside.side'),
      tade: box('section.dock'), tabs: box('nav.tabs') },
    scrolled,
    over: Math.max(page.scrollHeight - page.clientHeight, page.scrollWidth - page.clientWidth),
    room: { width: innerWidth, height: innerHeight },
  }
})()`

/** A block taller than any screen, at the end of a region, so it has somewhere to scroll. */
const lengthen = (selector: string) => `(() => {
  const region = document.querySelector(${JSON.stringify(selector)})
  if (region === null) return false
  const probe = document.createElement('div')
  probe.className = 'frame-probe'
  probe.setAttribute('aria-hidden', 'true')
  // Through the CSSOM, which the content policy allows; a style attribute it does not.
  probe.style.height = '4000px'
  // Not shrunk to fit, as a flex column's items are: the menu is one.
  probe.style.flexShrink = '0'
  region.append(probe)
  return region.scrollHeight > region.clientHeight
})()`

const UNDO = `(() => {
  for (const probe of document.querySelectorAll('.frame-probe')) probe.remove()
  for (const selector of ${JSON.stringify(Object.values(REGIONS))}) {
    const region = document.querySelector(selector)
    if (region !== null) region.scrollTop = 0
  }
  return true
})()`

/**
 * Whether a region's scroll has stopped moving since the last time this was
 * asked. A wheel and PageDown both animate, so a region that has *started* to
 * scroll has not finished, and the next step measured mid-animation reads the
 * last one's movement as its own.
 */
const still = (selector: string) => `(() => {
  const now = document.querySelector(${JSON.stringify(selector)}).scrollTop
  const same = globalThis.frameWas === now
  globalThis.frameWas = now
  return same
})()`

/** The middle of a box, which is where a pointer has to be for a wheel to reach it. */
const middleOf = (selector: string) => `(() => {
  const at = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
  return { x: Math.round(at.left + at.width / 2), y: Math.round(at.top + Math.min(at.height / 2, 200)) }
})()`

/** What each width draws, and the edge each part is held to. */
function edgesWanted(width: number): Record<string, (keyof Box)[]> {
  const wanted: Record<string, (keyof Box)[]> = { header: ['top', 'left', 'right'] }
  if (width < 768) wanted.tabs = ['bottom', 'left', 'right']
  if (width >= 768) {
    wanted.menu = ['bottom', 'left']
    wanted.tade = ['bottom']
  }
  if (width >= 1280) wanted.side = ['bottom', 'right']
  return wanted
}

/** Each part of the frame that is not at its edge, in words. */
function offEdges(stands: Stands, width: number): string[] {
  const off: string[] = []
  for (const [part, edges] of Object.entries(edgesWanted(width))) {
    const box = stands.parts[part]
    if (box === null || box === undefined) {
      off.push(`${part} not drawn`)
      continue
    }
    const at = { top: 0, left: 0, right: stands.room.width, bottom: stands.room.height }
    for (const edge of edges) {
      const gap = Math.abs(box[edge] - at[edge])
      if (gap > 1) off.push(`${part}'s ${edge} is ${String(gap)}px from the screen's`)
    }
  }
  return off
}

/** Every part that moved between two looks, in words. */
function moved(was: Stands, now: Stands): string[] {
  const out: string[] = []
  for (const [part, box] of Object.entries(was.parts)) {
    const then = now.parts[part]
    if (box === null || then === null || then === undefined) continue
    if (Math.abs(box.top - then.top) > 1 || Math.abs(box.bottom - then.bottom) > 1) {
      out.push(`${part} moved ${String(then.top - box.top)}px`)
    }
  }
  if (now.scrolled.page !== 0) out.push(`the document scrolled ${String(now.scrolled.page)}px`)
  return out
}

/**
 * The frame at one width, for the device granted nothing.
 *
 * Every step ends with the same two questions — did any part of the frame
 * move, and did the document scroll — and each region's own step asks a third:
 * did it scroll, and did it scroll alone.
 */
export async function frameAt(
  page: Page,
  origin: string,
  width: { name: string; width: number },
  found: Found,
): Promise<void> {
  const where = `the frame @ ${width.name}`
  const { mouse, keyboard } = page
  if (mouse === undefined || keyboard === undefined) {
    found('frame', where, 'unrun', 'this page has no pointer or keyboard to scroll with')
    return
  }
  const look = async () => (await page.evaluate(STANDS)) as Stands
  const fixed = async (was: Stands, step: string) => {
    const now = await look()
    const wrong = moved(was, now)
    if (wrong.length > 0) throw new Error(`${step}: ${wrong.join('; ')}`)
    return now
  }
  /** A region scrolled by a wheel over it, and nothing else scrolled with it. */
  const alone = async (region: Region, selector: string, was: Stands) => {
    if ((await page.evaluate(lengthen(REGIONS[region]))) !== true) {
      throw new Error(`the ${region} did not get longer than its room`)
    }
    const at = (await page.evaluate(middleOf(selector))) as { x: number; y: number }
    await mouse.move(at.x, at.y)
    // Past the browser's latching of one wheel gesture to one scroller, so this
    // wheel is a new one over this region rather than the last region's.
    await page.waitForTimeout(LATCH_MS)
    // Far past its end: the end of a region is where a scroll used to carry on
    // into the document.
    await mouse.wheel(0, 20_000)
    await until(page, `document.querySelector(${JSON.stringify(REGIONS[region])}).scrollTop > 0`)
    await until(page, still(REGIONS[region]))
    const now = await fixed(was, `scrolling the ${region}`)
    const others = (Object.keys(REGIONS) as Region[]).filter(
      (one) => one !== region && now.scrolled[one] !== was.scrolled[one],
    )
    if (others.length > 0) throw new Error(`scrolling the ${region} scrolled ${others.join(', ')}`)
    return now
  }
  try {
    await page.goto(`${origin}/`, { waitUntil: READY })
    await page.waitForSelector('main .section', { timeout: 10_000 })
    const first = await look()
    const off = offEdges(first, width.width)
    if (off.length > 0) throw new Error(off.join('; '))
    if (first.over > 0)
      throw new Error(`the document is ${String(first.over)}px longer than the screen`)

    // **The document cannot be moved**: asked to scroll, and wheeled over the
    // header, which has no scroll of its own to take it.
    await page.evaluate(`(() => {
      document.scrollingElement.scrollTop = 100000
      scrollBy(0, 100000)
      return true
    })()`)
    let was = await fixed(first, 'asking the document to scroll')
    const head = (await page.evaluate(middleOf('header.top'))) as { x: number; y: number }
    await mouse.move(head.x, head.y)
    await page.waitForTimeout(LATCH_MS)
    await mouse.wheel(0, 5_000)
    await page.waitForTimeout(300)
    was = await fixed(was, 'a wheel over the header')

    // **Each region on its own.**
    was = await alone('screen', 'main', was)
    if (width.width >= 768) was = await alone('menu', 'nav.rail', was)
    if (width.width >= 1280) was = await alone('side', 'aside.side .side-projects', was)

    // **The keyboard scrolls the screen**, and only the screen: focus is where
    // a navigation leaves it (`boot.js`), so PageDown is somebody reading on.
    await page.evaluate(`(() => {
      const main = document.querySelector('main')
      main.scrollTop = 0
      main.focus({ preventScroll: true })
      return true
    })()`)
    was = await look()
    await keyboard.press('PageDown')
    await until(page, `document.querySelector('main').scrollTop > 0`)
    await until(page, still('main'))
    await fixed(was, 'PageDown on the screen')
  } catch (problem) {
    found('frame', where, 'fail', said(problem))
    await page.evaluate(UNDO).catch(() => undefined)
    return
  }
  await page.evaluate(UNDO)
  if (width.width >= 1280) {
    found(
      'frame',
      where,
      'pass',
      'the header, menu, side and Tade at the edges; the page never scrolls, each region alone',
    )
    return
  }
  await drawerAt(page, width, found)
}

/**
 * Below a desk the side is a drawer, and its list scrolls inside it without
 * taking the screen under it, or the frame, along.
 */
async function drawerAt(
  page: Page,
  width: { name: string; width: number },
  found: Found,
): Promise<void> {
  const where = `the frame @ ${width.name}`
  const { mouse, keyboard } = page
  if (mouse === undefined || keyboard === undefined) return
  try {
    const door = width.width < 768 ? 'nav.tabs button[aria-controls="side"]' : 'header .side-door'
    await page.evaluate(`document.querySelector('${door}').click()`)
    await until(page, `getComputedStyle(document.querySelector('aside.side')).display !== 'none'`)
    const was = (await page.evaluate(STANDS)) as Stands
    if ((await page.evaluate(lengthen(REGIONS.side))) !== true) {
      throw new Error('the drawer’s list did not get longer than its room')
    }
    const at = (await page.evaluate(middleOf(REGIONS.side))) as { x: number; y: number }
    await mouse.move(at.x, at.y)
    await page.waitForTimeout(LATCH_MS)
    await mouse.wheel(0, 20_000)
    await until(page, `document.querySelector(${JSON.stringify(REGIONS.side)}).scrollTop > 0`)
    await until(page, still(REGIONS.side))
    const now = (await page.evaluate(STANDS)) as Stands
    const wrong = moved(was, now)
    if (now.scrolled.screen !== was.scrolled.screen) wrong.push('the screen under it scrolled')
    if (wrong.length > 0) throw new Error(`scrolling the drawer: ${wrong.join('; ')}`)
    await keyboard.press('Escape')
    await until(page, `getComputedStyle(document.querySelector('aside.side')).display === 'none'`)
    found(
      'frame',
      where,
      'pass',
      'the frame at the edges; the page never scrolls; the screen and the drawer each alone',
    )
  } catch (problem) {
    found('frame', where, 'fail', said(problem))
    // Closed again, or every check after this one runs under an open drawer.
    await keyboard.press('Escape').catch(() => undefined)
  } finally {
    await page.evaluate(UNDO).catch(() => undefined)
  }
}
