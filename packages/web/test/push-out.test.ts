import { createECDH, createPublicKey, createVerify, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { request as httpsRequest } from 'node:https'
import { describe, expect, it } from 'vitest'
import type { Resolved } from '../src/endpoint.ts'
import type { Notice } from '../src/noticed.ts'
import {
  answerFor,
  generateVapid,
  PUSH_TIMEOUT_MS,
  PUSH_TTL_S,
  pinned,
  pusher,
  signingFrom,
  VAPID_SUBJECT,
} from '../src/push-out.ts'

// The sender, driven offline, against a push service that is not one.
//
// **Not a test of a mock.** It runs this file's own code — the real
// `web-push`, the real address check, the real status table — and replaces
// exactly one thing: the socket. What that buys is the four properties nothing
// can see from outside and no real push service would prove either:
//
// 1. the `lookup` handed to `node:https` answers with **the address that was
//    checked** and nothing else, so there is no second resolution between the
//    check and the connection;
// 2. `servername` is the **name**, so pinning the address does not weaken the
//    certificate check — the pairing is what makes it safe, and either half
//    alone is a bug;
// 3. the body is the library's bytes unchanged, and the headers are its own;
// 4. each status becomes the right one of the four answers.
//
// And **the protocol is checked independently**, against `node:crypto` rather
// than against the library that produced it: the VAPID token's signature is
// verified with the public key, its claims are read, and the encrypted
// record's own header is read back. A real TLS server would need a certificate
// somebody generated and would prove none of the six.
//
// What nothing here can prove is that a real push service accepts it. That is
// a manual check against a real device, recorded as one in
// `test/browser-plan.ts`.

const ENDPOINT = 'https://web.push.apple.com/QDzVM4rMVZ1l0bT8VvPaDQ?x=1'

/** A subscription as a browser hands one over: real keys, real lengths. */
function subscription(): { endpoint: string; p256dh: string; auth: string } {
  const curve = createECDH('prime256v1')
  curve.generateKeys()
  return {
    endpoint: ENDPOINT,
    p256dh: curve.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  }
}

const NOTICE: Notice = { title: 'Tade', body: '2 want your answer', tag: 'tade' }

/** What one POST was made of, as the stand-in recorded it. */
interface Made {
  options: Record<string, unknown>
  body: Buffer
}

/**
 * A stand-in for `https.request` that answers a status and records everything.
 *
 * It behaves the way Node's does in the three ways this file depends on: the
 * callback gets a readable-ish response, `end(body)` is what sends, and
 * `timeout` is an event rather than a return value.
 */
function scriptedHttps(over: { status?: number; fail?: string; silent?: boolean } = {}): {
  request: typeof httpsRequest
  made: Made[]
} {
  const made: Made[] = []
  const request = ((options: Record<string, unknown>, onAnswer: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      end: (body: Buffer) => void
      destroy: () => void
    }
    req.destroy = () => {}
    req.end = (body: Buffer) => {
      made.push({ options, body })
      // Asynchronous, like a socket: a sender that assumed the answer arrived
      // before `end` returned would pass here and hang in the world.
      setTimeout(() => {
        if (over.fail !== undefined) {
          req.emit('error', new Error(over.fail))
          return
        }
        if (over.silent === true) {
          req.emit('timeout')
          return
        }
        const res = new EventEmitter() as EventEmitter & { statusCode: number; destroy: () => void }
        res.statusCode = over.status ?? 201
        res.destroy = () => {}
        onAnswer(res)
        res.emit('end')
      }, 0)
    }
    return req
  }) as unknown as typeof httpsRequest
  return { request, made }
}

const resolves =
  (...addresses: string[]) =>
  (): Promise<readonly Resolved[]> =>
    Promise.resolve(
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })) as Resolved[],
    )

describe('the signing key', () => {
  it('derives its public half rather than keeping one beside it', () => {
    // Two keys written down is two keys that can disagree, and the symptom is
    // every notification signed with a header a push service rejects.
    const made = generateVapid()
    expect(signingFrom(made.privateKey)).toEqual(made)
    expect(Buffer.from(made.privateKey, 'base64url')).toHaveLength(32)
    expect(Buffer.from(made.publicKey, 'base64url')).toHaveLength(65)
  })

  it('throws on something that is not a key, rather than answering quietly', () => {
    // **The short one is the case that matters.** `setPrivateKey` accepts a
    // short buffer and reads it as a small scalar, so `not-a-key` decodes to
    // six bytes, is taken, and derives a perfectly well-formed public key —
    // after which every notification is signed with a key whose private half
    // is guessable and nothing anywhere says so.
    expect(() => signingFrom('not-a-key')).toThrow()
    expect(() => signingFrom(Buffer.alloc(31).toString('base64url'))).toThrow()
    expect(() => signingFrom(Buffer.alloc(33).toString('base64url'))).toThrow()
    expect(() => signingFrom('')).toThrow()
    // And a 32-byte value the curve itself refuses.
    expect(() => signingFrom(Buffer.alloc(32).toString('base64url'))).toThrow()
  })

  it('names Tade rather than the owner as the contact', () => {
    // RFC 8292 wants a contact a push service can reach. The obvious value is
    // the owner's email address, and it is not used: that would put a personal
    // address in a token handed to Apple, Google and Mozilla on every
    // notification, to identify a laptop.
    expect(VAPID_SUBJECT).toBe('https://tade.sh')
    expect(VAPID_SUBJECT).not.toContain('@')
  })
})

describe('what a status means', () => {
  it('is sent for every 2xx', () => {
    for (const status of [200, 201, 202, 204]) {
      expect(answerFor(status), String(status)).toEqual({ kind: 'sent', status })
    }
  })

  it('is gone for 404 and 410, and for nothing else', () => {
    // RFC 8030 §7.3. The one status that must be acted on rather than retried:
    // a push service answers it for ever, so a sender that retried would post
    // to a dead endpoint on every beat until somebody noticed.
    for (const status of [404, 410]) expect(answerFor(status).kind, String(status)).toBe('gone')
    for (const status of [400, 401, 403, 413, 429, 500, 502, 503]) {
      expect(answerFor(status).kind, String(status)).not.toBe('gone')
    }
  })

  it('is later for rate limiting and for every 5xx', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(answerFor(status).kind, String(status)).toBe('later')
    }
  })

  it('is refused for what retrying cannot fix, and says what to do about it', () => {
    const key = answerFor(401)
    expect(key.kind).toBe('refused')
    if (key.kind === 'refused') expect(key.why).toContain('signing key')
    expect(answerFor(403).kind).toBe('refused')
    const big = answerFor(413)
    expect(big.kind).toBe('refused')
    if (big.kind === 'refused') expect(big.why).toContain('too large')
    expect(answerFor(400).kind).toBe('refused')
    expect(answerFor(0).kind).toBe('refused')
  })
})

describe('the lookup the socket is given', () => {
  it('answers with the checked addresses and asks nobody', () => {
    const lookup = pinned([
      { address: '17.253.144.10', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]) as unknown as (
      host: string,
      opts: { all?: boolean },
      done: (error: unknown, address: unknown, family?: number) => void,
    ) => void
    let all: unknown = null
    lookup('web.push.apple.com', { all: true }, (_e, value) => {
      all = value
    })
    expect(all).toEqual([
      { address: '17.253.144.10', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ])
    // The other shape Node calls it in: the first one and its family.
    let one: unknown = null
    let family: number | undefined
    lookup('web.push.apple.com', {}, (_e, value, got) => {
      one = value
      family = got
    })
    expect(one).toBe('17.253.144.10')
    expect(family).toBe(4)
  })

  it('answers an error rather than falling back to a resolver', () => {
    // A fallback to `dns.lookup` on an empty list would be the second
    // resolution this whole mechanism exists to remove.
    const lookup = pinned([]) as unknown as (
      host: string,
      opts: { all?: boolean },
      done: (error: unknown, address: unknown) => void,
    ) => void
    let error: unknown = null
    lookup('push.example', {}, (got) => {
      error = got
    })
    expect((error as { code?: string } | null)?.code).toBe('ENOTFOUND')
  })
})

describe('one notification, sent', () => {
  it('posts to the checked address, under the name TLS verifies', async () => {
    const https = scriptedHttps()
    const answer = await pusher({
      signing: generateVapid(),
      request: https.request,
      resolve: resolves('17.253.144.10'),
    }).send(subscription(), NOTICE)
    expect(answer).toEqual({ kind: 'sent', status: 201 })
    const made = https.made[0]
    expect(made).toBeDefined()
    if (made === undefined) return
    // **The name, not the address**, for the certificate and for SNI: pinning
    // the address without this would be a connection to a vetted address with
    // no idea who answered it.
    expect(made.options.host).toBe('web.push.apple.com')
    expect(made.options.servername).toBe('web.push.apple.com')
    expect(made.options.port).toBe(443)
    // The path and the query, because one push service puts the token in a
    // query parameter.
    expect(made.options.path).toBe('/QDzVM4rMVZ1l0bT8VvPaDQ?x=1')
    expect(made.options.method).toBe('POST')
    expect(made.options.timeout).toBe(PUSH_TIMEOUT_MS)
    // And the pinned lookup, asserted as the thing it is rather than as its
    // presence: handed the checked address and nothing else.
    const lookup = made.options.lookup as (
      host: string,
      opts: { all?: boolean },
      done: (e: unknown, value: unknown) => void,
    ) => void
    let got: unknown = null
    lookup('web.push.apple.com', { all: true }, (_e, value) => {
      got = value
    })
    expect(got).toEqual([{ address: '17.253.144.10', family: 4 }])
  })

  it('sends the library’s own headers, with the TTL and the replacing topic', async () => {
    const https = scriptedHttps()
    await pusher({
      signing: generateVapid(),
      request: https.request,
      resolve: resolves('17.253.144.10'),
    }).send(subscription(), NOTICE)
    const headers = (https.made[0]?.options.headers ?? {}) as Record<string, string | number>
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers.TTL).toBe(PUSH_TTL_S)
    expect(headers.Urgency).toBe('high')
    // **One topic for everything**, so a push service hands a phone that was
    // off for an hour the newest notification and not six. The same decision
    // the worker makes with `tag`, made in both places because either one
    // alone leaves the stack somewhere.
    expect(headers.Topic).toBe(NOTICE.tag)
  })

  it('sends nothing of the notification in the clear', async () => {
    // The payload is encrypted to the browser's own key, which is the whole of
    // what the push service cannot read. Asserted as bytes rather than
    // believed: a sender that sent the JSON would look identical from here.
    const https = scriptedHttps()
    await pusher({
      signing: generateVapid(),
      request: https.request,
      resolve: resolves('17.253.144.10'),
    }).send(subscription(), { title: 'Tade', body: 'a very distinctive body', tag: 'tade' })
    const body = https.made[0]?.body ?? Buffer.alloc(0)
    expect(body.includes('a very distinctive body')).toBe(false)
    expect(body.includes('Tade')).toBe(false)
  })
})

describe('the protocol, checked against node:crypto rather than against the library', () => {
  it('signs a token the public key verifies, with the claims RFC 8292 wants', async () => {
    const https = scriptedHttps()
    const signing = generateVapid()
    const before = Math.floor(Date.now() / 1000)
    await pusher({
      signing,
      request: https.request,
      resolve: resolves('17.253.144.10'),
    }).send(subscription(), NOTICE)
    const headers = (https.made[0]?.options.headers ?? {}) as Record<string, string>
    const authorization = headers.Authorization ?? ''
    const [, token = '', key = ''] = /^vapid t=([^,]+), k=(.+)$/.exec(authorization) ?? []
    // The key in the header is the one a browser was handed, so a subscription
    // made with `applicationServerKey` matches what signs the request.
    expect(key).toBe(signing.publicKey)

    const [head = '', claims = '', signature = ''] = token.split('.')
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    })
    const body = JSON.parse(Buffer.from(claims, 'base64url').toString()) as {
      aud: string
      exp: number
      sub: string
    }
    // The audience is the push service's **origin** and never the endpoint: a
    // token scoped to the whole URL would carry the per-device token in it.
    expect(body.aud).toBe('https://web.push.apple.com')
    expect(body.sub).toBe(VAPID_SUBJECT)
    expect(body.exp).toBeGreaterThan(before)
    // RFC 8292 caps the lifetime at 24 hours; the library's default is 12.
    expect(body.exp).toBeLessThanOrEqual(before + 24 * 60 * 60)

    // **Verified, not parsed.** ES256 is an ECDSA signature as two 32-byte
    // integers (IEEE P1363); `node:crypto` wants DER unless told otherwise,
    // and `dsaEncoding` is how it is told.
    const spki = createPublicKey({
      key: Buffer.concat([
        // The SPKI prefix for an uncompressed P-256 point, so the raw 65 bytes
        // the header carries can be read as a key without a library.
        Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
        Buffer.from(signing.publicKey, 'base64url'),
      ]),
      format: 'der',
      type: 'spki',
    })
    const verify = createVerify('sha256')
    verify.update(`${head}.${claims}`)
    expect(
      verify.verify({ key: spki, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
    ).toBe(true)
  })

  it('encrypts a record whose own header says what RFC 8188 wants', async () => {
    const https = scriptedHttps()
    const sub = subscription()
    await pusher({
      signing: generateVapid(),
      request: https.request,
      resolve: resolves('17.253.144.10'),
    }).send(sub, NOTICE)
    const body = https.made[0]?.body ?? Buffer.alloc(0)
    // `aes128gcm`'s header: a 16-byte salt, a 4-byte record size, a 1-byte key
    // id length, then the key id — which for Web Push is the sender's own
    // ephemeral public key, 65 bytes.
    expect(body.length).toBeGreaterThan(21 + 65)
    const recordSize = body.readUInt32BE(16)
    expect(recordSize).toBeGreaterThanOrEqual(body.length)
    expect(body[20]).toBe(65)
    const keyId = body.subarray(21, 21 + 65)
    // Uncompressed point, and **not** the browser's own key: it is the
    // sender's ephemeral half of the exchange, fresh per notification.
    expect(keyId[0]).toBe(0x04)
    expect(keyId.toString('base64url')).not.toBe(sub.p256dh)
    // Which is also the one property a replay would break: two sends of the
    // same notice are two different records.
    const second = scriptedHttps()
    await pusher({
      signing: generateVapid(),
      request: second.request,
      resolve: resolves('17.253.144.10'),
    }).send(sub, NOTICE)
    expect((second.made[0]?.body ?? Buffer.alloc(0)).equals(body)).toBe(false)
  })
})

describe('what goes wrong', () => {
  const send = (over: Parameters<typeof scriptedHttps>[0], resolve = resolves('17.253.144.10')) =>
    pusher({
      signing: generateVapid(),
      request: scriptedHttps(over).request,
      resolve,
    }).send(subscription(), NOTICE)

  it('reads a 410 as gone, which is the one answer that forgets a subscription', async () => {
    expect((await send({ status: 410 })).kind).toBe('gone')
  })

  it('reads a timeout as later, never as gone', async () => {
    const answer = await send({ silent: true })
    expect(answer.kind).toBe('later')
    if (answer.kind === 'later') expect(answer.why).toContain('no answer')
  })

  it('reads a socket that would not open as later, never as gone', async () => {
    // A subscription is forgotten when a push service **says** it is gone,
    // never because a network did something: a certificate that did not check
    // out, a reset, a laptop that just woke.
    const answer = await send({ fail: 'ECONNRESET' })
    expect(answer.kind).toBe('later')
    if (answer.kind === 'later') expect(answer.why).toContain('ECONNRESET')
  })

  it('refuses an endpoint the check says no to, and never opens a socket', async () => {
    const https = scriptedHttps()
    const answer = await pusher({
      signing: generateVapid(),
      request: https.request,
      resolve: resolves('17.253.144.10'),
    }).send({ ...subscription(), endpoint: 'https://10.0.0.1/x' }, NOTICE)
    expect(answer.kind).toBe('refused')
    expect(https.made).toEqual([])
  })

  it('reads a name that resolves privately as refused, and one that will not resolve as later', async () => {
    const private_ = await send({}, resolves('169.254.169.254'))
    expect(private_.kind).toBe('refused')
    const offline = await pusher({
      signing: generateVapid(),
      request: scriptedHttps().request,
      resolve: () => Promise.reject(new Error('EAI_AGAIN')),
    }).send(subscription(), NOTICE)
    // A machine that is offline is not a subscription that is gone.
    expect(offline.kind).toBe('later')
  })

  it('answers once, whatever the socket emits afterwards', async () => {
    // `end`, `error` and `close` all arrive on a real response, in orders that
    // depend on the peer. A sender that resolved twice would be a promise
    // nobody could reason about and a `web_pushed` line per event.
    const https = scriptedHttps({ status: 429 })
    const answer = await pusher({
      signing: generateVapid(),
      request: https.request,
      resolve: resolves('17.253.144.10'),
    }).send(subscription(), NOTICE)
    expect(answer.kind).toBe('later')
    expect(https.made).toHaveLength(1)
  })
})
