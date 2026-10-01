import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The page an extension says what it is for on, running one, turning one off,
// setting one up, and what it keeps in the bar along the bottom.

describe('the window, and its extensions', () => {
  let terminal: FakeTerminal
  let repo: Repo
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
    home = wired.home
  })

  it('lists a tool Tade wrote for itself, off, and turning it on is written down for next start', async () => {
    terminal.columns = 120
    terminal.rows = 50
    const root = join(home, 'extensions')
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, 'standup.ts'),
      '// Reads out what each agent did yesterday.\nexport default function () {}\n',
    )
    await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        orchestrator: { extensions: root },
      }),
      written: () => [
        {
          name: 'standup',
          why: 'Reads out what each agent did yesterday.',
          path: join(root, 'standup.ts'),
        },
      ],
    })
    await until('the footer', () =>
      screenOf(terminal.written).some((row) => row.includes('Extensions ]')),
    )
    const button = find('Extensions ]')
    click(button.col + 2, button.row)
    await until('what Tade wrote, off', () =>
      screenOf(terminal.written).some((row) => row.includes('standup') && row.includes('off')),
    )
    // Nothing was run to show it: what it is for is read out of the file.
    expect(
      screenOf(terminal.written).some((row) =>
        row.includes('Reads out what each agent did yesterday.'),
      ),
    ).toBe(true)
    const on = find('Turn on ]')
    click(on.col + 2, on.row)
    await until('it says when it will run', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('standup is on — it loads the next time Tade starts'),
      ),
    )
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('enabled: true')
  })

  it('runs an extension from its panel, and shows it working and what it said', async () => {
    terminal.columns = 120
    terminal.rows = 40
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining where a project lives.',
          tools: [
            {
              name: 'weather_now',
              description: 'Is it raining.',
              parameters: { type: 'object', properties: { project: { type: 'string' } } },
              for: ['orchestrator'],
              run: async (input, ctx) => {
                ctx.progress('looking outside')
                return { text: `Dry over **${String(input.project)}** today.` }
              },
            },
          ],
          actions: [{ id: 'now', title: 'Is it raining?', tool: 'weather_now', project: true }],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    await start({ extensions })
    await until('the footer', () =>
      screenOf(terminal.written).some((row) => row.includes('Extensions')),
    )
    const button = find('Extensions ]')
    click(button.col + 2, button.row)
    await until('the panel, on the one extension there is', () =>
      screenOf(terminal.written).some((row) => row.includes('Weather  built-in')),
    )
    // Tab moves into what it offers, which starts on what it can do rather
    // than on turning it off; enter runs it for the project you are in.
    terminal.press('\t')
    terminal.press('\r')
    await until('its answer in the conversation', () =>
      screenOf(terminal.written).some((row) => row.includes('Dry over app today.')),
    )
    expect(screenOf(terminal.written).some((row) => row.includes('✓ weather now · app'))).toBe(true)
  })

  it('turns an extension off, and sets one up from the guide it gives', async () => {
    terminal.columns = 120
    terminal.rows = 50
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          settings: [{ key: 'city', kind: 'string', means: 'where' }],
          ready: (ctx) => (ctx.settings.city ? null : 'which city?'),
          setup: () => ({
            guide: ['Say which **city** to look at.'],
            fields: [
              { key: 'city', label: 'City', kind: 'text', choices: async () => ['Vienna', 'Graz'] },
            ],
          }),
        },
        {
          name: 'clock',
          title: 'Clock',
          description: 'The time.',
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    await start({ extensions })
    await until('the footer', () =>
      screenOf(terminal.written).some((row) => row.includes('Extensions ]')),
    )
    const button = find('Extensions ]')
    click(button.col + 2, button.row)
    await until('the panel, with both of them listed', () =>
      screenOf(terminal.written).some((row) => row.includes('◐ Weather')),
    )

    // The clock is on; clicking its name shows it, and turning it off writes
    // that down. Only the one you are looking at has buttons, so there is one
    // "Turn off" on the screen and it is the clock's.
    const clock = find('● Clock')
    click(clock.col + 2, clock.row)
    await until('the clock, in full', () =>
      screenOf(terminal.written).some((row) => row.includes('Clock  built-in')),
    )
    const turnOff = find('Turn off ]')
    click(turnOff.col + 2, turnOff.row)
    await until('the clock off', () =>
      screenOf(terminal.written).some((row) => row.includes('○ Clock')),
    )
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('enabled: false')

    // Weather needs setting up: its guide, what it offers, and saving checks it.
    const weather = find('◐ Weather')
    click(weather.col + 2, weather.row)
    await until('what it needs', () =>
      screenOf(terminal.written).some((row) => row.includes('which city?')),
    )
    const setup = find('Set up… ]')
    click(setup.col + 2, setup.row)
    await until('the guide and its choices', () =>
      screenOf(terminal.written).some((row) => row.includes('Graz ]')),
    )
    const graz = find('Graz ]')
    click(graz.col + 1, graz.row)
    const save = find('Save and check ]')
    click(save.col + 2, save.row)
    await until('ready', () =>
      screenOf(terminal.written).some((row) => row.includes('Saved. Weather is ready.')),
    )
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('city: Graz')
  })

  it('takes a pasted key into the config, in plain sight, and works on it', async () => {
    terminal.columns = 120
    terminal.rows = 50
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
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
            guide: ['Paste the key from the console.'],
            fields: [{ key: 'key', label: 'API key', kind: 'secret' }],
          }),
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
      env: {},
    })
    await start({ extensions })
    await until('the footer', () =>
      screenOf(terminal.written).some((row) => row.includes('Extensions ]')),
    )
    const button = find('Extensions ]')
    click(button.col + 2, button.row)
    await until('the panel, on the one that wants setting up', () =>
      screenOf(terminal.written).some((row) => row.includes('Weather  built-in')),
    )
    const setup = find('Set up… ]')
    click(setup.col + 2, setup.row)
    await until('the field', () =>
      screenOf(terminal.written).some((row) => row.includes('API key')),
    )
    for (const char of 'wk_0123456789') terminal.press(char)
    // Drawn as it is typed: a key you cannot read is a key you cannot check
    // against the console that issued it.
    await until('the key as it is typed', () =>
      screenOf(terminal.written).some((row) => row.includes('wk_0123456789')),
    )
    const save = find('Save and check ]')
    click(save.col + 2, save.row)
    await until('ready', () =>
      screenOf(terminal.written).some((row) => row.includes('Weather is ready')),
    )
    // Written into the config, under the setting it is.
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('wk_0123456789')
    // And nowhere else: pasting a key writes no line about it, so the journal
    // this window has been keeping all along holds none of it.
    expect(readFileSync(join(home, 'events.jsonl'), 'utf8')).not.toContain('wk_0123456789')
  })

  it('keeps what an extension watches in the status bar, and opens its view from there', async () => {
    terminal.columns = 140
    terminal.rows = 40
    let asked = 0
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'meter',
          title: 'Meter',
          description: 'A number that goes up.',
          status: async () => ({ text: `meter ${++asked}` }),
          view: async () =>
            [
              '**Everything the meter knows.**',
              ...Array.from({ length: 80 }, (_, i) => `- reading ${i}`),
            ].join('\n'),
        },
      ],
      config: { extensions: {}, projects: {} },
      home,
    })
    await start({
      extensions,
      extensionWorkbench: {
        pid: process.pid,
        lanes: () => [],
        agents: () => [],
        startAgent: async () => ({ task: '', worktree: '' }),
      },
    })
    await until('the status', () =>
      screenOf(terminal.written).some((row) => row.includes('meter 1')),
    )
    const status = find('meter 1')
    click(status.col + 1, status.row)
    await until('the view', () =>
      screenOf(terminal.written).some((row) => row.includes('Everything the meter knows.')),
    )
    terminal.press('\x1b[6~')
    await until('it to scroll', () =>
      screenOf(terminal.written).some((row) => row.includes('↑↓ scrolls · 11–')),
    )
  })
})
