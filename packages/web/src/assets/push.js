// Notifications, from this page's side: the permission, the subscription, and
// the four honest answers about why there is not one. Nothing without a press;
// the browser asked about itself; each order the one that leaves no row behind
// (add-away-surface).

/** What this origin's notification state is, in one word. */
export const NOT_OFFERED = 'not offered'
export const CANNOT = 'cannot'
export const INSECURE = 'insecure'
export const DENIED = 'denied'
export const OFF = 'off'
export const ON = 'on'

/** Why a browser has none of this: `PUSH_NEEDS_A_GESTURE_SHORT`'s words (`test/push-client.test.ts`). */
export const NEEDS_HOME_SCREEN =
  'on iOS this is offered only to a page you added to the home screen'

/** Whether this browser, on this origin, has any of it. */
export function pushable() {
  return (
    typeof navigator === 'object' &&
    navigator !== null &&
    'serviceWorker' in navigator &&
    typeof self.PushManager === 'function' &&
    typeof Notification === 'function' &&
    self.isSecureContext === true
  )
}

/** The registration for the whole page, or null for every reason there is. */
async function registered() {
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
 * Where this device stands, one of six words and never a boolean: `denied` is
 * read before the subscription, which a revoked permission can leave behind.
 */
export async function pushState(shell) {
  if (shell === null || shell.notifying?.offered !== true) return NOT_OFFERED
  if (self.isSecureContext !== true) return INSECURE
  if (!pushable()) return CANNOT
  if (Notification.permission === 'denied') return DENIED
  const reg = await registered()
  if (reg === null) return OFF
  return (await heldBy(reg)) === null ? OFF : ON
}

/**
 * Ask the browser, then tell the machine — **called from a press and nowhere
 * else**. Answers the state it reached, or `denied` / `cannot`.
 */
export async function subscribe(shell, ask) {
  if (shell === null || shell.notifying?.offered !== true) return NOT_OFFERED
  if (!pushable()) return self.isSecureContext === true ? CANNOT : INSECURE
  let permission
  try {
    permission = await Notification.requestPermission()
  } catch {
    return CANNOT
  }
  if (permission !== 'granted') return DENIED
  const reg = await registered()
  if (reg === null) return CANNOT
  let made
  try {
    made = await reg.pushManager.subscribe({
      // Required: without it anybody holding the endpoint could ring it.
      userVisibleOnly: true,
      applicationServerKey: keyBytes(shell.notifying.key),
    })
  } catch {
    // A key refused, a push service that refused, a registration gone: one thing to do.
    return CANNOT
  }
  const sent = await ask('POST', '/api/notify/subscribe', bodyOf(made))
  if (sent.status !== 200) {
    // The machine refused, so the browser must not keep it either.
    await made.unsubscribe().catch(() => {})
    return CANNOT
  }
  return ON
}

/** The subscription this browser holds, told the machine again on every visit — never a prompt (add-away-surface). */
export async function resend(shell, ask) {
  if (shell === null || shell.notifying?.offered !== true) return false
  if (!pushable() || Notification.permission !== 'granted') return false
  const reg = await registered()
  if (reg === null) return false
  const held = await heldBy(reg)
  if (held === null) return false
  const sent = await ask('POST', '/api/notify/subscribe', bodyOf(held))
  return sent.status === 200
}

/** How often a page in front of somebody says so: inside the machine's two minutes, with one to spare. */
export const LOOKING_MS = 50_000

/**
 * Say this page is in front of somebody — visible and touched within
 * `LOOKING_MS`, not a tab left on a desk — so this phone is not buzzed about
 * its own screen (`looking.ts`). Asks for nothing.
 */
export function looking(shell, ask, page = document) {
  if (shell === null || shell.notifying?.offered !== true) return
  if (!pushable() || Notification.permission !== 'granted') return
  let touched = Date.now()
  const say = () => {
    if (page.visibilityState !== 'visible') return
    if (Date.now() - touched > LOOKING_MS) return
    void ask('POST', '/api/looking', {})
  }
  const touch = () => {
    touched = Date.now()
  }
  for (const kind of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    page.addEventListener(kind, touch, { passive: true })
  }
  page.addEventListener('visibilitychange', say)
  setInterval(say, LOOKING_MS)
  say()
}

/**
 * The subscription a registration holds, or null — for none, and for a browser
 * that will not answer about one, which is the same thing to every caller:
 * nothing this page can send to, so nothing is drawn as on and nothing is
 * told to the machine.
 */
async function heldBy(reg) {
  try {
    return await reg.pushManager.getSubscription()
  } catch {
    return null
  }
}

/**
 * Stop. The machine first, then the browser.
 *
 * That order on purpose: the row going and the browser's subscription staying
 * is a phone that gets nothing, which is what was asked for; the other way
 * round is a machine posting to a dead endpoint until a push service says
 * `410`.
 */
export async function unsubscribe(ask) {
  await ask('POST', '/api/notify/forget', {})
  const reg = await registered()
  if (reg === null) return OFF
  try {
    const held = await reg.pushManager.getSubscription()
    await held?.unsubscribe()
  } catch {
    // Already gone, or a browser that will not say. Either way this device is
    // not being told anything, because the machine has forgotten it.
  }
  return OFF
}

/** The three fields the machine takes, out of a browser's subscription. */
export function bodyOf(made) {
  const raw = made.toJSON()
  return {
    endpoint: raw.endpoint,
    p256dh: raw.keys?.p256dh ?? '',
    auth: raw.keys?.auth ?? '',
  }
}

/** The VAPID public key, base64url undone by hand: a key decoded wrongly fails silently weeks later. */
export function keyBytes(key) {
  const padded = key.replace(/-/g, '+').replace(/_/g, '/')
  const full = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  const raw = atob(full)
  const out = new Uint8Array(raw.length)
  for (let at = 0; at < raw.length; at++) out[at] = raw.charCodeAt(at)
  return out
}

/**
 * What to say about each state, in the page's own words.
 *
 * Here rather than on the screen that draws it, so the six words and the six
 * sentences cannot drift apart — and so a seventh state is a line in this
 * table rather than a hole on a page.
 */
export const PUSH_SAID = {
  [NOT_OFFERED]: 'this machine is not sending notifications',
  [INSECURE]: 'needs https or this machine itself; a LAN address is not',
  [CANNOT]: `this browser will not offer notifications here — ${NEEDS_HOME_SCREEN}`,
  [DENIED]: 'notifications are blocked for this page in your browser’s own settings',
  [OFF]: 'this device is not being told anything',
  [ON]: 'this device is told when work wants you, stops, goes red or finishes',
}
