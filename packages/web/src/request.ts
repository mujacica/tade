import type { IncomingMessage } from 'node:http'
import { type Refusal, refuse } from './errors.ts'
import type { Asking } from './guard.ts'

// A request as it comes off a socket, and every bound on reading one.
//
// Its own file because it is its own subject: `server.ts` decides what a
// request may do, and this decides what a request *is* — which header is one
// value, which URL is a path, how many bytes of body there may be, and how
// long anything may be waited for. Keeping them apart is what lets `guard.ts`
// stay pure: it is handed an `Asking` and never an `IncomingMessage`, so the
// whole cross-product of attacks it exists for is a table rather than a
// sequence of real requests.
//
// **No forwarded header is read here or anywhere in this package**
// (`NEVER_TRUSTED`, `headers.ts`). The address is the socket's and the host is
// `Host`, whatever is in front of the listener.

/** The largest body any route will read. A steer message, later; nothing now. */
export const BODY_MAX = 64 * 1024

/** The header the token travels in, which an HTML form cannot set. */
export const CSRF_HEADER = 'x-tade-csrf'

/**
 * A request, as the guard needs to see it.
 *
 * **The address is the socket's and the host is `Host`.** Reading a forwarded
 * header instead would make the rate limit, the journalled address, the `Host`
 * allow-list and the trusted-origin rule all be whatever the attacker typed,
 * which is four defences for the price of one header.
 */
export function askingOf(req: IncomingMessage): Asking {
  const socket = req.socket as typeof req.socket & { encrypted?: boolean }
  return {
    method: req.method ?? 'GET',
    path: pathOf(req.url ?? '/') ?? '/',
    host: header(req, 'host'),
    origin: header(req, 'origin'),
    site: header(req, 'sec-fetch-site'),
    contentType: header(req, 'content-type'),
    token: header(req, CSRF_HEADER),
    cookie: header(req, 'cookie'),
    tls: socket.encrypted === true,
    from: req.socket.remoteAddress ?? 'unknown',
  }
}

/** One header's value, or null. An array — a repeated header — is null. */
export function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  // A repeated header is two claims about one thing. Picking either is how a
  // guard gets walked past, so neither is picked.
  return null
}

/** The path out of a URL, or null for one that is not a path. */
export function pathOf(url: string): string | null {
  const at = url.search(/[?#]/)
  const path = at === -1 ? url : url.slice(0, at)
  if (!path.startsWith('/')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  // A NUL, a newline or a backslash in a path is not a path anything here
  // serves, and refusing them is cheaper than reasoning about what they mean.
  if (/[\0\r\n\\]/.test(decoded)) return null
  return decoded
}

/** The query, read by exactly one route and never for a credential. */
export function queryOf(url: string): URLSearchParams {
  const at = url.indexOf('?')
  if (at === -1) return new URLSearchParams()
  const end = url.indexOf('#', at)
  return new URLSearchParams(url.slice(at + 1, end === -1 ? undefined : end))
}

/** A device label, bounded and on one line. Its words are the person's. */
export function labelOf(said: string): string {
  return said
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 40)
}

/**
 * What reading a body came to.
 *
 * **A discriminated answer and not `unknown | null`**, because `null` is a
 * perfectly good JSON body: a four-byte `null` would otherwise be
 * indistinguishable from "this was refused", and the caller would return
 * without answering at all — a request held open for ever, for four bytes, by
 * anybody who can reach the pairing route.
 *
 * The refusal comes back rather than being written here, so that every byte
 * this package sends goes out through the one function in `server.ts` that
 * writes the security headers first.
 */
export type Read = { read: true; body: unknown } | { read: false; refusal: Refusal; spent: boolean }

/** The body, or why there is not one. Bounded as it arrives, not as declared. */
export async function readBody(req: IncomingMessage): Promise<Read> {
  const declared = header(req, 'content-length')
  if (declared !== null && Number(declared) > BODY_MAX) {
    return { read: false, refusal: refuse('too_big'), spent: false }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += bytes.length
    // Counted as it arrives and not from the declared length, because the
    // declared length is the client's claim: a chunked body declares none.
    if (size > BODY_MAX) {
      req.destroy()
      return { read: false, refusal: refuse('too_big'), spent: true }
    }
    chunks.push(bytes)
  }
  if (size === 0) return { read: true, body: {} }
  try {
    return { read: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { read: false, refusal: refuse('malformed'), spent: false }
  }
}

/**
 * A promise with a deadline, and the deadline is an answer rather than a hang.
 *
 * The same shape as the window's own `inTime`: every wait here has a deadline,
 * because a request held open for ever is a connection nobody closes and a
 * person watching a spinner. The promise it lost the race to is not cancelled —
 * nothing in this program can cancel a keypress — so whatever the window does
 * afterwards is the window's, and this side has already answered.
 */
export async function inTime<T>(promise: Promise<T>, ms: number, instead: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((done) => {
        timer = setTimeout(() => done(instead), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** A bind error's code, or Tade's own words for one that carries none. */
export function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'it could not be bound'
}
