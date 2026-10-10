// Notifications, from this page's side: the permission, the subscription, and
// the four honest answers about why there is not one.
//
// **Nothing here happens without a press.** A browser's permission prompt may
// only be raised from a user gesture — Chrome and Safari both refuse one that
// is not, and Safari refuses it outright outside a page added to the home
// screen — so this is a control somebody taps and never something the page
// does on load. That is not only a browser rule: a prompt nobody asked for is
// the thing people answer *no* to for ever, and a *no* on this origin cannot
// be asked again from here.
//
// **Two switches, and this is the second one.** The machine decides whether it
// will send anything (`surfaces.web.push`, and the public key it answers
// with); this device decides whether it will receive anything. Both are off
// until somebody says so, in two places, and neither can stand in for the
// other: `PUSH_NEEDS_A_GESTURE` is the sentence and this file is its other
// half.
//
// **It asks the browser about the browser.** Whether this device is subscribed
// is read from its own `pushManager` rather than from the machine, and that is
// the better answer: a permission somebody took back in the phone's own
// settings leaves a row in a file here and a browser that will deliver
// nothing, and only one of the two knows. So the page shows what the *phone*
// says, and the machine is asked only for what it offers.
//
// **Unsubscribing is both halves, in the order that cannot leave a row
// behind.** The machine is told first and the browser second: a browser that
// unsubscribed and a machine that still holds the endpoint would be a
// notification sent for ever to something that answers `410`, and a machine
// told first and a browser that then failed to unsubscribe is a phone that
// gets nothing, which is what was asked for.

/** What this origin's notification state is, in one word. */
export const NOT_OFFERED = 'not offered'
export const CANNOT = 'cannot'
export const INSECURE = 'insecure'
export const DENIED = 'denied'
export const OFF = 'off'
export const ON = 'on'

/**
 * Why a browser has none of this, in the page's own words.
 *
 * The clause is the domain's own (`PUSH_NEEDS_A_GESTURE_SHORT` is the other
 * half), copied here because a browser cannot import a `.ts` file and held
 * equal to it by `test/push-client.test.ts` — `glyphs.js`'s treatment, for
 * `glyphs.js`'s reason.
 */
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
 * Where this device stands, which is one of six words and never a boolean.
 *
 * Six, because they are six different sentences for somebody to read and a
 * boolean would make the page guess which: the machine is not offering it, the
 * origin is not secure, this browser has none of it, the permission was
 * refused, nothing is subscribed, something is.
 *
 * **`denied` is read before the subscription**, because a permission taken
 * back in the phone's settings can leave a subscription object behind: a
 * browser that will deliver nothing must not be drawn as on.
 */
export async function pushState(shell) {
  if (shell === null || shell.notifying?.offered !== true) return NOT_OFFERED
  if (self.isSecureContext !== true) return INSECURE
  if (!pushable()) return CANNOT
  if (Notification.permission === 'denied') return DENIED
  const reg = await registered()
  if (reg === null) return OFF
  try {
    return (await reg.pushManager.getSubscription()) === null ? OFF : ON
  } catch {
    return OFF
  }
}

/**
 * Ask the browser, then tell the machine. **Called from a press and nowhere
 * else.**
 *
 * The order is the browser first, and it is the only order that cannot write a
 * row for a device that will never be delivered to: a machine told first and a
 * permission then refused would be a subscription in a file with nothing
 * behind it.
 *
 * Answers in a word the caller can say: the state it reached, or `denied` /
 * `cannot` for what went wrong.
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
      // Required by every browser that implements this, and required by the
      // specification for a reason worth knowing: a subscription that could be
      // delivered to without a payload is one anybody holding the endpoint
      // could ring. With it, the endpoint is useless without the signing key.
      userVisibleOnly: true,
      applicationServerKey: keyBytes(shell.notifying.key),
    })
  } catch {
    // A key the browser would not take, a push service that refused, a
    // registration that went away under us. One answer, because there is one
    // thing to do about any of them.
    return CANNOT
  }
  const sent = await ask('POST', '/api/notify/subscribe', bodyOf(made))
  if (sent.status !== 200) {
    // **The machine refused, so the browser must not keep it.** A subscription
    // the machine does not hold is one nothing will ever use, and leaving it
    // would make the next press think this device is already on.
    await made.unsubscribe().catch(() => {})
    return CANNOT
  }
  return ON
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

/**
 * The VAPID public key as the bytes `subscribe` wants.
 *
 * `applicationServerKey` takes a `BufferSource`, and base64url is what the
 * machine sends — so the padding and the two swapped characters are undone
 * here. Written out rather than leaning on a helper, because the one bug this
 * has is silent: a key decoded wrongly is a subscription a push service
 * accepts and a signature it then rejects, weeks later.
 */
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
