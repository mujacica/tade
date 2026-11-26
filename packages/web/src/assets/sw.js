// The service worker: the static shell, kept so the page opens with no machine
// to ask, and nothing else at all. Served only at `/sw.js` behind its prelude
// (`self.SHELL`, `installable.ts`). Its rules — nothing authenticated cached,
// never taking over an open page, removing itself when told, a notification
// drawn from its payload alone — are in the add-away-surface skill.

/** What this worker was born knowing; null (no prelude, a bug) does nothing at all. */
const SHELL = self.SHELL ?? null

self.addEventListener('install', (event) => {
  if (SHELL === null) return
  if (!SHELL.serving) {
    // The uninstalling worker does not wait: it swaps nothing, and waiting it never would.
    event.waitUntil(self.skipWaiting())
    return
  }
  // Atomic: one file that cannot be fetched fails the install and the old worker stays.
  event.waitUntil(self.caches.open(SHELL.cache).then((cache) => cache.addAll(SHELL.files)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(settle())
})

/** Serving: drop old caches and claim the pages. Not serving: remove everything of ours, and say so. */
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
  // A navigation is the shell, whatever path it was for, as the machine serves it.
  const wanted = asked.mode === 'navigate' ? '/' : url.pathname
  if (!SHELL.files.includes(wanted)) return
  event.respondWith(fromShell(wanted, asked))
})

/** The shell's own copy, or the network where the browser evicted it — never refilled here. */
async function fromShell(wanted, asked) {
  const cache = await self.caches.open(SHELL.cache)
  const held = await cache.match(wanted)
  return held ?? fetch(asked)
}

/** A notification: always shown, drawn from its payload alone, one a tag. */
self.addEventListener('push', (event) => {
  const said = read(event)
  event.waitUntil(
    self.registration.showNotification(said.title, {
      body: said.body,
      tag: said.tag,
      // The precached icon: a URL the phone does not have would draw without one.
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
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
    // Not JSON — a bug, never a shape — so Tade's own sentence rather than the browser's.
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

/** A tap: the open page of ours focused, or `/` — there is no path in a payload. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  // So a Declarative Web Push browser (`payloadOf`) does not open one of its own.
  event.preventDefault()
  event.waitUntil(open())
})

async function open() {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const page of pages) {
    if (new URL(page.url).origin !== self.location.origin) continue
    if ('focus' in page) return page.focus()
  }
  return self.clients.openWindow('/')
}

self.addEventListener('message', (event) => {
  // The one thing a page may ask: only a waiting worker can decide to stop waiting.
  if (event.data !== null && typeof event.data === 'object' && event.data.tade === 'update') {
    self.skipWaiting()
  }
})
