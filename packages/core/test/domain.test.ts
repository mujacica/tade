import { describe, expect, it } from 'vitest'
import {
  type Answer,
  type Caa,
  type CertificateLook,
  type CertificateSeen,
  caaRecord,
  type DomainLine,
  type DomainSeen,
  domainHead,
  domainSays,
  parseConfig,
  publicAddresses,
  refusedName,
  TADE_SH_IS_THE_INSTALLER,
  trustedWrite,
} from '../src/index.ts'

// What each record comes to, out of answers written here: the zone's own
// servers and a public resolver, this machine's addresses, the certificate and
// Caddy's account. The asking is `@tade/workbench`'s `domain.test.ts`.

const NAME = 'tade.example.com'
const HERE4 = '203.0.113.7'
const HERE6 = '2001:db8::7'
const OTHER4 = '198.51.100.9'
const OTHER6 = '2001:db8::99'
const ACCOUNT = 'https://acme-v02.api.letsencrypt.org/acme/acct/1234567'
const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 16)

const found = <T = string>(values: T[], ttl = 300): Answer<T> => ({
  found: values,
  ttl,
  validated: false,
})
const none = <T = string>(ttl: number | null = 300): Answer<T> => ({
  none: 'name',
  ttl,
  validated: false,
})
const issue = (value: string) => ({ flags: 0, tag: 'issue', value })

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
const NO_CERTIFICATE: CertificateLook = { at: NOW, cannot: 'ENOTFOUND' }

/** A box with an A record pointing at it and nothing else yet. */
function seen(over: Partial<DomainSeen> = {}): DomainSeen {
  return {
    name: NAME,
    zone: { apex: 'example.com', servers: ['ns1.example.net', 'ns2.example.net'] },
    own: { a: found([HERE4]), aaaa: none(), caa: none() },
    world: { a: found([HERE4]), aaaa: none() },
    caa: { at: NAME, answer: none() },
    dnssec: { unsigned: true },
    here: { v4: [HERE4], v6: [] },
    serving: [],
    certificate: NO_CERTIFICATE,
    account: { cannot: 'only Caddy can read where it keeps it' },
    ...over,
  }
}

function of(look: DomainSeen, record: DomainLine['record']): DomainLine {
  const line = domainSays(look).find((one) => one.record === record)
  if (line === undefined) throw new Error(`no ${record} line`)
  return line
}

describe('the look, a line per record', () => {
  it('says them in the order they are done', () => {
    expect(domainSays(seen()).map((one) => one.record)).toEqual(['A', 'AAAA', 'DNSSEC', 'CAA'])
  })

  it('names the zone and its servers above them, and says when the zone could not be found', () => {
    expect(domainHead(seen())).toBe(
      `${NAME}, in the zone example.com, answered for by ns1.example.net, ns2.example.net`,
    )
    expect(domainHead(seen({ zone: { cannot: 'no answer from 1.1.1.1 in 1.5 s' } }))).toContain(
      'could not be found (no answer from 1.1.1.1 in 1.5 s)',
    )
  })
})

describe('A', () => {
  it('is right when the zone and the world both point it here', () => {
    expect(of(seen(), 'A')).toEqual({
      record: 'A',
      state: 'right',
      said: `A: ${NAME} → ${HERE4}, this machine`,
      add: null,
      remove: [],
      loud: false,
    })
  })

  it('is missing, with the exact record to add, where the zone has none', () => {
    const line = of(seen({ own: { a: none(), aaaa: none(), caa: none() } }), 'A')
    expect(line).toMatchObject({ state: 'missing', loud: true, add: `${NAME}. A ${HERE4}` })
  })

  it('says it cannot give the address where this machine has no public IPv4 of its own', () => {
    const line = of(
      seen({ own: { a: none(), aaaa: none(), caa: none() }, here: { v4: [], v6: [] } }),
      'A',
    )
    expect(line).toMatchObject({ state: 'missing', loud: true, add: null })
    expect(line.said).toContain('no public IPv4 of its own')
    // And pointing somewhere is then a thing it can read and not check.
    const nat = of(seen({ here: { v4: [], v6: [] } }), 'A')
    expect(nat).toMatchObject({ state: 'cannot', loud: false })
    expect(nat.said).toContain('cannot be told here')
  })

  it('is wrong where it points somewhere else, and says what to add and what to take away', () => {
    const line = of(seen({ own: { a: found([OTHER4]), aaaa: none(), caa: none() } }), 'A')
    expect(line).toMatchObject({
      state: 'wrong',
      loud: true,
      add: `${NAME}. A ${HERE4}`,
      remove: [`${NAME}. A ${OTHER4}`],
    })
    // Here and somewhere else: only the one in the way goes.
    const both = of(seen({ own: { a: found([HERE4, OTHER4]), aaaa: none(), caa: none() } }), 'A')
    expect(both).toMatchObject({ add: null, remove: [`${NAME}. A ${OTHER4}`] })
  })

  it('is right at the zone and not yet visible, for as long as resolvers keep what they had', () => {
    const fresh = of(seen({ world: { a: none(240), aaaa: none() } }), 'A')
    expect(fresh).toMatchObject({ state: 'unseen', loud: false, add: null })
    expect(fresh.said).toBe(
      "A: right at the zone's own servers, and not yet visible: resolvers keep none for up to 4 min",
    )
    const moved = of(seen({ world: { a: found([OTHER4], 90), aaaa: none() } }), 'A')
    expect(moved.said).toContain(`resolvers keep ${OTHER4} for up to 90 s`)
    const long = of(seen({ world: { a: found([OTHER4], 86_400), aaaa: none() } }), 'A')
    expect(long.said).toContain('for up to 24 h')
    expect(of(seen({ world: { a: none(null), aaaa: none() } }), 'A').said).toMatch(/keep none$/)
  })

  it('is loud where the zone is right and resolvers cannot answer at all', () => {
    const line = of(seen({ world: { a: { failed: 'SERVFAIL' }, aaaa: none() } }), 'A')
    expect(line).toMatchObject({ state: 'unseen', loud: true })
    expect(line.said).toContain('resolvers could not answer for tade.example.com: SERVFAIL')
  })

  it("reads the world's answer where the zone's own servers could not give one", () => {
    const own = { a: { failed: 'REFUSED' }, aaaa: none(), caa: none<Caa>() }
    expect(of(seen({ own }), 'A').state).toBe('right')
    expect(of(seen({ own: null }), 'A').state).toBe('right')
    const neither = of(seen({ own, world: { a: { failed: 'SERVFAIL' }, aaaa: none() } }), 'A')
    expect(neither).toMatchObject({ state: 'cannot', loud: false })
  })
})

describe('AAAA, only where IPv6 answers on 443', () => {
  const v6 = { v4: [HERE4], v6: [HERE6] }
  const aaaa = (values: string[]) => ({ a: found([HERE4]), aaaa: found(values), caa: none<Caa>() })

  it('is right to be missing where there is no IPv6, or nothing answers on it', () => {
    expect(of(seen(), 'AAAA')).toMatchObject({ state: 'right', add: null })
    expect(of(seen(), 'AAAA').said).toContain('no public IPv6')
    expect(of(seen({ here: v6 }), 'AAAA').said).toContain('while 443 does not answer on IPv6')
  })

  it('offers one, quietly, where 443 answers on IPv6 and there is none', () => {
    expect(of(seen({ here: v6, serving: [HERE6] }), 'AAAA')).toMatchObject({
      state: 'missing',
      loud: false,
      add: `${NAME}. AAAA ${HERE6}`,
    })
  })

  it('is wrong where it points somewhere else, or here and nothing answers there', () => {
    const elsewhere = of(seen({ here: v6, own: aaaa([OTHER6]) }), 'AAAA')
    expect(elsewhere).toMatchObject({
      state: 'wrong',
      loud: true,
      remove: [`${NAME}. AAAA ${OTHER6}`],
    })
    expect(elsewhere.said).toContain("Let's Encrypt tries IPv6 first")
    const nowhere = of(seen({ own: aaaa([OTHER6]) }), 'AAAA')
    expect(nowhere.said).toContain('this machine has no public IPv6')
    const silent = of(seen({ here: v6, own: aaaa([HERE6]), serving: [HERE4] }), 'AAAA')
    expect(silent).toMatchObject({ state: 'wrong', loud: true, remove: [`${NAME}. AAAA ${HERE6}`] })
  })

  it('waits for Caddy where nothing answers on 443 here at all', () => {
    const line = of(seen({ here: v6, own: aaaa([HERE6]) }), 'AAAA')
    expect(line).toMatchObject({ state: 'later', loud: false })
  })

  it('is right where it points here and 443 answers there, and not yet visible until resolvers see it', () => {
    const right = of(
      seen({
        here: v6,
        own: aaaa([HERE6]),
        world: { a: found([HERE4]), aaaa: found([HERE6]) },
        serving: [HERE6],
      }),
      'AAAA',
    )
    expect(right).toMatchObject({ state: 'right', said: `AAAA: ${NAME} → ${HERE6}, this machine` })
    const unseen = of(seen({ here: v6, own: aaaa([HERE6]), serving: [HERE6] }), 'AAAA')
    expect(unseen.state).toBe('unseen')
  })

  it('cannot tell where nothing answered for it', () => {
    const line = of(
      seen({ own: null, world: { a: found([HERE4]), aaaa: { failed: 'no answer' } } }),
      'AAAA',
    )
    expect(line).toMatchObject({ state: 'cannot', loud: false })
  })
})

describe('DNSSEC, before ordering', () => {
  const registrar = { keyTag: 42069, algorithm: 13, digestType: 2, digest: 'AA' }
  const zone = { keyTag: 50719, algorithm: 13, digestType: 2, digest: 'D602' }

  it('is right signed and validating, and right unsigned', () => {
    expect(of(seen({ dnssec: { validates: true } }), 'DNSSEC')).toMatchObject({
      state: 'right',
      said: 'DNSSEC: example.com is signed, and it validates',
    })
    expect(of(seen(), 'DNSSEC').said).toBe(
      'DNSSEC: example.com is not signed, so there is nothing to break',
    )
    expect(of(seen({ dnssec: { cannot: 'no answer' } }), 'DNSSEC').state).toBe('cannot')
  })

  it("replaces a registrar's DS that names a key the zone is not signed with", () => {
    const line = of(
      seen({ dnssec: { broken: true, registrar: [registrar], zone: [zone] } }),
      'DNSSEC',
    )
    expect(line).toMatchObject({
      state: 'wrong',
      loud: true,
      add: 'example.com. DS 50719 13 2 D602',
      remove: ['example.com. DS 42069 13 2 AA'],
    })
    expect(line.said).toContain('replace it at the registrar')
  })

  it('takes the DS away where the zone is not signed any more', () => {
    const line = of(seen({ dnssec: { broken: true, registrar: [registrar], zone: [] } }), 'DNSSEC')
    expect(line).toMatchObject({ add: null, remove: ['example.com. DS 42069 13 2 AA'], loud: true })
    expect(line.said).toContain('take the DS record away at the registrar')
  })

  it('says the signatures are the trouble where the DS names the right key', () => {
    const line = of(seen({ dnssec: { broken: true, registrar: [zone], zone: [zone] } }), 'DNSSEC')
    expect(line.said).toContain('sign the zone again at its DNS host')
    const unread = of(seen({ dnssec: { broken: true, registrar: [zone], zone: null } }), 'DNSSEC')
    expect(unread).toMatchObject({ state: 'wrong', loud: true })
    expect(unread.said).toContain("the zone's own keys could not be read")
  })
})

describe('CAA, after the first certificate', () => {
  const known = { uri: ACCOUNT }
  const record = `${NAME}. CAA 0 issue "letsencrypt.org; accounturi=${ACCOUNT}; validationmethods=tls-alpn-01,http-01"`

  it("writes the record that names Caddy's account, and Let's Encrypt alone without one", () => {
    expect(caaRecord(NAME, ACCOUNT)).toBe(record)
    expect(caaRecord(NAME, null)).toBe(
      `${NAME}. CAA 0 issue "letsencrypt.org; validationmethods=tls-alpn-01,http-01"`,
    )
  })

  it('waits for the first certificate, and for one from Let’s Encrypt', () => {
    expect(of(seen(), 'CAA')).toMatchObject({ state: 'later', loud: false, add: null })
    const google: CertificateLook = {
      at: NOW,
      seen: {
        ...(LETS_ENCRYPT as { seen: CertificateSeen }).seen,
        issuer: 'Google Trust Services',
      },
    }
    expect(of(seen({ certificate: google }), 'CAA').said).toContain('from Google Trust Services')
    const expired: CertificateLook = {
      at: NOW,
      seen: { ...(LETS_ENCRYPT as { seen: CertificateSeen }).seen, validTo: NOW - DAY },
    }
    expect(of(seen({ certificate: expired }), 'CAA').state).toBe('later')
  })

  it("is wrong before ordering where a CAA set lets other CAs issue and not Let's Encrypt", () => {
    const line = of(seen({ caa: { at: 'example.com', answer: found([issue('pki.goog')]) } }), 'CAA')
    expect(line).toMatchObject({ state: 'wrong', loud: true })
    expect(line.said).toBe(
      `CAA: example.com lets pki.goog issue and not Let's Encrypt, so Caddy cannot get a certificate for ${NAME}`,
    )
    expect(line.add).toContain(`${NAME}. CAA 0 issue "letsencrypt.org;`)
    const nobody = of(seen({ caa: { at: NAME, answer: found([issue(';')]) } }), 'CAA')
    expect(nobody.said).toContain('lets no CA at all issue')
  })

  it('is missing, quietly, once there is a certificate and nothing keeps other issuers out', () => {
    const line = of(seen({ certificate: LETS_ENCRYPT }), 'CAA')
    expect(line).toMatchObject({ state: 'missing', loud: false })
    expect(line.add).toBe(caaRecord(NAME, null))
    expect(line.said).toContain("Caddy's account could not be read: only Caddy can read")
    const narrowed = of(seen({ certificate: LETS_ENCRYPT, account: known }), 'CAA')
    expect(narrowed.add).toBe(record)
    // A set with no `issue` in it keeps nobody out either.
    const iodef = of(
      seen({
        certificate: LETS_ENCRYPT,
        caa: {
          at: NAME,
          answer: found([{ flags: 0, tag: 'iodef', value: 'mailto:x@example.com' }]),
        },
      }),
      'CAA',
    )
    expect(iodef.state).toBe('missing')
  })

  it("narrows a set that lets Let's Encrypt issue to any account, where Caddy's is known", () => {
    const parent = { at: 'example.com', answer: found([issue('letsencrypt.org')]) }
    expect(
      of(seen({ certificate: LETS_ENCRYPT, caa: parent, account: known }), 'CAA'),
    ).toMatchObject({
      state: 'missing',
      add: record,
    })
    const unknown = of(seen({ certificate: LETS_ENCRYPT, caa: parent }), 'CAA')
    expect(unknown).toMatchObject({ state: 'right', add: null })
    expect(unknown.said).toContain("example.com lets only Let's Encrypt issue")
  })

  it("is right pinned to Caddy's account, and wrong pinned to another", () => {
    const pinned = { at: NAME, answer: found([issue(`letsencrypt.org; accounturi=${ACCOUNT}`)]) }
    expect(
      of(seen({ certificate: LETS_ENCRYPT, caa: pinned, account: known }), 'CAA'),
    ).toMatchObject({
      state: 'right',
      said: `CAA: only Caddy's account at Let's Encrypt may issue for ${NAME}`,
    })
    const other = of(
      seen({ certificate: LETS_ENCRYPT, caa: pinned, account: { uri: `${ACCOUNT}9` } }),
      'CAA',
    )
    expect(other).toMatchObject({ state: 'wrong', loud: true })
  })

  it('judges a set the zone has and resolvers do not yet, and calls it not yet visible', () => {
    const own = { a: found([HERE4]), aaaa: none(), caa: found([issue(`letsencrypt.org`)]) }
    const line = of(
      seen({ certificate: LETS_ENCRYPT, own, caa: { at: NAME, answer: none(600) } }),
      'CAA',
    )
    expect(line).toMatchObject({ state: 'unseen', loud: false })
    expect(line.said).toContain('for up to 10 min')
    // Judged as it will be: a set the zone has that keeps Let's Encrypt out is wrong now.
    const theirs = { ...own, caa: found([issue('pki.goog')]) }
    expect(of(seen({ own: theirs }), 'CAA').state).toBe('wrong')
  })

  it('is loud where resolvers cannot answer for CAA, because a CA that cannot read it does not issue', () => {
    const line = of(seen({ caa: { at: NAME, answer: { failed: 'SERVFAIL' } } }), 'CAA')
    expect(line).toMatchObject({ state: 'wrong', loud: true })
  })
})

describe('the name itself', () => {
  it('refuses tade.sh and every name under it, and nothing else', () => {
    for (const name of ['tade.sh', 'TADE.SH.', 'vps.tade.sh', 'a.b.tade.sh']) {
      expect(refusedName(name), name).toBe(TADE_SH_IS_THE_INSTALLER)
    }
    for (const name of ['nottade.sh', 'tade.sh.example.com', 'tade.example.com']) {
      expect(refusedName(name), name).toBeNull()
    }
  })

  it('is refused at the schema with the reason, so every way of setting it says the same', () => {
    const read = parseConfig("surfaces:\n  web:\n    public: 'vps.tade.sh'\n")
    expect(read.ok).toBe(false)
    if (!read.ok) {
      expect(read.issues[0]?.path).toBe('surfaces.web.public')
      expect(read.issues[0]?.message).toBe(TADE_SH_IS_THE_INSTALLER)
    }
  })

  it('is written as the public name and added to the trusted hostnames, and never twice', () => {
    expect(
      trustedWrite({ public: '', trusted_hosts: ['studio.ts.net'] }, 'Tade.Example.com'),
    ).toEqual({ public: NAME, trusted_hosts: ['studio.ts.net', NAME] })
    expect(trustedWrite({ public: '', trusted_hosts: [NAME] }, NAME)).toEqual({
      public: NAME,
      trusted_hosts: [NAME],
    })
    expect(trustedWrite({ public: NAME, trusted_hosts: ['TADE.example.com'] }, NAME)).toBeNull()
  })
})

describe("this machine's public addresses", () => {
  it('keeps what the internet can reach and nothing else', () => {
    const here = publicAddresses({
      lo0: [
        { address: '127.0.0.1', internal: true },
        { address: '::1', internal: true },
      ],
      eth0: [
        { address: HERE4, internal: false },
        { address: '2a01:4f8:c17:1234::1', internal: false },
        { address: 'fe80::1', internal: false },
        { address: 'fd00::1', internal: false },
      ],
      docker0: [{ address: '172.17.0.1', internal: false }],
      wlan0: [
        { address: '192.168.1.20', internal: false },
        { address: '10.0.0.2', internal: false },
        { address: '100.101.102.103', internal: false },
        { address: '169.254.3.4', internal: false },
      ],
      again: [{ address: HERE4, internal: false }],
      none: undefined,
    })
    expect(here).toEqual({ v4: [HERE4], v6: ['2a01:4f8:c17:1234::1'] })
  })
})
