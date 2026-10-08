// The headers every answer carries, and the content policy that is the backstop
// under all of it.
//
// Pure: what kind of answer this is in, the header pairs out. One function, so
// there is no route that forgot one — the server writes these before it writes
// anything else, including before a refusal, because a refusal is a page a
// browser renders too.
//
// **The policy is `default-src 'none'` and it is deliberately total.** The page
// may load its own scripts, its own stylesheet, its own images and nothing
// else: no CDN, no webfont, no analytics, no remote source map, and
// `connect-src 'self'` means it cannot reach the internet at all. The page
// renders text a person typed, text an agent wrote and — later — text from a
// forge, so the useful question is not "is this page trustworthy" but "what can
// script on it reach if it gets there", and the answer is this machine and
// nothing else.
//
// `form-action 'none'` is not a leftover: there is no HTML form in the design.
// Everything is `fetch` with JSON and a token, so a form post is not a shape
// the page has — which is also the thing that makes a cross-site form post
// useless against it.

/** The content policy, as one header value. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ')

/**
 * The companions, on every answer.
 *
 * `no-referrer` because the pairing page has a ticket in its fragment and a
 * referrer is the one way a fragment has ever leaked; the two cross-origin
 * policies because a control room in somebody else's `window.opener` or
 * `<img>` is a control room they can probe; the permissions policy because
 * nothing here wants a camera and saying so costs one header.
 */
export const COMPANIONS: Readonly<Record<string, string>> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  /**
   * There is no HTML frame in the design and `frame-ancestors` above already
   * says so. This is here for the browser that does not read the policy, which
   * is the whole idea of a backstop having a backstop.
   */
  'x-frame-options': 'DENY',
}

/** What kind of answer, which decides only how it may be cached. */
export type Kind =
  /** A file out of `assets/`: revalidate always, 304 nearly always. */
  | 'asset'
  /** Anything under `/api`: never stored, without exception. */
  | 'api'
  /** The live stream: never stored, and never buffered on the way out. */
  | 'stream'
  /** A refusal. Cached like an API answer, whatever it was refusing. */
  | 'refusal'

/**
 * Every header for one answer.
 *
 * `no-store` on `/api` has no exception and no TTL worth the saving: what these
 * routes answer is what is happening in somebody's work, and a browser cache is
 * a copy of it on a disk nobody decided to put it on. Assets revalidate rather
 * than being immutable, because in Phases 1–3 there is no version in their
 * URLs and a stale script is a page that is subtly wrong with no way to say so.
 */
export function headersFor(kind: Kind, type: string, etag?: string): Record<string, string> {
  const out: Record<string, string> = { ...COMPANIONS, 'content-type': type }
  if (kind === 'asset') {
    out['cache-control'] = 'no-cache'
    if (etag !== undefined) out.etag = etag
  } else {
    out['cache-control'] = 'no-store'
  }
  if (kind === 'stream') {
    // Two hints for a proxy somebody deliberately put in front of this — the
    // only kind there is, since `trusted_hosts` is how a host gets to be one
    // (`NEVER_TRUSTED` is the other half of that rule). A proxy that buffers a
    // response until it has a few hundred bytes turns a live stream into a
    // page that says nothing for a minute, which is indistinguishable from a
    // machine that went to sleep — and §5.10's whole job is telling those
    // apart. Sent as hints and relied on by nothing: `STREAM_OPENING` pads
    // past the usual buffer, so the stream works through a proxy that ignores
    // both.
    out['x-accel-buffering'] = 'no'
    out.connection = 'keep-alive'
  }
  return out
}

/**
 * The headers that say what *not* to trust, as a list a test can read.
 *
 * Nothing here reads any of them, and that is the point. **A proxy may be in
 * front of this** — `tailscale serve` is the recommended way to give a phone
 * HTTPS — and it is *still* not read, because a forwarded header is only worth
 * anything if everything that can reach the port is the proxy, and nothing
 * here can know that. What a deliberate proxy gets instead is a deliberate
 * configuration: its name in `surfaces.web.trusted_hosts`, which is what makes
 * its host pass the allow-list and its `https` origin a trusted one
 * (`schemesFor`, `trusted`) — a person's act in the `never` subtree, not a
 * header anybody on the network can write.
 *
 * Read one and four defences become whatever the attacker typed:
 * `X-Forwarded-For` is the rate limit and the journalled address;
 * `X-Forwarded-Host` walks through the `Host` allow-list, which is the
 * rebinding defence; `X-Forwarded-Proto` makes a plaintext session look
 * trusted enough to act.
 *
 * So the rule is "the socket and the `Host` header, and nothing else", and
 * `test/guard.test.ts` asserts no source file in this package so much as names
 * one of these.
 */
export const NEVER_TRUSTED = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  // A tunnel's own spelling of the same thing. Named for the same reason: the
  // day somebody puts `cloudflared` in front of this, a header that was being
  // read would start carrying a stranger's claim about who they are.
  'cf-connecting-ip',
  'true-client-ip',
] as const
