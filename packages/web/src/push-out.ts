import { createECDH } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import webpush from 'web-push'
import { type Resolved, reachable } from './endpoint.ts'
import type { Notice } from './noticed.ts'

// Sending one notification: the vetted library for the cryptography, and
// Tade's own socket for the request.
//
// ## Why a dependency, and what it cost
//
// Web Push is two specifications under the one POST. RFC 8291 is the payload:
// an ECDH over P-256 against the key the browser generated, HKDF with the
// browser's `auth` secret as the salt input, AES-128-GCM with a record
// structure and a padding delimiter. RFC 8292 is the authorisation: an ES256
// JWT over the push service's origin, with the public key beside it in the
// header. Both are implementable in `node:crypto` in a hundred lines — and
// writing those hundred lines *in order to have no dependency* is the
// trade this repository should not make. A bug in them is not a wrong answer
// on a screen: it is a payload a browser silently drops, or an authorisation
// header that works against one push service and not another, found months
// later on somebody else's phone.
//
// So: **`web-push` 3.6.7** (`web-push-libs/web-push`), which is the reference
// implementation the specification's own authors maintain, and the trade-off
// written down rather than left to be rediscovered:
//
// - **Licence: MPL-2.0**, and Tade is MIT. Weak copyleft, file-scoped: §3.3
//   allows distributing it inside a larger work under other terms as long as
//   its own files stay under the MPL, which they do — it is installed, never
//   vendored and never modified. It is the **first MPL-2.0 package Tade
//   ships**: the other two in `THIRD_PARTY_NOTICES.md` are `lightningcss`,
//   which is a build-time tool and goes nowhere near the tarball. That is why
//   this paragraph exists rather than a line in a changelog.
// - **Size: five direct dependencies** — `asn1.js` (the private key as PEM for
//   `jws`), `http_ece` (the RFC 8188 record encoding), `jws` (the ES256 JWT),
//   `https-proxy-agent` and `minimist` (its own CLI, which Tade never runs) —
//   and about fifteen packages with their own transitive ones. Measured
//   against the alternative, which was a hundred lines of our own
//   cryptography, that is the bill and it is a real one.
// - **Supply chain:** it ships to the published `tade-sh`, so it runs on
//   everybody's machine, as the harness for the two protocols and nothing
//   else. What it does **not** do is reach the network, which is the next
//   section and is the part that makes the size of the tree matter less than
//   it would.
//
// ## It does not make the request
//
// `generateRequestDetails` is the one function called: it answers with the
// encrypted body and the headers and **sends nothing**. The socket is Tade's,
// for three reasons, and the first is not a nicety:
//
// 1. **SSRF is ours to prevent and cannot be delegated.** The endpoint comes
//    from a browser, so the address this machine connects to is chosen by
//    somebody else. `endpoint.ts` checks the URL and resolves the name, and
//    the connection is then made to **the address that was checked** by
//    handing `node:https` a `lookup` that answers with it. A library that
//    resolved the name itself would resolve it again, after the check, which
//    is the DNS-rebinding bug with a validator in front of it.
// 2. **`https-proxy-agent` reads the environment.** `web-push`'s own sender
//    honours `HTTPS_PROXY`, so a machine with one set would send every
//    notification through whatever that variable says — which is *where Tade
//    sends something* being decided by a variable rather than by a setting,
//    and that is a `never` in `reach.ts`'s own words.
// 3. **Nothing waits without a deadline.** The window draws on this thread.
//
// The host name is still what TLS is verified against (`servername`), so
// pinning the address buys the rebinding defence without weakening the
// certificate check — which is the pairing that makes this safe rather than
// one or the other.

/** Where one notification goes: the endpoint and the browser's two keys. */
export interface PushTo {
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * What came of sending one, as four answers rather than a status code.
 *
 * Four, because they are four different things for the caller to do and a
 * number would make each call site decide again: `sent` is done, `gone` means
 * forget this subscription for ever, `later` means try the next one on its own
 * schedule, and `refused` means something is wrong here that retrying cannot
 * fix.
 */
export type PushAnswer =
  | { kind: 'sent'; status: number }
  | { kind: 'gone'; status: number; why: string }
  | { kind: 'later'; status: number; why: string }
  | { kind: 'refused'; status: number; why: string }

/** Sending one notification to one subscription. The port, with two sides. */
export interface Pusher {
  send(to: PushTo, notice: Notice): Promise<PushAnswer>
}

/**
 * What a status means, as the one table.
 *
 * Pure, so the whole of it is tested without a socket — and in one place, so
 * the `410` rule cannot be written twice and disagree.
 *
 * - **404 and 410 are `gone`.** RFC 8030 §7.3: the subscription no longer
 *   exists. This is the one status that must be *acted on* rather than
 *   retried, because a push service answers it for ever and a sender that
 *   retried would post to a dead endpoint on every beat until somebody noticed.
 * - **429 and every 5xx are `later`.** The service is busy or broken; the
 *   subscription is fine. `Retry-After` is not read, deliberately: the next
 *   look is the next transition, which is already minutes away and is paced by
 *   what happens rather than by what a header suggests.
 * - **401, 403 and 400 are `refused`**, and are about *this machine*: a VAPID
 *   key the service will not accept, a subject it rejects, a payload it cannot
 *   read. Retrying sends the same thing again, so what is owed instead is a
 *   `warning` a person can act on.
 * - **413 is `refused`** too: too large is a payload bug, and the payload is a
 *   count and a word (`noticed.ts`), so this one means something is wrong in
 *   Tade rather than on the phone.
 */
export function answerFor(status: number): PushAnswer {
  if (status >= 200 && status < 300) return { kind: 'sent', status }
  if (status === 404 || status === 410) {
    return { kind: 'gone', status, why: 'the push service says that subscription is gone' }
  }
  if (status === 429) return { kind: 'later', status, why: 'the push service is rate limiting' }
  if (status >= 500) return { kind: 'later', status, why: `the push service answered ${status}` }
  if (status === 401 || status === 403) {
    return { kind: 'refused', status, why: 'the push service would not accept the signing key' }
  }
  if (status === 413) {
    return { kind: 'refused', status, why: 'the push service says the notification is too large' }
  }
  return { kind: 'refused', status, why: `the push service answered ${status}` }
}

/** The VAPID key pair, as the sender needs it. */
export interface Signing {
  /** The private key, base64url, 32 bytes decoded. */
  privateKey: string
  /** The public key, base64url, 65 bytes decoded. Derived, never stored twice. */
  publicKey: string
}

/**
 * The public key for a private one.
 *
 * **Derived rather than kept beside it**, which is the whole reason the config
 * holds one value and not two: a pair written down as two keys is two keys
 * that can disagree, and the symptom of that is every push being signed with a
 * header a service rejects. `setPrivateKey` computes the point, and
 * `generateVapid` below is held to agreeing with it by a test.
 *
 * Throws on a key that is not a valid scalar for P-256, because a key the
 * curve refuses is a key nothing can be signed with and a quiet answer here
 * would be a notification that silently never arrives.
 */
export function signingFrom(privateKey: string): Signing {
  const scalar = Buffer.from(privateKey, 'base64url')
  // **Thirty-two bytes, checked here**, and this is not belt and braces.
  // `setPrivateKey` accepts a *short* buffer and reads it as a small scalar —
  // so `not-a-key` decodes to six bytes, is taken, and derives a perfectly
  // well-formed public key. Every push would then be signed with a key whose
  // private half is guessable, and nothing anywhere would say so: the token
  // verifies, the push service accepts it, and the only symptom is that
  // anybody could mint one. `base64url` also ignores what it cannot read, so
  // the length is the only thing that catches a typed value.
  if (scalar.length !== PRIVATE_BYTES) {
    throw new Error(`a signing key is ${PRIVATE_BYTES} bytes of base64url`)
  }
  const curve = createECDH('prime256v1')
  curve.setPrivateKey(scalar)
  const publicKey = curve.getPublicKey()
  if (publicKey.length !== PUBLIC_BYTES) throw new Error('that key has no usable public half')
  return { privateKey, publicKey: publicKey.toString('base64url') }
}

/** What a P-256 key pair is, in bytes, as RFC 8292 carries them. */
export const PRIVATE_BYTES = 32
export const PUBLIC_BYTES = 65

/** A new pair, generated here and nowhere else. */
export function generateVapid(): Signing {
  const made = webpush.generateVAPIDKeys()
  return { privateKey: made.privateKey, publicKey: made.publicKey }
}

/**
 * The contact in the signed token, and it is Tade rather than you.
 *
 * RFC 8292 wants a `mailto:` or an `https:` URL so a push service can reach
 * whoever is sending. The obvious value is the owner's email address, and it
 * is **not** used: that would put a personal address in a token handed to
 * Apple, Google and Mozilla on every notification, to identify a laptop. Tade's
 * own homepage says the same thing about who is sending and says nothing about
 * who owns the machine.
 */
export const VAPID_SUBJECT = 'https://tade.sh'

/** How long a push service should hold an undelivered notification. */
export const PUSH_TTL_S = 15 * 60

/**
 * How long one send may take before it is given up on.
 *
 * Short, because this runs on the thread the window draws on — not inside the
 * draw, but on the same event loop — and because a notification that took
 * thirty seconds is a notification about something that has moved on.
 */
export const PUSH_TIMEOUT_MS = 10_000

/** How much of a push service's answer is read before it is thrown away. */
const ANSWER_BOUND = 4_096

/** What the real sender needs, and the two seams a test replaces. */
export interface Sending {
  signing: Signing
  /**
   * The request function. `https.request` by default.
   *
   * A seam, and the test that uses it is not a test of a mock: it drives this
   * file's own code and asserts the things that matter and cannot be seen from
   * outside — that the `lookup` handed over answers with the vetted address
   * and nothing else, that `servername` is the name rather than that address,
   * that the body is the library's bytes unchanged, and that each status
   * becomes the right answer. A real TLS server would need a certificate
   * somebody generated, and would prove none of those four.
   */
  request?: typeof httpsRequest
  /** How a name is resolved. `dns.lookup` with `all` by default. */
  resolve?: (host: string) => Promise<readonly Resolved[]>
}

/** `dns.lookup` as `endpoint.ts` wants it: every address, or a throw. */
export function resolver(): (host: string) => Promise<readonly Resolved[]> {
  return (host) =>
    new Promise((done, fail) => {
      dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => {
        if (error) fail(error)
        else done(addresses.map((one) => ({ address: one.address, family: one.family as 4 | 6 })))
      })
    })
}

/**
 * The sender: check, encrypt, sign, and post to the address that was checked.
 *
 * Every refusal `endpoint.ts` can give comes back as `refused` except one — a
 * name that could not be looked up, which is `later`, because a machine that
 * is offline is not a subscription that is gone.
 */
export function pusher(opts: Sending): Pusher {
  const send = opts.request ?? httpsRequest
  const resolve = opts.resolve ?? resolver()
  return {
    async send(to, notice) {
      const reached = await reachable(to.endpoint, resolve)
      if (!reached.ok) {
        // A lookup that could not happen is the machine, not the endpoint: the
        // network is down, the resolver is unreachable, the laptop just woke.
        // `later`, so nothing is forgotten over an outage.
        const offline = reached.why.startsWith('could not be looked up')
        return offline
          ? { kind: 'later', status: 0, why: reached.why }
          : { kind: 'refused', status: 0, why: `that endpoint ${reached.why}` }
      }
      const details = webpush.generateRequestDetails(
        { endpoint: to.endpoint, keys: { p256dh: to.p256dh, auth: to.auth } },
        JSON.stringify(notice),
        {
          vapidDetails: {
            subject: VAPID_SUBJECT,
            publicKey: opts.signing.publicKey,
            privateKey: opts.signing.privateKey,
          },
          TTL: PUSH_TTL_S,
          contentEncoding: 'aes128gcm',
          // `high`, because every one of the five transitions is somebody being
          // waited on — and because `low` lets a service batch a notification
          // until the phone next wakes, which for *wants your answer* is the
          // whole point missed.
          urgency: 'high',
          // **The push service replaces rather than stacks.** One topic for
          // everything, so a phone that was off for an hour is handed the
          // newest notification and not six, which is the same decision
          // `NOTICE_TAG` makes on the phone itself and has to be made in both
          // places to hold.
          topic: notice.tag,
        },
      )
      const body = Buffer.isBuffer(details.body) ? details.body : Buffer.from(details.body ?? '')
      return post(send, {
        host: reached.endpoint.host,
        path: reached.endpoint.path,
        addresses: reached.addresses,
        headers: details.headers as Record<string, string | number>,
        body,
      })
    },
  }
}

/** One POST, to a pinned address, with a deadline and a bounded answer. */
function post(
  send: typeof httpsRequest,
  what: {
    host: string
    path: string
    addresses: readonly Resolved[]
    headers: Record<string, string | number>
    body: Buffer
  },
): Promise<PushAnswer> {
  return new Promise<PushAnswer>((done) => {
    let settled = false
    const once = (answer: PushAnswer): void => {
      if (settled) return
      settled = true
      done(answer)
    }
    const req = send(
      {
        // The **name**, so SNI and the certificate check are against the name
        // the browser gave us. Pinning the address without this would be a
        // connection to a vetted address with no idea who answered it.
        host: what.host,
        servername: what.host,
        port: 443,
        path: what.path,
        method: 'POST',
        headers: what.headers,
        timeout: PUSH_TIMEOUT_MS,
        // **The address that was checked, and only it.** Node asks this
        // instead of the resolver, so there is no second lookup between the
        // check and the socket — which is the whole of the rebinding defence
        // and is why `endpoint.ts` hands the addresses over rather than only a
        // boolean.
        lookup: pinned(what.addresses),
      },
      (res) => {
        // The answer's body is read and thrown away: nothing in it is used,
        // and leaving it unread holds the socket open. Bounded, because a
        // push service that answered a megabyte of HTML is still somebody
        // else's service.
        let read = 0
        res.on('data', (chunk: Buffer) => {
          read += chunk.length
          if (read > ANSWER_BOUND) res.destroy()
        })
        res.on('end', () => once(answerFor(res.statusCode ?? 0)))
        res.on('error', () => once(answerFor(res.statusCode ?? 0)))
        res.on('close', () => once(answerFor(res.statusCode ?? 0)))
      },
    )
    // A timeout is **`later`**: the service did not answer, which says nothing
    // about whether the subscription is good.
    req.on('timeout', () => {
      req.destroy()
      once({ kind: 'later', status: 0, why: `no answer in ${PUSH_TIMEOUT_MS / 1000}s` })
    })
    req.on('error', (error) => {
      // A socket that would not open, a TLS certificate that did not check
      // out, a connection reset. All `later` and none of them `gone`: a
      // subscription is forgotten when a push service *says* it is gone, never
      // because a network did something.
      once({ kind: 'later', status: 0, why: `could not reach it: ${String(error).slice(0, 160)}` })
    })
    req.end(what.body)
  })
}

/**
 * A `lookup` that answers with the addresses already checked, and never asks
 * anybody.
 *
 * Both shapes Node calls it in: `all` wants the list, and without it the first
 * one and its family. There is no path in here that reaches a resolver, which
 * is the property worth having — a fallback to `dns.lookup` on an empty list
 * would be the second resolution this exists to remove.
 */
export function pinned(
  addresses: readonly Resolved[],
): Exclude<Parameters<typeof httpsRequest>[0] extends { lookup?: infer L } ? L : never, undefined> {
  const all = addresses.map((one) => ({ address: one.address, family: one.family }))
  // Typed through the option's own signature above, so a Node release that
  // changes the callback's shape is a compile error here rather than a
  // notification that silently stops being sent.
  return ((
    _host: string,
    options: { all?: boolean },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ) => {
    if (options.all === true) {
      callback(null, all)
      return
    }
    const first = all[0]
    if (first === undefined) {
      callback(Object.assign(new Error('nothing to connect to'), { code: 'ENOTFOUND' }), '')
      return
    }
    callback(null, first.address, first.family)
  }) as never
}
