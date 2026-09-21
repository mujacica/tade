import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Secrets } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The page opened from its button, a setting saved so the next agent gets it,
// and a key that goes to the keychain and never to the config.

describe('the window, and its settings', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
  })

  it('opens Settings from its button, with its categories and controls', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    terminal.written = ''
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Where agents run'))
    expect(terminal.written).toContain('Accounts')
  })

  it('saves where agents work so the workbench starts the next one there', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Where agents work'))
    terminal.written = ''
    // Two choices are radios: the arrow moves to the other one and saves it.
    terminal.press('\x1b[C')
    await until('saved', () => terminal.written.includes('applies now'))
    // The workbench's own copy is the one that decides where a task is made.
    expect(client.config.agents.workspace).toBe('worktree')
  })

  it('pastes a key from Settings, into the keychain and not the config', async () => {
    terminal.columns = 140
    terminal.rows = 50
    const secrets = Secrets.open({ home, platform: 'linux' })
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          settings: [
            { key: 'key', kind: 'secret', env: 'WEATHER_API_KEY', means: 'the forecast key' },
          ],
          ready: (ctx) => (ctx.secret('key') ? null : 'weather needs a key'),
          setup: () => ({
            guide: ['Paste the key.'],
            fields: [{ key: 'key', label: 'API key', kind: 'secret' }],
          }),
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
      env: {},
      secrets,
    })
    await start({ extensions })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    // Every key anything asks for is one group, wherever the thing asking for
    // it lives: it is a key, and that is how people look for it.
    await until('the settings', () => terminal.written.includes('Keys and tokens'))
    const category = find('Keys and tokens')
    click(category.col + 1, category.row)
    await until('the field', () =>
      screenOf(terminal.written).some((row) => row.includes('Weather api key')),
    )
    const field = find('Weather api key')
    click(field.col + 30, field.row)
    for (const char of 'wk_0123456789') terminal.press(char)
    terminal.press('\r')
    await until('saved', () => terminal.written.includes('Saved in'))
    expect(secrets.get('weather.key')).toBe('wk_0123456789')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('wk_0123456789')
    // Neither as it was typed, nor read back to you afterwards.
    expect(terminal.written).not.toContain('wk_0123456789')
  })
})
