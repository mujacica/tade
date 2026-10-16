import { type Device, listing } from '../src/devices.ts'
import { keepingOf } from '../src/installable.ts'
import { projector } from '../src/reading.ts'
import { reachOf } from '../src/surface.ts'
import { type Still, type Visit, type World, worldAt } from './still.ts'
import { Listening, StillDocument, StillElement, StillEvent, SVG } from './still-dom.ts'
import { xhtmlOf } from './still-xhtml.ts'

// One visit to the away view's page, in a process of its own (`still.ts` starts
// it): the page's own `boot.js` booted in `still-dom.ts`'s document, answered
// the way the server answers it, taken to each screen the visit names — and
// what it built, written to stdout as JSON.
//
//   node packages/web/scripts/still-visit.ts <world module URL> <export> '<visit JSON>'
//
// Started with `TZ=UTC`, so a time the page spells is the same everywhere.

const BOOT = new URL('../src/assets/boot.js', import.meta.url)

async function visited(world: World, visit: Visit): Promise<Still[]> {
  const device = world.devices.find((one) => one.id === visit.device)
  if (device === undefined) throw new Error(`the world has no device ${visit.device}`)
  const reading = projector(world.input(reachOf(device)), world.now, {
    agent: world.agent,
    settings: world.settings,
  })
  const page = staged(world, device, visit, reading)
  const doc = page.doc
  page.go(visit.paths[0] ?? '/')
  await import(BOOT.href)
  await page.settle()
  page.connect()
  await page.settle()
  const shot: Still[] = []
  for (const [at, path] of visit.paths.entries()) {
    if (at > 0) {
      page.go(path)
      page.window.dispatchEvent(new StillEvent('popstate'))
      await page.settle()
    }
    drewItself(doc, path)
    shot.push({
      path,
      width: visit.width,
      height: visit.height,
      pointer: visit.pointer,
      rootClass: doc.documentElement.className,
      bodyClass: doc.body.className,
      body: doc.body.childNodes
        .map((node) => xhtmlOf(node, 'http://www.w3.org/1999/xhtml'))
        .join(''),
      title: doc.title,
    })
  }
  return shot
}

/**
 * That what is about to be a picture is the control room, live, on the screen
 * asked for — and a throw naming what it is instead.
 *
 * The page draws something for every failure, which is right for a person and
 * wrong for a picture: a boot that threw is a page saying *Tade isn't
 * answering*, a refused session is the pairing screen, a refused snapshot is a
 * bar over a page that never went live, and a path the router does not know is
 * *Nothing here*. Each is a real screen, and a picture of one is a README
 * showing a broken page with every test passing.
 */
function drewItself(doc: StillDocument, path: string): void {
  const said = doc.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 160)
  if (doc.querySelector('header.top') === null || doc.querySelector('.frame') === null)
    throw new Error(`the page did not start at ${path}; it says: ${said}`)
  if (/\b(Nothing here|Pair this device)\b/.test(doc.title))
    throw new Error(`the page drew "${doc.title}" at ${path}`)
  if (doc.querySelector('.dot.is-live') === null)
    throw new Error(`the page at ${path} never went live; it says: ${said}`)
}

/** A Response, as far as `boot.js`'s `ask` reads one. */
const answered = (status: number, body: unknown) =>
  Promise.resolve({ status, json: () => Promise.resolve(body) })

/**
 * The globals the page reaches for, put in place for good: this process is the
 * page's, and ends with it.
 */
function staged(world: World, device: Device, visit: Visit, reading: ReturnType<typeof projector>) {
  const doc = new StillDocument()
  doc.measured = visit.measured ?? {}
  const sprite = doc.createElementNS(SVG, 'svg')
  sprite.setAttribute('class', 'sprite')
  doc.body.append(sprite)
  const win = new Listening()
  const streams: (Listening & { readyState: number; close: () => void })[] = []
  const at = { pathname: '/', hash: '', search: '' }
  const store = new Map<string, string>()
  if (visit.folded !== undefined && visit.folded.length > 0)
    store.set('tade.docks.folded', visit.folded.join(','))

  /** What the server answers each `GET` the page makes, out of the same functions. */
  const fetched = (path: string, init: { method?: string } = {}) => {
    const url = new URL(path, 'http://still.invalid')
    if ((init.method ?? 'GET') !== 'GET') return answered(404, null)
    if (url.pathname === '/api/devices')
      return answered(
        200,
        listing(device, world.devices, keepingOf({ installing: false, keepsView: false }), {
          // Loopback, so acting asks for no passkey and the page draws no bar.
          asks: false,
          made: false,
          proven: false,
          until: null,
          makeBy: null,
          hours: 12,
        }),
      )
    if (url.pathname === '/api/snapshot') return answered(200, reading.snapshot())
    if (url.pathname === '/api/settings') return answered(200, reading.settings())
    if (url.pathname === '/api/notes')
      return answered(
        200,
        reading.notes(url.searchParams.get('scope') ?? undefined, url.searchParams.get('after')),
      )
    const agent = /^\/api\/agent\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    if (agent !== null)
      return answered(
        200,
        reading.agent(
          `${decodeURIComponent(agent[1] ?? '')}/${decodeURIComponent(agent[2] ?? '')}`,
        ),
      )
    return answered(404, null)
  }

  class Stream extends Listening {
    readyState = 0
    constructor() {
      super()
      streams.push(this)
    }
    close() {
      this.readyState = 2
    }
  }

  const matches = (query: string) => {
    const wide = /\(min-width:\s*(\d+)px\)/.exec(query)
    const narrow = /\(max-width:\s*(\d+)px\)/.exec(query)
    const pointer = /\(pointer:\s*(\w+)\)/.exec(query)
    if (wide !== null && visit.width < Number(wide[1])) return false
    if (narrow !== null && visit.width > Number(narrow[1])) return false
    if (pointer !== null && pointer[1] !== visit.pointer) return false
    return true
  }

  const history = {
    state: null as unknown,
    pushState(_: unknown, __: string, path: string) {
      at.pathname = path
    },
    replaceState(state: unknown, _: string, path?: string) {
      history.state = state
      if (path !== undefined) at.pathname = path
    },
    back() {},
  }
  const nothing = () => 0
  const replaced: Record<string, unknown> = {
    document: doc,
    window: globalThis,
    self: globalThis,
    location: {
      get pathname() {
        return at.pathname
      },
      get hash() {
        return at.hash
      },
      get search() {
        return at.search
      },
      origin: 'http://still.invalid',
      reload() {},
      replace() {},
    },
    history,
    navigator: { userAgent: 'still', language: 'en-US', languages: ['en-US'] },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
    },
    matchMedia: (query: string) => ({
      matches: matches(query),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
    requestAnimationFrame: nothing,
    cancelAnimationFrame: nothing,
    setTimeout: nothing,
    clearTimeout: nothing,
    setInterval: nothing,
    clearInterval: nothing,
    fetch: fetched,
    EventSource: Stream,
    addEventListener: win.addEventListener.bind(win),
    removeEventListener: win.removeEventListener.bind(win),
    Element: StillElement,
    HTMLElement: StillElement,
  }

  for (const [name, value] of Object.entries(replaced))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  Date.now = () => world.now
  // The zone is the process's (`TZ`, set by whoever started it); the language
  // is pinned here, because a default locale is read from the machine.
  const spelt = {
    date: Date.prototype.toLocaleDateString,
    time: Date.prototype.toLocaleTimeString,
    both: Date.prototype.toLocaleString,
  }
  const pinned = (
    spell: (this: Date, locale?: string, opts?: Intl.DateTimeFormatOptions) => string,
  ) =>
    function (this: Date, _locale?: string, opts: Intl.DateTimeFormatOptions = {}) {
      return spell.call(this, 'en-US', { ...opts, timeZone: 'UTC' })
    }
  Date.prototype.toLocaleDateString = pinned(spelt.date)
  Date.prototype.toLocaleTimeString = pinned(spelt.time)
  Date.prototype.toLocaleString = pinned(spelt.both)

  return {
    doc,
    window: win,
    go(path: string) {
      at.pathname = path
    },
    /** The stream opens and its first frame is the snapshot, as the server sends it. */
    connect() {
      const stream = streams[streams.length - 1]
      if (stream === undefined) throw new Error('the page opened no stream')
      stream.readyState = 1
      stream.dispatchEvent(new StillEvent('open'))
      stream.dispatchEvent(new StillEvent('snapshot', JSON.stringify(reading.snapshot())))
    },
    /** Every answer the page is waiting on, delivered, and every paint after it. */
    async settle() {
      for (let n = 0; n < 8; n++) await new Promise((done) => setImmediate(done))
    },
  }
}

const [module = '', name = '', asked = '{}'] = process.argv.slice(2)
const drawn = await visited(await worldAt({ module, name }), JSON.parse(asked) as Visit)
// Written and left to finish: an exit here could cut a pipe's write short.
process.stdout.write(JSON.stringify(drawn))
