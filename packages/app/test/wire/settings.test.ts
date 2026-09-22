import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, loadConfig, Secrets, settingsOf } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { asPaste } from '../../src/input.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The page opened from its button, a setting saved so the next agent gets it,
// a key that goes to the keychain and never to the config, and a DSN that is
// neither — an endpoint, drawn as itself, and kept once it is typed.

/** Seventy characters, which is what a Sentry DSN is and what a field is not. */
const DSN = 'https://0123456789abcdef0123456789abcdef@o447951.ingest.sentry.io/4505'

describe('the window, and its settings', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  const { start, newTerminal, click, find } = windowUnderTest((wired) => {
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
    // Pasted, not typed, because that is how a key this long gets into a
    // field at all — and the break at the end of it is the clipboard's:
    // copying a key off a page takes the newline after it too, and it must
    // neither send the field nor end up in the keychain.
    terminal.press(asPaste('wk_0123456789\n'))
    terminal.press('\r')
    await until('saved', () => terminal.written.includes('Saved in'))
    expect(secrets.get('weather.key')).toBe('wk_0123456789')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('wk_0123456789')
    // Neither as it was pasted, nor read back to you afterwards.
    expect(terminal.written).not.toContain('wk_0123456789')
  })

  // Three things were wrong with the one field on this page that is neither a
  // switch nor a list, and the DSN is where all three met: it was drawn as
  // bullets, it was too long for the field, and clicking away from it lost
  // what had been pasted while the foot of the page said "Saved as you change
  // it". What that looks like is a value that resets itself.
  it('keeps a DSN pasted into Settings, in full, and across a restart', async () => {
    terminal.columns = 140
    terminal.rows = 50
    const first = await start()
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Where agents run'))
    const category = find('Telemetry')
    click(category.col + 1, category.row)
    await until('the field', () =>
      screenOf(terminal.written).some((row) => row.includes('Send to')),
    )
    const field = find('Send to')
    click(field.col + 42, field.row)
    terminal.press(asPaste(`${DSN}\n`))
    // Closed by its own button rather than by enter: leaving a field is what
    // used to throw it away.
    const done = find('Done')
    terminal.written = ''
    click(done.col + 2, done.row)
    // The workbench's own copy is the one that decides what is sent, and it
    // is the last thing a save touches.
    await until('the DSN to be saved', () => client.config.telemetry.dsn === DSN)
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain(DSN)
    await until('the page to close', () => !terminal.written.includes('Send to'))
    await first.stop()

    // A new window on the same home, started the way the binary starts it:
    // from the file. What was saved is what it opens on.
    const loaded = await loadConfig(join(home, 'config.yaml'))
    if (!loaded.ok) throw new Error('the config would not load with the DSN in it')
    terminal = newTerminal()
    terminal.columns = 140
    terminal.rows = 50
    await start({ config: loaded.config })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const again = find('Settings ')
    click(again.col + 1, again.row)
    await until('the settings', () => terminal.written.includes('Where agents run'))
    const telemetry = find('Telemetry')
    click(telemetry.col + 1, telemetry.row)
    await until('the field', () =>
      screenOf(terminal.written).some((row) => row.includes('Send to')),
    )
    // Drawn as itself, and the whole of it: a DSN is an ingest endpoint, not a
    // key, and seventy characters you cannot read are seventy characters you
    // cannot check for a typo.
    const screen = screenOf(terminal.written)
    let got = ''
    for (const row of screen) {
      for (let len = DSN.length - got.length; len > 2; len--) {
        const piece = DSN.slice(got.length, got.length + len)
        if (row.includes(piece)) {
          got += piece
          break
        }
      }
    }
    expect(got).toBe(DSN)
  })

  it('leaves a key that is a key where keys are kept, and never on the page', async () => {
    // The audit that came with the DSN: what is genuinely a credential still
    // behaves like one. A Sentry auth token grants reading an organisation; a
    // DSN grants sending events to one project and is published in the
    // JavaScript of every page Sentry watches.
    const groups = settingsOf(ConfigSchema.parse({}), [
      { name: 'sentry.token', title: 'Sentry', means: 'a user auth token', from: null },
    ])
    const of = (path: string) =>
      groups.flatMap((group) => group.settings).find((one) => one.path === path)
    expect(of('secrets.sentry.token')?.kept).toBe('sentry.token')
    expect(of('secrets.sentry.token')?.secret).toBe(true)
    expect(of('secrets.sentry.token')?.value).toBe('')
    expect(of('telemetry.dsn')?.kept).toBeUndefined()
    expect(of('telemetry.dsn')?.secret).toBeUndefined()
  })

  it('keeps a paste wider than the field whole, and the break at the end of it out', async () => {
    terminal.columns = 140
    terminal.rows = 50
    await start()
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Rules for every agent'))
    const field = find('Rules for every agent')
    click(field.col + 42, field.row)
    // Two lines pasted into a field with room for one: they arrive as the one
    // line they have to be, rather than as nothing at all.
    const rules = `Never force-push. ${'Read the guide before editing. '.repeat(3)}`.trim()
    terminal.press(asPaste(`${rules.replace('guide before', 'guide\n  before')}\n`))
    terminal.press('\r')
    await until('saved', () => terminal.written.includes('applies now'))
    expect(client.config.agents.instructions).toBe(rules)
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('Never force-push.')
  })
})
