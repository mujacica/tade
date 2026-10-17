import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJournal } from '@tade/workbench/events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { writeFromShell } from '../src/config-write.ts'

// The config written from a terminal goes through the one write path and is
// written down as `config_changed`, `by: cli`, like a change from Settings —
// and the line never carries a key.

afterEach(() => {
  vi.unstubAllEnvs()
})

/** A home of its own, as `TADE_HOME`, its config holding `text`. */
function homeWith(text: string): { home: string; path: string } {
  const home = tmp('tade-config-write-')
  vi.stubEnv('TADE_HOME', home)
  const path = join(home, 'config.yaml')
  writeFileSync(path, text)
  return { home, path }
}

function unsaid(said: string): void {
  throw new Error(`said that it could not be written down: ${said}`)
}

const details = async (home: string) =>
  (await readJournal(home, { types: ['config_changed'] })).map(({ detail }) => {
    const { at: _at, ...rest } = detail
    return rest
  })

describe('a config write from a terminal', () => {
  it('writes down each key it changed, what it was and is, by the CLI', async () => {
    const { home, path } = homeWith('# mine\nsurfaces:\n  web:\n    enabled: false\n')
    await writeFromShell(
      path,
      [
        { key: 'surfaces.web.enabled', value: true },
        { key: 'surfaces.web.bind', value: 'lan' },
        { key: 'surfaces.web.trusted_hosts', value: ['studio.ts.net', 'tunnel.example.com'] },
      ],
      unsaid,
    )
    expect(readFileSync(path, 'utf8')).toContain('# mine')
    expect(await details(home)).toEqual([
      { path: 'surfaces.web.enabled', was: 'false', now: 'true', by: 'cli' },
      { path: 'surfaces.web.bind', was: '', now: 'lan', by: 'cli' },
      {
        path: 'surfaces.web.trusted_hosts',
        was: '',
        now: 'studio.ts.net tunnel.example.com',
        by: 'cli',
      },
    ])
  })

  it('never says a key, nor what is inside a block a key may be in', async () => {
    const { home, path } = homeWith('')
    await writeFromShell(
      path,
      [
        { key: 'extensions.sentry.auth_token', value: 'sntrys_THE-TOKEN' },
        { key: 'extensions.jev.key', value: 'jev-0123456789' },
        { key: 'extensions.deps.registry', value: 'npm-secret-value', secret: true },
        {
          key: 'remotes.box',
          value: { ssh: 'box', device: 'd1', session: 'THE-SESSION', csrf: 'THE-CSRF' },
        },
      ],
      unsaid,
    )
    const said = await details(home)
    expect(said.map((one) => one.now)).toEqual([
      '16 characters',
      '14 characters',
      '16 characters',
      'set',
    ])
    const journal = readFileSync(join(home, 'events.jsonl'), 'utf8')
    for (const secret of ['THE-TOKEN', 'jev-0123456789', 'npm-secret-value', 'THE-SESSION']) {
      expect(journal).not.toContain(secret)
    }
  })

  it('writes nothing down for a key written as what it was', async () => {
    const { home, path } = homeWith('surfaces:\n  web:\n    enabled: true\n')
    await writeFromShell(path, [{ key: 'surfaces.web.enabled', value: true }], unsaid)
    expect(await details(home)).toEqual([])
  })

  it('writes nothing in this home for a file that is not its config', async () => {
    const { home } = homeWith('')
    const elsewhere = join(tmp('tade-config-elsewhere-'), 'config.yaml')
    await writeFromShell(elsewhere, [{ key: 'surfaces.web.enabled', value: true }], unsaid)
    expect(readFileSync(elsewhere, 'utf8')).toContain('enabled: true')
    expect(await details(home)).toEqual([])
  })

  it('says the key is written but not yet in the journal, where the journal will not take it', async () => {
    const { home, path } = homeWith('')
    mkdirSync(join(home, 'events.jsonl'))
    const said: string[] = []
    await writeFromShell(path, [{ key: 'surfaces.web.enabled', value: true }], (one) =>
      said.push(one),
    )
    expect(readFileSync(path, 'utf8')).toContain('enabled: true')
    expect(said).toEqual([
      expect.stringContaining('surfaces.web.enabled is written, but not yet in the journal'),
    ])
  })
})
