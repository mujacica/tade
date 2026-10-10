import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { assetsDir, etagOf, readAssets, WORKER_FILE } from '../src/assets.ts'
import { cacheName, type Shell, shellOf, VIEW_CACHE, workerBytes } from '../src/installable.ts'

// The service worker, **run**.
//
// A worker is the one part of the away view that keeps working after the
// machine it came from is asleep, and the things that go wrong with one all go
// wrong quietly: a cache that was not dropped on an upgrade, an answer served
// out of a disk to a request that should have gone to the network, a version
// that went backwards, an uninstall that did not. None of those fails a test
// that reads the source.
//
// So this runs the **served bytes** — the prelude and the file, which is what
// `/sw.js` actually answers with — in a scope made of the handful of things a
// worker touches: `caches`, `clients`, `registration`, and a listener table.
// Everything below is then the real control flow, with an upgrade, a rollback
// and an uninstall driven by building a second scope the way a browser builds
// a second worker.
//
// What it cannot ask is whether a browser does any of this the way the spec
// says. That is the browser harness's (`scripts/browser-pwa.ts`), and an
// iPhone's own install is a person's — `MANUAL` in `test/browser-plan.ts` says
// which steps nothing here can take.

const SOURCE = readFileSync(join(assetsDir(), WORKER_FILE), 'utf8')

/**
 * The source with everything inside backticks taken out.
 *
 * **Reached, not mentioned** — the rule `test/separation.test.ts` already
 * holds this package to. The worker names what it must never do in the comment
 * that says it does not do it, and a test that fails on its own explanation is
 * one somebody deletes.
 */
const CODE = SOURCE.replaceAll(/`[^`]*`/g, '``')

/** A cache, as much of one as a worker uses. */
class FakeCache {
  readonly held = new Map<string, string>()
  // A field and an assignment rather than a parameter property: Node runs this
  // repository's `.ts` by stripping types, so a constructor parameter property
  // is syntax that would have to be compiled.
  readonly served: ReadonlyMap<string, string>
  constructor(served: ReadonlyMap<string, string>) {
    this.served = served
  }

  /** Atomic, like the real one: one file missing and nothing is cached. */
  async addAll(urls: string[]): Promise<void> {
    const got = urls.map((url) => {
      const body = this.served.get(url)
      if (body === undefined) throw new Error(`no ${url}`)
      return [url, body] as const
    })
    for (const [url, body] of got) this.held.set(url, body)
  }

  async match(url: string): Promise<{ body: string } | undefined> {
    const body = this.held.get(url)
    return body === undefined ? undefined : { body }
  }

  async put(url: string, value: { body: string }): Promise<void> {
    this.held.set(url, value.body)
  }
}

class FakeCaches {
  readonly all = new Map<string, FakeCache>()
  readonly served: ReadonlyMap<string, string>
  constructor(served: ReadonlyMap<string, string>) {
    this.served = served
  }
  async open(name: string): Promise<FakeCache> {
    const found = this.all.get(name) ?? new FakeCache(this.served)
    this.all.set(name, found)
    return found
  }
  async keys(): Promise<string[]> {
    return [...this.all.keys()]
  }
  async delete(name: string): Promise<boolean> {
    return this.all.delete(name)
  }
}

interface Scope {
  // biome-ignore lint/suspicious/noExplicitAny: a worker's own global, as it is
  [key: string]: any
}

/** One worker, running, over a set of caches that outlive it. */
function run(shell: Shell, caches: FakeCaches) {
  const listeners = new Map<string, ((event: Scope) => void)[]>()
  const said: string[] = []
  const shown: { title: string; opts: Scope }[] = []
  const opened: string[] = []
  const focused: string[] = []
  const state = { claimed: 0, skipped: 0, unregistered: false }
  const pages: { url: string; focus?: () => void }[] = [
    {
      url: 'https://machine.example/queue',
      focus: () => {
        focused.push('https://machine.example/queue')
      },
    },
  ]
  const scope: Scope = {
    location: { origin: 'https://machine.example' },
    caches,
    clients: {
      claim: async () => {
        state.claimed += 1
      },
      matchAll: async (opts: { type?: string } = {}) =>
        opts.type === 'window'
          ? pages
          : [{ postMessage: (what: { tade: string }) => said.push(what.tade) }],
      openWindow: async (url: string) => {
        opened.push(url)
        return null
      },
    },
    registration: {
      unregister: async () => {
        state.unregistered = true
      },
      showNotification: async (title: string, opts: Scope) => {
        shown.push({ title, opts })
      },
    },
    skipWaiting: () => {
      state.skipped += 1
    },
    addEventListener: (name: string, fn: (event: Scope) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn])
    },
  }
  const context = createContext({
    self: scope,
    URL,
    Promise,
    // The network, as a worker reaches it: the same bodies the caches are
    // filled from, so a fall-through is distinguishable from a cache hit only
    // by what the fake is asked for.
    fetch: async (asked: { url: string }) => ({ body: `network:${asked.url}` }),
  })
  runInContext(workerBytes(Buffer.from(SOURCE, 'utf8'), shell).toString('utf8'), context)

  const fire = async (name: string, event: Scope): Promise<void> => {
    const waits: Promise<unknown>[] = []
    for (const fn of listeners.get(name) ?? [])
      fn({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
  }
  return {
    said,
    state,
    shown,
    opened,
    focused,
    pages,
    install: () => fire('install', {}),
    activate: () => fire('activate', {}),
    message: (data: unknown) => fire('message', { data }),
    /** A notification arrived. `data` is the payload, as a browser hands it. */
    push: (payload: unknown, over: { broken?: boolean; none?: boolean } = {}) =>
      fire('push', {
        data: over.none
          ? null
          : {
              json: () => {
                if (over.broken === true) throw new Error('not json')
                return payload
              },
            },
      }),
    /** Somebody tapped one. */
    tapped: () => {
      const closed: number[] = []
      return fire('notificationclick', {
        notification: {
          close: () => closed.push(1),
        },
      }).then(() => closed.length)
    },
    /** A request, and what the worker answered — or `null` for *not ours*. */
    async ask(
      url: string,
      opts: { method?: string; mode?: string } = {},
    ): Promise<{ body: string } | null> {
      let answered: Promise<{ body: string }> | null = null
      const request = { url, method: opts.method ?? 'GET', mode: opts.mode ?? 'no-cors' }
      for (const fn of listeners.get('fetch') ?? []) {
        fn({
          request,
          respondWith: (p: Promise<{ body: string }>) => {
            answered = p
          },
        })
      }
      return answered === null ? null : await answered
    },
  }
}

/** The files a machine serves, keyed by the path the page asks for them at. */
function machineServing(bodies: Record<string, string>): {
  shell: Shell
  caches: FakeCaches
} {
  const assets = new Map(
    Object.entries(bodies).map(([name, body]) => {
      const bytes = Buffer.from(body, 'utf8')
      return [name, { path: name, bytes, type: 'text/plain', etag: etagOf(bytes) }]
    }),
  )
  const served = new Map<string, string>([['/', bodies['index.html'] ?? '']])
  for (const [name, body] of Object.entries(bodies)) {
    if (name !== 'index.html') served.set(`/assets/${name}`, body)
  }
  return { shell: shellOf(assets, { serving: true }), caches: new FakeCaches(served) }
}

const FIRST = { 'index.html': '<html>one', 'away.css': 'body{}', 'boot.js': 'one()' }
const SECOND = { 'index.html': '<html>two', 'away.css': 'body{}', 'boot.js': 'two()' }

describe('what it caches, and what it will not', () => {
  it('precaches the shell under a name made of its own version', async () => {
    const { shell, caches } = machineServing(FIRST)
    const worker = run(shell, caches)
    await worker.install()
    const cache = caches.all.get(cacheName(shell.version))
    expect(cache).toBeDefined()
    expect([...(cache?.held.keys() ?? [])].sort()).toEqual([
      '/',
      '/assets/away.css',
      '/assets/boot.js',
    ])
  })

  it('caches nothing at all if one file of the shell cannot be fetched', async () => {
    // `addAll` is atomic, and this is why it is used rather than a loop: a
    // half-filled cache is a page that loads offline and has no stylesheet,
    // which looks like a design somebody shipped rather than a failed install.
    const { shell, caches } = machineServing(FIRST)
    const missing = new FakeCaches(
      new Map([...caches.served].filter(([at]) => at !== '/assets/boot.js')),
    )
    const worker = run(shell, missing)
    await expect(worker.install()).rejects.toThrow()
    expect(missing.all.get(cacheName(shell.version))?.held.size).toBe(0)
  })

  it('answers a precached file out of the cache', async () => {
    const { shell, caches } = machineServing(FIRST)
    const worker = run(shell, caches)
    await worker.install()
    expect(await worker.ask('https://machine.example/assets/away.css')).toEqual({ body: 'body{}' })
  })

  it('answers any navigation with the shell, whatever path it was for', async () => {
    // The machine serves the same bytes at every screen's path too, so this is
    // not the worker inventing a rule — and a path that is not a screen gets
    // the shell and the page's own *nothing here*, which beats the browser's
    // offline page for a typo.
    const { shell, caches } = machineServing(FIRST)
    const worker = run(shell, caches)
    await worker.install()
    for (const path of ['/t/tade/away', '/queue', '/not-a-screen']) {
      expect(await worker.ask(`https://machine.example${path}`, { mode: 'navigate' })).toEqual({
        body: '<html>one',
      })
    }
  })

  it('does not touch an API request, a mutation or another origin', async () => {
    // **The whole of the no-leaked-cache claim, as behaviour.** None of these
    // is refused or passed through by this worker — `respondWith` is never
    // called, so the request is made as though no worker existed, and the
    // machine's own `no-store` is the only thing deciding.
    const { shell, caches } = machineServing(FIRST)
    const worker = run(shell, caches)
    await worker.install()
    expect(await worker.ask('https://machine.example/api/snapshot')).toBeNull()
    expect(await worker.ask('https://machine.example/api/stream')).toBeNull()
    expect(await worker.ask('https://machine.example/api/devices')).toBeNull()
    expect(await worker.ask('https://machine.example/api/act/park', { method: 'POST' })).toBeNull()
    expect(await worker.ask('https://elsewhere.example/assets/boot.js')).toBeNull()
    expect(
      await worker.ask('https://machine.example/assets/away.css', { method: 'POST' }),
    ).toBeNull()
    // And nothing anywhere put one in a cache.
    for (const cache of caches.all.values()) {
      for (const at of cache.held.keys()) expect(at.startsWith('/api')).toBe(false)
    }
  })

  it('falls back to the network for a file the browser evicted', async () => {
    const { shell, caches } = machineServing(FIRST)
    const worker = run(shell, caches)
    await worker.install()
    caches.all.get(cacheName(shell.version))?.held.delete('/assets/away.css')
    expect(await worker.ask('https://machine.example/assets/away.css')).toEqual({
      body: 'network:https://machine.example/assets/away.css',
    })
    // A miss is never refilled behind somebody's back: the only thing allowed
    // to decide what is cached is an install with a version on it.
    expect(caches.all.get(cacheName(shell.version))?.held.has('/assets/away.css')).toBe(false)
  })
})

describe('upgrading, rolling back, and being turned off', () => {
  it('takes over on activate and drops every older shell, keeping the last view', async () => {
    const one = machineServing(FIRST)
    const first = run(one.shell, one.caches)
    await first.install()
    await first.activate()
    // Something this device keeps of its own, which an upgrade may not eat.
    ;(await one.caches.open(VIEW_CACHE)).held.set('/last-view', '{"savedAt":1}')

    const two = machineServing(SECOND)
    expect(two.shell.version).not.toBe(one.shell.version)
    const second = run(two.shell, one.caches)
    await second.install()
    // Installed and waiting: the old shell is still the one being served, and
    // nothing has been dropped. This is the state the page puts a bar up for.
    expect(one.caches.all.has(cacheName(one.shell.version))).toBe(true)
    expect(second.state.claimed).toBe(0)

    await second.activate()
    expect(one.caches.all.has(cacheName(one.shell.version))).toBe(false)
    expect(one.caches.all.has(cacheName(two.shell.version))).toBe(true)
    expect(one.caches.all.get(VIEW_CACHE)?.held.get('/last-view')).toBe('{"savedAt":1}')
    expect(second.state.claimed).toBe(1)
  })

  it('never stops waiting on its own, and does when the page says to', async () => {
    // The page's own rule, from the other side: a reload nobody asked for is
    // somebody's half-typed note gone, so the worker waits until it is told.
    const { shell, caches } = machineServing(SECOND)
    const worker = run(shell, caches)
    await worker.install()
    expect(worker.state.skipped).toBe(0)
    await worker.activate()
    expect(worker.state.skipped).toBe(0)
    await worker.message({ tade: 'nothing-like-this' })
    await worker.message('not an object')
    await worker.message(null)
    expect(worker.state.skipped).toBe(0)
    await worker.message({ tade: 'update' })
    expect(worker.state.skipped).toBe(1)
  })

  it('goes back to an older shell as readily as forward to a newer one', async () => {
    // A rollback is somebody installing the Tade they had last week. There is
    // no version arithmetic anywhere — the name is a hash of the bytes, not a
    // number — so going back is the same two steps as going forward, and the
    // test is here because the tempting alternative (a counter) is one that
    // would refuse this and fail nowhere.
    const one = machineServing(FIRST)
    const two = machineServing(SECOND)
    const forward = run(two.shell, one.caches)
    await forward.install()
    await forward.activate()

    const back = run(one.shell, one.caches)
    await back.install()
    await back.activate()
    expect([...one.caches.all.keys()]).toEqual([cacheName(one.shell.version)])
    expect(await back.ask('https://machine.example/', { mode: 'navigate' })).toEqual({
      body: '<html>one',
    })
  })

  it('does not wait when it is the one that removes things', async () => {
    // **Not an exception to the rule above.** Waiting exists so a shell is not
    // swapped under a loaded page; this worker serves nothing and claims
    // nothing, so there is no swap. Made to wait, it would sit behind a *new
    // version is ready* button for as long as a tab stayed open — the wrong
    // sentence about the wrong thing — and the removal would never happen.
    const { caches } = machineServing(FIRST)
    const ending = run(shellOf(new Map(), { serving: false }), caches)
    await ending.install()
    expect(ending.state.skipped).toBe(1)
    expect(caches.all.size).toBe(0)
  })

  it('removes itself, everything it kept and the last view when it is told to', async () => {
    const one = machineServing(FIRST)
    const worker = run(one.shell, one.caches)
    await worker.install()
    await worker.activate()
    ;(await one.caches.open(VIEW_CACHE)).held.set('/last-view', '{"savedAt":1}')

    // What the machine serves when installing is turned off: the same URL, a
    // different prelude, and bytes a browser sees as an update. A `404` would
    // leave the worker above exactly where it is.
    const off = shellOf(new Map(), { serving: false })
    const ending = run(off, one.caches)
    await ending.install()
    await ending.activate()
    expect([...one.caches.all.keys()]).toEqual([])
    expect(ending.state.unregistered).toBe(true)
    expect(ending.said).toEqual(['gone'])
    // And it answers nothing while it is on its way out.
    expect(await ending.ask('https://machine.example/', { mode: 'navigate' })).toBeNull()
  })

  it('is the same bytes every time it is off, so a removed shell is removed once', async () => {
    // If the uninstalling worker carried a changing version, every load would
    // be an update, an install and an unregister — for ever, on a machine that
    // simply does not offer this. A constant is what makes *off* settle.
    const first = shellOf(new Map(), { serving: false })
    const second = shellOf(
      new Map([['x', { path: 'x', bytes: Buffer.from('x'), type: 't', etag: '"x"' }]]),
      {
        serving: false,
      },
    )
    expect(workerBytes(Buffer.from(SOURCE), first)).toEqual(
      workerBytes(Buffer.from(SOURCE), second),
    )
  })

  it('does nothing at all without its prelude, rather than removing anything', async () => {
    // Unreachable through `/sw.js`, which always writes one — so this is a bug
    // in the server rather than a decision, and the safe answer to a bug is
    // the quietest one. Treating it as *off* would make a mistake here
    // uninstall every phone, which is the one thing this machine could not
    // undo.
    const { caches } = machineServing(FIRST)
    const listeners = new Map<string, ((event: Scope) => void)[]>()
    const scope: Scope = {
      location: { origin: 'https://machine.example' },
      caches,
      clients: { claim: async () => {}, matchAll: async () => [] },
      registration: {
        unregister: async () => {
          throw new Error('a worker with no prelude unregistered itself')
        },
      },
      skipWaiting: () => {},
      addEventListener: (name: string, fn: (event: Scope) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), fn])
      },
    }
    runInContext(SOURCE, createContext({ self: scope, URL, Promise, fetch: async () => ({}) }))
    const waits: Promise<unknown>[] = []
    for (const fn of listeners.get('activate') ?? [])
      fn({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
    expect(caches.all.size).toBe(0)
  })
})

describe('what the source may never contain', () => {
  it('writes to a cache in one place, which is the precache', () => {
    // Read as text as well as run, because the thing this is against is a
    // *future* line rather than a behaviour: one `cache.put` in the fetch
    // handler and an authenticated answer is on a disk. `addAll` with a list
    // the worker was born holding is the only write there is.
    expect(CODE).not.toContain('.put(')
    expect(CODE.match(/addAll\(/g)?.length).toBe(1)
  })

  it('names no route of the machine’s at all', () => {
    // It cannot answer for one either — the list it holds is files out of a
    // folder — but a worker that so much as mentioned `/api` would be one
    // somebody could believe had an opinion about it.
    expect(CODE).not.toContain('/api')
  })

  it('skips waiting in exactly two places, and neither serves anything', () => {
    // Read as text as well as run, because a third one is the line that would
    // make a shell swap itself under whatever somebody is typing — and the two
    // that are here are the message handler (a person pressed the button) and
    // the uninstalling worker's install (there is nothing to swap).
    expect(CODE.match(/skipWaiting/g)?.length).toBe(2)
  })
})

describe('a notification, arriving', () => {
  it('draws exactly what was sent, with nothing fetched and nothing cached', async () => {
    // **The rule this is for**: a worker that asked the machine *what was that
    // about* would be a request made with the page's credentials by something
    // nobody is looking at, on a schedule a push service decides.
    const { shell, caches } = machineServing(FIRST)
    const worker = run(shell, caches)
    await worker.install()
    await worker.activate()
    const before = caches.all.get(cacheName(shell.version))?.held.size
    await worker.push({ title: 'Tade', body: '2 want your answer', tag: 'tade' })
    expect(worker.shown).toHaveLength(1)
    expect(worker.shown[0]?.title).toBe('Tade')
    expect(worker.shown[0]?.opts.body).toBe('2 want your answer')
    // One tag for everything, so a phone that was off for an hour holds one
    // notification rather than a column of them.
    expect(worker.shown[0]?.opts.tag).toBe('tade')
    expect(worker.shown[0]?.opts.requireInteraction).toBe(false)
    // **The icon is a file the real shell precaches**, so an offline phone
    // draws one rather than a notification with a hole in it — asserted
    // against the folder rather than against this test's three-file fixture,
    // because the folder is what a phone downloads.
    const real = shellOf(await readAssets(), { serving: true })
    expect(real.files).toContain(worker.shown[0]?.opts.icon)
    expect(real.files).toContain(worker.shown[0]?.opts.badge)
    expect(caches.all.get(cacheName(shell.version))?.held.size).toBe(before)
  })

  it('always shows one, even where the payload says nothing it can use', async () => {
    // `userVisibleOnly` is what every subscription is made with, and a browser
    // handed a push that showed nothing draws **its own** *this site has been
    // updated in the background* instead — somebody else's sentence on a lock
    // screen — and then revokes the subscription after a few.
    const { shell, caches } = machineServing(FIRST)
    for (const how of [{ none: true }, { broken: true }] as const) {
      const worker = run(shell, caches)
      await worker.push(null, how)
      expect(worker.shown, JSON.stringify(how)).toHaveLength(1)
      expect(worker.shown[0]?.title).toBe('Tade')
      expect(worker.shown[0]?.opts.body.length).toBeGreaterThan(0)
    }
  })

  it('bounds every field and falls back to Tade’s own words', async () => {
    const { shell, caches } = machineServing(FIRST)
    const worker = run(shell, caches)
    await worker.push({ title: 'x'.repeat(500), body: 'y'.repeat(500), tag: 'z'.repeat(500) })
    expect(worker.shown[0]?.title.length).toBeLessThanOrEqual(60)
    expect(worker.shown[0]?.opts.body.length).toBeLessThanOrEqual(160)
    expect(worker.shown[0]?.opts.tag.length).toBeLessThanOrEqual(40)
    // And a field of the wrong shape is Tade's own word rather than `[object
    // Object]` on somebody's lock screen.
    const second = run(shell, caches)
    await second.push({ title: 42, body: { a: 1 }, tag: [] })
    expect(second.shown[0]?.title).toBe('Tade')
    expect(second.shown[0]?.opts.body).toBe('Something wants you')
  })

  it('focuses a page that is already open rather than opening another', async () => {
    const { shell, caches } = machineServing(FIRST)
    const worker = run(shell, caches)
    expect(await worker.tapped()).toBe(1)
    expect(worker.focused).toEqual(['https://machine.example/queue'])
    expect(worker.opened).toEqual([])
  })

  it('opens the root, and never a path out of the payload', async () => {
    // **No path out of the payload**, which is the half worth the words: a
    // notification that carried a url would be a project and a task in
    // something a push service keeps and a lock screen draws.
    const { shell, caches } = machineServing(FIRST)
    const worker = run(shell, caches)
    worker.pages.length = 0
    await worker.tapped()
    expect(worker.opened).toEqual(['/'])
  })

  it('ignores a window of somebody else’s origin', async () => {
    const { shell, caches } = machineServing(FIRST)
    const worker = run(shell, caches)
    worker.pages.length = 0
    worker.pages.push({ url: 'https://evil.example/', focus: () => worker.focused.push('evil') })
    await worker.tapped()
    expect(worker.focused).toEqual([])
    expect(worker.opened).toEqual(['/'])
  })

  it('reaches no network and no route in the push handler, as text', () => {
    // Read as text as well as run, because the thing this is against is a
    // *future* line: one `fetch` in here and a notification is a request made
    // by something nobody is looking at.
    const push = /addEventListener\('push'[\s\S]*?^}\)/m.exec(CODE)?.[0] ?? ''
    expect(push, 'the push handler').not.toBe('')
    expect(push).not.toContain('fetch')
    expect(push).not.toContain('caches')
  })
})
