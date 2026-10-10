// The service worker: the static shell, kept so the page opens with no machine
// to ask, and nothing else at all.
//
// **This file is never served as it is.** `/sw.js` answers with a line of JSON
// in front of it — `self.SHELL`, made by `installable.ts` out of the files that
// are actually in the folder and their etags. So the version is the shell's own
// bytes rather than a constant somebody remembers to bump, and `/assets/sw.js`
// is a `404`: a worker registered there would have the scope `/assets/` and
// could never control the page, and one with no prelude would cache nothing
// while looking exactly like the real thing.
//
// Five rules, and each of them is a thing that goes wrong quietly:
//
// 1. **Nothing authenticated is ever cached.** There is no `put` in this file
//    outside the one precache, and the only paths it will answer are the ones
//    it was born holding — markup, styles, modules, icons. Everything else,
//    `/api` first among them, is not intercepted at all: no `respondWith`, so
//    the request goes to the network as though this worker did not exist. The
//    machine already says `no-store` on every one of those answers, and this is
//    the half of that promise which lives on the phone.
// 2. **It never takes over a page that is already open.** No `skipWaiting` on
//    the install of a shell: one swapped under a loaded page is somebody's
//    half-typed note replaced by a reload they did not ask for. The page is
//    told there is an update and offers it; the swap happens when a person
//    presses the button, and `install.js` is the other half. The uninstalling
//    worker below does skip, and swaps nothing when it does.
// 3. **It is cache-first for the shell and the shell only.** The shell has a
//    version in its cache's name, so what is in there is what that version was
//    — there is no staleness to revalidate. Freshness belongs to the worker
//    update, which the browser does on navigations anyway.
// 4. **Turned off, it removes itself.** A `404` on this URL does not: the
//    service worker spec was asked to unregister on 404 and 410 and decided
//    against it in 2017, so a failed update leaves the old worker exactly where
//    it was. What works is being *told* — the same URL, a prelude that says
//    `serving: false`, and these bytes delete every cache of ours and
//    unregister. That happens the next time the phone reaches this machine, and
//    what it cannot do is said where somebody turns the setting on.
// 5. **A notification is drawn from the payload and never fetched.** The
//    `push` handler reads the two strings it was sent and shows them; there is
//    no `fetch` in it, no request to `/api` and nothing written to a cache. A
//    worker that asked the machine *what was that about* would be a request
//    made with the page's credentials by something nobody is looking at, on a
//    schedule a push service decides — and an offline phone would draw a
//    notification with a hole in it. What was sent is all there is, which is
//    why the machine builds a payload that stands on its own (`noticed.ts`).

/**
 * What this worker was born knowing, or null.
 *
 * Null is a worker that was served without its prelude, which cannot happen
 * through `/sw.js` and is therefore a bug rather than a decision. So it is the
 * **quietest** possible answer: cache nothing, intercept nothing, remove
 * nothing. Treating it as `serving: false` would make a mistake in the server
 * uninstall every phone, which is the one failure here that cannot be undone
 * from this machine.
 */
const SHELL = self.SHELL ?? null

self.addEventListener('install', (event) => {
  if (SHELL === null) return
  if (!SHELL.serving) {
    // **The one install that does not wait, and it is not an exception to
    // rule two.** Waiting is about not swapping a shell under a loaded page;
    // this worker serves nothing and claims nothing, so there is no swap —
    // what it does is delete and unregister, and nothing on the page changes
    // when it does. Made to wait, it would sit behind a *new version is
    // ready* button for as long as somebody keeps the tab open, which is the
    // wrong sentence about the wrong thing, and the removal would never
    // happen.
    event.waitUntil(self.skipWaiting())
    return
  }
  // `addAll` is atomic: one file that cannot be fetched fails the install and
  // the old worker stays. A half-filled cache would be a shell that loads and
  // then has no stylesheet, offline, with nothing able to say why.
  event.waitUntil(self.caches.open(SHELL.cache).then((cache) => cache.addAll(SHELL.files)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(settle())
})

/**
 * What activating means, which is two different things.
 *
 * Serving: drop every cache of ours that is not this version's and not the
 * page's own last view, then claim the pages. Claiming matters on the **first**
 * install — without it the tab that registered this worker is uncontrolled
 * until it is reloaded, so the first visit would not be the one that works
 * offline. On an update it is reached only after the person pressed the button.
 *
 * Not serving: this is the uninstalling worker. Everything of ours goes, this
 * registration goes with it, and any open page is told so it can say so rather
 * than finding out by being slow.
 */
async function settle() {
  if (SHELL === null) return
  if (!SHELL.serving) {
    await drop(() => true)
    await tell('gone')
    await self.registration.unregister()
    return
  }
  await drop((name) => name !== SHELL.cache && name !== SHELL.view)
  await self.clients.claim()
}

/** Every cache of ours the test says is doomed. Ours is the prefix, always. */
async function drop(doomed) {
  const names = await self.caches.keys()
  await Promise.all(
    names
      .filter((name) => name.startsWith(SHELL.prefix) && doomed(name))
      .map((name) => self.caches.delete(name)),
  )
}

/** One word to every page of ours, controlled or not. */
async function tell(word) {
  const pages = await self.clients.matchAll({ includeUncontrolled: true })
  for (const page of pages) page.postMessage({ tade: word })
}

self.addEventListener('fetch', (event) => {
  if (SHELL === null || !SHELL.serving) return
  const asked = event.request
  if (asked.method !== 'GET') return
  const url = new URL(asked.url)
  if (url.origin !== self.location.origin) return
  // **A navigation is the shell, whatever path it was for.** Every screen is
  // served as the same bytes by the machine too, so this is not an invention
  // of the worker's: `/t/a/b` opened cold is the shell, which then asks for
  // what it may read. A path that is not a screen gets the shell as well, and
  // the page's own *nothing here* — which is a better answer than the
  // browser's offline page for a typo.
  const wanted = asked.mode === 'navigate' ? '/' : url.pathname
  if (!SHELL.files.includes(wanted)) return
  event.respondWith(fromShell(wanted, asked))
})

/**
 * The shell's own copy, or the network.
 *
 * The fallback is for a cache the browser evicted under pressure — which it
 * may do at any time, whatever a quota says. Falling back rather than failing
 * means the only cost of an eviction is being online again, and there is still
 * no `put` here: a miss is never refilled behind somebody's back, because the
 * only thing allowed to decide what is cached is an install with a version on
 * it.
 */
async function fromShell(wanted, asked) {
  const cache = await self.caches.open(SHELL.cache)
  const held = await cache.match(wanted)
  return held ?? fetch(asked)
}

/**
 * A notification arrived.
 *
 * **`showNotification` is not optional.** Every subscription is made
 * `userVisibleOnly`, and a browser that is handed a push and shown nothing
 * revokes the subscription after a few — Chrome draws its own *this site has
 * been updated in the background* notification instead, which is somebody
 * else's sentence on your lock screen. So this always shows one, and the one
 * case where it has nothing to show is answered with Tade's own words rather
 * than with silence.
 *
 * **The payload is read defensively because it arrived from the network.** It
 * is encrypted to this browser's own keys, so only the machine that holds the
 * signing key could have produced it — but a worker that threw inside `push`
 * is a worker that shows the browser's own notification instead, so every
 * field is read as *whatever came, as a string, bounded*.
 *
 * `tag` with `renotify` left alone is what makes a phone that was off for an
 * hour hold **one** notification rather than a column of them: the newer
 * replaces the older silently, which is the same decision the machine makes
 * with the push service's own `Topic` header, made in both places because
 * either one alone leaves the stack somewhere.
 */
self.addEventListener('push', (event) => {
  const said = read(event)
  event.waitUntil(
    self.registration.showNotification(said.title, {
      body: said.body,
      tag: said.tag,
      // The shell's own icon, which is a file in the precache: a notification
      // that reached for a URL the phone does not have would draw without one
      // and look broken.
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      // **Not silent and not requiring interaction.** Silent is what a phone
      // does with a notification nobody meant to send; requiring interaction
      // would leave one on a lock screen until somebody dealt with it, which
      // is a thing to do to somebody about their own alarm clock and not about
      // a test run.
      requireInteraction: false,
    }),
  )
})

/** The payload, read as three bounded strings, with Tade's own words as the floor. */
function read(event) {
  const fallback = { title: 'Tade', body: 'Something wants you', tag: 'tade' }
  if (event.data === null || event.data === undefined) return fallback
  let sent = null
  try {
    sent = event.data.json()
  } catch {
    // Not JSON, which cannot happen through `noticed.ts` and is therefore a
    // bug rather than a shape to handle. Shown as Tade's own sentence, because
    // the alternative is the browser's.
    return fallback
  }
  if (sent === null || typeof sent !== 'object') return fallback
  return {
    title: text(sent.title, fallback.title, 60),
    body: text(sent.body, fallback.body, 160),
    tag: text(sent.tag, fallback.tag, 40),
  }
}

/** One field: a string, bounded, or the floor. */
function text(value, floor, most) {
  return typeof value === 'string' && value !== '' ? value.slice(0, most) : floor
}

/**
 * Somebody tapped it: Tade's own page, and the one already open if there is
 * one.
 *
 * **No path out of the payload**, which is the half worth the words. A
 * notification that carried a url would be a project and a task in something a
 * push service keeps and a lock screen draws — so it carries neither, and this
 * opens the root. The page then opens where it was last left, which is what
 * somebody tapping a notification wanted anyway.
 *
 * An already-open window is focused rather than a second one opened, because
 * three tabs of the same control room is what the alternative looks like after
 * three notifications.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(open())
})

async function open() {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const page of pages) {
    if (new URL(page.url).origin !== self.location.origin) continue
    if ('focus' in page) return page.focus()
  }
  // `openWindow` is only allowed from a notification click, which is exactly
  // where this is.
  return self.clients.openWindow('/')
}

self.addEventListener('message', (event) => {
  // The one thing a page may ask of this worker, and it is the half of the
  // update prompt that cannot be done from a page: a worker waiting to take
  // over is the only thing that can decide to stop waiting. Everything else a
  // page needs — clearing the caches, unregistering on the way out — it does
  // itself, because a message round trip is a step that can be missed on the
  // one path where being thorough matters.
  if (event.data !== null && typeof event.data === 'object' && event.data.tade === 'update') {
    self.skipWaiting()
  }
})
