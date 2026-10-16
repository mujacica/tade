import { describe, expect, it } from 'vitest'
import {
  type CertificateLook,
  caddySite,
  certificateSays,
  outdatedSays,
  PUBLIC_DIR,
  publicDirCommand,
  publicDirProblem,
  publicName,
  publicSocket,
} from '../src/public-listener.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 16)

describe('a public name', () => {
  it('is a name of two labels or more', () => {
    for (const name of ['tade.example.com', 'Tade.Example.COM', 'a.b', 'x-1.example.co.uk'])
      expect(publicName(name), name).toBe(true)
  })

  it('is never a scheme, a port, a path, an address or one label', () => {
    for (const name of [
      '',
      'localhost',
      'https://tade.example.com',
      'tade.example.com:443',
      'tade.example.com/away',
      'tade.example.com.',
      '203.0.113.7',
      '-tade.example.com',
      'tade-.example.com',
      'tade example.com',
      'tade.exa_mple.com',
      `${'a'.repeat(64)}.example.com`,
      `${'a.'.repeat(127)}com`,
    ])
      expect(publicName(name), name).toBe(false)
  })
})

describe('the socket and its directory', () => {
  const MINE = 501

  it('is one socket, in /run, which Caddy’s PrivateTmp cannot hide', () => {
    expect(PUBLIC_DIR).toBe('/run/tade')
    expect(publicSocket()).toBe('/run/tade/away.sock')
  })

  it('is what the command makes: this user’s, setgid, its group in, everybody else out', () => {
    expect(publicDirProblem({ directory: true, uid: MINE, mode: 0o42750 }, MINE)).toBeNull()
    expect(publicDirProblem({ directory: true, uid: MINE, mode: 0o42710 }, MINE)).toBeNull()
  })

  it('names what is wrong, and the way to the fix, for each way it can be', () => {
    const cases: [Parameters<typeof publicDirProblem>[0], string][] = [
      [null, 'is not there'],
      [{ directory: false, uid: MINE, mode: 0o2750 }, 'is not a directory'],
      [{ directory: true, uid: 0, mode: 0o2750 }, 'is not this user’s'],
      [{ directory: true, uid: MINE, mode: 0o2751 }, 'open to every user'],
      [{ directory: true, uid: MINE, mode: 0o2755 }, 'open to every user'],
      [{ directory: true, uid: MINE, mode: 0o2700 }, 'closed to its group'],
      [{ directory: true, uid: MINE, mode: 0o750 }, 'no setgid'],
    ]
    for (const [seen, said] of cases) {
      const problem = publicDirProblem(seen, MINE)
      expect(problem, said).toContain(said)
      expect(problem, said).toContain('`tade host caddy`')
    }
  })

  it('is made by one root line that also makes it at every boot, with a name a shell reads back', () => {
    expect(publicDirCommand('you')).toBe(
      "printf 'd /run/tade 2750 %s caddy -\\n' you | sudo tee /etc/tmpfiles.d/tade.conf >/dev/null" +
        ' && sudo systemd-tmpfiles --create /etc/tmpfiles.d/tade.conf',
    )
    expect(publicDirCommand('EXAMPLE\\you')).toContain("%s caddy -\\n' 'EXAMPLE\\you' |")
  })
})

describe('the site block', () => {
  it('is name-bound, to the socket, with the PROXY header, and rewrites nothing', () => {
    const block = caddySite('tade.example.com')
    expect(block).toBe(
      [
        'tade.example.com {',
        '\treverse_proxy unix//run/tade/away.sock {',
        '\t\ttransport http {',
        '\t\t\tproxy_protocol v2',
        '\t\t}',
        '\t}',
        '}',
        '',
      ].join('\n'),
    )
    // Rewriting Host would make the guard refuse every request.
    expect(block).not.toMatch(/header_up|Host/)
  })
})

describe('what the certificate look says', () => {
  const seen = (from: number, to: number, over = {}): CertificateLook => ({
    at: NOW,
    seen: {
      validFrom: NOW + from * DAY,
      validTo: NOW + to * DAY,
      issuer: "Let's Encrypt",
      authorized: true,
      error: null,
      ...over,
    },
  })

  it('says days left, the date and the issuer, quietly, while renewing is on time', () => {
    expect(certificateSays('tade.example.com', seen(-30, 60), NOW)).toEqual({
      said: "certificate: 60 days left, until 2026-12-15, from Let's Encrypt",
      loud: false,
    })
    // Caddy renews at a third: 30 of 90 left is the day it should, not late.
    expect(certificateSays('t.example', seen(-60, 30), NOW).loud).toBe(false)
  })

  it('is loud past a sixth of its life, whatever the lifetime is', () => {
    expect(certificateSays('t.example', seen(-76, 14), NOW).loud).toBe(true)
    expect(certificateSays('t.example', seen(-76, 14), NOW).said).toContain(
      'renewing has been failing',
    )
    // Forty-five days, from 2028: seven left is late, ten is not.
    expect(certificateSays('t.example', seen(-38, 7), NOW).loud).toBe(true)
    expect(certificateSays('t.example', seen(-35, 10), NOW).loud).toBe(false)
  })

  it('is loud when it has run out, does not verify, or could not be looked at', () => {
    expect(certificateSays('t.example', seen(-91, -1), NOW)).toEqual({
      said: 'the certificate for t.example ran out 1 day ago',
      loud: true,
    })
    expect(certificateSays('t.example', seen(-90, 0), NOW).said).toContain('ran out today')
    const self = seen(-1, 89, { authorized: false, error: 'self-signed certificate' })
    expect(certificateSays('t.example', self, NOW)).toEqual({
      said: 'the certificate for t.example does not verify: self-signed certificate',
      loud: true,
    })
    expect(certificateSays('t.example', { at: NOW, cannot: 'connection refused' }, NOW)).toEqual({
      said: 'could not look at https://t.example: connection refused',
      loud: true,
    })
  })
})

describe('being behind with the internet able to reach it', () => {
  it('is loud, with the Updates look’s own clause and the way forward', () => {
    expect(outdatedSays('t.example', '0.2.4 is out')).toEqual({
      said: 'this Tade is out of date (0.2.4 is out) and answers the internet as t.example: `tade update` moves it forward',
      loud: true,
    })
    expect(outdatedSays('t.example', null)).toBeNull()
  })
})
