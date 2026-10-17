import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, type DomainSeen, loadConfig } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { asPaste } from '../../src/input.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The records a public name needs, in Settings › Away view: a name typed in
// the Public name row is written as the public name alone — it is trusted on
// its own — and changing or clearing it takes back the copy of an earlier one
// Tade wrote into the trusted hostnames, and nothing somebody put there. The
// look is drawn under the row when the page shows it and again on Look again.
// The look is handed in, as the CLI hands the real one, so nothing here
// reaches the network.

const NAME = 'box.example.com'
const OLD = 'old.example.com'
const TAILNET = 'studio.ts.net'
const MINE = 'mine.example.com'

function seenFor(name: string): DomainSeen {
  return {
    name,
    zone: { apex: 'example.com', servers: ['ns1.example.net'] },
    own: {
      a: { none: 'name', ttl: 300, validated: false },
      aaaa: { none: 'name', ttl: 300, validated: false },
      caa: { none: 'name', ttl: 300, validated: false },
    },
    world: {
      a: { none: 'name', ttl: 300, validated: false },
      aaaa: { none: 'name', ttl: 300, validated: false },
    },
    caa: { at: name, answer: { none: 'name', ttl: 300, validated: false } },
    dnssec: { unsigned: true },
    here: { v4: ['203.0.113.7'], v6: [] },
    serving: [],
    certificate: { at: 0, cannot: 'ENOTFOUND' },
    account: { cannot: 'only Caddy can read where it keeps it' },
  }
}

describe('a public name, set up from Settings', () => {
  let terminal: FakeTerminal
  let repo: Repo
  let home: string
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
    home = wired.home
    client = wired.client
  })

  /** Settings › Away view open, on a window started with these two keys. */
  async function onThePage(web: { public?: string; trusted_hosts: string[] }): Promise<string> {
    const config = join(home, 'config.yaml')
    const named = web.public === undefined ? '' : `    public: ${web.public}\n`
    writeFileSync(
      config,
      `projects:\n  app:\n    root: ${repo.root}\nsurfaces:\n  web:\n${named}    trusted_hosts: [${web.trusted_hosts.join(', ')}]\n`,
    )
    terminal.columns = 160
    terminal.rows = 90
    await start({
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } }, surfaces: { web } }),
      domain: async (name: string) => seenFor(name),
    })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Away view'))
    const category = find('Away view')
    click(category.col + 1, category.row)
    await until('the row', () =>
      screenOf(terminal.written).some((row) => row.includes('Public name')),
    )
    return config
  }

  /** What Settings wrote for a public name typed in until 2026-10-17: the name, then its copy, in one loop. */
  function copiedBefore(name: string, was: readonly string[]): void {
    for (const detail of [
      { path: 'surfaces.web.public', was: '', now: name },
      { path: 'surfaces.web.trusted_hosts', was: was.join(' '), now: [...was, name].join(' ') },
    ]) {
      void client.log.append({ type: 'config_changed', detail: { ...detail, by: 'window' } })
    }
  }

  /** Empty the Public name row, type `name` into it as a person would, and leave it with enter. */
  function typeName(name: string): void {
    const field = find('Public name')
    click(field.col + 30, field.row)
    terminal.press('\x15')
    if (name !== '') terminal.press(asPaste(name))
    terminal.press('\r')
  }

  /** The trusted hostnames lines the journal has. */
  function trustedLines(): { was: string; now: string }[] {
    return readFileSync(join(home, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"path":"surfaces.web.trusted_hosts"'))
      .map((line) => JSON.parse(line).detail)
  }

  it('takes back the copy of the name it replaces, and keeps what somebody put there', async () => {
    copiedBefore(OLD, [TAILNET])
    const config = await onThePage({ public: OLD, trusted_hosts: [TAILNET, OLD, MINE] })
    typeName(NAME)
    await until('saved', () =>
      screenOf(terminal.written).some((row) =>
        row.includes(`${OLD} is no longer a trusted hostname`),
      ),
    )
    const saved = await loadConfig(config)
    if (!saved.ok) throw new Error('the config would not load')
    expect(saved.config.surfaces.web.public).toBe(NAME)
    expect(saved.config.surfaces.web.trusted_hosts).toEqual([TAILNET, MINE])
    // Written down beside the public name's line, so the taking back can be undone too.
    await until('the taking back in the journal', () => trustedLines().length === 2)
    expect(trustedLines()[1]).toMatchObject({
      was: `${TAILNET} ${OLD} ${MINE}`,
      now: `${TAILNET} ${MINE}`,
    })
  })

  it('takes back the copy when the name is cleared, too', async () => {
    copiedBefore(OLD, [])
    const config = await onThePage({ public: OLD, trusted_hosts: [OLD, TAILNET] })
    typeName('')
    await until('saved', () =>
      screenOf(terminal.written).some((row) =>
        row.includes(`${OLD} is no longer a trusted hostname`),
      ),
    )
    const saved = await loadConfig(config)
    if (!saved.ok) throw new Error('the config would not load')
    expect(saved.config.surfaces.web.public).toBe('')
    expect(saved.config.surfaces.web.trusted_hosts).toEqual([TAILNET])
  })

  it('takes nothing back that Tade did not put there', async () => {
    // The same name, typed into the file by the person: no line says Tade wrote it.
    const config = await onThePage({ public: OLD, trusted_hosts: [OLD] })
    typeName(NAME)
    await until('saved', () =>
      screenOf(terminal.written).some((row) => row.includes('Saved. It applies now.')),
    )
    const saved = await loadConfig(config)
    if (!saved.ok) throw new Error('the config would not load')
    expect(saved.config.surfaces.web.public).toBe(NAME)
    expect(saved.config.surfaces.web.trusted_hosts).toEqual([OLD])
    expect(screenOf(terminal.written).join('\n')).not.toContain('no longer a trusted hostname')
    expect(trustedLines()).toEqual([])
  })

  it('writes a typed name as the public name alone, and draws its records under it', async () => {
    const asked: string[] = []
    const domain = async (name: string) => {
      asked.push(name)
      return seenFor(name)
    }
    const config = join(home, 'config.yaml')
    writeFileSync(
      config,
      `projects:\n  app:\n    root: ${repo.root}\nsurfaces:\n  web:\n    trusted_hosts: [studio.ts.net]\n`,
    )
    terminal.columns = 160
    terminal.rows = 90
    await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        surfaces: { web: { trusted_hosts: ['studio.ts.net'] } },
      }),
      domain,
    })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Away view'))
    const category = find('Away view')
    click(category.col + 1, category.row)
    await until('the row', () =>
      screenOf(terminal.written).some((row) => row.includes('Public name')),
    )
    // No name, nothing to look at.
    expect(asked).toEqual([])
    const field = find('Public name')
    click(field.col + 30, field.row)
    terminal.press(asPaste('Box.Example.com\n'))
    terminal.press('\r')
    await until('saved', () =>
      screenOf(terminal.written).some((row) => row.includes('Saved. It applies now.')),
    )
    const saved = await loadConfig(config)
    if (!saved.ok) throw new Error('the config would not load')
    expect(saved.config.surfaces.web.public).toBe('Box.Example.com')
    // Trusted on its own, so never copied into the trusted hostnames, where it
    // would outlive a change of name.
    expect(saved.config.surfaces.web.trusted_hosts).toEqual(['studio.ts.net'])
    expect(screenOf(terminal.written).join('\n')).not.toContain('trusted hostname')
    // Written down, so it can be found and undone.
    await until('in the journal', () =>
      readFileSync(join(home, 'events.jsonl'), 'utf8').includes('"path":"surfaces.web.public"'),
    )
    expect(trustedLines()).toEqual([])

    await until('the records', () =>
      screenOf(terminal.written).some((row) => row.includes(`A: missing for ${NAME}`)),
    )
    expect(asked).toEqual([NAME])
    const page = screenOf(terminal.written).join('\n')
    expect(page).toContain(`add ${NAME}. A 203.0.113.7`)
    expect(page).toContain('CAA: after the first certificate')

    const again = find('Look again')
    click(again.col + 1, again.row)
    await until('a second look', () => asked.length === 2)
  })
})
