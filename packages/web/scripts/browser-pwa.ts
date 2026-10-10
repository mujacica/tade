import type { Verdict } from '../test/browser-plan.ts'

// The three questions about an installed shell that only a browser can answer,
// and the several it cannot.
//
// **What is here.** That a real browser registers the worker and lets it take
// charge; that the page then cold-loads with the network off and says it
// cannot reach the machine rather than showing the browser's own error page;
// and that after all of it, nothing under `/api` is in any cache on the
// device. The last one is the claim this whole slice is most able to break
// quietly: a worker that cached one authenticated answer would pass every
// other check here and leave somebody's work on a phone.
//
// **What is not, and why.** An upgrade, a rollback and an uninstall all mean
// serving *different bytes at the same URL*, and a listener reads its files
// once when it comes up — so a harness would have to start a second server,
// which is a second origin and therefore a different registration. Those three
// are run properly in `test/worker.test.ts`, against the same served bytes in
// a scope made of the handful of things a worker touches. And a real iPhone's
// own install is nobody's but a person's: `MANUAL` in `test/browser-plan.ts`
// is the list, and a headless Chromium passing here is not evidence about it.
//
// The types below are structural and local, like the ones in `browser.ts`:
// Playwright is not in this repository's lockfile and must not be.

interface Page {
  goto: (url: string, opts?: object) => Promise<unknown>
  waitForSelector: (selector: string, opts?: object) => Promise<unknown>
  evaluate: (body: string) => Promise<unknown>
  title: () => Promise<string>
}

interface Context {
  newPage: () => Promise<Page>
  setOffline: (offline: boolean) => Promise<void>
}

export interface PwaRun {
  /**
   * A context whose device is **already paired**, handed over rather than made.
   *
   * Two reasons, and the first is not a convenience. Pairing is rate limited
   * per address — five tries in ten minutes, which is the guard doing its job
   * — and the harness already spends five of them. A sixth is refused, and the
   * pass that asked for it would have reported a failure of the away view
   * rather than of itself. The second is that the page registers nothing until
   * the machine has answered it, so there is nothing to ask of an unpaired
   * one anyway.
   *
   * It is the acting pass's own context: a phone's width, with touch, with
   * every grant — which is the device an install is actually for.
   */
  context: Context
  origin: string
  found: (check: string, where: string, verdict: Verdict, said: string) => void
}

/** What the page is asked, in the page, because that is where the answer is. */
const REGISTERED = `navigator.serviceWorker.getRegistration('/').then((reg) => ({
  has: reg !== undefined && reg !== null,
  active: reg?.active?.state ?? null,
  script: reg?.active?.scriptURL ?? null,
  controlled: navigator.serviceWorker.controller !== null,
  secure: self.isSecureContext,
}))`

const CACHED = `caches.keys().then((names) =>
  Promise.all(names.map((name) => caches.open(name).then((cache) => cache.keys()))).then(
    (lists) => ({ names, urls: lists.flat().map((asked) => asked.url) }),
  ),
)`

const MANIFEST = `fetch('/assets/tade.webmanifest').then((answer) =>
  answer.json().then((manifest) =>
    Promise.all(
      manifest.icons.map((icon) =>
        fetch(icon.src).then((got) => ({ src: icon.src, status: got.status, type: got.headers.get('content-type') })),
      ),
    ).then((icons) => ({ manifest, icons })),
  ),
)`

interface Registered {
  has: boolean
  active: string | null
  script: string | null
  controlled: boolean
  secure: boolean
}

interface Cached {
  names: string[]
  urls: string[]
}

/**
 * The install, the cold load with nothing answering, and what is on the disk.
 *
 * **Nothing here may throw out of this function.** Each of the three reports
 * its own finding either way, and this catches whatever is left — a harness
 * that died on its last pass would print no report at all, losing every row
 * the four passes before it had earned.
 */
export async function asPwa(run: PwaRun): Promise<void> {
  const page = await run.context.newPage()
  try {
    await installed(run, page)
    await coldOffline(run, page)
    await nothingOfTheWork(run, page)
  } catch (problem) {
    for (const check of ['install', 'offline-cold', 'no-api-cache']) {
      run.found(check, 'a phone', 'fail', said(problem))
    }
  }
}

/** It registers, it becomes active, and it takes charge of the page it is on. */
async function installed(run: PwaRun, page: Page): Promise<void> {
  try {
    await page.goto(`${run.origin}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('header .brand', { timeout: 10_000 })
    const reg = (await until(
      page,
      REGISTERED,
      (held: Registered) => held.active === 'activated',
    )) as Registered | null
    if (reg === null) throw new Error('no worker became active within the deadline')
    if (!reg.secure) throw new Error('this origin is not a secure context, so none of this can run')
    if (!reg.script?.endsWith('/sw.js')) {
      // The scope is the folder it was served from, so this is not pedantry:
      // a worker registered anywhere else could never answer for `/`.
      throw new Error(`the worker is ${reg.script ?? 'nowhere'} rather than /sw.js`)
    }
    if (!reg.controlled) {
      // `clients.claim()` on activate is what makes the **first** visit the
      // one that works offline. Without it a phone has to be opened twice.
      throw new Error('the worker activated but did not take charge of this page')
    }
    const got = (await page.evaluate(MANIFEST)) as {
      manifest: { start_url: string; scope: string; display: string }
      icons: { src: string; status: number; type: string | null }[]
    }
    if (got.manifest.scope !== '/' || got.manifest.start_url !== '/') {
      throw new Error(
        `the manifest's scope is ${got.manifest.scope} and start is ${got.manifest.start_url}`,
      )
    }
    const missing = got.icons.filter((icon) => icon.status !== 200)
    if (missing.length > 0)
      throw new Error(`icons that are not there: ${missing.map((one) => one.src).join(', ')}`)
    run.found(
      'install',
      'a phone',
      'pass',
      `${got.icons.length} icons, display ${got.manifest.display}, worker active and in charge`,
    )
  } catch (problem) {
    run.found('install', 'a phone', 'fail', said(problem))
  }
}

/**
 * The whole point: a tap on the home screen with nothing answering.
 *
 * A navigation to a screen's own deep path, with the network off — so this is
 * the cold load it claims to be: every byte of it has to come off the disk,
 * including the document, which the worker answers for any navigation. What it
 * must not be is the browser's own offline page, and what it must say is that
 * it cannot reach the machine.
 */
async function coldOffline(run: PwaRun, page: Page): Promise<void> {
  try {
    await run.context.setOffline(true)
    await page.goto(`${run.origin}/queue`, { waitUntil: 'commit' })
    await page.waitForSelector('header .brand', { timeout: 10_000 })
    const title = await page.title()
    if (!title.includes('Tade')) throw new Error(`the browser's own page, titled ${title}`)
    const words = String(await page.evaluate('document.body.innerText')).toLowerCase()
    // **Said, not left blank.** An offline page that drew the frame and
    // nothing else would be the §5.10 failure in its purest form: nothing is
    // running, said by a page that simply could not ask.
    if (
      !words.includes('cannot reach') &&
      !words.includes('not answering') &&
      !words.includes('pair')
    ) {
      throw new Error('the shell loaded and said nothing about not being able to ask')
    }
    run.found(
      'offline-cold',
      'a deep link',
      'pass',
      'the shell loaded with the network off, and said so',
    )
  } catch (problem) {
    run.found('offline-cold', 'a deep link', 'fail', said(problem))
  } finally {
    await run.context.setOffline(false)
  }
}

/**
 * Nothing authenticated on the disk, asked of the disk.
 *
 * The page is walked around first so that every read it makes has been made —
 * a snapshot, the notes, the device list, the stream. Then every cache on the
 * origin is enumerated, by name and by entry, and the two things that must be
 * true of all of them: ours are named under one prefix, and not one of them
 * holds an answer from `/api`.
 */
async function nothingOfTheWork(run: PwaRun, page: Page): Promise<void> {
  try {
    for (const path of ['/', '/queue', '/notes', '/devices', '/spend']) {
      await page.goto(`${run.origin}${path}`, { waitUntil: 'networkidle' })
    }
    const held = (await page.evaluate(CACHED)) as Cached
    const strangers = held.names.filter((name) => !name.startsWith('tade-'))
    if (strangers.length > 0) throw new Error(`caches that are not ours: ${strangers.join(', ')}`)
    const leaked = held.urls.filter((url) => new URL(url).pathname.startsWith('/api'))
    if (leaked.length > 0) throw new Error(`answers from /api on the disk: ${leaked.join(', ')}`)
    run.found(
      'no-api-cache',
      'the disk',
      'pass',
      `${held.urls.length} files in ${held.names.length} cache(s), none of them an answer`,
    )
  } catch (problem) {
    run.found('no-api-cache', 'the disk', 'fail', said(problem))
  }
}

/**
 * Poll in this program rather than in the page.
 *
 * `waitForFunction` compiles a string **in the page**, and the content policy
 * has no `unsafe-eval` — which is the policy working, so the waiting is a loop
 * here. `evaluate` goes through the debugger protocol and needs none.
 */
async function until(
  page: Page,
  body: string,
  good: (held: never) => boolean,
  tries = 40,
): Promise<unknown> {
  for (let n = 0; n < tries; n += 1) {
    const held = await page.evaluate(body)
    if (good(held as never)) return held
    await new Promise((done) => setTimeout(done, 250))
  }
  return null
}

function said(problem: unknown): string {
  return problem instanceof Error ? problem.message : String(problem)
}
