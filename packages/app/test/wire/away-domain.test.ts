import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, type DomainSeen, loadConfig } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { asPaste } from '../../src/input.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The records a public name needs, in Settings › Away view: a name typed in
// the Public name row is written as a trusted hostname on the same press, and
// the look is drawn under the row when the page shows it and again on Look
// again. The look is handed in, as the CLI hands the real one, so nothing here
// reaches the network.

const NAME = 'box.example.com'

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
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
    home = wired.home
  })

  it('writes a typed name as a trusted hostname too, and draws its records under it', async () => {
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
      screenOf(terminal.written).some((row) => row.includes(`${NAME} is a trusted hostname too`)),
    )
    const saved = await loadConfig(config)
    if (!saved.ok) throw new Error('the config would not load')
    expect(saved.config.surfaces.web.public).toBe('Box.Example.com')
    expect(saved.config.surfaces.web.trusted_hosts).toEqual(['studio.ts.net', NAME])
    // Both written down, so either can be found and undone.
    await until('both in the journal', () => {
      const journal = readFileSync(join(home, 'events.jsonl'), 'utf8')
      return (
        journal.includes('"path":"surfaces.web.public"') &&
        journal.includes('"path":"surfaces.web.trusted_hosts"')
      )
    })

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
