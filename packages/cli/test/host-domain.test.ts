import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DomainSeen, loadConfig, TADE_SH_IS_THE_INSTALLER } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  domainJson,
  domainPrinted,
  domainRefused,
  loopbackAsks,
  markOf,
  type NameOffer,
  offerName,
  writeLoopback,
  writePublic,
} from '../src/commands/host-domain.ts'
import type { Asker } from '../src/commands/host-service.ts'

// `tade host domain`: the look printed as the terminal has it, the name
// refused before anything is asked, and the write that happens on a press —
// the public name alone, or a trusted hostname for a Caddy in front of the
// loopback listener, and never both.
// What the records come to is `@tade/core`'s `domain.test.ts`; asking for them
// is `@tade/workbench`'s, over a server on loopback — a test here never
// reaches the network, which is why the binary is only run where it refuses.

const NAME = 'tade.example.com'
const OLD = 'old.example.com'
const HERE4 = '203.0.113.7'

/** A config file holding `text`, somewhere of its own. */
function configWith(text: string): string {
  const path = join(tmp('tade-domain-write-'), 'config.yaml')
  writeFileSync(path, text)
  return path
}

/** The two keys as the config at `path` loads them. */
async function web(path: string): Promise<{ public: string; trusted_hosts: string[] }> {
  const loaded = await loadConfig(path)
  if (!loaded.ok) throw new Error(`${path} does not load`)
  const { public: name, trusted_hosts } = loaded.config.surfaces.web
  return { public: name, trusted_hosts: [...trusted_hosts] }
}

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

  it('is written as the public name alone, keeping the trusted hostnames as they were', async () => {
    const path = configWith('# mine\nsurfaces:\n  web:\n    trusted_hosts: [studio.ts.net]\n')
    expect(await writePublic(path, NAME, [])).toEqual({ public: NAME, taken: [] })
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('# mine')
    expect(text).toContain(`public: ${NAME}`)
    expect(await web(path)).toEqual({ public: NAME, trusted_hosts: ['studio.ts.net'] })
    // Twice is once.
    expect(await writePublic(path, NAME, [])).toBeNull()
  })

  it('takes back what Tade copied beside the public name it replaces, and nothing else', async () => {
    const path = configWith(
      `surfaces:\n  web:\n    public: ${OLD}\n    trusted_hosts: [studio.ts.net, ${OLD}]\n`,
    )
    expect(await writePublic(path, NAME, [OLD, 'gone.example.com'])).toEqual({
      public: NAME,
      taken: [OLD],
    })
    expect(await web(path)).toEqual({ public: NAME, trusted_hosts: ['studio.ts.net'] })
  })

  it('is added to the trusted hostnames alone for a Caddy in front of the loopback listener', async () => {
    const path = configWith('surfaces:\n  web:\n    trusted_hosts: [studio.ts.net]\n')
    expect(await writeLoopback(path, NAME)).toEqual(['studio.ts.net', NAME])
    expect(await web(path)).toEqual({ public: '', trusted_hosts: ['studio.ts.net', NAME] })
    expect(await writeLoopback(path, NAME)).toBeNull()
  })

  it('puts the file back as it was where the config would not load with it', async () => {
    const dir = tmp('tade-domain-refused-')
    const path = join(dir, 'config.yaml')
    const before = '# mine\nsurfaces:\n  web:\n    enabled: true\n'
    writeFileSync(path, before)
    await expect(writePublic(path, 'box.tade.sh', [])).rejects.toThrow(TADE_SH_IS_THE_INSTALLER)
    expect(readFileSync(path, 'utf8')).toBe(before)
    // And where there was no file, there is none after.
    const none = join(dir, 'none.yaml')
    await expect(writePublic(none, 'box.tade.sh', [])).rejects.toThrow(TADE_SH_IS_THE_INSTALLER)
    expect(existsSync(none)).toBe(false)
    // A config that does not load is not written into.
    writeFileSync(path, 'surfaces: [\n')
    await expect(writePublic(path, NAME, [])).rejects.toThrow('does not load')
    await expect(writeLoopback(path, NAME)).rejects.toThrow('does not load')
  })
})

describe('the name, on a press', () => {
  /** A terminal that answers each question in turn, and keeps what was said and asked. */
  function asker(answers: boolean[]): Asker & { said: string[]; asked: string[] } {
    const said: string[] = []
    const asked: string[] = []
    return {
      said,
      asked,
      say: (text) => said.push(text),
      confirm: async (question) => {
        asked.push(question)
        return answers.shift() ?? false
      },
      run: async () => 0,
    }
  }

  function offer(path: string, over: Partial<NameOffer> = {}): NameOffer {
    return {
      path,
      loud: false,
      write: false,
      asking: true,
      copies: async () => [],
      open: async () => false,
      ...over,
    }
  }

  it('asks once, and writes the public name alone', async () => {
    const path = configWith('surfaces:\n  web:\n    trusted_hosts: [studio.ts.net]\n')
    const ask = asker([true])
    expect(await offerName(ask, NAME, offer(path))).toBe(true)
    expect(ask.asked).toEqual([`Write ${NAME} as surfaces.web.public?`])
    expect(await web(path)).toEqual({ public: NAME, trusted_hosts: ['studio.ts.net'] })
    expect(ask.said.at(-1)).toBe(
      `surfaces.web.public is ${NAME}. It applies the next time Tade starts. \`tade host caddy\` prints the site block for it.`,
    )
  })

  it('takes back the copy of the name it replaces, and says so', async () => {
    const path = configWith(
      `surfaces:\n  web:\n    public: ${OLD}\n    trusted_hosts: [studio.ts.net, ${OLD}]\n`,
    )
    const ask = asker([true])
    const open = async () => true
    expect(await offerName(ask, NAME, offer(path, { copies: async () => [OLD], open }))).toBe(true)
    expect(await web(path)).toEqual({ public: NAME, trusted_hosts: ['studio.ts.net'] })
    expect(ask.said.at(-1)).toBe(
      `surfaces.web.public is ${NAME}. ${OLD} is no longer a trusted hostname: Tade had copied it there beside a public name, which is trusted on its own. A window has this home open, so it applies when that window next starts. \`tade host caddy\` prints the site block for it.`,
    )
  })

  it('writes the public name and takes nothing back where the journal could not be read', async () => {
    const path = configWith(`surfaces:\n  web:\n    public: ${OLD}\n    trusted_hosts: [${OLD}]\n`)
    const ask = asker([])
    const copies = async () => {
      throw new Error('EACCES')
    }
    expect(await offerName(ask, NAME, offer(path, { write: true, copies }))).toBe(true)
    expect(ask.asked).toEqual([])
    expect(await web(path)).toEqual({ public: NAME, trusted_hosts: [OLD] })
    expect(ask.said.at(-1)).toContain(
      `surfaces.web.public is ${NAME}. Trusted hostnames left as they were: the journal, which says which of them Tade copied there, could not be read (EACCES).`,
    )
  })

  it('offers the trusted hostnames only once the public name is declined, said as the loopback path', async () => {
    const path = configWith('surfaces:\n  web:\n    port: 7700\n')
    const ask = asker([false, true])
    expect(await offerName(ask, NAME, offer(path))).toBe(true)
    expect(ask.asked).toEqual([`Write ${NAME} as surfaces.web.public?`, loopbackAsks(NAME, 7700)])
    expect(loopbackAsks(NAME, 7700)).toContain('127.0.0.1:7700, with no public socket')
    expect(await web(path)).toEqual({ public: '', trusted_hosts: [NAME] })
    expect(ask.said.at(-1)).toBe(
      `${NAME} is a trusted hostname, for a Caddy in front of the loopback listener. It applies the next time Tade starts.`,
    )
  })

  it('writes nothing where both are declined', async () => {
    const before = 'surfaces:\n  web:\n    enabled: true\n'
    const path = configWith(before)
    const ask = asker([false, false])
    expect(await offerName(ask, NAME, offer(path))).toBe(true)
    expect(ask.asked).toHaveLength(2)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('does not offer the trusted hostnames where the name is one already', async () => {
    const path = configWith(`surfaces:\n  web:\n    trusted_hosts: [${NAME}]\n`)
    const ask = asker([false])
    expect(await offerName(ask, NAME, offer(path))).toBe(true)
    expect(ask.asked).toEqual([`Write ${NAME} as surfaces.web.public?`])
  })

  it('asks nothing where it is the public name already, or where there is no terminal to ask in', async () => {
    const set = configWith(`surfaces:\n  web:\n    public: ${NAME}\n`)
    const ask = asker([])
    expect(await offerName(ask, NAME, offer(set))).toBe(true)
    expect(ask.said.at(-1)).toBe(`surfaces.web.public is ${NAME}.`)
    const before = 'surfaces:\n  web:\n    enabled: true\n'
    const unset = configWith(before)
    expect(await offerName(ask, NAME, offer(unset, { asking: false }))).toBe(true)
    expect(ask.said.at(-1)).toBe(
      `\`tade host domain ${NAME} --write\` writes it as the public name.`,
    )
    expect(ask.asked).toEqual([])
    expect(readFileSync(unset, 'utf8')).toBe(before)
  })

  it('says why and answers false where the write failed', async () => {
    const path = configWith('surfaces: [\n')
    const ask = asker([true])
    expect(await offerName(ask, NAME, offer(path))).toBe(false)
    expect(ask.said.at(-1)).toContain('does not load')
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
