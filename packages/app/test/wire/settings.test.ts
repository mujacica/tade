import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, loadConfig, SEEN_BY_AGENTS, settingsOf, writeSetting } from '@tade/core'
import { ExtensionHost, type TadeExtension } from '@tade/extensions-core'
import type { Workbench } from '@tade/workbench'
import { recordConfigChanges } from '@tade/workbench/config-changes'
import { describe, expect, it } from 'vitest'
import { asPaste } from '../../src/input.ts'
import type { Thinker } from '../../src/wire/context.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The page opened from its button, a setting saved so the next agent gets it,
// a key written into the config as it was pasted, and a DSN, which is not a
// key at all and is now kept and drawn exactly the same way.

/** Seventy characters, which is what a Sentry DSN is and what a field is not. */
const DSN = 'https://0123456789abcdef0123456789abcdef@o447951.ingest.sentry.io/4505'

/** What is on screen, a wrapped line read as one. */
const shown = (terminal: FakeTerminal) =>
  screenOf(terminal.written)
    .map((row) => row.replace(/[│┃▕▏█▌]/g, ' ').trim())
    .join(' ')
    .replace(/\s+/g, ' ')

describe('the window, and its settings', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  let awake: { took: string[]; dropped: () => number }
  const { start, newTerminal, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
    awake = wired.awake
  })

  it('opens Settings from its button, with its categories and controls', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    terminal.written = ''
    click(button.col + 1, button.row)
    // The first control of the first group, so this holds however many rows
    // that group grows: one added above `workspace.driver` pushed it off a
    // 24-row terminal, and a page that had opened read as one that never did.
    await until('the settings', () => terminal.written.includes('Where agents work'))
    // A second category beside the controls, so this is the page and not one
    // group of it. Which one is not the point — the list is longer than a
    // 24-row terminal and scrolls, and a row of it is two rows tall, so this
    // names one that is drawn.
    expect(terminal.written).toContain('Models')
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

  it('reads which account new agents run as back from the workbench after the Accounts page sets it', async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    // Tall enough that the Accounts category is drawn without scrolling to it.
    terminal.resize(120, 60)
    const app = await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        accounts: { work: { harness: 'claude-code' } },
      }),
    })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Accounts'))
    const accounts = find('Accounts')
    click(accounts.col + 1, accounts.row)
    await until('the account to choose', () => terminal.written.includes('Use for new agents'))
    const use = find('Use for new agents')
    terminal.written = ''
    click(use.col + 1, use.row)
    await until('it said so', () => terminal.written.includes('agents run as work'))
    expect(client.config.workers.accounts['claude-code']).toBe('work')
    // The row the orchestrator and the Models page read is the same answer,
    // not the one the window was opened with — once the action has read the
    // accounts back, which is after the page has said what it did.
    const row = async () => app.configTools().settings('account')
    await until('the row to say so', async () =>
      (await row()).includes('workers.accounts.claude-code = work'),
    )
  })

  it('moves the orchestrator to another account from the Accounts page, and starts it again there', async () => {
    // The way off a plan it has used up: with no turns left it cannot be asked.
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    writeSetting(join(home, 'config.yaml'), 'orchestrator.harness', 'claude-code')
    const config = ConfigSchema.parse({
      projects: { app: { root: repo.root } },
      orchestrator: { harness: 'claude-code' },
      accounts: { work: { harness: 'claude-code' } },
    })
    client.config = config
    let restarts = 0
    terminal.resize(120, 60)
    await start({
      config,
      restartThinker: async () => {
        restarts += 1
      },
    })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Accounts'))
    const accounts = find('Accounts')
    click(accounts.col + 1, accounts.row)
    await until('the account to move to', () =>
      terminal.written.includes('Use for the orchestrator'),
    )
    const use = find('Use for the orchestrator')
    terminal.written = ''
    click(use.col + 1, use.row)
    await until('it said so', () => terminal.written.includes('starts again as work'))
    expect(restarts).toBe(1)
    expect(client.config.orchestrator.account).toBe('work')
    const loaded = await loadConfig(join(home, 'config.yaml'))
    expect(loaded.ok && loaded.config.orchestrator.account).toBe('work')
  })

  it('says the orchestrator moves back to its own sign-in by the name somebody gave it', async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    const file = join(home, 'config.yaml')
    writeSetting(file, 'orchestrator.harness', 'claude-code')
    writeSetting(file, 'orchestrator.account', 'work')
    writeSetting(file, 'workers.default_names.claude-code', 'sentry')
    const config = ConfigSchema.parse({
      projects: { app: { root: repo.root } },
      orchestrator: { harness: 'claude-code', account: 'work' },
      accounts: { work: { harness: 'claude-code' } },
      workers: { default_names: { 'claude-code': 'sentry' } },
    })
    client.config = config
    terminal.resize(120, 60)
    await start({ config, restartThinker: async () => {} })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Accounts'))
    const accounts = find('Accounts')
    click(accounts.col + 1, accounts.row)
    await until('the own sign-in to move to', () =>
      terminal.written.includes('Use for the orchestrator'),
    )
    const use = find('Use for the orchestrator')
    terminal.written = ''
    click(use.col + 1, use.row)
    // Both what the page says and, once it is closed, what the strip under it
    // says: its name, never the words for a sign-in nobody named.
    await until('the page said so', () => shown(terminal).includes('starts again as sentry now'))
    terminal.press('\x1b')
    await until('the strip said so', () =>
      shown(terminal).includes('the orchestrator is starting again as sentry'),
    )
    expect(shown(terminal)).not.toContain('as its own sign-in')
  })

  it('hears nothing more from the orchestrator it stopped to move it, whose TERM ends it with 143', async () => {
    // Claude Code ends on the TERM a restart sends it with code 143, after the
    // one on the new account is up: said by the one it replaced, that read as
    // the new one stopping — `The orchestrator stopped: Claude Code exited
    // with code 143` under `orchestrator ready`.
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    writeSetting(join(home, 'config.yaml'), 'orchestrator.harness', 'claude-code')
    const config = ConfigSchema.parse({
      projects: { app: { root: repo.root } },
      orchestrator: { harness: 'claude-code' },
      accounts: { work: { harness: 'claude-code' } },
    })
    client.config = config
    type Listener = Parameters<NonNullable<Thinker['onEvent']>>[0]
    const thinker = () => {
      const listeners = new Set<Listener>()
      const one: Thinker = {
        ask: async () => '',
        onEvent: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
      const says = (event: Parameters<Listener>[0]) => {
        for (const listener of [...listeners]) listener(event)
      }
      return { one, says }
    }
    const old = thinker()
    const moved = thinker()
    let restarts = 0
    terminal.resize(120, 60)
    const app = await start({
      config,
      thinker: old.one,
      restartThinker: async () => {
        app.attachThinker(moved.one)
        restarts += 1
      },
    })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Accounts'))
    const accounts = find('Accounts')
    click(accounts.col + 1, accounts.row)
    await until('the account to move to', () =>
      terminal.written.includes('Use for the orchestrator'),
    )
    const use = find('Use for the orchestrator')
    click(use.col + 1, use.row)
    await until('it was started again', () => restarts === 1)
    // Closed, so the conversation is in view.
    const done = find('Done')
    click(done.col + 2, done.row)
    await until('the page to close', () => !shown(terminal).includes('Use for new agents'))
    old.says({ type: 'failed', reason: 'Claude Code exited with code 143' })
    old.says({ type: 'exited', code: 143 })
    moved.says({ type: 'message', text: 'still here as work' })
    await until('the one it runs as now', () => shown(terminal).includes('still here as work'))
    expect(shown(terminal)).not.toContain('orchestrator stopped')
  })

  it('holds the machine awake from the button in the strip, and says the machine is held', async () => {
    // The whole way through, because the interesting part is the wiring: the
    // press writes the setting, the setting comes back through the one door
    // every setting comes back through, and the hold is taken *there* — so
    // the button and the Settings page cannot do two different things. The
    // assertion is the harness's own; no test asks this laptop to stay awake.
    await start()
    await until('the first frame', () => terminal.written.includes('Keep awake'))
    const button = find('Keep awake ')
    click(button.col + 1, button.row)
    await until('the hold', () => awake.took.length === 1)
    expect(client.config.agents.keep_awake).toBe(true)
    // And the button says what is true of the machine now, not what was asked.
    await until('the way out', () => terminal.written.includes('Let it sleep'))

    const again = find('Let it sleep ')
    click(again.col + 1, again.row)
    await until('the hold dropped', () => awake.dropped() === 1)
    expect(client.config.agents.keep_awake).toBe(false)
  })

  // `tade config` in another terminal, or over SSH, while this window holds
  // the journal: the line waits in the spool for the window's beat, which
  // writes it down and takes the change as it takes one of its own — the hold
  // taken here and now, where it used to wait for Tade to be started again.
  it('holds the machine awake when a terminal turns it on, on its next beat', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('Keep awake'))
    const path = join(home, 'config.yaml')
    writeFileSync(path, `${readFileSync(path, 'utf8')}agents:\n  keep_awake: true\n`)
    const change = { path: 'agents.keep_awake', was: '', now: 'true', by: 'cli' }
    expect(await recordConfigChanges(home, [change])).toBe('spool')
    await until('the hold', () => awake.took.length === 1)
    expect(client.config.agents.keep_awake).toBe(true)
    await until('the way out', () => terminal.written.includes('Let it sleep'))
    const lines = (await client.events({ types: ['config_changed'] })).map(({ detail }) => detail)
    expect(lines).toContainEqual(expect.objectContaining(change))
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
    // There are more harnesses than radios, so it is a list: opened on its
    // value, and chosen from by typing. Found while the whole screen is still
    // in the buffer: what is written after it is cleared is only what changed.
    const rows = screenOf(terminal.written)
    const row = rows.findIndex((line) => line.includes('Agent harness'))
    const label = rows[row]?.indexOf('Agent harness') ?? -1
    const control = { row, col: rows[row]?.indexOf('pi', label + 'Agent harness'.length) ?? -1 }
    const choose = async (typed: string) => {
      terminal.written = ''
      click(control.col + 1, control.row)
      await until('the list', () =>
        screenOf(terminal.written).some((line) => line.includes('codex')),
      )
      terminal.written = ''
      terminal.press(typed)
      terminal.press('\r')
      await until('saved', () => terminal.written.includes('Saved'))
    }
    // Choosing the harness it is already on is not a new choice, and may not
    // quietly take the model away.
    await choose('pi')
    expect(client.config.workers.routes.default?.model).toBe('anthropic/claude-opus-5')

    await choose('claude')
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

  it('pastes a key from Settings into the config, and reads it back after a restart', async () => {
    terminal.columns = 140
    terminal.rows = 50
    const weather: TadeExtension = {
      name: 'weather',
      title: 'Weather',
      description: 'Whether it is raining.',
      settings: [{ key: 'key', kind: 'secret', env: 'WEATHER_API_KEY', means: 'the forecast key' }],
      ready: (ctx) => (ctx.secret('key') ? null : 'weather needs a key'),
      setup: () => ({
        guide: ['Paste the key.'],
        fields: [{ key: 'key', label: 'API key', kind: 'secret' }],
      }),
    }
    const extensions = await ExtensionHost.load({
      builtin: [weather],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
      env: {},
    })
    const first = await start({ extensions })
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
    // neither send the field nor end up in the value.
    terminal.press(asPaste('wk_0123456789\n'))
    terminal.press('\r')
    await until('saved', () => terminal.written.includes('applies now'))
    // In the config, under the setting it is, as it was typed.
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('wk_0123456789')
    const saved = await loadConfig(join(home, 'config.yaml'))
    if (!saved.ok) throw new Error('the config would not load with the key in it')
    expect(saved.config.extensions.weather?.key).toBe('wk_0123456789')
    await first.stop()

    // And read back: a new window on the same home draws the key it has, so
    // it can be checked against the console that issued it.
    terminal = newTerminal()
    terminal.columns = 140
    terminal.rows = 50
    const again = await ExtensionHost.load({
      builtin: [weather],
      config: { extensions: saved.config.extensions, projects: { app: { root: repo.root } } },
      home,
      env: {},
    })
    await start({ config: saved.config, extensions: again })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const reopened = find('Settings ')
    click(reopened.col + 1, reopened.row)
    await until('the settings', () => terminal.written.includes('Keys and tokens'))
    const keys = find('Keys and tokens')
    click(keys.col + 1, keys.row)
    await until('the key', () => terminal.written.includes('wk_0123456789'))
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

  it('says when a variable in the shell beats the key that was just pasted', async () => {
    // The one thing about a key that cannot be read off the page: what is
    // written is not always what is used, and a key kept and not used is the
    // worst of both.
    const weather: TadeExtension = {
      name: 'weather',
      title: 'Weather',
      description: 'Whether it is raining.',
      settings: [{ key: 'key', kind: 'secret', env: 'WEATHER_API_KEY', means: 'the forecast key' }],
      ready: (ctx) => (ctx.secret('key') ? null : 'weather needs a key'),
      setup: () => ({
        guide: ['Paste the key.'],
        fields: [{ key: 'key', label: 'API key', kind: 'secret' }],
      }),
    }
    terminal.columns = 140
    terminal.rows = 50
    const extensions = await ExtensionHost.load({
      builtin: [weather],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
      env: { WEATHER_API_KEY: 'from-the-shell' },
    })
    await start({ extensions })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Keys and tokens'))
    const category = find('Keys and tokens')
    click(category.col + 1, category.row)
    await until('the field', () =>
      screenOf(terminal.written).some((row) => row.includes('Weather api key')),
    )
    const field = find('Weather api key')
    click(field.col + 30, field.row)
    terminal.press(asPaste('wk_9876543210\n'))
    terminal.press('\r')
    await until('the word about which one wins', () =>
      screenOf(terminal.written).some((row) => row.includes('$WEATHER_API_KEY is set')),
    )
    // Saved all the same: it is what is used the day the variable goes.
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('wk_9876543210')
  })

  it('says under the field who else can read it, and keeps the key out of the journal', async () => {
    // Two halves of one promise. The file is one you can read back — that is
    // the whole reason it is a file — and `0600` keeps it from other people,
    // who are not the threat: agents run as you. So the page says so where
    // somebody is deciding to paste one. And everywhere a key is *not* meant
    // to be, it still is not: `config_changed` is what makes a change
    // undoable, and for a credential it says whether there is one, never
    // which one.
    const weather: TadeExtension = {
      name: 'weather',
      title: 'Weather',
      description: 'Whether it is raining.',
      settings: [{ key: 'key', kind: 'secret', env: 'WEATHER_API_KEY', means: 'the key' }],
      ready: (ctx) => (ctx.secret('key') ? null : 'weather needs a key'),
      setup: () => ({
        guide: ['Paste the key.'],
        fields: [{ key: 'key', label: 'API key', kind: 'secret' }],
      }),
    }
    terminal.columns = 140
    terminal.rows = 50
    const extensions = await ExtensionHost.load({
      builtin: [weather],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
      env: {},
    })
    await start({ extensions })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Keys and tokens'))
    const category = find('Keys and tokens')
    click(category.col + 1, category.row)
    await until('the field', () =>
      screenOf(terminal.written).some((row) => row.includes('Weather api key')),
    )
    const field = find('Weather api key')
    click(field.col + 30, field.row)
    // The line under the setting you are on, which is where this page puts
    // what a control's name cannot say.
    await until('what it says about who can read it', () =>
      screenOf(terminal.written).some((row) => row.includes(SEEN_BY_AGENTS)),
    )
    terminal.press(asPaste('wk_5555555555\n'))
    terminal.press('\r')
    await until('saved', () => terminal.written.includes('applies now'))
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('wk_5555555555')

    const written = async () =>
      (await client.events({ types: ['config_changed'] })).find(
        (event) => event.detail.path === 'extensions.weather.key',
      )?.detail
    await until('the change written down', async () => (await written()) !== undefined)
    expect(await written()).toMatchObject({ was: 'not set', now: 'set' })
    // And not only this line: the journal is one file and a key is in none of
    // it, whatever else the window wrote while this was going on.
    expect(readFileSync(join(home, 'events.jsonl'), 'utf8')).not.toContain('wk_5555555555')
  })

  it('says why a key did not save, rather than saying Saved over the top of it', async () => {
    // The other half of a key being ordinary: it is written to a file, and a
    // file can refuse. What must never happen is what a keychain that stopped
    // to ask did — the window quiet and the page saying nothing at all.
    terminal.columns = 140
    terminal.rows = 50
    await start()
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Rules for every agent'))
    // A directory where the config should be: nothing can read it and nothing
    // can write it, whoever is running the tests.
    rmSync(join(home, 'config.yaml'))
    mkdirSync(join(home, 'config.yaml'))
    const field = find('Rules for every agent')
    click(field.col + 42, field.row)
    terminal.press(asPaste('never force-push\n'))
    terminal.press('\r')
    await until('the reason on the page', () =>
      screenOf(terminal.written).some((row) => row.includes('EISDIR')),
    )
    // Still open, on the value that did not save, and never "Saved".
    expect(screenOf(terminal.written).join('\n')).toContain('Rules for every agent')
  })

  it('writes a key that is a key to the same file, as the setting it is', async () => {
    // What the DSN's audit found is now true of both: a Sentry auth token and
    // a DSN are a line in `config.yaml` each, told apart by what they grant
    // and by the environment winning over one of them — not by where they are
    // kept, because there is one place.
    const groups = settingsOf(ConfigSchema.parse({}), [
      {
        path: 'extensions.sentry.token',
        title: 'Sentry',
        means: 'a user auth token',
        value: 'sntrys_kept',
        from: 'config.yaml',
      },
    ])
    const of = (path: string) =>
      groups.flatMap((group) => group.settings).find((one) => one.path === path)
    expect(of('extensions.sentry.token')?.value).toBe('sntrys_kept')
    expect(of('extensions.sentry.token')?.type.kind).toBe('text')
    expect(of('telemetry.dsn')?.value).toBe('')
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

  it('drops the models and levels of the harness just chosen, under it', async () => {
    terminal.columns = 140
    terminal.rows = 50
    // What each harness says it runs, as the workbench would ask it.
    const runs: Record<string, string> = {
      pi: 'openrouter/moonshotai/kimi-k2.6',
      codex: 'openai/gpt-5.5-codex',
    }
    await start({
      models: async (harness) => {
        const id = runs[harness]
        return id
          ? { harness, models: [{ id, provider: id.split('/')[0] ?? '', name: id }], why: null }
          : { harness, models: [], why: 'was not asked here' }
      },
    })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Where agents work'))
    const page = find('Orchestrator')
    click(page.col + 1, page.row)
    // The whole screen replayed rather than what changed since, because the
    // fields are found by where they are drawn.
    const shown = () => screenOf(terminal.written)
    const field = (title: string) => {
      const rows = shown()
      const row = rows.findIndex(
        (line) => line.includes(` ${title} `) && line.includes('the harness decides'),
      )
      return { row, col: rows[row]?.indexOf('the harness decides') ?? -1 }
    }
    await until('the orchestrator page', () => field('Thinking').row >= 0)
    const model = field('Model')
    const thinking = field('Thinking')

    // Clicking a radio leaves the keyboard on the Harness row, where the
    // category put it: the list each field below dropped was that row's.
    const codex = find('codex')
    click(codex.col + 1, codex.row)
    await until('saved', () => shown().some((row) => row.includes('applies when Tade next starts')))
    expect(client.config.orchestrator.harness).toBe('codex')

    click(model.col + 1, model.row)
    await until('codex’s models', () => shown().some((row) => row.includes('gpt-5.5-codex')))
    const offered = find('gpt-5.5-codex')
    click(offered.col + 1, offered.row)
    await until('the model saved', () => client.config.orchestrator.model === 'gpt-5.5-codex')
    expect(client.config.orchestrator.provider).toBe('openai')
    // And drawn, before the next click: a click lands on what is on screen,
    // and until the frame after the save that is the list it was chosen from.
    await until('the model on screen', () =>
      shown().some((row) => row.includes('openai/gpt-5.5-codex')),
    )

    // `minimal` is a level codex has and Claude Code does not.
    click(thinking.col + 1, thinking.row)
    await until('codex’s levels', () => shown().some((row) => row.includes('minimal')))
    const level = find('minimal')
    click(level.col + 1, level.row)
    await until('the level saved', () => client.config.orchestrator.thinking === 'minimal')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toMatch(/model: (pi|codex)\b/)
  })

  it('clears the provider a route keeps when another provider’s model is chosen, and starts on it', async () => {
    terminal.columns = 140
    terminal.rows = 50
    // What the old route-keeping wrote: the provider apart from the model. A
    // model row writes its own key alone, so choosing OpenRouter's here once
    // left `anthropic` beside it, and pi made up an anthropic model of that
    // name for every new agent (`route-model.test.ts` in the pi harness).
    const yaml = [
      'projects:',
      '  app:',
      `    root: ${repo.root}`,
      'workers:',
      '  routes:',
      '    default:',
      '      harness: pi',
      '      provider: anthropic',
      '      model: claude-opus-5',
      '',
    ].join('\n')
    writeFileSync(join(home, 'config.yaml'), yaml)
    const loaded = await loadConfig(join(home, 'config.yaml'))
    if (!loaded.ok) throw new Error('the test config would not load')
    const offered = ['anthropic/claude-opus-5', 'openrouter/anthropic/claude-opus-4.5']
    await start({
      config: loaded.config,
      models: async (harness) => ({
        harness,
        models: offered.map((id) => ({ id, provider: id.split('/')[0] ?? '', name: id })),
        why: null,
      }),
    })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Where agents work'))
    const models = find('Models')
    click(models.col + 1, models.row)
    const shown = () => screenOf(terminal.written)
    const field = () => {
      const rows = shown()
      const row = rows.findIndex(
        (line) => line.includes('Agent model') && line.includes('anthropic/claude-opus-5'),
      )
      return { row, col: rows[row]?.indexOf('anthropic/claude-opus-5') ?? -1 }
    }
    await until('the agent model', () => field().row >= 0)
    const model = field()
    click(model.col + 1, model.row)
    // Listed under each provider, without its name in front.
    await until('the models', () => shown().some((row) => row.includes('OPENROUTER')))
    const chosen = find('anthropic/claude-opus-4.5')
    click(chosen.col + 1, chosen.row)
    await until(
      'the model saved',
      () => client.config.workers.routes.default?.model === 'openrouter/anthropic/claude-opus-4.5',
    )
    // The provider went with it, on the same press, and the page said so.
    expect(client.config.workers.routes.default?.provider).toBeUndefined()
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('provider')
    await until('said', () =>
      shown().some((row) => row.includes('Its provider, anthropic, is cleared')),
    )
    // Each key its own line, so either can be found and put back.
    const changed = async () =>
      (await client.events({ types: ['config_changed'] })).map((event) => [
        event.detail?.path,
        event.detail?.was,
        event.detail?.now,
      ])
    await until('both written down', async () => (await changed()).length === 2)
    expect(await changed()).toEqual([
      [
        'workers.routes.default.model',
        'anthropic/claude-opus-5',
        'openrouter/anthropic/claude-opus-4.5',
      ],
      ['workers.routes.default.provider', 'anthropic', ''],
    ])

    // And the next agent starts on that model, named as pi has it.
    const task = await client.createTask({ project: 'app', slug: 'fresh', intent: 'a new one' })
    const lane = await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    expect(lane.spec.args.join(' ')).toContain('--model openrouter/anthropic/claude-opus-4.5')
    expect(lane.spec.args).not.toContain('--provider')
  }, 60_000)
})
