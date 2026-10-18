import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { type CertificateLook, type DomainSeen, domainSays } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { ask, canonical6, decodeReply, dsOf, encodeQuery, ipv6, keyTag } from '../src/dns.ts'
import {
  accountUri,
  CADDY_ACCOUNTS,
  caddyAccount,
  type DomainOptions,
  lookAtDomain,
  servesHttps,
} from '../src/domain.ts'
import { type Asked, type DnsServer, dnsServer, rr, type Served, soa } from './dns-server.ts'

// The look behind `tade host domain`, over a real socket to a DNS server on
// loopback (`dns-server.ts`) that answers as a resolver and as a zone's own
// servers both — so nothing here reaches the network, and what it comes to is
// `domainSays`, tested on its own in `@tade/core`.

const NAME = 'tade.example.com'
const HERE4 = '203.0.113.7'
const ACCOUNT = 'https://acme-v02.api.letsencrypt.org/acme/acct/1234567'
const NOW = Date.UTC(2026, 9, 16)
const DAY = 86_400_000
const NOERROR = 0
const SERVFAIL = 2
const NXDOMAIN = 3

const LETS_ENCRYPT: CertificateLook = {
  at: NOW,
  seen: {
    validFrom: NOW - 10 * DAY,
    validTo: NOW + 80 * DAY,
    issuer: "Let's Encrypt",
    authorized: true,
    error: null,
  },
}

/** The KSK of `dnssec-failed.org`, Comcast's zone broken on purpose, as `dig DNSKEY` read it. */
const KSK = Buffer.concat([
  Buffer.from([0x01, 0x01, 3, 13]),
  Buffer.from(
    '1CcdGV2EigL5bsrPpkSvYHzyfYR1udWKZtWHU9EQXMrbtKglmUDYKKkwwajHQQ7TAMIit/vQbCrh4SPkxLbhgg==',
    'base64',
  ),
])
/** Its DS, as Python's hashlib made it from the same bytes, and its key tag as dig says. */
const KSK_DIGEST = 'D602C971A02AF89B7661B99D6DD1B9E2EC876617631D04F633902A42CD4D6BBD'
const KSK_TAG = 50719

const servers: DnsServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((one) => one.close()))
})

async function serving(serve: (asked: Asked) => Served | null): Promise<DnsServer> {
  const one = await dnsServer(serve)
  servers.push(one)
  return one
}

/** One server, as the world's resolver and the zone's own: what a test may ask. */
function from(at: DnsServer, over: Partial<DomainOptions> = {}): DomainOptions {
  return {
    resolvers: ['127.0.0.1'],
    zoneServers: ['127.0.0.1'],
    ask: { port: at.port, ms: 400, tries: 1 },
    interfaces: () => ({ eth0: [{ address: HERE4, internal: false }] }),
    serves: async () => false,
    certificate: async () => ({ at: NOW, cannot: 'ENOTFOUND' }),
    account: async () => ({ cannot: 'only Caddy can read where it keeps it' }),
    ...over,
  }
}

/** A zone, example.com, with nothing at the name yet, signed and validating. */
function zone(asked: Asked, over: Record<string, Served> = {}): Served {
  const key = `${asked.name}/${asked.type}/${asked.recurse ? 'world' : 'zone'}`
  const said = over[key] ?? over[`${asked.name}/${asked.type}`]
  if (said !== undefined) return said
  if (asked.name === 'example.com' && asked.type === 'SOA') {
    return { authenticated: true, answers: [soa('example.com')] }
  }
  if (asked.name === 'example.com' && asked.type === 'NS') {
    return {
      answers: [
        rr('example.com', { type: 'NS', target: 'ns2.example.net' }),
        rr('example.com', { type: 'NS', target: 'ns1.example.net' }),
      ],
    }
  }
  if (asked.name === 'com') return { rcode: NOERROR, authority: [soa('com', 900)] }
  return {
    rcode: asked.name === NAME ? NXDOMAIN : NOERROR,
    authenticated: asked.recurse,
    authority: [soa('example.com', 300)],
  }
}

describe('a question, over UDP', () => {
  it('reads the records, the code, the AD bit and a name compressed as a pointer', async () => {
    const at = await serving(() => ({
      authenticated: true,
      answers: [rr(NAME, { type: 'A', address: HERE4 }, 120)],
    }))
    const got = await ask('127.0.0.1', { name: NAME, type: 'A', recurse: true }, { port: at.port })
    expect(got).toEqual({
      rcode: NOERROR,
      authenticated: true,
      truncated: false,
      answers: [{ name: NAME, ttl: 120, data: { type: 'A', address: HERE4 } }],
      authority: [],
    })
    expect(at.asked).toEqual([{ name: NAME, type: 'A', recurse: true, unchecked: false }])
  })

  it('sends recursion and checking as asked', async () => {
    const at = await serving(() => ({}))
    await ask(
      '127.0.0.1',
      { name: NAME, type: 'SOA', recurse: false, unchecked: true },
      { port: at.port },
    )
    expect(at.asked[0]).toMatchObject({ recurse: false, unchecked: true })
  })

  it('takes only the reply to its own question, and says what it could not read', async () => {
    const at = await serving(() => ({
      strangerFirst: true,
      answers: [rr(NAME, { type: 'A', address: HERE4 })],
    }))
    const got = await ask('127.0.0.1', { name: NAME, type: 'A', recurse: true }, { port: at.port })
    expect('answers' in got && got.answers).toHaveLength(1)
    const garbage = await serving((asked) => ({
      garbage: asked.type === 'A' ? 'first' : 'only',
      answers: [rr(NAME, { type: 'A', address: HERE4 })],
    }))
    const past = await ask(
      '127.0.0.1',
      { name: NAME, type: 'A', recurse: true },
      { port: garbage.port },
    )
    expect('answers' in past && past.answers).toHaveLength(1)
    const unread = await ask(
      '127.0.0.1',
      { name: NAME, type: 'AAAA', recurse: true },
      { port: garbage.port, ms: 100, tries: 1 },
    )
    expect(unread).toEqual({
      cannot: 'no answer from 127.0.0.1 in 0.1 s that could be read (a name runs past the end)',
    })
  })

  it('gives up at its deadline, every try, and says so', async () => {
    const at = await serving(() => null)
    const started = Date.now()
    const got = await ask(
      '127.0.0.1',
      { name: NAME, type: 'A', recurse: true },
      { port: at.port, ms: 100, tries: 2 },
    )
    expect(got).toEqual({ cannot: 'no answer from 127.0.0.1 in 0.1 s' })
    expect(at.asked).toHaveLength(2)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('reads every kind of record the look asks for', async () => {
    const at = await serving(() => ({
      answers: [
        rr(NAME, { type: 'AAAA', address: '2001:db8::7' }),
        rr(NAME, { type: 'CAA', flags: 0, tag: 'issue', value: 'letsencrypt.org' }),
        rr(NAME, { type: 'CNAME', target: 'box.example.net' }),
        rr('example.com', {
          type: 'DS',
          keyTag: 42069,
          algorithm: 13,
          digestType: 2,
          digest: 'ABCD',
        }),
        rr('example.com', { type: 'DNSKEY', flags: 257, algorithm: 13, rdata: KSK }),
        rr('example.com', { type: 'other' }),
      ],
      authority: [soa('example.com', 60, 30)],
    }))
    const got = await ask('127.0.0.1', { name: NAME, type: 'A', recurse: true }, { port: at.port })
    if ('cannot' in got) throw new Error(got.cannot)
    expect(got.answers.map((one) => one.data)).toEqual([
      { type: 'AAAA', address: '2001:db8::7' },
      { type: 'CAA', flags: 0, tag: 'issue', value: 'letsencrypt.org' },
      { type: 'CNAME', target: 'box.example.net' },
      { type: 'DS', keyTag: 42069, algorithm: 13, digestType: 2, digest: 'ABCD' },
      { type: 'DNSKEY', flags: 257, algorithm: 13, rdata: KSK },
      { type: 'other' },
    ])
    expect(got.authority).toEqual([
      { name: 'example.com', ttl: 30, data: { type: 'SOA', minimum: 60 } },
    ])
  })

  it('refuses bytes that are not a reply rather than reading past them', () => {
    const query = encodeQuery(7, { name: NAME, type: 'A', recurse: true })
    expect(decodeReply(query).question).toBe(`${NAME}/1`)
    expect(() => decodeReply(query.subarray(0, 20))).toThrow()
    const pointing = Buffer.from(query)
    pointing.writeUInt16BE(0xc00c, 12)
    expect(() => decodeReply(pointing)).toThrow('a name that points at itself')
  })
})

describe('what DNSSEC needs worked out', () => {
  it("makes a key's tag and its DS the way dig and Python do", () => {
    expect(keyTag(KSK)).toBe(KSK_TAG)
    expect(dsOf('dnssec-failed.org.', KSK, 13)).toEqual({
      keyTag: KSK_TAG,
      algorithm: 13,
      digestType: 2,
      digest: KSK_DIGEST,
    })
  })

  it('spells an IPv6 address one way, so two can be compared', () => {
    const bytes = Buffer.alloc(16)
    bytes.writeUInt16BE(0x2001, 0)
    bytes.writeUInt16BE(0x0db8, 2)
    bytes.writeUInt16BE(7, 14)
    expect(ipv6(bytes)).toBe('2001:db8::7')
    expect(canonical6('2001:0DB8:0:0:0:0:0:0007')).toBe('2001:db8::7')
    expect(canonical6('fe80::1%en0')).toBe('fe80::1')
    expect(canonical6('not one')).toBe('not one')
  })
})

describe('the look', () => {
  it('asks the zone and the world, and says a record the zone has is not yet visible', async () => {
    const at = await serving((asked) =>
      zone(asked, {
        [`${NAME}/A/zone`]: { answers: [rr(NAME, { type: 'A', address: HERE4 })] },
        'example.com/CAA': {
          answers: [
            rr('example.com', { type: 'CAA', flags: 0, tag: 'issue', value: 'letsencrypt.org' }),
          ],
        },
      }),
    )
    const seen = await lookAtDomain(
      'Tade.Example.com.',
      from(at, {
        interfaces: () => ({
          eth0: [
            { address: HERE4, internal: false },
            { address: '2001:0db8::0007', internal: false },
          ],
        }),
        serves: async (address) => address === HERE4,
        certificate: async () => LETS_ENCRYPT,
        account: async () => ({ uri: ACCOUNT }),
      }),
    )
    expect(seen).toMatchObject({
      name: NAME,
      zone: { apex: 'example.com', servers: ['ns1.example.net', 'ns2.example.net'] },
      own: { a: { found: [HERE4], ttl: 300 } },
      world: { a: { none: 'name', ttl: 300, validated: true } },
      caa: { at: 'example.com' },
      dnssec: { validates: true },
      here: { v4: [HERE4], v6: ['2001:db8::7'] },
      serving: [HERE4],
      account: { uri: ACCOUNT },
    })
    expect(domainSays(seen).map((one) => one.state)).toEqual([
      'unseen',
      'right',
      'right',
      'missing',
    ])
    // The world is asked with checking on and recursion; the zone's servers without.
    const own = at.asked.filter((one) => !one.recurse)
    expect(new Set(own.map((one) => one.type))).toEqual(new Set(['A', 'AAAA', 'CAA']))
    expect(
      at.asked.filter((one) => one.type === 'CAA' && one.recurse).map((one) => one.name),
    ).toEqual([NAME, 'example.com'])
  })

  it("finds a broken DNSSEC chain, what the registrar has, and the DS the zone's key needs", async () => {
    const apex = 'dnssec-failed.org'
    const at = await serving((asked) => {
      if (asked.recurse && !asked.unchecked && asked.type !== 'DS') return { rcode: SERVFAIL }
      if (asked.type === 'SOA') return { answers: [soa(apex)] }
      if (asked.type === 'DS') {
        return {
          answers: [
            rr(apex, { type: 'DS', keyTag: 42069, algorithm: 13, digestType: 2, digest: 'AABB' }),
          ],
        }
      }
      if (asked.type === 'DNSKEY') {
        return {
          answers: [
            rr(apex, {
              type: 'DNSKEY',
              flags: 256,
              algorithm: 13,
              rdata: Buffer.from([1, 0, 3, 13, 9]),
            }),
            rr(apex, { type: 'DNSKEY', flags: 257, algorithm: 13, rdata: KSK }),
          ],
        }
      }
      if (asked.type === 'A') return { answers: [rr(apex, { type: 'A', address: HERE4 })] }
      return { authority: [soa(apex)] }
    })
    const seen = await lookAtDomain(apex, from(at))
    expect(seen.dnssec).toEqual({
      broken: true,
      registrar: [{ keyTag: 42069, algorithm: 13, digestType: 2, digest: 'AABB' }],
      zone: [{ keyTag: KSK_TAG, algorithm: 13, digestType: 2, digest: KSK_DIGEST }],
    })
    expect(seen.world.a).toEqual({ failed: 'SERVFAIL' })
    expect(seen.caa).toEqual({ at: apex, answer: { failed: 'SERVFAIL' } })
    const line = domainSays(seen).find((one) => one.record === 'DNSSEC')
    expect(line?.add).toBe(`${apex}. DS ${KSK_TAG} 13 2 ${KSK_DIGEST}`)
  })

  it('tells a zone whose servers do not answer from one whose signatures do not validate', async () => {
    const at = await serving((asked) =>
      asked.name === 'example.com' && asked.type === 'SOA' && asked.recurse
        ? { rcode: SERVFAIL }
        : zone(asked),
    )
    const seen = await lookAtDomain(NAME, from(at))
    expect(seen.dnssec).toEqual({
      cannot: 'resolvers could not reach the servers that answer for example.com',
    })
  })

  it('says what an unsigned zone is, and an answer it cannot place', async () => {
    const unsigned = await serving((asked) => ({ ...zone(asked), authenticated: false }))
    expect((await lookAtDomain(NAME, from(unsigned))).dnssec).toEqual({ unsigned: true })
    await unsigned.close()
    const refused = await serving((asked) =>
      asked.name === 'example.com' && asked.type === 'SOA' && !asked.unchecked
        ? { rcode: 5 }
        : zone(asked),
    )
    expect((await lookAtDomain(NAME, from(refused))).dnssec).toEqual({
      cannot: 'resolvers answered REFUSED for example.com',
    })
  })

  it('says a name nobody registered, rather than calling the root its zone', async () => {
    // `tade host domain` with a typo, or a stand-in name: the nearest SOA is
    // the top-level domain's, or the root's, and its servers and signature
    // were said as the name's own.
    const at = await serving((asked) =>
      asked.name === 'example'
        ? { rcode: NXDOMAIN, authority: [soa('', 900)] }
        : { rcode: NXDOMAIN, authenticated: true, authority: [soa('example', 900)] },
    )
    const seen = await lookAtDomain('tade.nowhere.example', from(at))
    expect(seen.zone).toEqual({
      cannot: 'nobody has registered it — the nearest zone that answers is .example',
    })
    expect(seen.dnssec).toEqual({
      cannot: 'nobody has registered it — the nearest zone that answers is .example',
    })
  })

  it('asks a server that did not answer once, and says everything it could not ask', async () => {
    const at = await serving(() => null)
    const seen: DomainSeen = await lookAtDomain(
      NAME,
      from(at, { ask: { port: at.port, ms: 100, tries: 1 }, zoneServers: [] }),
    )
    expect(at.asked).toHaveLength(1)
    expect(seen.zone).toEqual({ cannot: 'no answer from 127.0.0.1 in 0.1 s' })
    expect(seen.own).toBeNull()
    expect(seen.world.a).toEqual({ failed: 'no answer from 127.0.0.1 in 0.1 s' })
    expect(seen.dnssec).toEqual({ cannot: 'no answer from 127.0.0.1 in 0.1 s' })
  })

  it("finds the zone of an alias in its parent's, and does not compare an alias it cannot follow", async () => {
    const at = await serving((asked) =>
      zone(asked, {
        [`${NAME}/SOA`]: {
          answers: [rr(NAME, { type: 'CNAME', target: 'box.example.net' })],
          authority: [soa('example.net')],
        },
        [`${NAME}/A/zone`]: { answers: [rr(NAME, { type: 'CNAME', target: 'box.example.net' })] },
        [`${NAME}/A/world`]: {
          answers: [
            rr(NAME, { type: 'CNAME', target: 'box.example.net' }),
            rr('box.example.net', { type: 'A', address: HERE4 }),
          ],
        },
      }),
    )
    const seen = await lookAtDomain(NAME, from(at))
    expect(seen.zone).toMatchObject({ apex: 'example.com' })
    expect(seen.own?.a).toEqual({ failed: 'an alias to a name outside the zone' })
    expect(seen.world.a).toMatchObject({ found: [HERE4] })
  })

  it('says a reply too big for UDP rather than reading half of one', async () => {
    const at = await serving((asked) =>
      asked.type === 'A' && asked.recurse ? { truncated: true } : zone(asked),
    )
    expect((await lookAtDomain(NAME, from(at))).world.a).toEqual({
      failed: 'the answer was too big to come over UDP',
    })
  })
})

describe("Caddy's account, and 443", () => {
  it('reads the account Caddy keeps, and says where it has none', async () => {
    const dir = tmp('tade-caddy-users-')
    expect(await caddyAccount(join(dir, 'missing'))).toEqual({
      cannot: "Caddy has no account at Let's Encrypt here yet",
    })
    mkdirSync(join(dir, 'default'))
    writeFileSync(join(dir, 'default', 'notes.txt'), 'not json')
    writeFileSync(join(dir, 'default', 'default.json'), JSON.stringify({ location: 'nope' }))
    expect(await caddyAccount(dir)).toEqual({
      cannot: `Caddy has no account at Let's Encrypt in ${dir} yet`,
    })
    writeFileSync(
      join(dir, 'default', 'default.json'),
      JSON.stringify({ status: 'valid', location: ACCOUNT }),
    )
    expect(await caddyAccount(dir)).toEqual({ uri: ACCOUNT })
  })

  it('says how to read it where only Caddy can', async () => {
    // Root reads through a closed directory, so there is nothing to show there.
    if (process.getuid?.() === 0) return
    const dir = tmp('tade-caddy-closed-')
    chmodSync(dir, 0)
    try {
      const got = await caddyAccount(dir)
      expect(got).toEqual({
        cannot: `only Caddy can read where it keeps it: \`sudo sh -c 'grep -h location ${dir}/*/*.json'\` prints it, for \`tade host domain <name> --account <uri>\``,
      })
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(CADDY_ACCOUNTS).toContain('acme-v02.api.letsencrypt.org-directory')
  })

  it('takes an account only where it cannot end the CAA value early', () => {
    expect(accountUri(ACCOUNT)).toBe(true)
    for (const bad of ['http://x', 'https://x"; issue', 'https://a b', 'https://x;y']) {
      expect(accountUri(bad), bad).toBe(false)
    }
  })

  it('says whether something answers on a port here', async () => {
    const listening = createServer((socket) => socket.end())
    await new Promise<void>((done) => listening.listen(0, '127.0.0.1', done))
    const port = (listening.address() as { port: number }).port
    expect(await servesHttps('127.0.0.1', { port })).toBe(true)
    await new Promise<void>((done) => listening.close(() => done()))
    expect(await servesHttps('127.0.0.1', { port, ms: 500 })).toBe(false)
  })
})
