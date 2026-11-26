// Installing the shell, updating it, and taking it off again — the page's half
// of `sw.js`. A secure origin is the browser's rule (`OFFLINE_NEEDS_HTTPS`);
// the page never reloads itself; signing out clears what is reachable and
// `INSTALLED_IS_NOT_REVOCABLE` says what is not (add-away-surface).

/** Every name this origin keeps of ours starts so: `installable.ts`'s (`test/offline.test.ts`). */
export const CACHE_PREFIX = 'tade-'

/**
 * The one Trusted Types policy (`tade-worker`), made once, refusing every URL
 * but the worker's; held equal to `headers.ts` by `test/trusted-types.test.ts`.
 */
export const WORKER_POLICY = 'tade-worker'
export const WORKER_URL = '/sw.js'

/** What `register` is handed for the worker, made through `types` when the browser has them. */
export function workerURLs(types) {
  if (!types || typeof types.createPolicy !== 'function') return (url) => url
  const policy = types.createPolicy(WORKER_POLICY, {
    createScriptURL: (url) => {
      if (url !== WORKER_URL) throw new TypeError(`${url} is not this page's worker`)
      return url
    },
  })
  return (url) => policy.createScriptURL(url)
}

let trusted = null

/** The worker's URL as the page may hand it over: the policy made the first time it is asked. */
function workerURL() {
  if (trusted === null) trusted = workerURLs(globalThis.trustedTypes)
  return trusted(WORKER_URL)
}

/**
 * Why a browser refused all of this — which nothing else says — in the domain's
 * words (`OFFLINE_NEEDS_HTTPS_SHORT`), held equal by `test/offline.test.ts`.
 */
export const NOT_SECURE = 'needs https or this machine itself; a LAN address is not'

/** Whether this browser, on this origin, has any of it. */
export function installable() {
  return (
    typeof navigator === 'object' &&
    navigator !== null &&
    'serviceWorker' in navigator &&
    self.isSecureContext === true
  )
}

/** The registration for the whole page, or null for every reason there is. */
async function registered() {
  if (!installable()) return null
  try {
    return (await navigator.serviceWorker.getRegistration('/')) ?? null
  } catch {
    // A browser with the API and no permission to use it — a private window in
    // some browsers, an enterprise policy in others. Not an error anybody can
    // act on, and the page works without any of this.
    return null
  }
}

/**
 * Register, or bring an existing registration up to date — always, which is
 * how an *off* reaches a phone; a new one only where the setting is on.
 * Answers `on`, `off`, `insecure` or `cannot`; `told` hears `update` and `gone`.
 */
export async function startInstall(shell, told) {
  // `insecure` a person can fix, where it is served from; `cannot` they cannot.
  if (self.isSecureContext !== true) return 'insecure'
  if (!installable()) return 'cannot'
  let reg = await registered()
  if (reg === null) {
    if (shell === null || shell.install !== true) return 'off'
    try {
      reg = await navigator.serviceWorker.register(workerURL(), { scope: '/' })
    } catch {
      // A registration that will not take stops nothing: the page asks for all it draws.
      return 'cannot'
    }
  } else {
    // Not awaited: the page has a snapshot to ask for.
    reg.update().catch(() => {
      // Not worth a word: the page already says the machine is not answering.
    })
  }
  // The uninstalling worker says so, or a *new version* bar would stay up for it.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data !== null && typeof event.data === 'object' && event.data.tade === 'gone') {
      told('gone')
    }
  })
  watch(reg, told)
  return shell !== null && shell.install === true ? 'on' : 'off'
}

/** A new shell waiting, said only where one is already in control: a first install replaces nothing. */
function watch(reg, told) {
  if (reg.waiting !== null && navigator.serviceWorker.controller !== null) told('update')
  reg.addEventListener('updatefound', () => {
    const coming = reg.installing
    if (coming === null) return
    coming.addEventListener('statechange', () => {
      if (coming.state === 'installed' && navigator.serviceWorker.controller !== null) {
        told('update')
      }
    })
  })
}

/**
 * Take the update, which is the one thing that reloads this page.
 *
 * Pressed, never automatic. The worker is told to stop waiting and the reload
 * waits for it to be in charge — reloading first would land back on the old
 * shell and look like a button that does nothing.
 */
export async function takeUpdate() {
  const reg = await registered()
  const waiting = reg?.waiting ?? null
  if (waiting === null) {
    location.reload()
    return
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
    once: true,
  })
  waiting.postMessage({ tade: 'update' })
}

/** Everything this device keeps, gone — from the page, each half tried on its own. */
export async function forget() {
  if (!installable()) return
  try {
    const names = await self.caches.keys()
    await Promise.all(
      names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => self.caches.delete(name)),
    )
  } catch {
    // A store that will not open holds nothing this page put there either.
  }
  try {
    const reg = await registered()
    await reg?.unregister()
  } catch {
    // Already gone, or never there.
  }
}
