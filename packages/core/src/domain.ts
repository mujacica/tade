import type { NetworkAddress } from './network.ts'
import type { CertificateLook } from './public-listener.ts'

// The records a public name needs, and what each one comes to (REMOTE-TADE
// §7.3): `tade host domain` and the Public name row in Settings › Away view.
//
// Pure: what was resolved in, one line per record out, so the terminal and
// the window say the same words about the same answers. The asking is
// `@tade/workbench/domain`'s.
//
// **Two answers per record, because "missing" and "not yet visible" are two
// different things to do.** The zone's own servers say what is true now; a
// public resolver says what everybody else sees, which is the zone as it was up
// to a TTL ago. A record the zone has and the world does not yet is one to wait
// for rather than add again, and how long is the resolver's own countdown.
//
// **In the order they are done.** A first. AAAA only where IPv6 answers on 443,
// because Let's Encrypt tries IPv6 first and an AAAA nothing answers on fails
// the validation outright. DNSSEC before ordering, because a signed zone whose
// signatures do not validate makes the CAA lookup fail, and every CA has had to
// check it since 2026-03-15. CAA last, after the first certificate, because
// the record that keeps every other issuer out names Caddy's account at Let's
// Encrypt (RFC 8657), and that account exists once it has ordered one.
//
// **Nothing at the registrar is Tade's**, so every line that wants something
// done there gives the record exactly, as a zone file line, and nothing here
// holds a DNS API token: neither challenge Caddy uses needs one.

/** One CAA record: `0 issue "letsencrypt.org"`. */
export interface Caa {
  flags: number
  tag: string
  value: string
}

/**
 * What one DNS server said about one name and one type: the records, that
 * there are none — no such name, or none of that type — or that it could not
 * answer. `ttl` on `none` is how long a resolver may remember that, where the
 * zone said. `validated` is a validating resolver's word that DNSSEC checked.
 */
export type Answer<T = string> =
  | { found: readonly T[]; ttl: number; validated: boolean }
  | { none: 'name' | 'type'; ttl: number | null; validated: boolean }
  | { failed: string }

/** A DS record, at the registrar or as the zone's key would need it. */
export interface DelegationSigner {
  keyTag: number
  algorithm: number
  digestType: number
  /** Hex, upper case, as registrars show it. */
  digest: string
}

/**
 * Whether a validating resolver can answer for the zone. `broken` carries what
 * the registrar holds and what the zone's own signing keys would need, which
 * is the whole of what fixing it at a registrar takes.
 */
export type Dnssec =
  | { validates: true }
  | { unsigned: true }
  | {
      broken: true
      registrar: readonly DelegationSigner[]
      /** What the zone's keys would need, or null where its keys could not be read. */
      zone: readonly DelegationSigner[] | null
    }
  | { cannot: string }

/** Everything the look found, from this machine. */
export interface DomainSeen {
  name: string
  /** The zone the name is in, and the servers that answer for it — or why they could not be found. */
  zone: { apex: string; servers: readonly string[] } | { cannot: string }
  /** What the zone's own servers say, which is what is true now. Null where none could be asked. */
  own: { a: Answer; aaaa: Answer; caa: Answer<Caa> } | null
  /** What a public resolver that validates DNSSEC says, which is what everybody else sees. */
  world: { a: Answer; aaaa: Answer }
  /** The CAA set that governs the name — its own, or the closest one above it — and where it is. */
  caa: { at: string; answer: Answer<Caa> }
  dnssec: Dnssec
  /** This machine's own public addresses (`publicAddresses`). */
  here: { v4: readonly string[]; v6: readonly string[] }
  /** Which of this machine's public addresses answered on 443. */
  serving: readonly string[]
  /** The certificate the name answers with (`lookAtCertificate`). */
  certificate: CertificateLook
  /** The URI of Caddy's account at Let's Encrypt, or why it could not be read. */
  account: { uri: string } | { cannot: string }
}

export type RecordState = 'right' | 'missing' | 'wrong' | 'unseen' | 'later' | 'cannot'

/** What one record comes to: one line, and what to do at the registrar. */
export interface DomainLine {
  record: 'A' | 'AAAA' | 'DNSSEC' | 'CAA'
  state: RecordState
  /** One line: what was found, and what that means. */
  said: string
  /** The record to add, exactly, as a zone file line. */
  add: string | null
  /** The records in the way, to take away. */
  remove: readonly string[]
  /** It stops a certificate being issued, or sends people somewhere that is not here. */
  loud: boolean
}

/** The installer's domain. */
export const TADE_SH = 'tade.sh'

/**
 * Why `tade.sh` and every name under it are refused as a public name: said
 * where the name is given, in the CLI, in Settings and in `tade config
 * --check`, because the schema refuses it.
 */
export const TADE_SH_IS_THE_INSTALLER =
  'tade.sh serves the installer that people pipe into a shell, so neither it nor any name under ' +
  'it may be a public name: a box with agents on it that answered as one could, if it were ' +
  'ever taken over, put pages on the domain installs come from. Use a domain of your own — ' +
  'tade.example.com.'

/** Why `name` may not be a public name, or null where it may. */
export function refusedName(name: string): string | null {
  const named = name.toLowerCase().replace(/\.$/, '')
  return named === TADE_SH || named.endsWith(`.${TADE_SH}`) ? TADE_SH_IS_THE_INSTALLER : null
}

/**
 * This machine's own public addresses, out of `os.networkInterfaces()`.
 *
 * What a record must point at, when the box has its address on an interface
 * of its own — which a VPS does. A box behind NAT has none, and then where a
 * record points can be read and not checked, which the line says rather than
 * calling it wrong.
 */
export function publicAddresses(
  interfaces: Readonly<Record<string, readonly NetworkAddress[] | undefined>>,
): { v4: string[]; v6: string[] } {
  const v4: string[] = []
  const v6: string[] = []
  for (const addresses of Object.values(interfaces)) {
    for (const one of addresses ?? []) {
      if (one.internal) continue
      if (one.address.includes(':')) {
        // Global unicast is 2000::/3; everything else here is link-local,
        // unique-local or a mapped address, none of which the internet reaches.
        if (/^[23]/.test(one.address) && !v6.includes(one.address)) v6.push(one.address)
      } else if (publicV4(one.address) && !v4.includes(one.address)) v4.push(one.address)
    }
  }
  return { v4, v6 }
}

function publicV4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  return !(a === 192 && b === 168)
}

/**
 * The CAA record that keeps every issuer but Caddy's account at Let's Encrypt
 * out, for the two ways Caddy proves a name (RFC 8657). Without an account, the
 * same record naming Let's Encrypt alone.
 */
export function caaRecord(name: string, account: string | null): string {
  const uri = account === null ? '' : `accounturi=${account}; `
  return `${name}. CAA 0 issue "letsencrypt.org; ${uri}validationmethods=tls-alpn-01,http-01"`
}

/** The look, a line per record, in the order they are done. */
export function domainSays(seen: DomainSeen): DomainLine[] {
  return [aSays(seen), aaaaSays(seen), dnssecSays(seen), caaSays(seen)]
}

/** The line above them: which zone the name is in, and who answers for it. */
export function domainHead(seen: DomainSeen): string {
  if ('cannot' in seen.zone) {
    return `${seen.name}: which zone it is in could not be found (${seen.zone.cannot}), so this is what resolvers see, and nothing can be called not yet visible`
  }
  const servers = seen.zone.servers.length === 0 ? 'nobody' : seen.zone.servers.join(', ')
  return `${seen.name}, in the zone ${seen.zone.apex}, answered for by ${servers}`
}

/**
 * The name, written as the public name and added to the trusted hostnames —
 * or null where both already have it.
 *
 * **Only ever on a press.** The name is the one the person gave, and nothing
 * here guesses one: a name Tade typed in would be a decision about who reaches
 * this machine made by something other than the person. Added to the trusted
 * hostnames rather than replacing them, so a tailnet name already there stays.
 */
export function trustedWrite(
  web: { public: string; trusted_hosts: readonly string[] },
  name: string,
): { public: string; trusted_hosts: string[] } | null {
  const named = name.toLowerCase()
  const trusted = web.trusted_hosts.some((one) => one.toLowerCase() === named)
  if (web.public.toLowerCase() === named && trusted) return null
  return {
    public: named,
    trusted_hosts: trusted ? [...web.trusted_hosts] : [...web.trusted_hosts, named],
  }
}

// ── one record each ──

function line(
  record: DomainLine['record'],
  state: RecordState,
  said: string,
  more: { add?: string | null; remove?: readonly string[]; loud?: boolean } = {},
): DomainLine {
  return {
    record,
    state,
    said,
    add: more.add ?? null,
    remove: more.remove ?? [],
    loud: more.loud ?? false,
  }
}

/** The zone's own answer where it gave one, and the world's where it could not. */
function truthOf(own: Answer | undefined, world: Answer): Answer {
  return own === undefined || 'failed' in own ? world : own
}

function aSays(seen: DomainSeen): DomainLine {
  const { name } = seen
  const truth = truthOf(seen.own?.a, seen.world.a)
  const want = seen.here.v4[0]
  const add = want === undefined ? null : `${name}. A ${want}`
  if ('failed' in truth)
    return line('A', 'cannot', `A: nothing answered for ${name}: ${truth.failed}`)
  if ('none' in truth) {
    return line(
      'A',
      'missing',
      want === undefined
        ? `A: missing for ${name}, and this machine has no public IPv4 of its own to point it at — the one the internet reaches it by`
        : `A: missing for ${name}`,
      { add, loud: true },
    )
  }
  const to = truth.found.join(', ')
  if (want === undefined) {
    return line(
      'A',
      'cannot',
      `A: ${name} → ${to}; this machine has no public IPv4 of its own, so whether that reaches it cannot be told here`,
    )
  }
  const elsewhere = truth.found.filter((one) => !seen.here.v4.includes(one))
  if (elsewhere.length > 0) {
    return line('A', 'wrong', `A: ${name} → ${to}, which is not this machine (${want})`, {
      add: truth.found.includes(want) ? null : add,
      remove: elsewhere.map((one) => `${name}. A ${one}`),
      loud: true,
    })
  }
  return visible('A', name, truth.found, seen.world.a, `A: ${name} → ${to}, this machine`)
}

function aaaaSays(seen: DomainSeen): DomainLine {
  const { name } = seen
  const truth = truthOf(seen.own?.aaaa, seen.world.aaaa)
  const serves = seen.here.v6.filter((one) => seen.serving.includes(one))
  const offer = serves[0] === undefined ? null : `${name}. AAAA ${serves[0]}`
  if ('failed' in truth) {
    return line('AAAA', 'cannot', `AAAA: nothing answered for ${name}: ${truth.failed}`)
  }
  if ('none' in truth) {
    if (offer !== null) {
      // Missing, and nothing stops for it: Let's Encrypt and every phone on
      // IPv4 use the A record. Worth adding for a phone on IPv6 alone.
      return line(
        'AAAA',
        'missing',
        `AAAA: none, and 443 answers on IPv6 here, so one may be added`,
        {
          add: offer,
        },
      )
    }
    return line(
      'AAAA',
      'right',
      seen.here.v6.length === 0
        ? 'AAAA: none, which is right: this machine has no public IPv6'
        : 'AAAA: none, which is right while 443 does not answer on IPv6 here',
    )
  }
  const to = truth.found.join(', ')
  const remove = truth.found.map((one) => `${name}. AAAA ${one}`)
  const elsewhere = truth.found.filter((one) => !seen.here.v6.includes(one))
  if (elsewhere.length > 0) {
    return line(
      'AAAA',
      'wrong',
      seen.here.v6.length === 0
        ? `AAAA: ${name} → ${to}, and this machine has no public IPv6, which Let's Encrypt tries first`
        : `AAAA: ${name} → ${to}, which is not this machine, and Let's Encrypt tries IPv6 first`,
      { add: offer, remove: elsewhere.map((one) => `${name}. AAAA ${one}`), loud: true },
    )
  }
  if (!truth.found.every((one) => seen.serving.includes(one))) {
    if (seen.serving.length === 0) {
      return line(
        'AAAA',
        'later',
        `AAAA: ${name} → ${to}, this machine; nothing answers on 443 here yet, so whether IPv6 does is told once Caddy is up`,
      )
    }
    return line(
      'AAAA',
      'wrong',
      `AAAA: ${name} → ${to}, where 443 does not answer, and Let's Encrypt tries IPv6 first: take it away, or have Caddy answer there`,
      { remove, loud: true },
    )
  }
  return visible('AAAA', name, truth.found, seen.world.aaaa, `AAAA: ${name} → ${to}, this machine`)
}

/** Right where the world sees what the zone says, and not yet visible where it does not. */
function visible(
  record: 'A' | 'AAAA',
  name: string,
  found: readonly string[],
  world: Answer,
  right: string,
): DomainLine {
  if ('found' in world && sameSet(world.found, found)) return line(record, 'right', right)
  if ('failed' in world) {
    return line(
      record,
      'unseen',
      `${record}: right at the zone's own servers, and resolvers could not answer for ${name}: ${world.failed}`,
      { loud: true },
    )
  }
  const had = 'found' in world ? world.found.join(', ') : 'none'
  const wait = world.ttl === null ? '' : ` for up to ${duration(world.ttl)}`
  return line(
    record,
    'unseen',
    `${record}: right at the zone's own servers, and not yet visible: resolvers keep ${had}${wait}`,
  )
}

function dnssecSays(seen: DomainSeen): DomainLine {
  const { dnssec } = seen
  const apex = 'apex' in seen.zone ? seen.zone.apex : seen.name
  if ('cannot' in dnssec) return line('DNSSEC', 'cannot', `DNSSEC: cannot tell: ${dnssec.cannot}`)
  if ('validates' in dnssec)
    return line('DNSSEC', 'right', `DNSSEC: ${apex} is signed, and it validates`)
  if ('unsigned' in dnssec) {
    return line('DNSSEC', 'right', `DNSSEC: ${apex} is not signed, so there is nothing to break`)
  }
  const refused = 'resolvers that check refuse every answer, and no CA will issue'
  const ds = (one: DelegationSigner) =>
    `${apex}. DS ${one.keyTag} ${one.algorithm} ${one.digestType} ${one.digest}`
  const remove = dnssec.registrar.map(ds)
  if (dnssec.zone === null) {
    return line(
      'DNSSEC',
      'wrong',
      `DNSSEC: ${apex} does not validate, so ${refused}, and the zone's own keys could not be read to say why`,
      { loud: true },
    )
  }
  const wanted = dnssec.zone[0]
  if (wanted === undefined) {
    return line(
      'DNSSEC',
      'wrong',
      `DNSSEC: the registrar has a DS record for ${apex} and the zone is not signed, so ${refused}: take the DS record away at the registrar`,
      { remove, loud: true },
    )
  }
  const tags = new Set(dnssec.zone.map((one) => one.keyTag))
  if (!dnssec.registrar.some((one) => tags.has(one.keyTag))) {
    return line(
      'DNSSEC',
      'wrong',
      `DNSSEC: the registrar's DS record for ${apex} names a key the zone is not signed with, so ${refused}: replace it at the registrar`,
      { add: ds(wanted), remove, loud: true },
    )
  }
  return line(
    'DNSSEC',
    'wrong',
    `DNSSEC: ${apex}'s signatures do not validate, so ${refused}: sign the zone again at its DNS host`,
    { loud: true },
  )
}

function caaSays(seen: DomainSeen): DomainLine {
  const { name } = seen
  const world = seen.caa
  const account = 'uri' in seen.account ? seen.account.uri : null
  const record = caaRecord(name, account)
  // The zone's own set at the name where it has one, because the closest set
  // wins and that is what is true now; the closest one resolvers see where it
  // has none. A set the zone has and resolvers do not yet is judged as it will
  // be, and only then said to be not yet visible.
  const own = seen.own?.caa
  const mine = own !== undefined && 'found' in own && own.found.length > 0 ? own.found : null
  if (mine === null && 'failed' in world.answer) {
    return line(
      'CAA',
      'wrong',
      `CAA: resolvers could not answer for ${world.at} (${world.answer.failed}), and a CA that cannot read CAA does not issue`,
      { loud: true },
    )
  }
  const at = mine === null ? world.at : name
  const all = mine ?? ('found' in world.answer ? world.answer.found : [])
  const set = all.filter((one) => one.tag.toLowerCase() === 'issue')
  const ours = set.filter((one) => issuerOf(one.value) === 'letsencrypt.org')
  // No `issue` property at all lets any CA issue (RFC 8659), which includes
  // Let's Encrypt; a set that names others and not it is the one that stops it.
  if (set.length > 0 && ours.length === 0) {
    const who = [...new Set(set.map((one) => issuerOf(one.value) || 'no CA at all'))].join(', ')
    return line(
      'CAA',
      'wrong',
      `CAA: ${at} lets ${who} issue and not Let's Encrypt, so Caddy cannot get a certificate for ${name}`,
      { add: record, loud: true },
    )
  }
  const pinned = ours.flatMap((one) => paramOf(one.value, 'accounturi') ?? [])
  if (account !== null && pinned.length > 0 && !pinned.includes(account)) {
    return line(
      'CAA',
      'wrong',
      `CAA: ${at} lets Let's Encrypt issue only to ${pinned.join(', ')}, and Caddy's account is ${account}`,
      { add: record, loud: true },
    )
  }
  const seenAtName = world.at === name && 'found' in world.answer ? world.answer.found : []
  if (mine !== null && !sameSet(mine.map(caaText), seenAtName.map(caaText))) {
    const wait =
      'failed' in world.answer || world.answer.ttl === null
        ? ''
        : ` for up to ${duration(world.answer.ttl)}`
    return line(
      'CAA',
      'unseen',
      `CAA: at the zone's own servers for ${name}, and not yet visible: resolvers keep what they had${wait}`,
    )
  }
  const cert = seen.certificate
  if ('cannot' in cert || !cert.seen.authorized || cert.seen.validTo <= cert.at) {
    return line(
      'CAA',
      'later',
      "CAA: after the first certificate — the record names Caddy's account at Let's Encrypt, which exists once it has ordered one",
    )
  }
  if (!/let'?s ?encrypt/i.test(cert.seen.issuer)) {
    return line(
      'CAA',
      'later',
      `CAA: the certificate for ${name} is from ${cert.seen.issuer}, and the record names Let's Encrypt, so it waits for Caddy's first one from there`,
    )
  }
  const how =
    'cannot' in seen.account ? ` — Caddy's account could not be read: ${seen.account.cannot}` : ''
  if (ours.length === 0) {
    return line('CAA', 'missing', `CAA: none, so any CA may issue for ${name}${how}`, {
      add: record,
    })
  }
  if (account !== null && pinned.length === 0) {
    return line(
      'CAA',
      'missing',
      `CAA: ${at} lets Let's Encrypt issue to any account, and this narrows it to Caddy's`,
      { add: record },
    )
  }
  return line(
    'CAA',
    'right',
    pinned.length > 0
      ? `CAA: only Caddy's account at Let's Encrypt may issue for ${name}`
      : `CAA: ${at} lets only Let's Encrypt issue${how}`,
  )
}

/** A CAA record as a zone file has it after the name, for comparing two sets. */
function caaText(one: Caa): string {
  return `${one.flags} ${one.tag.toLowerCase()} "${one.value}"`
}

/** The issuer domain a CAA `issue` value names: `letsencrypt.org; accounturi=…` → `letsencrypt.org`. */
function issuerOf(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase()
}

function paramOf(value: string, key: string): string | null {
  for (const part of value.split(';').slice(1)) {
    const [k, v] = part.split('=').map((one) => one.trim())
    if (k?.toLowerCase() === key && v !== undefined && v !== '') return v
  }
  return null
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((one) => b.includes(one))
}

function duration(seconds: number): string {
  if (seconds < 120) return `${seconds} s`
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}
