import { PUSH_NEEDS_A_GESTURE } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bodyOf,
  CANNOT,
  DENIED,
  INSECURE,
  keyBytes,
  NEEDS_HOME_SCREEN,
  NOT_OFFERED,
  OFF,
  ON,
  PUSH_SAID,
  pushable,
  pushState,
  subscribe,
  unsubscribe,
} from '../src/assets/push.js'
import { generateVapid } from '../src/push-out.ts'

// The page's half of notifications, run against a browser that is not one.
//
// Everything here is a thing that goes wrong on somebody's phone and nowhere
// else: a permission prompt raised outside a gesture, a key decoded wrongly, a
// browser that has the API and refuses it, a machine that said no after the
// browser said yes. None of them fails a test that reads the source, and the
// last one is the one that leaves a row in a file for a device that will never
// be delivered to.

/** What the whole of `self`, `navigator` and `Notification` look like. */
interface Browser {
  /** Whether `getRegistration` throws: a private window, an enterprise policy. */
  sealed?: boolean
  /** Whether `getSubscription` and `unsubscribe` throw. */
  opaque?: boolean
  secure?: boolean
  worker?: boolean
  pushManager?: boolean
  notification?: 'default' | 'granted' | 'denied' | null
  /** What the permission prompt answers, or a throw. */
  asked?: 'granted' | 'denied' | 'throw'
  /** Whether there is a registration at all. */
  registration?: boolean
  /** What `getSubscription` answers. */
  subscribed?: boolean
  /** Whether `pushManager.subscribe` throws. */
  refuses?: boolean
}

const ENDPOINT = 'https://web.push.apple.com/QDzVM4rMVZ1l0bT8VvPaDQ'
const KEYS = { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) }

/**
 * The globals this replaces, and why `defineProperty` rather than assignment.
 *
 * `globalThis.navigator` is a **getter** in Node, so `Reflect.set` on it
 * answers `false` and changes nothing — and a harness whose stand-in silently
 * did not take would be every test here passing for the wrong reason. Found
 * exactly that way: `pushable()` came back `false` with a perfectly good fake
 * in front of it.
 */
const NAMES = ['self', 'navigator', 'Notification', 'PushManager', 'atob'] as const
const had = new Map(
  NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const),
)

function put(name: (typeof NAMES)[number], value: unknown): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, name)
    return
  }
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

afterEach(() => {
  for (const [name, was] of had) {
    if (was === undefined) Reflect.deleteProperty(globalThis, name)
    else Object.defineProperty(globalThis, name, was)
  }
})

/** One browser, as the page sees one, and what it was asked. */
function browser(over: Browser = {}) {
  const asked: string[] = []
  let subscribed = over.subscribed === true
  const subscription = {
    toJSON: () => ({ endpoint: ENDPOINT, keys: KEYS }),
    unsubscribe: () => {
      asked.push('unsubscribe')
      if (over.opaque === true) return Promise.reject(new Error('no'))
      subscribed = false
      return Promise.resolve(true)
    },
  }
  const registration = {
    pushManager: {
      getSubscription: () =>
        over.opaque === true
          ? Promise.reject(new Error('no'))
          : Promise.resolve(subscribed ? subscription : null),
      subscribe: (opts: { userVisibleOnly?: boolean; applicationServerKey?: Uint8Array }) => {
        asked.push('subscribe')
        if (over.refuses === true) return Promise.reject(new Error('no'))
        // The two things a browser requires, asserted where the browser would:
        // `userVisibleOnly` is mandatory, and the key has to be bytes.
        if (opts.userVisibleOnly !== true) return Promise.reject(new Error('needs userVisibleOnly'))
        if (!(opts.applicationServerKey instanceof Uint8Array)) {
          return Promise.reject(new Error('needs a key'))
        }
        subscribed = true
        return Promise.resolve(subscription)
      },
    },
  }
  put('self', {
    isSecureContext: over.secure ?? true,
    PushManager: over.pushManager === false ? undefined : function PushManager() {},
  })
  put('PushManager', over.pushManager === false ? undefined : () => {})
  put('navigator', {
    ...(over.worker === false
      ? {}
      : {
          serviceWorker: {
            getRegistration: () =>
              over.sealed === true
                ? Promise.reject(new Error('not allowed here'))
                : Promise.resolve(over.registration === false ? undefined : registration),
          },
        }),
  })
  if (over.notification === null) put('Notification', undefined)
  else {
    const Notification = (() => {}) as unknown as {
      permission: string
      requestPermission: () => Promise<string>
    }
    Notification.permission = over.notification ?? 'default'
    Notification.requestPermission = () => {
      asked.push('prompt')
      if (over.asked === 'throw') return Promise.reject(new Error('refused to ask'))
      return Promise.resolve(over.asked ?? 'granted')
    }
    put('Notification', Notification)
  }
  return { asked, isSubscribed: () => subscribed }
}

/** The machine's half, as `/api/devices` answers it. */
function shell(over: { offered?: boolean; key?: string } = {}) {
  return {
    install: true,
    keepsView: false,
    notifying: { offered: over.offered ?? true, key: over.key ?? generateVapid().publicKey },
  }
}

/** The page's `ask`, recording what was sent. */
function asking(status = 200) {
  const sent: { method: string; path: string; body: unknown }[] = []
  return {
    sent,
    ask: (method: string, path: string, body: unknown) => {
      sent.push({ method, path, body })
      return Promise.resolve({ status, body: null, text: '' })
    },
  }
}

describe('where this device stands', () => {
  it('is six words, each of which is a different sentence to read', () => {
    // Six rather than a boolean, because they are six different things for
    // somebody to do about it — and a word with no sentence is a hole on a
    // page, which is why the table is held to the words.
    expect(Object.keys(PUSH_SAID).sort()).toEqual(
      [NOT_OFFERED, INSECURE, CANNOT, DENIED, OFF, ON].sort(),
    )
    for (const said of Object.values(PUSH_SAID)) expect(said.length).toBeGreaterThan(10)
  })

  it('says the machine is not offering it before anything else', async () => {
    browser()
    expect(await pushState(shell({ offered: false }))).toBe(NOT_OFFERED)
    expect(await pushState(null)).toBe(NOT_OFFERED)
  })

  it('says insecure for an origin a browser refuses all of this on', async () => {
    // The one failure nobody is told about by anything else: `PushManager` is
    // simply not there on a plain address over a network, and the browser says
    // nothing. So a person turns the setting on, opens their phone, and
    // nothing happens.
    browser({ secure: false })
    expect(await pushState(shell())).toBe(INSECURE)
  })

  it('says cannot for a browser that has the API nowhere', async () => {
    browser({ pushManager: false })
    expect(await pushState(shell())).toBe(CANNOT)
    browser({ notification: null })
    expect(await pushState(shell())).toBe(CANNOT)
    browser({ worker: false })
    expect(await pushState(shell())).toBe(CANNOT)
  })

  it('says denied before it looks at the subscription, never on', async () => {
    // A permission taken back in the phone's own settings can leave a
    // subscription object behind, and a browser that will deliver nothing must
    // not be drawn as on.
    browser({ notification: 'denied', subscribed: true })
    expect(await pushState(shell())).toBe(DENIED)
  })

  it('says off, never on, for a browser that will not answer about one', async () => {
    // **The safe direction.** A browser that throws when asked about its own
    // subscription is one nothing can be concluded from, and drawing *on* over
    // it would be a page saying this device is being told when it may not be.
    browser({ notification: 'granted', subscribed: true, opaque: true })
    expect(await pushState(shell())).toBe(OFF)
    browser({ notification: 'granted', sealed: true })
    expect(await pushState(shell())).toBe(OFF)
  })

  it('reads on and off out of the browser’s own subscription', async () => {
    // **The phone's answer and not the machine's.** A row in a file here and a
    // permission somebody revoked there are two different facts, and only one
    // of them decides whether anything arrives.
    browser({ notification: 'granted', subscribed: true })
    expect(await pushState(shell())).toBe(ON)
    browser({ notification: 'granted', subscribed: false })
    expect(await pushState(shell())).toBe(OFF)
    browser({ notification: 'granted', registration: false })
    expect(await pushState(shell())).toBe(OFF)
  })

  it('answers whether this browser has any of it, and needs every part', () => {
    browser()
    expect(pushable()).toBe(true)
    for (const over of [
      { secure: false },
      { pushManager: false },
      { worker: false },
      { notification: null as null },
    ]) {
      browser(over)
      expect(pushable(), JSON.stringify(over)).toBe(false)
    }
  })
})

describe('subscribing, which only ever happens from a press', () => {
  it('asks the browser first and the machine second', async () => {
    // The only order that cannot write a row for a device that will never be
    // delivered to: a machine told first and a permission then refused would
    // be a subscription in a file with nothing behind it.
    const fake = browser()
    const asks = asking()
    expect(await subscribe(shell(), asks.ask)).toBe(ON)
    expect(fake.asked).toEqual(['prompt', 'subscribe'])
    expect(asks.sent).toEqual([
      { method: 'POST', path: '/api/notify/subscribe', body: { endpoint: ENDPOINT, ...KEYS } },
    ])
  })

  it('never asks the machine where the permission was refused', async () => {
    const fake = browser({ asked: 'denied' })
    const asks = asking()
    expect(await subscribe(shell(), asks.ask)).toBe(DENIED)
    expect(fake.asked).toEqual(['prompt'])
    expect(asks.sent).toEqual([])
  })

  it('never asks a browser anything where the machine is not offering it', async () => {
    const fake = browser()
    const asks = asking()
    expect(await subscribe(shell({ offered: false }), asks.ask)).toBe(NOT_OFFERED)
    expect(fake.asked).toEqual([])
    expect(asks.sent).toEqual([])
  })

  it('unsubscribes the browser where the machine refused it', async () => {
    // **A subscription the machine does not hold is one nothing will ever
    // use**, and leaving it would make the next press think this device is
    // already on.
    const fake = browser()
    const asks = asking(403)
    expect(await subscribe(shell(), asks.ask)).toBe(CANNOT)
    expect(fake.asked).toEqual(['prompt', 'subscribe', 'unsubscribe'])
    expect(fake.isSubscribed()).toBe(false)
  })

  it('answers cannot for a browser that refused the subscription itself', async () => {
    const asks = asking()
    browser({ refuses: true })
    expect(await subscribe(shell(), asks.ask)).toBe(CANNOT)
    expect(asks.sent).toEqual([])
  })

  it('answers cannot where asking for the permission threw', async () => {
    browser({ asked: 'throw' })
    expect(await subscribe(shell(), asking().ask)).toBe(CANNOT)
  })

  it('answers cannot for a browser that will not hand over its registration', async () => {
    // A private window in some browsers, an enterprise policy in others: the
    // API is there and using it is refused. Not an error anybody can act on,
    // and the page works without any of this — so it is a word rather than a
    // throw, and the page draws the sentence for it.
    const asks = asking()
    browser({ sealed: true })
    expect(await subscribe(shell(), asks.ask)).toBe(CANNOT)
    expect(asks.sent).toEqual([])
    browser({ registration: false })
    expect(await subscribe(shell(), asking().ask)).toBe(CANNOT)
  })

  it('tells the difference between an insecure origin and a browser with none of it', async () => {
    // Two answers rather than one, because one of them is a thing somebody can
    // fix and the other is not.
    browser({ secure: false })
    expect(await subscribe(shell(), asking().ask)).toBe(INSECURE)
    browser({ pushManager: false })
    expect(await subscribe(shell(), asking().ask)).toBe(CANNOT)
  })
})

describe('stopping', () => {
  it('tells the machine first and the browser second', async () => {
    // That order: the row going and the browser's subscription staying is a
    // phone that gets nothing, which is what was asked for; the other way
    // round is a machine posting to a dead endpoint until a push service says
    // `410`.
    const fake = browser({ notification: 'granted', subscribed: true })
    const asks = asking()
    expect(await unsubscribe(asks.ask)).toBe(OFF)
    expect(asks.sent).toEqual([{ method: 'POST', path: '/api/notify/forget', body: {} }])
    expect(fake.asked).toEqual(['unsubscribe'])
    expect(fake.isSubscribed()).toBe(false)
  })

  it('still tells the machine where the browser has nothing to unsubscribe', async () => {
    browser({ registration: false })
    const asks = asking()
    expect(await unsubscribe(asks.ask)).toBe(OFF)
    expect(asks.sent).toHaveLength(1)
  })

  it('answers off where the browser would not unsubscribe, because the machine has', async () => {
    // **The one swallow here that is deliberate**, and this is the test that
    // says so: the machine has already forgotten the row, so this device gets
    // nothing whatever its browser does with the subscription object. The
    // other order — browser first, machine second — is the one that leaves a
    // machine posting to a dead endpoint until a push service says `410`.
    const fake = browser({ notification: 'granted', subscribed: true, opaque: true })
    const asks = asking()
    expect(await unsubscribe(asks.ask)).toBe(OFF)
    // The machine first, and it landed.
    expect(asks.sent).toEqual([{ method: 'POST', path: '/api/notify/forget', body: {} }])
    // The browser would not even say what it holds, so there was nothing to
    // call `unsubscribe` on — and that is still *off*, because the machine
    // will not post to it again.
    expect(fake.asked).toEqual([])
    expect(fake.isSubscribed()).toBe(true)
  })
})

describe('the key, and the two sentences', () => {
  it('decodes base64url to the bytes a browser wants', () => {
    // The one bug here is silent: a key decoded wrongly is a subscription a
    // push service accepts and a signature it then rejects, weeks later. So
    // the check is against `Buffer`, which is a different implementation.
    put('atob', (text: string) => Buffer.from(text, 'base64').toString('latin1'))
    const made = generateVapid()
    expect(Buffer.from(keyBytes(made.publicKey))).toEqual(Buffer.from(made.publicKey, 'base64url'))
    // And over a hundred keys, because the padding is what is got wrong and it
    // depends on the length.
    for (let at = 0; at < 20; at++) {
      const one = generateVapid().publicKey
      expect(Buffer.from(keyBytes(one))).toHaveLength(65)
      expect(Buffer.from(keyBytes(one))).toEqual(Buffer.from(one, 'base64url'))
    }
  })

  it('reads the three fields the machine takes out of a subscription', () => {
    expect(bodyOf({ toJSON: () => ({ endpoint: ENDPOINT, keys: KEYS }) })).toEqual({
      endpoint: ENDPOINT,
      ...KEYS,
    })
    // A browser that answered no keys is a body the machine refuses rather
    // than a page that throws on a phone.
    expect(bodyOf({ toJSON: () => ({ endpoint: ENDPOINT }) })).toEqual({
      endpoint: ENDPOINT,
      p256dh: '',
      auth: '',
    })
  })

  it('says the iOS limit in the clause the domain says it in', () => {
    // The one refusal that looks exactly like a bug: Safari offers the prompt
    // only to a page added to the home screen, and refuses silently
    // otherwise. The page says so, because nothing else will — and the domain
    // says it too, where somebody turns the setting on.
    expect(PUSH_SAID[CANNOT]).toContain(NEEDS_HOME_SCREEN)
    expect(PUSH_NEEDS_A_GESTURE).toContain('home screen')
  })
})
