import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, Secrets } from '@tade/core'
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

  it('clears the model when the harness is reselected, so the new one decides', async () => {
    terminal.columns = 140
    terminal.rows = 50
    // In the file as well as in the window: a setting is written by reading
    // that file, changing it and writing it back, so what is only in memory
    // is not what is being cleared.
    const yaml = [
      'projects:',
      '  app:',
      `    root: ${repo.root}`,
      'workers:',
      '  routes:',
      '    default:',
      '      harness: pi',
      '      provider: openrouter',
      '      model: anthropic/claude-opus-5',
      '',
    ].join('\n')
    writeFileSync(join(home, 'config.yaml'), yaml)
    const loaded = await loadConfig(join(home, 'config.yaml'))
    if (!loaded.ok) throw new Error('the test config would not load')
    await start({ config: loaded.config })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Where agents run'))
    const models = find('Models')
    click(models.col + 1, models.row)
    await until('the agent model', () =>
      screenOf(terminal.written).some((row) => row.includes('Agent harness')),
    )
    // Choosing the harness it is already on is not a new choice, and may not
    // quietly take the model away.
    const same = find('◉ pi')
    // Found while the whole screen is still in the buffer: what is written
    // after it is cleared is only what changed.
    const harness = find('claude-code')
    terminal.written = ''
    click(same.col + 2, same.row)
    await until('saved', () => terminal.written.includes('Saved'))
    expect(client.config.workers.routes.default?.model).toBe('anthropic/claude-opus-5')

    terminal.written = ''
    click(harness.col + 1, harness.row)
    await until('saved', () => terminal.written.includes('Saved'))
    // A model chosen for pi is not Claude Code's to start on, and `routeIn`
    // reads a route's own model as its own harness's — so it goes, and the
    // harness decides until somebody chooses again.
    expect(client.config.workers.routes.default?.harness).toBe('claude-code')
    expect(client.config.workers.routes.default?.model).toBeUndefined()
    expect(client.config.workers.routes.default?.provider).toBeUndefined()
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('claude-opus-5')
    // Said, because a choice that disappears without a word reads as a bug.
    expect(screenOf(terminal.written).join('\n')).toContain(
      'The agent model is cleared: claude-code decides.',
    )
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
