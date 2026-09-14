import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { extensionConformance } from '../src/conformance.ts'
import { ExtensionHost, type ExtensionRun, settingFrom } from '../src/host.ts'
import type { WilcoExtension } from '../src/port.ts'
import { object, string } from '../src/schema.ts'

// Holding extensions and running them. What any one extension finds is its
// own business; this is the part every one of them relies on.

function weather(overrides: Partial<WilcoExtension> = {}): WilcoExtension {
  return {
    name: 'weather',
    title: 'Weather',
    description: 'Says whether it is raining where a project is.',
    settings: [{ key: 'city', kind: 'string', means: 'where to look' }],
    ready: (ctx) => (ctx.settings.city ? null : 'set extensions.weather.city'),
    tools: [
      {
        name: 'weather_now',
        description: 'Whether it is raining in the city.',
        parameters: object({ project: string('which project') }, ['project']),
        for: ['orchestrator', 'agent'],
        run: async (input, ctx) => {
          ctx.progress('looking outside')
          return {
            text: `Dry in ${String(ctx.settings.city)} for ${ctx.project(String(input.project)).name}.`,
            links: [{ title: 'forecast', url: 'https://weather.example/today' }],
          }
        },
      },
      {
        name: 'weather_change',
        description: 'Make it rain. Only the orchestrator may.',
        parameters: object({}),
        for: ['orchestrator'],
        run: async () => ({ text: 'Raining now.' }),
      },
    ],
    actions: [{ id: 'now', title: 'Is it raining?', tool: 'weather_now', project: true }],
    brief: async () => [{ said: 'it is dry in Vienna', ask: 'should we deploy while it is dry?' }],
    orchestrator: () => 'Use weather_now before deciding whether to deploy.',
    agents: (_ctx, project) =>
      `The weather where ${project.name} is kept is available as weather_now.`,
    linkers: () => [{ pattern: 'RAIN-\\d+', url: 'https://weather.example/$&' }],
    harness: { pi: { skills: ['skills/umbrella'] } },
    ...overrides,
  }
}

const projects = { shop: { root: '/src/shop' } }

async function host(
  settings: Record<string, unknown> = { city: 'Vienna' },
  extra: Partial<WilcoExtension> = {},
) {
  return ExtensionHost.load({
    builtin: [weather(extra)],
    config: { extensions: { weather: settings }, projects },
    home: '/home',
  })
}

extensionConformance(() => weather(), { settings: { city: 'Vienna' } })

describe('loading extensions', () => {
  it('is ready with what it needs, and says what to do without it', async () => {
    expect((await host()).list()[0]).toMatchObject({ state: 'ready', source: 'built-in' })
    expect((await host({})).list()[0]).toMatchObject({
      state: 'needs setup',
      problem: 'set extensions.weather.city',
    })
    expect((await host({ city: 'Vienna', enabled: false })).list()[0]?.state).toBe('off')
  })

  it('loads yours from active/, and lists a broken one with why, without stopping the rest', async () => {
    const root = tmp('wilco-ext-')
    const mine = join(root, 'active', 'greeting')
    mkdirSync(mine, { recursive: true })
    writeFileSync(
      join(mine, 'extension.ts'),
      `export default {
        name: 'greeting', title: 'Greeting', description: 'Says hello.',
        tools: [{ name: 'greeting_hello', description: 'Hello.', parameters: { type: 'object', properties: {} }, for: ['agent'], run: async () => ({ text: 'hello' }) }],
      }\n`,
    )
    const broken = join(root, 'active', 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'extension.ts'), 'this is not typescript !!!\n')
    // Proposed ones do nothing until a human moves them.
    mkdirSync(join(root, 'proposed', 'waiting'), { recursive: true })
    writeFileSync(join(root, 'proposed', 'waiting', 'extension.ts'), 'export default {}\n')

    const loaded = await ExtensionHost.load({
      builtin: [weather()],
      root,
      config: { extensions: { weather: { city: 'Vienna' } }, projects },
      home: '/home',
    })
    expect(loaded.list().map((one) => [one.name, one.source, one.state])).toEqual([
      ['weather', 'built-in', 'ready'],
      ['broken', 'yours', 'broken'],
      ['greeting', 'yours', 'ready'],
    ])
    expect(loaded.specs('agent').map((spec) => spec.name)).toContain('greeting_hello')

    // --safe starts with none of yours, broken or not.
    const safe = await ExtensionHost.load({
      builtin: [weather()],
      root,
      safe: true,
      config: { extensions: { weather: { city: 'Vienna' } }, projects },
      home: '/home',
    })
    expect(
      safe
        .list()
        .filter((one) => one.source === 'yours')
        .map((one) => one.state),
    ).toEqual(['off', 'off'])
  })

  it('refuses one that is put together wrong', async () => {
    const loaded = await host(
      { city: 'Vienna' },
      { tools: [{ ...weather().tools![0]!, name: 'forecast' }], actions: [] },
    )
    expect(loaded.list()[0]).toMatchObject({ state: 'broken' })
    expect(loaded.list()[0]?.problem).toContain('should start with weather_')
  })
})

describe('running a tool', () => {
  it('answers with its links written out, and reports how it went as it goes', async () => {
    const loaded = await host()
    const runs: ExtensionRun[] = []
    loaded.onRun((run) => runs.push(run))
    const answer = await loaded.call(
      'weather_now',
      { project: 'shop' },
      { caller: { kind: 'you' }, id: 'c1' },
    )
    expect(answer.text).toBe('Dry in Vienna for shop.\n\n- forecast: https://weather.example/today')
    expect(runs.map((run) => [run.id, run.state])).toEqual([
      ['c1', 'running'],
      ['c1', 'progress'],
      ['c1', 'ok'],
    ])
  })

  it('says what is wrong: a missing input, a project that is not there, who may not call it', async () => {
    const loaded = await host()
    await expect(loaded.call('weather_now', {}, { caller: { kind: 'you' } })).rejects.toThrow(
      'weather_now: project is needed: which project',
    )
    await expect(
      loaded.call('weather_now', { project: 'nowhere' }, { caller: { kind: 'you' } }),
    ).rejects.toThrow('there is no project called nowhere (there is shop)')
    await expect(
      loaded.call(
        'weather_change',
        {},
        { caller: { kind: 'agent', task: 'shop/a', project: 'shop', cwd: '/w' } },
      ),
    ).rejects.toThrow('not offered to agents')
    await expect(
      (await host({})).call('weather_now', { project: 'shop' }, { caller: { kind: 'you' } }),
    ).rejects.toThrow('needs setup')
  })

  it('gives up on a tool that never answers', async () => {
    const loaded = await ExtensionHost.load({
      builtin: [
        weather({
          tools: [
            {
              name: 'weather_slow',
              description: 'Never answers.',
              parameters: object({}),
              for: ['orchestrator'],
              run: () => new Promise(() => {}),
            },
          ],
          actions: [],
        }),
      ],
      config: { extensions: { weather: { city: 'Vienna' } }, projects },
      home: '/home',
      timeoutMs: 50,
    })
    await expect(
      loaded.call('weather_slow', {}, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow('given up on')
  })
})

describe('what extensions tell everyone else', () => {
  it('fills the brief, and leaves out one that fails', async () => {
    const loaded = await ExtensionHost.load({
      builtin: [
        weather(),
        weather({
          name: 'storms',
          title: 'Storms',
          tools: [],
          actions: [],
          ready: () => null,
          brief: async () => {
            throw new Error('the radar is down')
          },
        }),
      ],
      config: { extensions: { weather: { city: 'Vienna' } }, projects },
      home: '/home',
    })
    expect(await loaded.brief()).toEqual({
      items: [{ said: 'it is dry in Vienna', ask: 'should we deploy while it is dry?' }],
      problems: ['Storms: the radar is down'],
    })
  })

  it('tells the orchestrator what it can use, and what is not set up yet', async () => {
    expect((await host()).orchestratorPrompt()).toBe(
      'Extensions:\n- Weather (weather_now, weather_change): Use weather_now before deciding whether to deploy.',
    )
    expect((await host({})).orchestratorPrompt()).toContain(
      'Weather is installed but not set up: set extensions.weather.city',
    )
  })

  it('tells agents, gives each harness its pieces, and knows what text opens where', async () => {
    const root = tmp('wilco-ext-root-')
    mkdirSync(join(root, 'skills', 'umbrella'), { recursive: true })
    const loaded = await host({ city: 'Vienna' }, { root })
    expect(loaded.agentPrompt({ name: 'shop', root: '/src/shop' })).toContain('weather_now')
    expect(loaded.harness('pi')).toEqual({
      extensions: [],
      skills: [join(root, 'skills', 'umbrella')],
    })
    expect(loaded.harness('another-harness')).toEqual({ extensions: [], skills: [] })
    expect(loaded.linkers()).toEqual([{ pattern: 'RAIN-\\d+', url: 'https://weather.example/$&' }])
  })
})

describe('changing extensions while the window is open', () => {
  it('turns one off and on again, and says what it needs when it comes back', async () => {
    const loaded = await host({ city: 'Vienna' })
    await loaded.reconfigure({ weather: { city: 'Vienna', enabled: false } })
    expect(loaded.list()[0]).toMatchObject({ state: 'off' })
    expect(loaded.specs('orchestrator')).toEqual([])
    await expect(
      loaded.call('weather_change', {}, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow('off')
    await loaded.reconfigure({ weather: {} })
    expect(loaded.list()[0]).toMatchObject({
      state: 'needs setup',
      problem: 'set extensions.weather.city',
    })
    await loaded.reconfigure({ weather: { city: 'Graz' } })
    expect(loaded.list()[0]?.state).toBe('ready')
  })

  it('describes its setup with the values it has, and what a field offers', async () => {
    const loaded = await host(
      { city: 'Vienna', skip: ['rain', 'snow'] },
      {
        settings: [
          { key: 'city', kind: 'string', means: 'where' },
          { key: 'skip', kind: 'list', means: 'what not to mention' },
        ],
        setup: () => ({
          guide: ['Pick a city.'],
          fields: [
            { key: 'city', label: 'City', kind: 'text', choices: async () => ['Vienna', 'Graz'] },
            { key: 'skip', label: 'Skip', kind: 'list' },
          ],
        }),
      },
    )
    expect(
      loaded.setupOf('weather')?.fields.map((field) => [field.key, field.value, field.offers]),
    ).toEqual([
      ['city', 'Vienna', true],
      ['skip', 'rain, snow', false],
    ])
    expect(await loaded.choices('weather', 'city')).toEqual(['Vienna', 'Graz'])
    expect(settingFrom('checkout=checkout-api, web=web+edge', 'map')).toEqual({
      checkout: 'checkout-api',
      web: ['web', 'edge'],
    })
    expect(settingFrom('a, b', 'list')).toEqual(['a', 'b'])
    expect(settingFrom('', 'text')).toBeUndefined()
    expect(settingFrom('off', 'flag')).toBe(false)
  })
})
