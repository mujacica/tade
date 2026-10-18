import { readdir, readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import {
  type Answer,
  type Caa,
  type CertificateLook,
  type DelegationSigner,
  type Dnssec,
  type DomainSeen,
  type NetworkAddress,
  publicAddresses,
} from '@tade/core'
import { lookAtCertificate } from './certificate.ts'
import {
  type AskOptions,
  ask,
  canonical6,
  type Data,
  dsOf,
  NOERROR,
  NXDOMAIN,
  type Question,
  type Reply,
  type Rr,
  SERVFAIL,
} from './dns.ts'

// The look behind `tade host domain` and the Public name row: every record a
// public name needs, resolved twice — by the zone's own servers and by a public
// resolver — and the rest of what deciding needs, from this machine. What it
// comes to is `domainSays` (`@tade/core`), which is pure.
//
// **Which resolvers, and why public ones.** "Visible" means what everybody else
// sees, so it is asked of resolvers everybody else uses, and of ones that
// validate DNSSEC, because Let's Encrypt does. Asking them sends the name and
// nothing else, which is what any lookup of it does. The machine's own
// resolver is not asked: it may be a cache on this box, which would call a
// record visible that only this box can see.
//
// **Asking the world is not free** (`set-up-the-machine`): this runs when
// somebody asks — the command, or the Settings row being looked at — and never
// on a clock. Every ask has a deadline, a server that did not answer is not
// asked again in the same look, and it never throws: what could not be asked
// is an answer.

/** Resolvers that validate DNSSEC, asked in turn until one answers: Cloudflare's, then Google's. */
export const RESOLVERS = ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']

/** Where Caddy, installed from its own package, keeps its account at Let's Encrypt. */
export const CADDY_ACCOUNTS =
  '/var/lib/caddy/.local/share/caddy/acme/acme-v02.api.letsencrypt.org-directory/users'

/** How long a connection to 443 may take before the address is said not to answer. */
export const SERVES_MS = 2_000

export interface DomainOptions {
  /** The world's resolvers, in order. */
  resolvers?: readonly string[]
  /** The zone's own servers, instead of the ones its NS records name: a test's. */
  zoneServers?: readonly string[]
  /** Every DNS server's port, and each ask's deadline: a test's. */
  ask?: AskOptions
  interfaces?: () => Readonly<Record<string, readonly NetworkAddress[] | undefined>>
  /** Whether something answers on 443 at an address of this machine. */
  serves?: (address: string) => Promise<boolean>
  certificate?: (name: string) => Promise<CertificateLook>
  /** Caddy's account, or why it could not be read; `caddyAccount` where not given. */
  account?: () => Promise<{ uri: string } | { cannot: string }>
}

/** Look at every record `name` needs, from here. Never throws. */
export async function lookAtDomain(name: string, opts: DomainOptions = {}): Promise<DomainSeen> {
  const named = name.toLowerCase().replace(/\.$/, '')
  // What does not need DNS starts now, beside it.
  const here = publicAddresses((opts.interfaces ?? networkInterfaces)())
  const v6 = here.v6.map(canonical6)
  const serves = opts.serves ?? ((one: string) => servesHttps(one))
  const serving = Promise.all(
    [...here.v4, ...v6].map(async (one) => ((await serves(one)) ? [one] : [])),
  ).then((all) => all.flat())
  const certificate = (opts.certificate ?? lookAtCertificate)(named)
  const account = (opts.account ?? caddyAccount)()

  const world = asker(opts.resolvers ?? RESOLVERS, opts.ask)
  const zone = await zoneOf(named, world)
  const servers =
    opts.zoneServers ?? ('apex' in zone ? await addressesOf(zone.nameservers, world) : [])
  const own = servers.length === 0 ? null : asker(servers, opts.ask)
  const ofOwn = (type: 'A' | 'AAAA' | 'CAA') =>
    own === null ? null : own({ name: named, type, recurse: false })

  const [ownA, ownAaaa, ownCaa, worldA, worldAaaa, caa, dnssec] = await Promise.all([
    ofOwn('A'),
    ofOwn('AAAA'),
    ofOwn('CAA'),
    world({ name: named, type: 'A', recurse: true }),
    world({ name: named, type: 'AAAA', recurse: true }),
    governing(named, world),
    'apex' in zone ? dnssecOf(zone.apex, world, own) : { cannot: zone.cannot },
  ])
  return {
    name: named,
    zone: 'apex' in zone ? { apex: zone.apex, servers: zone.nameservers } : zone,
    own:
      ownA === null || ownAaaa === null || ownCaa === null
        ? null
        : { a: answerOf(ownA, 'A'), aaaa: answerOf(ownAaaa, 'AAAA'), caa: caaOf(ownCaa) },
    world: { a: answerOf(worldA, 'A'), aaaa: answerOf(worldAaaa, 'AAAA') },
    caa,
    dnssec,
    here: { v4: here.v4, v6 },
    serving: await serving,
    certificate: await certificate,
    account: await account,
  }
}

type Asker = (question: Question) => Promise<Reply | { cannot: string }>

/**
 * Ask a list of servers, each question of the first that answers. One that
 * did not answer is not asked again in this look, so a machine with no
 * network waits on each server once rather than once per question.
 */
function asker(servers: readonly string[], opts: AskOptions | undefined): Asker {
  /** Each server that did not answer, and why: said again for every question after. */
  const dead = new Map<string, string>()
  return async (question) => {
    let why = 'nobody to ask'
    for (const server of servers) {
      const was = dead.get(server)
      if (was !== undefined) {
        why = was
        continue
      }
      const got = await ask(server, question, opts)
      if (!('cannot' in got)) return got
      dead.set(server, got.cannot)
      why = got.cannot
    }
    return { cannot: why }
  }
}

/**
 * The zone `name` is in, out of the SOA its servers name in answer to a
 * question about it — its own where it is the apex, the one in the authority
 * section where it is not, or does not exist yet. Checking off, so a zone with
 * broken DNSSEC is still found; that is `dnssecOf`'s to say.
 */
async function zoneOf(
  name: string,
  world: Asker,
): Promise<{ apex: string; nameservers: string[] } | { cannot: string }> {
  let asking = name
  for (;;) {
    const got = await world({ name: asking, type: 'SOA', recurse: true, unchecked: true })
    if ('cannot' in got) return { cannot: got.cannot }
    if (got.rcode !== NOERROR && got.rcode !== NXDOMAIN) return { cannot: rcodeOf(got.rcode) }
    // A name that is an alias says nothing about its own zone: the SOA that
    // comes back is its target's. Its parent's zone is the one it is in.
    const alias = got.answers.some((one) => one.name === asking && one.data.type === 'CNAME')
    const soa = [...got.answers, ...got.authority].find((one) => one.data.type === 'SOA')
    if (!alias && soa !== undefined) {
      // The nearest zone that answers is a top-level domain or the root
      // itself: nobody registered the name, and the root's servers and its
      // signature say nothing about it.
      const apex = soa.name.replace(/\.$/, '')
      if (!apex.includes('.')) {
        return {
          cannot: `nobody has registered it — the nearest zone that answers is ${apex === '' ? 'the root' : `.${apex}`}`,
        }
      }
      const ns = await world({ name: soa.name, type: 'NS', recurse: true, unchecked: true })
      const nameservers =
        'cannot' in ns ? [] : ns.answers.flatMap((one) => targetOf(one.data)).sort()
      return { apex: soa.name, nameservers }
    }
    const parent = asking.split('.').slice(1).join('.')
    if (alias && parent.includes('.')) asking = parent
    else return { cannot: `no SOA came back for ${asking}` }
  }
}

/** Two of the zone's servers' addresses: one answering is enough, a second is for the one that does not. */
async function addressesOf(nameservers: readonly string[], world: Asker): Promise<string[]> {
  const out: string[] = []
  for (const one of nameservers) {
    if (out.length === 2) break
    const got = await world({ name: one, type: 'A', recurse: true, unchecked: true })
    if ('cannot' in got) continue
    const address = got.answers.flatMap((rr) => (rr.data.type === 'A' ? [rr.data.address] : []))[0]
    if (address !== undefined) out.push(address)
  }
  return out
}

/**
 * The CAA set that governs `name`: its own, or the closest one above it, which
 * is the set a CA reads (RFC 8659). Where there is none anywhere, the answer at
 * the name itself.
 */
async function governing(name: string, world: Asker): Promise<DomainSeen['caa']> {
  let first: Answer<Caa> | null = null
  for (let at = name; at.includes('.'); at = at.split('.').slice(1).join('.')) {
    const answer = caaOf(await world({ name: at, type: 'CAA', recurse: true }))
    first ??= answer
    if ('failed' in answer || ('found' in answer && answer.found.length > 0)) return { at, answer }
  }
  return { at: name, answer: first ?? { failed: 'nothing to ask' } }
}

/**
 * Whether a validating resolver can answer for the zone: asked with checking
 * on, where a zone whose signatures do not validate is SERVFAIL while the same
 * question with checking off (`zoneOf`) was answered. Where it is broken, what
 * the registrar has and what the zone's own keys would need.
 */
async function dnssecOf(apex: string, world: Asker, own: Asker | null): Promise<Dnssec> {
  const checked = await world({ name: apex, type: 'SOA', recurse: true })
  if ('cannot' in checked) return { cannot: checked.cannot }
  if (checked.rcode === NOERROR)
    return checked.authenticated ? { validates: true } : { unsigned: true }
  if (checked.rcode !== SERVFAIL)
    return { cannot: `resolvers answered ${rcodeOf(checked.rcode)} for ${apex}` }
  // SERVFAIL is also a zone whose servers do not answer. Only where the same
  // question with checking off is answered is it the signatures.
  const unchecked = await world({ name: apex, type: 'SOA', recurse: true, unchecked: true })
  if ('cannot' in unchecked || unchecked.rcode !== NOERROR) {
    return { cannot: `resolvers could not reach the servers that answer for ${apex}` }
  }
  const ds = await world({ name: apex, type: 'DS', recurse: true, unchecked: true })
  const registrar =
    'cannot' in ds
      ? []
      : ds.answers.flatMap((one): DelegationSigner[] => {
          if (one.data.type !== 'DS') return []
          const { keyTag, algorithm, digestType, digest } = one.data
          return [{ keyTag, algorithm, digestType, digest }]
        })
  const keys = own === null ? null : await own({ name: apex, type: 'DNSKEY', recurse: false })
  if (keys === null || 'cannot' in keys || keys.rcode !== NOERROR) {
    return { broken: true, registrar, zone: null }
  }
  const all = keys.answers.flatMap((one) => (one.data.type === 'DNSKEY' ? [one.data] : []))
  // The keys a DS names are the ones marked secure entry point (257); a zone
  // signed with one key for both has only that one.
  const entry = all.filter((one) => (one.flags & 1) === 1)
  const zone = (entry.length > 0 ? entry : all).map((one) => dsOf(apex, one.rdata, one.algorithm))
  return { broken: true, registrar, zone }
}

/** A reply, as an answer about addresses of one type. */
function answerOf(got: Reply | { cannot: string }, type: 'A' | 'AAAA'): Answer {
  return answered(got, (data) =>
    data.type === type ? [type === 'AAAA' ? canonical6(data.address) : data.address] : [],
  )
}

function caaOf(got: Reply | { cannot: string }): Answer<Caa> {
  return answered(got, (data) =>
    data.type === 'CAA' ? [{ flags: data.flags, tag: data.tag, value: data.value }] : [],
  )
}

function answered<T>(got: Reply | { cannot: string }, pick: (data: Data) => T[]): Answer<T> {
  if ('cannot' in got) return { failed: got.cannot }
  if (got.truncated) return { failed: 'the answer was too big to come over UDP' }
  if (got.rcode !== NOERROR && got.rcode !== NXDOMAIN) return { failed: rcodeOf(got.rcode) }
  const records = got.answers.filter((one) => pick(one.data).length > 0)
  if (records.length > 0) {
    return {
      found: records.flatMap((one) => pick(one.data)),
      ttl: Math.min(...records.map((one) => one.ttl)),
      validated: got.authenticated,
    }
  }
  // An alias to a name somewhere else, from a zone's own server that does not
  // resolve it: not a "none", and nothing this can compare. The world's answer
  // follows it.
  if (got.answers.some((one) => one.data.type === 'CNAME')) {
    return { failed: 'an alias to a name outside the zone' }
  }
  return {
    none: got.rcode === NXDOMAIN ? 'name' : 'type',
    ttl: negativeTtl(got.authority),
    validated: got.authenticated,
  }
}

/** How long a resolver may remember "none": the SOA's own TTL or its minimum, whichever is less (RFC 2308). */
function negativeTtl(authority: readonly Rr[]): number | null {
  const soa = authority.find((one) => one.data.type === 'SOA')
  if (soa === undefined || soa.data.type !== 'SOA') return null
  return Math.min(soa.ttl, soa.data.minimum)
}

function targetOf(data: Data): string[] {
  return data.type === 'NS' ? [data.target] : []
}

function rcodeOf(rcode: number): string {
  const names: Record<number, string> = { 1: 'FORMERR', 2: 'SERVFAIL', 4: 'NOTIMP', 5: 'REFUSED' }
  return names[rcode] ?? `response code ${rcode}`
}

/** Whether something answers on 443 at `address`, asked from here. `port` is a test's. */
export function servesHttps(
  address: string,
  opts: { port?: number; ms?: number } = {},
): Promise<boolean> {
  const ms = opts.ms ?? SERVES_MS
  return new Promise((done) => {
    const socket = connect({ host: address, port: opts.port ?? 443 })
    const answer = (yes: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      done(yes)
    }
    const timer = setTimeout(() => answer(false), ms)
    socket.once('connect', () => answer(true))
    socket.once('error', () => answer(false))
  })
}

/**
 * The URI of Caddy's account at Let's Encrypt, out of the file Caddy keeps it
 * in (`location`, as certmagic writes it) — or why it could not be read, in
 * words that end in how to read it. Caddy keeps it where only its own user can
 * read, so on a box set up as `tade host caddy` says, the answer is usually the
 * command.
 */
export async function caddyAccount(
  dir = CADDY_ACCOUNTS,
): Promise<{ uri: string } | { cannot: string }> {
  const how = `\`sudo sh -c 'grep -h location ${dir}/*/*.json'\` prints it, for \`tade host domain <name> --account <uri>\``
  try {
    for (const user of (await readdir(dir)).sort()) {
      for (const file of (await readdir(join(dir, user))).sort()) {
        if (!file.endsWith('.json')) continue
        const read: unknown = JSON.parse(await readFile(join(dir, user, file), 'utf8'))
        const uri = (read as { location?: unknown }).location
        if (typeof uri === 'string' && accountUri(uri)) return { uri }
      }
    }
    return { cannot: `Caddy has no account at Let's Encrypt in ${dir} yet` }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { cannot: `Caddy has no account at Let's Encrypt here yet` }
    if (code === 'EACCES') return { cannot: `only Caddy can read where it keeps it: ${how}` }
    return { cannot: `${code ?? String(err)}: ${how}` }
  }
}

/**
 * Whether `uri` may go into a CAA record as an account: an https URL with no
 * space, quote or semicolon, which are what would end the value early.
 */
export function accountUri(uri: string): boolean {
  return /^https:\/\/[^\s";]+$/.test(uri)
}
