import { describe, expect, it } from 'vitest'
import {
  addressAllowed,
  ENDPOINT_BOUND,
  endpointAllowed,
  looksLikeAddress,
  type Resolved,
  reachable,
} from '../src/endpoint.ts'

// The one place in Tade where an address somebody else chose decides what this
// machine connects to, run against every shape somebody would try.
//
// It is a cross-product rather than a handful of cases on purpose: this is the
// file whose bugs are a request made from inside somebody's network, and the
// ones that get through a hand-written list are the spellings nobody thought
// of — a decimal `127.1`, an octal octet, an IPv4 address wearing IPv6
// clothes, a name that resolves to two addresses of which one is private.

/** The endpoints real push services actually use, as of 2026. */
const REAL = [
  'https://web.push.apple.com/QDzVM4rMVZ1l0bT8VvPaDQ',
  'https://fcm.googleapis.com/fcm/send/dKx8:APA91bH',
  'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
  'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
]

describe('the endpoint a browser hands over', () => {
  it('takes the endpoints real push services use', () => {
    for (const one of REAL) {
      const checked = endpointAllowed(one)
      expect(checked.ok, one).toBe(true)
      if (!checked.ok) continue
      expect(checked.origin).toBe(`https://${new URL(one).hostname}`)
      // The path **and** the query, because one push service puts the token in
      // a query parameter: an endpoint reassembled without it would be a POST
      // to a service's root.
      expect(`${checked.origin}${checked.path}`).toBe(one)
    }
  })

  it('refuses anything that is not https, with a clause saying what it was', () => {
    for (const scheme of ['http', 'ftp', 'file', 'ws', 'gopher']) {
      const checked = endpointAllowed(`${scheme}://push.example/x`)
      expect(checked.ok, scheme).toBe(false)
      if (checked.ok) continue
      expect(checked.why).toContain('https')
    }
    // Not a URL at all, and the two shapes that nearly are.
    for (const value of ['', 'push.example/x', '//push.example/x', 'javascript:alert(1)']) {
      expect(endpointAllowed(value).ok, value).toBe(false)
    }
  })

  it('refuses credentials in the URL, which nothing legitimate has', () => {
    expect(endpointAllowed('https://user:pass@push.example/x').ok).toBe(false)
    expect(endpointAllowed('https://user@push.example/x').ok).toBe(false)
  })

  it('refuses any port but 443, and accepts it written out', () => {
    expect(endpointAllowed('https://push.example:443/x').ok).toBe(true)
    for (const port of [80, 8080, 9200, 6379, 22, 11211]) {
      const checked = endpointAllowed(`https://push.example:${port}/x`)
      expect(checked.ok, String(port)).toBe(false)
      if (!checked.ok) expect(checked.why).toContain(String(port))
    }
  })

  it('refuses an address written where a name goes, in both families', () => {
    for (const host of [
      '1.2.3.4',
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '[::1]',
      '[fd00::1]',
      '[2606:4700::1111]',
      // The two spellings a permissive parser accepts and a dotted-quad check
      // does not: a 32-bit decimal and a short form.
      '2130706433',
      '127.1',
    ]) {
      const checked = endpointAllowed(`https://${host}/x`)
      expect(checked.ok, host).toBe(false)
      if (!checked.ok) expect(checked.why, host).toContain('address')
    }
  })

  it('refuses this machine and the names a resolver answers locally', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'push.localhost',
      'nas.local',
      'db.internal',
      'printer.home.arpa',
      'intranet',
    ]) {
      expect(endpointAllowed(`https://${host}/x`).ok, host).toBe(false)
    }
  })

  it('refuses the retired GCM endpoint by name, and says why in its own words', () => {
    // Not a security refusal: the pre-VAPID protocol needs a Google API key
    // Tade does not have, and the vetted library answers that shape by
    // printing a warning on stdout — which in a process whose stdout is a
    // window somebody is looking at is a stranger's sentence in a frame.
    const checked = endpointAllowed('https://android.googleapis.com/gcm/send/abc')
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.why).toContain('GCM')
  })

  it('is bounded, and says the bound', () => {
    const long = `https://push.example/${'x'.repeat(ENDPOINT_BOUND)}`
    const checked = endpointAllowed(long)
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.why).toContain(String(ENDPOINT_BOUND))
  })

  it('reads a host as an address when its last label is digits, and never otherwise', () => {
    for (const host of ['1.2.3.4', '0.0.0.0', 'example.1', 'fd00::1', '::1'])
      expect(looksLikeAddress(host), host).toBe(true)
    for (const host of ['push.example', 'web.push.apple.com', 'x1.example', '1a.example'])
      expect(looksLikeAddress(host), host).toBe(false)
  })
})

describe('whether a resolved address is somewhere on the public internet', () => {
  it('allows ordinary public addresses', () => {
    for (const address of [
      '17.253.144.10',
      '142.250.74.206',
      '1.1.1.1',
      '8.8.8.8',
      '2606:4700:4700::1111',
      '2a00:1450:4001:80f::200e',
    ])
      expect(addressAllowed(address), address).toBe(true)
  })

  it('refuses every IPv4 range that is not one', () => {
    for (const address of [
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.0.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255',
    ])
      expect(addressAllowed(address), address).toBe(false)
  })

  it('allows the public addresses that sit next to a private range', () => {
    // The off-by-one direction that matters: a check written with `>=` where it
    // wanted `>` refuses real services, which is a feature that silently does
    // not work rather than a hole.
    for (const address of [
      '9.255.255.255',
      '11.0.0.1',
      '100.63.255.255',
      '100.128.0.1',
      '126.255.255.255',
      '128.0.0.1',
      '172.15.255.255',
      '172.32.0.1',
      '192.167.255.255',
      '192.169.0.1',
      '223.255.255.255',
    ])
      expect(addressAllowed(address), address).toBe(true)
  })

  it('refuses anything but plain decimal octets, rather than normalising it', () => {
    // `010` is eight to a parser that reads octal and ten to one that does not,
    // and `0x7f` is a hundred and twenty-seven to one of them. A check that
    // normalised would have to agree with whatever the socket layer does.
    for (const address of [
      '0127.0.0.1',
      '010.0.0.1',
      '0x7f.0.0.1',
      '127.0.0.01',
      '1.2.3',
      '1.2.3.4.5',
      '1.2.3.256',
    ])
      expect(addressAllowed(address), address).toBe(false)
  })

  it('refuses every IPv6 range that is not public unicast', () => {
    for (const address of [
      '::',
      '::1',
      '0:0:0:0:0:0:0:1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'febf::1',
      'ff02::1',
      'ff00::',
      '64:ff9b::7f00:1',
      '100::1',
      '2001:0:1234::1',
      '2001:db8::1',
      '2002:7f00:1::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '::127.0.0.1',
    ])
      expect(addressAllowed(address), address).toBe(false)
  })

  it('reads a scope id and brackets off before deciding', () => {
    expect(addressAllowed('fe80::1%en0')).toBe(false)
    expect(addressAllowed('[2606:4700::1111]')).toBe(true)
  })

  it('refuses what it cannot read, which is the safe direction', () => {
    for (const address of ['', 'not an address', '::g', '1:2:3:4:5:6:7:8:9', '::1::2', 'fe80:'])
      expect(addressAllowed(address), address).toBe(false)
  })
})

describe('an endpoint resolved, which is the half a URL check cannot do', () => {
  const only =
    (...addresses: string[]) =>
    () =>
      Promise.resolve(
        addresses.map(
          (address) => ({ address, family: address.includes(':') ? 6 : 4 }) as Resolved,
        ),
      )

  it('hands back every address it resolved, so the socket uses the checked one', async () => {
    const reached = await reachable(REAL[0] ?? '', only('17.253.144.10', '2606:4700::1111'))
    expect(reached.ok).toBe(true)
    if (!reached.ok) return
    expect(reached.addresses.map((one) => one.address)).toEqual([
      '17.253.144.10',
      '2606:4700::1111',
    ])
    expect(reached.endpoint.host).toBe('web.push.apple.com')
  })

  it('refuses a perfectly ordinary name that answers a private address', async () => {
    // One DNS record away for anybody, and the whole reason the URL check is
    // not the end of it.
    const reached = await reachable('https://push.example/x', only('127.0.0.1'))
    expect(reached.ok).toBe(false)
    if (reached.ok) return
    expect(reached.why).toContain('127.0.0.1')
    expect(reached.why).toContain('not public')
  })

  it('refuses a name that answers one public address and one private one', async () => {
    // **Every address, not the first.** The next lookup may well pick the
    // second, so a check that passed on the first would pass by luck.
    const reached = await reachable('https://push.example/x', only('1.1.1.1', '169.254.169.254'))
    expect(reached.ok).toBe(false)
    if (!reached.ok) expect(reached.why).toContain('169.254.169.254')
  })

  it('refuses a name that resolves to nothing', async () => {
    const reached = await reachable('https://push.example/x', only())
    expect(reached.ok).toBe(false)
    if (!reached.ok) expect(reached.why).toContain('no address')
  })

  it('says a lookup that could not happen in its own words, which is not *gone*', async () => {
    // The sender reads this clause as a retry: a machine that is offline is not
    // a subscription that has gone away, and forgetting one over an outage is
    // the failure this wording exists to keep apart.
    const reached = await reachable('https://push.example/x', () =>
      Promise.reject(new Error('EAI_AGAIN')),
    )
    expect(reached.ok).toBe(false)
    if (!reached.ok) expect(reached.why.startsWith('could not be looked up')).toBe(true)
  })

  it('never resolves anything it already refused', async () => {
    let asked = 0
    const reached = await reachable('http://push.example/x', () => {
      asked += 1
      return Promise.resolve([])
    })
    expect(reached.ok).toBe(false)
    expect(asked).toBe(0)
  })
})
