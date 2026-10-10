// Installing the shell, updating it, and taking it off again — the page's half
// of `sw.js`.
//
// **Nothing here is reached on a plain-HTTP origin off this machine, and that
// is a browser's rule rather than ours.** A service worker, Cache Storage and
// an install all need a *potentially trustworthy* origin: this machine's own
// `localhost` and `127.0.0.0/8` are, and `192.168.*`, `10.*` and every other
// private address over plain HTTP are not. So a `lan` bind can never be
// installed, however many settings are on, and `navigator.serviceWorker` is
// simply not there to ask. The sentence a person reads about that is
// `OFFLINE_NEEDS_HTTPS`, said where the setting is.
//
// **The page never reloads itself.** A worker that is waiting is a bar with a
// button on it, and the swap happens when somebody presses it — because the
// thing a reload throws away is a paragraph typed on a phone, and that is the
// one failure on this page nobody can undo. The serving worker does not call
// `skipWaiting` on install for the same reason; the uninstalling one does,
// and it swaps nothing.
//
// **Signing out clears what is reachable, and says what it cannot.** Every
// cache under the prefix goes, the registration goes with it — and a push
// subscription belongs to a registration, so it goes too — but a shell that
// was already downloaded onto a phone that never comes back is not ours to
// erase. `INSTALLED_IS_NOT_REVOCABLE` is where that is said out loud.

/**
 * Everything this origin keeps of ours is named under this.
 *
 * Spelt here as well as in `installable.ts`, and held equal to it by
 * `test/offline.test.ts` — the same treatment the domain's own words get in
 * `glyphs.js`, and for the same reason: a browser cannot import a `.ts` file,
 * and the page has to know this name **without asking**. The one moment it
 * matters most is the one where there is nothing to ask — a cold open with no
 * answer, and a session that has just been refused.
 */
export const CACHE_PREFIX = 'tade-'

/**
 * Why a browser refused all of this, in the page's own words.
 *
 * **The one failure here nobody is told about by anything else.** A browser
 * on a plain address over a network does not offer a worker, a cache or an
 * install, and it says nothing: `navigator.serviceWorker` is simply not there.
 * So a person turns the setting on at the machine, opens their phone, and
 * nothing happens — which looks exactly like a thing that is broken.
 *
 * The clause is the domain's own (`OFFLINE_NEEDS_HTTPS_SHORT`), copied here
 * because a browser cannot import a `.ts` file and held equal to it by
 * `test/offline.test.ts` — `glyphs.js`'s treatment, for `glyphs.js`'s reason.
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
 * Register, or bring an existing registration up to date.
 *
 * The order matters. An existing registration is **always** asked to update,
 * whatever the setting says, because that is the one moment this machine can
 * tell a phone that the away view has been turned off — `/sw.js` then answers
 * with the uninstalling worker and the shell comes off. Registering a *new*
 * one happens only where the setting is on, so a machine that never offered
 * this does not install a worker on every load in order to remove it again.
 *
 * Answers in a word, so the caller can say which: `on`, `off` for a machine
 * that does not offer it, `insecure` for an origin a browser refuses all of
 * this on, and `cannot` for a browser that has none of it.
 *
 * `told` is called with a word when something happens afterwards: `update`
 * when a new shell is installed and waiting, `gone` when the uninstalling
 * worker has taken this device's copy off. Both reach the same place on the
 * page, because the thing they change is the same bar.
 */
export async function startInstall(shell, told) {
  // **Two answers, not one, and the difference is a sentence somebody reads.**
  // `insecure` is the browser refusing because of where this page is served
  // from, which is a thing a person can fix; `cannot` is a browser that has
  // none of this, which is not.
  if (self.isSecureContext !== true) return 'insecure'
  if (!installable()) return 'cannot'
  let reg = await registered()
  if (reg === null) {
    if (shell === null || shell.install !== true) return 'off'
    try {
      reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    } catch {
      // A registration that will not take is not a page that stops working:
      // everything here is an addition to a page that already asks the
      // machine for everything it draws.
      return 'cannot'
    }
  } else {
    // Deliberately not awaited: an update check is a network round trip, and
    // the page has a snapshot to ask for.
    reg.update().catch(() => {})
  }
  // **The uninstalling worker says so**, which is the other half of its not
  // waiting: without this the page would have put a *new version is ready*
  // bar up for a worker whose whole job was to remove itself, and left it
  // there. One listener, for the life of the page.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data !== null && typeof event.data === 'object' && event.data.tade === 'gone') {
      told('gone')
    }
  })
  watch(reg, told)
  return shell !== null && shell.install === true ? 'on' : 'off'
}

/**
 * Say when there is a new shell waiting, and never before.
 *
 * `navigator.serviceWorker.controller` is the whole of the test. With no
 * controller this is a first install and there is nothing to replace — telling
 * somebody a page they have just opened is out of date would be a prompt that
 * means nothing. With one, a worker that has reached `installed` is a shell
 * sitting beside the one being looked at, and that is worth a sentence.
 */
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

/**
 * Everything this device keeps, gone.
 *
 * Done from the page rather than by asking the worker, because this runs on
 * the paths where being thorough matters most — signed out, revoked, refused —
 * and a message to a worker that is not there, or is being unregistered as the
 * message arrives, is a step that can be missed. Both halves are tried
 * independently: a cache that will not delete must not stop a registration
 * from being removed.
 */
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
