// The PROXY protocol's header, read off the front of a connection (HAProxy's
// spec, versions 1 and 2): the one way the client's address crosses a proxy
// that ends TLS in front of the public listener.
//
// Pure, and its own file for the reason `guard.ts` is: every malformed header
// is a row in `test/proxy-protocol.test.ts` rather than a socket somebody had
// to open. `proxied.ts` does the reading; this decides what the bytes are.
//
// **Read only on the public listener's socket**, which only Caddy's group can
// open (`publicDirProblem`). A header is a claim by whoever connected, so
// where anybody could connect it would make the address whatever they typed —
// the reason no forwarded *header* is ever read (`NEVER_TRUSTED`). Even there,
// what it carries is the rate limit's key and the address in the journal,
// never a permission: which listener accepted the socket decides that.
//
// **Optional, and that is safe here and nowhere else.** Caddy writes the HTTP
// request itself, so the first bytes on the upstream connection are Caddy's,
// never a client's: no request a phone sends can start with a header. A
// connection with none is Caddy without `proxy_protocol`, and its requests
// share one address — said once (`proxied.ts`), never refused.

/** What the bytes at the front of a connection are. */
export type ProxyHeader =
  /** Too few bytes to say yet. */
  | { kind: 'more' }
  /** No header: these bytes are the request itself. */
  | { kind: 'none' }
  /** A header of `length` bytes, and the client's address, or null where it named none. */
  | { kind: 'header'; from: string | null; length: number }
  /** Something that began as a header and is not one. The connection is closed. */
  | { kind: 'bad'; why: string }

/** Version 2's twelve-byte signature, which no HTTP request can begin with. */
const V2 = Buffer.from('\r\n\r\n\0\r\nQUIT\n', 'latin1')

/** Version 1's opening. */
const V1 = Buffer.from('PROXY ', 'latin1')

/** The longest version 1 header there may be, CRLF included (the spec's 107). */
const V1_MOST = 107

/**
 * The longest version 2 header read, its TLVs included. A proxy that sends
 * more is not the one this listener is for; Caddy's is 28 bytes.
 */
export const V2_MOST = 1024

/** What the bytes at the front of a connection are, so far. */
export function readProxyHeader(bytes: Buffer): ProxyHeader {
  if (startsLike(bytes, V2)) return bytes.length < V2.length ? { kind: 'more' } : version2(bytes)
  if (startsLike(bytes, V1)) return bytes.length < V1.length ? { kind: 'more' } : version1(bytes)
  return { kind: 'none' }
}

/** Whether `bytes` and `sig` agree for as far as both go, with at least one byte to go on. */
function startsLike(bytes: Buffer, sig: Buffer): boolean {
  if (bytes.length === 0) return true
  const n = Math.min(bytes.length, sig.length)
  return bytes.subarray(0, n).equals(sig.subarray(0, n))
}

function version1(bytes: Buffer): ProxyHeader {
  const end = bytes.subarray(0, V1_MOST).indexOf('\r\n')
  if (end === -1) {
    return bytes.length >= V1_MOST
      ? { kind: 'bad', why: 'a version 1 header with no end in 107 bytes' }
      : { kind: 'more' }
  }
  const line = bytes.subarray(V1.length, end).toString('latin1')
  const length = end + 2
  const [family, src, dst, sport, dport, ...rest] = line.split(' ')
  if (family === 'UNKNOWN') return { kind: 'header', from: null, length }
  if (rest.length > 0 || dport === undefined || !port(sport) || !port(dport)) {
    return { kind: 'bad', why: 'a version 1 header that is not five fields' }
  }
  const read = family === 'TCP4' ? ipv4 : family === 'TCP6' ? ipv6 : null
  if (read === null) return { kind: 'bad', why: 'a version 1 header of an unknown family' }
  const from = read(src ?? '')
  if (from === null || read(dst ?? '') === null) {
    return { kind: 'bad', why: `a version 1 ${family} header whose addresses are not addresses` }
  }
  return { kind: 'header', from, length }
}

function version2(bytes: Buffer): ProxyHeader {
  if (bytes.length < 16) return { kind: 'more' }
  const version = bytes[12] ?? 0
  if (version >> 4 !== 2) return { kind: 'bad', why: 'a version 2 signature on another version' }
  const length = 16 + bytes.readUInt16BE(14)
  if (length > V2_MOST) return { kind: 'bad', why: `a version 2 header of ${length} bytes` }
  if (bytes.length < length) return { kind: 'more' }
  const command = version & 0x0f
  // LOCAL is the proxy speaking for itself — a health check — and names nobody.
  if (command === 0) return { kind: 'header', from: null, length }
  if (command !== 1) return { kind: 'bad', why: 'a version 2 header with an unknown command' }
  const family = (bytes[13] ?? 0) >> 4
  const body = bytes.subarray(16, length)
  if (family === 1) {
    if (body.length < 12) return { kind: 'bad', why: 'a version 2 IPv4 header that is too short' }
    return { kind: 'header', from: [...body.subarray(0, 4)].join('.'), length }
  }
  if (family === 2) {
    if (body.length < 36) return { kind: 'bad', why: 'a version 2 IPv6 header that is too short' }
    const groups: string[] = []
    for (let at = 0; at < 16; at += 2) groups.push(body.readUInt16BE(at).toString(16))
    return { kind: 'header', from: ipv6(groups.join(':')), length }
  }
  // UNSPEC or a Unix socket: a connection, and no address to key a limit by.
  return { kind: 'header', from: null, length }
}

function port(text: string | undefined): boolean {
  return text !== undefined && /^(0|[1-9]\d{0,4})$/.test(text) && Number(text) <= 65535
}

/** A dotted quad, strictly: WHATWG's own parser would take `0x7f.1` too. */
function ipv4(text: string): string | null {
  const byte = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
  return new RegExp(`^${byte}(\\.${byte}){3}$`).test(text) ? text : null
}

/**
 * An IPv6 address in the one spelling Node gives a socket's, so a phone is one
 * key however the proxy wrote it — and a mapped IPv4 one as the IPv4 it is.
 */
function ipv6(text: string): string | null {
  if (!/^[0-9a-f:.]+$/i.test(text)) return null
  const url = `http://[${text}]/`
  // One the URL parser refuses is not an address, which is the whole answer.
  if (!URL.canParse(url)) return null
  const host = new URL(url).hostname.slice(1, -1)
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mapped === null) return host
  const high = Number.parseInt(mapped[1] ?? '0', 16)
  const low = Number.parseInt(mapped[2] ?? '0', 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}
