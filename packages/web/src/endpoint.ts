// Where a notification may be sent, and the whole of why that is a question.
//
// **This is the one place in Tade where an address somebody else chose decides
// what this machine connects to.** Everything else outbound is a host Tade
// wrote down — `api.github.com`, `slack.com/api`, a DSN somebody pasted. A push
// subscription's endpoint arrives *from a browser*, on a request, and the whole
// of the Web Push protocol is "POST to the URL the phone gave you". So the
// request that is about to be made is server-side, authenticated by nothing,
// and aimed wherever that string says — which is the definition of the hole,
// and it is why this file exists before the sender does.
//
// Two layers, and **both are needed because each misses what the other
// catches**:
//
// 1. **The URL** (`endpointAllowed`): `https`, no credentials in it, the
//    default port, a name rather than an address, and bounded. Pure, so
//    `test/endpoint.test.ts` runs the cross-product of every shape somebody
//    would try.
// 2. **The addresses it resolves to** (`addressAllowed`): every one of them
//    has to be a public unicast address. A perfectly ordinary name can answer
//    `127.0.0.1` — that is one DNS record away for anybody, and it is how a
//    validated-looking URL reaches the thing listening on this laptop.
//
// And **the connection is made to the address that was checked**, not to the
// name: `node:https`'s `lookup` is handed the vetted answer, so there is no
// second resolution between the check and the socket for a short TTL to change
// (`push-out.ts`). A checker that resolves and then lets the HTTP client
// resolve again is the DNS-rebinding bug with a validator in front of it.
//
// **Refusing an IP literal outright is deliberate and is not laziness.** Every
// push service there is answers on a name — `web.push.apple.com`,
// `fcm.googleapis.com`, `updates.push.services.mozilla.com`,
// `*.notify.windows.com` — so the whole class goes rather than being filtered,
// and `addressAllowed` is what the names are then held to. The alternative is
// a table of private ranges as the *only* defence, which is the shape that
// gets a new range the day IANA allocates one.

/** How long an endpoint may be. Longer than any real one, bounded all the same. */
export const ENDPOINT_BOUND = 1_024

/** Why an endpoint was refused, in Tade's own words. Never the phone's. */
export interface NotAnEndpoint {
  ok: false
  /** One clause, for the journal and for the device's refusal. */
  why: string
}

/** An endpoint that may be posted to, as the sender needs it. */
export interface Endpoint {
  ok: true
  /** The host, lowercased, with no port. What is resolved and what is dialled. */
  host: string
  /** The path and query, as the push service wrote them. */
  path: string
  /** The origin, for the VAPID audience. Always `https://<host>`. */
  origin: string
}

/** What checking an endpoint came to. */
export type Checked = Endpoint | NotAnEndpoint

/**
 * Whether this string is an endpoint Tade will ever post to.
 *
 * Pure, and every refusal carries a clause rather than a boolean, because the
 * one that matters — *that is not a name* — is the one somebody debugging a
 * self-hosted push service has to be able to read.
 */
export function endpointAllowed(value: string): Checked {
  if (value.length > ENDPOINT_BOUND) return no(`longer than ${ENDPOINT_BOUND} characters`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return no('not a URL')
  }
  // `https` and nothing else. Not a preference: the subscription's `auth` and
  // `p256dh` are the device's, the VAPID header is a bearer-shaped credential
  // for that one request, and plain HTTP would put the whole exchange on the
  // wire of whatever network this machine is on.
  if (url.protocol !== 'https:') return no(`${url.protocol.replace(':', '')} is not https`)
  // Credentials in a URL are a request made *as* somebody. Nothing legitimate
  // puts them there, and the one thing that would is an endpoint crafted to
  // authenticate against something on this network.
  if (url.username !== '' || url.password !== '') return no('carries credentials in the URL')
  // The default port, only. A push service on 443 is every push service there
  // is; an arbitrary port is how one endpoint reaches an admin interface, a
  // metrics port or a database on a host that resolves publicly.
  if (url.port !== '' && url.port !== '443') return no(`port ${url.port} is not 443`)
  const host = url.hostname.toLowerCase()
  if (host === '') return no('has no host')
  // **The whole IP-literal class, refused.** See the note at the top: every
  // real push service answers on a name, so this costs nothing and takes the
  // private-range table out of the critical path.
  if (looksLikeAddress(host)) return no('is an address rather than a name')
  // Names a resolver answers from this machine's own notion of *here*. `.local`
  // is mDNS, `.localhost` is reserved for loopback, and a bare label with no
  // dot in it is whatever the search domain makes it.
  if (host === 'localhost' || host.endsWith('.localhost')) return no('is this machine')
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return no('is a local-network name')
  }
  if (!host.includes('.')) return no('is not a fully qualified name')
  // **The retired GCM endpoint, refused by name**, and this one is not about
  // security. Google's pre-VAPID protocol needs a server API key Tade does not
  // have and will not ask anybody for, and the vetted library answers that
  // shape by printing a warning on stdout — which, in a process whose stdout
  // is a window somebody is looking at, is a frame with a stranger's sentence
  // in the middle of it. Refused here with Tade's own words instead.
  if (host === 'android.googleapis.com') {
    return no('is the retired GCM endpoint, which needs a Google API key Tade does not have')
  }
  return { ok: true, host, path: `${url.pathname}${url.search}`, origin: `https://${host}` }
}

/**
 * Whether a host is written as an address rather than as a name.
 *
 * Both families, and **bracketless**: `URL.hostname` strips the brackets off
 * an IPv6 literal, so what arrives here is bare. A name can never contain a
 * colon, which is the whole of the IPv6 test; the IPv4 test is a name whose
 * last label is all digits, which is what `1.2.3.4` and `example.1` have in
 * common and no real host name has.
 */
export function looksLikeAddress(host: string): boolean {
  if (host.includes(':')) return true
  const last = host.split('.').at(-1) ?? ''
  return last !== '' && /^\d+$/.test(last)
}

/**
 * Whether one resolved address is a public unicast address.
 *
 * The answer to "the name was fine and it resolves here". Every range that is
 * not somewhere on the public internet is refused — loopback, the three
 * private blocks, carrier NAT, link-local, multicast, the documentation and
 * benchmark blocks, and the IPv6 forms that embed an IPv4 address, because
 * those are how a v4 range sneaks past a v6 check.
 *
 * Unknown shapes are **refused**, not allowed: a string this cannot read is
 * not a string to connect to.
 */
export function addressAllowed(address: string): boolean {
  const bare = address.replace(/^\[|]$/g, '').split('%')[0] ?? ''
  if (bare.includes(':')) return allowedSix(bare.toLowerCase())
  return allowedFour(bare)
}

/** An IPv4 address that is somewhere on the public internet. */
function allowedFour(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const bytes: number[] = []
  for (const part of parts) {
    // `010` and `0x7f` are the two spellings a permissive parser accepts and a
    // check written for decimal does not, so anything but plain decimal is
    // refused rather than normalised.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false
    const byte = Number(part)
    if (byte > 255) return false
    bytes.push(byte)
  }
  const [a = 0, b = 0, c = 0] = bytes
  if (a === 0) return false // this network, and `0.0.0.0`
  if (a === 10) return false // private
  if (a === 127) return false // loopback
  if (a === 100 && b >= 64 && b <= 127) return false // carrier NAT
  if (a === 169 && b === 254) return false // link-local
  if (a === 172 && b >= 16 && b <= 31) return false // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // protocol, documentation
  if (a === 192 && b === 88 && c === 99) return false // 6to4 relay anycast
  if (a === 192 && b === 168) return false // private
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && c === 100) return false // documentation
  if (a === 203 && b === 0 && c === 113) return false // documentation
  if (a >= 224) return false // multicast, reserved, broadcast
  return true
}

/**
 * An IPv6 address that is somewhere on the public internet.
 *
 * The embedded-v4 forms are the half worth the words. `::ffff:127.0.0.1`,
 * `64:ff9b::7f00:1` (NAT64), `2002:7f00:0100::` (6to4) and `2001:0:…` (Teredo)
 * all carry an IPv4 address inside an IPv6 one, so a check that only knew
 * about `::1` and `fc00::/7` would let every private v4 range through in v6
 * clothing. Each is refused as a block rather than unpacked, because refusing
 * four blocks nothing legitimate answers on is the smaller rule.
 */
function allowedSix(address: string): boolean {
  if (!/^[0-9a-f:.]+$/.test(address)) return false
  const groups = expandSix(address)
  if (groups === null) return false
  const [first = 0, second = 0] = groups
  if (groups.every((group) => group === 0)) return false // unspecified
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false // loopback
  if ((first & 0xfe00) === 0xfc00) return false // unique local
  if ((first & 0xffc0) === 0xfe80) return false // link local
  if ((first & 0xff00) === 0xff00) return false // multicast
  if (first === 0x0064 && second === 0xff9b) return false // NAT64
  if (first === 0x0100) return false // discard-only
  if (first === 0x2001 && second === 0x0000) return false // Teredo
  if (first === 0x2001 && second === 0x0db8) return false // documentation
  if (first === 0x2002) return false // 6to4
  // `::ffff:a.b.c.d` and `::a.b.c.d`: the top five groups are nought and the
  // bottom two are an IPv4 address, mapped or deprecated-compatible.
  if (groups.slice(0, 5).every((group) => group === 0)) return false
  return true
}

/**
 * An IPv6 address as eight numbers, or null for anything this cannot read.
 *
 * Written out rather than leaning on a parser, because `node:net`'s is a
 * different question (*is this an address*) and this one is *which address* —
 * and because a mis-expansion here is a private range read as public, which is
 * exactly the failure the file exists for. Refusing what it cannot read is the
 * safe direction.
 */
function expandSix(address: string): number[] | null {
  const halves = address.split('::')
  if (halves.length > 2) return null
  const four = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1]
  // A trailing dotted quad is two groups. Read as bytes so `::ffff:1.2.3.4`
  // and `::ffff:102:304` expand to the same eight numbers.
  const tail: number[] = []
  if (four !== undefined) {
    const bytes = four.split('.').map(Number)
    if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null
    tail.push(((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0), ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0))
  }
  const strip = (half: string): string =>
    four === undefined ? half : half.slice(0, half.length - four.length).replace(/:$/, '')
  const read = (half: string, withTail: boolean): number[] | null => {
    const text = withTail ? strip(half) : half
    const parts = text === '' ? [] : text.split(':')
    const out: number[] = []
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      out.push(Number.parseInt(part, 16))
    }
    return withTail ? [...out, ...tail] : out
  }
  if (halves.length === 1) {
    const whole = read(halves[0] ?? '', true)
    return whole !== null && whole.length === 8 ? whole : null
  }
  const head = read(halves[0] ?? '', false)
  const rest = read(halves[1] ?? '', true)
  if (head === null || rest === null) return null
  const missing = 8 - head.length - rest.length
  if (missing < 1) return null
  return [...head, ...Array.from({ length: missing }, () => 0), ...rest]
}

function no(why: string): NotAnEndpoint {
  return { ok: false, why }
}

/** One address a resolver answered with, and which family it is. */
export interface Resolved {
  address: string
  family: 4 | 6
}

/** What a name looked up to, or why it could not be. */
export type Reached =
  | { ok: true; endpoint: Endpoint; addresses: readonly Resolved[] }
  | NotAnEndpoint

/**
 * An endpoint, checked and resolved, with every address held to
 * `addressAllowed`.
 *
 * **Every address and not the first one.** A name that answers one public
 * address and one loopback address is a name whose next lookup may well pick
 * the second, and a check that passed on the first would be a check that
 * passed by luck. All of them, or none.
 *
 * `resolve` is handed in, so the cross-product of answers a resolver can give
 * — several addresses, a mixed family, an empty answer, a throw — is tested
 * without a network (`test/endpoint.test.ts`). The real one is `dns.lookup`
 * with `all: true`, in `push-out.ts`.
 */
export async function reachable(
  value: string,
  resolve: (host: string) => Promise<readonly Resolved[]>,
): Promise<Reached> {
  const checked = endpointAllowed(value)
  if (!checked.ok) return checked
  let addresses: readonly Resolved[]
  try {
    addresses = await resolve(checked.host)
  } catch (error) {
    // A name that could not be looked up is **not** a name that is gone: the
    // machine may simply be offline, and a subscription is not forgotten over
    // one failed lookup. The sender reads this as a retry, never as a `410`.
    return no(`could not be looked up: ${String(error).slice(0, 120)}`)
  }
  if (addresses.length === 0) return no('resolved to no address')
  const refused = addresses.filter((one) => !addressAllowed(one.address))
  if (refused.length > 0) {
    return no(`resolves to ${refused.map((one) => one.address).join(', ')}, which is not public`)
  }
  return { ok: true, endpoint: checked, addresses }
}
