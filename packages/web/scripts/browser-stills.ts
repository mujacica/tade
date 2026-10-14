import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Grant } from '../src/reach.ts'
import { projector } from '../src/reading.ts'
import { webServer } from '../src/server.ts'
import { OFF, type Scope } from '../src/surface.ts'
import { Tickets } from '../src/tickets.ts'
import { until } from './browser-until.ts'
import { type Still, stillsOf, type Visit, type WorldAt, worldAt } from './still.ts'
import { xhtmlOf } from './still-xhtml.ts'

// Whether the README's pictures of the away view are the page, asked of a
// browser.
//
//   pnpm screens --page [dir]
//
// The pictures are the page's own modules run in a stand-in document
// (`still.ts`), which is what lets `pictures.test.ts` hold them to their bytes
// on a machine with no browser. What that cannot prove is that the stand-in
// builds what a browser builds. So this serves the same world through the real
// server, pairs a device through the real page, has Chromium build every screen
// of every visit at the same size, clock, zone and language, writes each out
// with **the same serializer** (`xhtmlOf`, handed to the page as its source),
// and compares the two:
//
// - `same` — the picture's document is the one Chromium built.
// - `layout` — they differ only in geometry: an SVG's coordinates and sizes.
//   That is the stand-in having no layout (`still-dom.ts`), and it is said, with
//   where, rather than passed over.
// - `differs` — text, a class, an element: the picture shows a page Chromium
//   does not build, and that is the one that has to be fixed.
//
// With a `dir`, it photographs both — the page in Chromium and each frame of
// the picture as an `<img>`, which is how a README shows it — for a person to
// look at side by side, because whether a picture *looks* right is not a thing
// a comparison of markup can say.
//
// **It needs a browser and says `unrun` without one**, like the harness it
// sits beside (`browser.ts`): Playwright is not in the lockfile, on purpose.

export interface StillCheck {
  /** `<device> <path>`. */
  at: string
  verdict: 'same' | 'layout' | 'differs' | 'unrun'
  said: string
}

/** What of Playwright this drives, typed here so the file checks where it is not installed. */
interface Engine {
  newContext: (opts: object) => Promise<Context>
  close: () => Promise<void>
}

interface Context {
  newPage: () => Promise<Page>
  clock: { setFixedTime: (time: number) => Promise<void> }
  close: () => Promise<void>
}

interface Page {
  goto: (url: string, opts?: object) => Promise<unknown>
  fill: (selector: string, value: string) => Promise<void>
  click: (selector: string) => Promise<void>
  waitForURL: (url: string, opts?: object) => Promise<void>
  waitForSelector: (selector: string, opts?: object) => Promise<unknown>
  evaluate: (body: string) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
  screenshot: (opts: object) => Promise<unknown>
  setContent: (html: string) => Promise<void>
  setViewportSize: (size: { width: number; height: number }) => Promise<void>
}

const PLAYWRIGHT = 'playwright'

/** The attributes that are where a thing is drawn, which a document with no layout cannot know. */
const GEOMETRY = /\s(?:d|cx|cy|r|x|y|x1|x2|y1|y2|width|height|viewBox|points|transform)="[^"]*"/g

/** Where two documents part, with a little of each either side, or null where they do not. */
export function partedAt(picture: string, page: string): string | null {
  if (picture === page) return null
  let at = 0
  while (at < picture.length && picture[at] === page[at]) at++
  const from = Math.max(0, at - 80)
  return `picture: …${picture.slice(from, at + 80)}…\n  page:    …${page.slice(from, at + 80)}…`
}

/** One screen, judged: the picture's document against the one Chromium built. */
export function judged(at: string, picture: string, page: string): StillCheck {
  const parted = partedAt(picture, page)
  if (parted === null) return { at, verdict: 'same', said: 'the document Chromium built' }
  const shapes = partedAt(picture.replace(GEOMETRY, ''), page.replace(GEOMETRY, ''))
  if (shapes === null)
    return {
      at,
      verdict: 'layout',
      said: `the same document but for where things are drawn, which needs a layout:\n  ${parted}`,
    }
  return { at, verdict: 'differs', said: shapes }
}

/** Every screen of every visit, in a browser and as the picture has it. */
export async function stillsInBrowser(
  at: WorldAt,
  visits: readonly Visit[],
  opts: { dir?: string; picture?: string } = {},
): Promise<StillCheck[]> {
  const world = await worldAt(at)
  const stills = await stillsOf(at, visits)
  const names = visits.flatMap((visit) => visit.paths.map((path) => `${visit.device} ${path}`))
  let loaded: { chromium: { launch: (opts: object) => Promise<Engine> } }
  try {
    loaded = await import(PLAYWRIGHT)
  } catch {
    return names.map((at) => ({ at, verdict: 'unrun', said: 'playwright is not installed here' }))
  }
  let made: Engine
  try {
    made = await loaded.chromium.launch({ headless: true })
  } catch (problem) {
    const why = `a browser could not be started: ${String(problem)}`
    return names.map((at) => ({ at, verdict: 'unrun', said: why }))
  }
  const home = await mkdtemp(join(tmpdir(), 'tade-away-stills-'))
  const tickets = new Tickets()
  const server = webServer({
    home,
    surface: { ...OFF, enabled: true, port: 0 },
    readingFor: (reach) =>
      projector(world.input(reach), world.now, { agent: world.agent, settings: world.settings }),
    tickets,
    // The keypress at the machine, answered as the world's devices were let in:
    // what each may read, and what it may do.
    confirm: async (ask) => {
      const device = world.devices.find((one) => one.label === ask.label)
      return {
        let: true,
        projects: device?.projects ?? null,
        granted: [...(device?.granted ?? [])] as Grant[],
        scopes: [...(device?.scopes ?? [])] as Scope[],
      }
    },
  })
  const bound = await server.listen()
  const origin = `http://${bound.find((one) => one.startsWith('127.0.0.1')) ?? bound[0]}`
  if (opts.dir !== undefined) await mkdir(opts.dir, { recursive: true })
  const checks: StillCheck[] = []
  let n = 0
  try {
    for (const visit of visits) {
      const device = world.devices.find((one) => one.id === visit.device)
      if (device === undefined) throw new Error(`the world has no device ${visit.device}`)
      const coarse = visit.pointer === 'coarse'
      const context = await made.newContext({
        viewport: { width: visit.width, height: visit.height },
        deviceScaleFactor: 2,
        hasTouch: coarse,
        isMobile: coarse,
        timezoneId: 'UTC',
        locale: 'en-US',
      })
      try {
        await context.clock.setFixedTime(world.now)
        const page = await context.newPage()
        await page.goto(`${origin}/pair#t=${tickets.mint(`${origin}/pair`, Date.now()).value}`)
        await page.waitForSelector('#label', { timeout: 10_000 })
        await page.fill('#label', device.label)
        await page.click('button.pair-press')
        await page.waitForURL(`${origin}/`, { timeout: 15_000 })
        await page.evaluate(
          `localStorage.setItem('tade.docks.folded', ${JSON.stringify((visit.folded ?? []).join(','))})`,
        )
        for (const [at, path] of visit.paths.entries()) {
          if (at === 0) await page.goto(`${origin}${path}`)
          else
            await page.evaluate(
              `history.pushState(null, '', ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent('popstate'))`,
            )
          await until(page, "document.querySelector('.dot.is-live') !== null")
          const built = await settled(page)
          const still = stills[n] as Still
          const check = judged(`${visit.device} ${path}`, still.body, built)
          // Where the picture was told what a browser measures, what this one
          // does: the number to write down when the layout has moved.
          const asked = Object.keys(visit.measured ?? {})
          if (check.verdict !== 'same' && asked.length > 0) {
            const here = await page.evaluate(
              `${JSON.stringify(asked)}.map((one) => one + ' ' + (document.querySelector(one)?.clientWidth ?? 'absent'))`,
            )
            check.said += `\n  Chromium measures ${(here as string[]).join(', ')}`
          }
          checks.push(check)
          if (opts.dir !== undefined)
            // `caret: 'initial'`, because hiding the caret is Playwright writing
            // an inline style onto the box it is in — which the next screen's
            // document then carries as `style=""`, and reads as the page's.
            await page.screenshot({ path: join(opts.dir, `${n}-page.png`), caret: 'initial' })
          n += 1
        }
      } finally {
        await context.close()
      }
    }
    if (opts.dir !== undefined && opts.picture !== undefined)
      await photographed(made, opts.picture, opts.dir)
  } finally {
    await made.close()
    await server.close()
  }
  return checks
}

/** The page's document once two reads a beat apart agree, which is a page that has stopped moving. */
async function settled(page: Page): Promise<string> {
  const read = `[...document.body.childNodes].map((node) => (${xhtmlOf.toString()})(node, 'http://www.w3.org/1999/xhtml')).join('')`
  let last = String(await page.evaluate(read))
  for (let tries = 0; tries < 20; tries++) {
    await page.waitForTimeout(250)
    const now = String(await page.evaluate(read))
    if (now === last) return now
    last = now
  }
  return last
}

/** Each frame of the picture, alone, as an `<img>` — which is how a README draws it. */
async function photographed(made: Engine, picture: string, dir: string): Promise<void> {
  const frames = (picture.match(/<g id="f\d+"/g) ?? []).length
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(picture)
  const width = Math.ceil(Number(box?.[1] ?? 1280))
  const height = Math.ceil(Number(box?.[2] ?? 800))
  const context = await made.newContext({ viewport: { width, height }, deviceScaleFactor: 2 })
  try {
    const page = await context.newPage()
    for (let at = 0; at < frames; at++) {
      const one = picture.replace(
        '<style><![CDATA[',
        `<style><![CDATA[#f${at}{opacity:1!important;animation:none!important}.f:not(#f${at}){display:none}`,
      )
      const data = Buffer.from(one).toString('base64')
      await page.setContent(
        `<body style="margin:0"><img src="data:image/svg+xml;base64,${data}" width="${width}"></body>`,
      )
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(dir, `frame-${at}.png`) })
    }
    await writeFile(join(dir, 'picture.svg'), picture)
  } finally {
    await context.close()
  }
}
