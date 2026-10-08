import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COOKIES_IGNORE_PORTS,
  DEVICES_AND_AGENTS,
  HTTPONLY_IS_NOT_XSS,
  LAN_IS_PLAINTEXT,
  listenOn,
  loopbackHost,
  OFF,
  sameHost,
  scopesOn,
  surfaceOf,
  trusted,
} from '../src/surface.ts'

// Two things this package must never become, and the four sentences it must
// never stop saying.

const SRC = new URL('../src/', import.meta.url).pathname

function sources(dir = SRC): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(at))
    else if (entry.name.endsWith('.ts')) out.push(at)
  }
  return out
}

const FILES = sources()

describe('the away server is not the ToolHost', () => {
  it('reaches neither the orchestrator nor a Unix socket', () => {
    // The `ToolHost` is a Unix socket in `@tade/orchestrator`, hosted by the
    // window for its own child agents: undiscoverable, nothing outside the
    // process tree may connect, dead when the window closes. This is a TCP
    // listener a person turns on, for a browser they paired, serving a
    // projection built to leave the machine. Different transport, different
    // authority, different threat model — and the only thing they share is
    // the process. A route that could reach the one from the other would hand
    // a phone every tool the orchestrator has.
    // **Reached, not mentioned**, throughout this file. Several of these
    // sources name the thing in the comment that says they do not touch it,
    // and a test that failed on its own explanation is one somebody deletes.
    const problems: string[] = []
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8')
      for (const banned of ['@tade/orchestrator', '@tade/app', '@tade/workbench', 'node:net'])
        if (text.includes(`'${banned}`)) problems.push(`${file} imports ${banned}`)
      // The socket itself, as a value rather than as a word in prose.
      for (const reached of ['new ToolHost', 'ToolHost.listen', 'toolHost.'])
        if (text.includes(reached)) problems.push(`${file} reaches ${reached}`)
    }
    expect(problems).toEqual([])
  })

  it('starts nothing: no spawn, no exec, no detached child', () => {
    // Everything Tade starts runs detached, and this starts nothing at all.
    // A server that could spawn is a server that is one route away from being
    // "run an arbitrary command", which is a `never remote` line.
    const problems: string[] = []
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8')
      for (const banned of [
        'node:child_process',
        'spawn(',
        'execFile(',
        'execSync',
        'spawnSync',
        // `.exec(` is a regular expression's own method and is everywhere in
        // the guard, so the shell forms are named individually rather than by
        // a substring that cannot tell the two apart.
        'exec(`',
        "exec('",
      ])
        if (text.includes(banned)) problems.push(`${file} uses ${banned}`)
    }
    expect(problems).toEqual([])
  })

  it('never reaches what writes a `said` line', () => {
    // `said` has exactly one writer and `namedBy` reads those lines to
    // authorise every `asked`-tier setting change on this machine. A page that
    // could put words in somebody's mouth would inherit authority over all of
    // them.
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8')
      expect(text, `${file} reaches remember()`).not.toMatch(/\.remember\s*\(/)
      expect(text, `${file} reaches say()`).not.toMatch(/\bwire\.say\s*\(/)
    }
  })

  it('writes no config: there is no setting any route can move', () => {
    const problems: string[] = []
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8')
      // The writers by name, and no `config.yaml`: the path is named in prose
      // in three of these files, and what matters is that nothing calls a
      // function that moves a setting.
      for (const banned of ['writeSetting', 'writeKey', 'applySetting', 'writeFileSync'])
        if (text.includes(banned)) problems.push(`${file} uses ${banned}`)
    }
    expect(problems).toEqual([])
  })
})

describe('what the surface is turned on as', () => {
  it('is off, on this machine, by default', () => {
    expect(OFF.enabled).toBe(false)
    expect(OFF.bind).toBe('loopback')
    expect(listenOn(OFF)).toEqual([])
  })

  it('reads a config that says nothing as off', () => {
    const surface = surfaceOf({ enabled: false, bind: 'lan', port: 7654, trusted_hosts: ['x'] })
    // `lan` with `enabled: false` is **off**, not "on the network and
    // waiting": two decisions, and the one deciding whether anything listens
    // is read first. Nothing here can turn on what the file did not.
    expect(surface.enabled).toBe(false)
    expect(surface.bind).toBe('loopback')
    expect(surface.trustedHosts).toEqual([])
    expect(listenOn(surface)).toEqual([])
  })

  it('listens on two addresses, explicitly, for each bind', () => {
    // `::` with `ipv6Only: false` accepts IPv4-mapped connections on many
    // systems and not all, so one listener would make which addresses are
    // served a property of the machine rather than of the setting.
    expect(
      listenOn(surfaceOf({ enabled: true, bind: 'loopback', port: 1, trusted_hosts: [] })),
    ).toEqual(['127.0.0.1', '::1'])
    expect(listenOn(surfaceOf({ enabled: true, bind: 'lan', port: 1, trusted_hosts: [] }))).toEqual(
      ['0.0.0.0', '::'],
    )
  })

  it('knows this machine in each of its spellings, and nothing else', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'app.localhost',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
    ])
      expect(loopbackHost(host), host).toBe(true)
    for (const host of [
      'localhost.evil.example',
      '192.168.1.10',
      '10.0.0.1',
      '0.0.0.0',
      '127.0.0.1.evil.example',
    ])
      expect(loopbackHost(host), host).toBe(false)
  })

  it('compares a host without its brackets or its case', () => {
    expect(sameHost('[::1]', '::1')).toBe(true)
    expect(sameHost('Studio.TS.NET', 'studio.ts.net')).toBe(true)
    expect(sameHost('a.example', 'b.example')).toBe(false)
  })
})

describe('what a session minted on an origin may ever do', () => {
  const lan = surfaceOf({
    enabled: true,
    bind: 'lan',
    port: 7654,
    trusted_hosts: ['studio.yak-bebop.ts.net'],
  })

  it('is everything it was granted, from this machine', () => {
    expect(trusted({ scheme: 'http', host: '127.0.0.1' }, lan)).toBe(true)
    expect(scopesOn({ scheme: 'http', host: 'localhost' }, lan, ['read', 'steer'])).toEqual([
      'read',
      'steer',
    ])
  })

  it('is everything it was granted, over https to a host the config trusts', () => {
    expect(trusted({ scheme: 'https', host: 'studio.yak-bebop.ts.net' }, lan)).toBe(true)
    expect(
      scopesOn({ scheme: 'https', host: 'studio.yak-bebop.ts.net' }, lan, ['read', 'answer']),
    ).toEqual(['read', 'answer'])
  })

  it('is read and nothing else over plain HTTP off this machine', () => {
    // DECISIONS §4.3: `bind: lan` is a read-only transport. A credential that
    // travelled in the clear across a network never buys an act, whatever is
    // turned on later — not a flag that could be raised, not a scope a grant
    // could widen.
    expect(trusted({ scheme: 'http', host: '192.168.1.10' }, lan)).toBe(false)
    expect(
      scopesOn({ scheme: 'http', host: '192.168.1.10' }, lan, ['read', 'steer', 'ask']),
    ).toEqual(['read'])
  })

  it('is nothing at all for an https host nobody wrote down', () => {
    // An `https` origin Tade was never told about is somebody else's name
    // resolving here.
    expect(trusted({ scheme: 'https', host: 'evil.example' }, lan)).toBe(false)
    expect(scopesOn({ scheme: 'https', host: 'evil.example' }, lan, ['read', 'steer'])).toEqual([
      'read',
    ])
  })

  it('grants nothing to a device that was granted nothing', () => {
    expect(scopesOn({ scheme: 'http', host: '127.0.0.1' }, lan, [])).toEqual([])
    expect(scopesOn({ scheme: 'http', host: '192.168.1.10' }, lan, [])).toEqual([])
  })
})

describe('the four sentences', () => {
  it('say what a LAN is, and the way out in the same breath', () => {
    expect(LAN_IS_PLAINTEXT).toContain('plain HTTP')
    expect(LAN_IS_PLAINTEXT).toContain('same wifi')
    expect(LAN_IS_PLAINTEXT).toContain('tailscale serve')
  })

  it('never promise a LAN is private', () => {
    for (const sentence of [LAN_IS_PLAINTEXT, COOKIES_IGNORE_PORTS, DEVICES_AND_AGENTS])
      for (const word of ['secure', 'encrypted', 'private', 'safe'])
        expect(sentence.toLowerCase(), `${word} in ${sentence.slice(0, 30)}`).not.toContain(word)
  })

  it('say a cookie prefix does not isolate ports, which is what it gets named as', () => {
    expect(COOKIES_IGNORE_PORTS).toContain('not isolated by port')
    expect(COOKIES_IGNORE_PORTS).toContain('no cookie prefix changes that')
    // And name the two mitigations that are real, because a correction with no
    // answer in it is one people scroll past.
    expect(COOKIES_IGNORE_PORTS).toContain('exact host')
    expect(COOKIES_IGNORE_PORTS).toContain('TLS')
  })

  it('narrow what HttpOnly does, rather than calling it an answer to XSS', () => {
    expect(HTTPONLY_IS_NOT_XSS).toContain('does not keep one from using it')
    expect(HTTPONLY_IS_NOT_XSS).toContain('builds no markup')
    expect(HTTPONLY_IS_NOT_XSS.toLowerCase()).not.toContain('survives')
  })
})
