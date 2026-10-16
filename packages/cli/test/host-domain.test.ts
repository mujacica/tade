import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DomainSeen, TADE_SH_IS_THE_INSTALLER } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  domainJson,
  domainPrinted,
  domainRefused,
  markOf,
  writeTrusted,
} from '../src/commands/host-domain.ts'

// `tade host domain`: the look printed as the terminal has it, the name
// refused before anything is asked, and the write that happens on a press.
// What the records come to is `@tade/core`'s `domain.test.ts`; asking for them
// is `@tade/workbench`'s, over a server on loopback — a test here never
// reaches the network, which is why the binary is only run where it refuses.

const NAME = 'tade.example.com'
const HERE4 = '203.0.113.7'

const SEEN: DomainSeen = {
  name: NAME,
  zone: { apex: 'example.com', servers: ['ns1.example.net'] },
  own: {
    a: { found: ['198.51.100.9'], ttl: 300, validated: false },
    aaaa: { none: 'type', ttl: 300, validated: false },
    caa: { none: 'type', ttl: 300, validated: false },
  },
  world: {
    a: { found: ['198.51.100.9'], ttl: 300, validated: false },
    aaaa: { none: 'type', ttl: 300, validated: false },
  },
  caa: { at: NAME, answer: { none: 'type', ttl: 300, validated: false } },
  dnssec: { unsigned: true },
  here: { v4: [HERE4], v6: [] },
  serving: [],
  certificate: { at: 0, cannot: 'ENOTFOUND' },
  account: { cannot: 'only Caddy can read where it keeps it' },
}

describe('the look, as the terminal prints it', () => {
  it('says the zone, then a line per record, with what to add and take away under it', () => {
    expect(domainPrinted(SEEN)).toEqual([
      `${NAME}, in the zone example.com, answered for by ns1.example.net`,
      `▲ A: ${NAME} → 198.51.100.9, which is not this machine (${HERE4})`,
      `    add     ${NAME}. A ${HERE4}`,
      `    remove  ${NAME}. A 198.51.100.9`,
      '✓ AAAA: none, which is right: this machine has no public IPv6',
      '✓ DNSSEC: example.com is not signed, so there is nothing to break',
      "· CAA: after the first certificate — the record names Caddy's account at Let's Encrypt, which exists once it has ordered one",
    ])
  })

  it('marks what is loud, what is right, and the rest', () => {
    const line = { record: 'A', add: null, remove: [], said: '' } as const
    expect(markOf({ ...line, state: 'wrong', loud: true })).toBe('▲')
    expect(markOf({ ...line, state: 'right', loud: false })).toBe('✓')
    expect(markOf({ ...line, state: 'later', loud: false })).toBe('·')
  })

  it('puts every line and its state in --json', () => {
    const json = domainJson(SEEN) as { name: string; records: { record: string; state: string }[] }
    expect(json.name).toBe(NAME)
    expect(json.records.map((one) => `${one.record} ${one.state}`)).toEqual([
      'A wrong',
      'AAAA right',
      'DNSSEC right',
      'CAA later',
    ])
  })
})

describe('the name', () => {
  it('refuses what is not a name, and tade.sh with why', () => {
    expect(domainRefused(NAME)).toBeNull()
    expect(domainRefused('https://tade.example.com')).toContain('is not a host name')
    expect(domainRefused('box.tade.sh')).toBe(TADE_SH_IS_THE_INSTALLER)
  })

  it('is written as the public name and a trusted hostname, keeping what was there', async () => {
    const path = join(tmp('tade-domain-write-'), 'config.yaml')
    writeFileSync(path, '# mine\nsurfaces:\n  web:\n    trusted_hosts: [studio.ts.net]\n')
    expect(await writeTrusted(path, NAME)).toEqual({
      public: NAME,
      trusted_hosts: ['studio.ts.net', NAME],
    })
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('# mine')
    expect(text).toContain(`public: ${NAME}`)
    expect(text).toContain(`- ${NAME}`)
    // Twice is once.
    expect(await writeTrusted(path, NAME)).toBeNull()
  })

  it('puts the file back as it was where the config would not load with it', async () => {
    const dir = tmp('tade-domain-refused-')
    const path = join(dir, 'config.yaml')
    const before = '# mine\nsurfaces:\n  web:\n    enabled: true\n'
    writeFileSync(path, before)
    await expect(writeTrusted(path, 'box.tade.sh')).rejects.toThrow(TADE_SH_IS_THE_INSTALLER)
    expect(readFileSync(path, 'utf8')).toBe(before)
    // And where there was no file, there is none after.
    const none = join(dir, 'none.yaml')
    await expect(writeTrusted(none, 'box.tade.sh')).rejects.toThrow(TADE_SH_IS_THE_INSTALLER)
    expect(existsSync(none)).toBe(false)
    // A config that does not load is not written into.
    writeFileSync(path, 'surfaces: [\n')
    await expect(writeTrusted(path, NAME)).rejects.toThrow('does not load')
  })
})

describe('tade host domain', () => {
  const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const dir = tmp('tade-domain-cli-')
      const child = spawn(process.execPath, [bin, ...args], {
        env: { ...process.env, TADE_HOME: dir, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('exit', (code) => resolve({ code, stdout, stderr }))
    })

  it('refuses tade.sh, what is not a name and an account that is not one, before asking anything', async () => {
    const installer = await run(['host', 'domain', 'Box.Tade.sh.'])
    expect(installer).toEqual({ code: 2, stdout: '', stderr: `${TADE_SH_IS_THE_INSTALLER}\n` })
    const url = await run(['host', 'domain', 'https://tade.example.com/'])
    expect(url.code).toBe(2)
    expect(url.stderr).toContain('is not a host name')
    const account = await run(['host', 'domain', NAME, '--account', 'https://x"; y'])
    expect(account.code).toBe(2)
    expect(account.stderr).toContain('is not an account')
  })
})
