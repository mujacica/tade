import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Secrets } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { extensionConformance } from '../src/conformance.ts'
import { ExtensionHost, type ExtensionRun, settingFrom } from '../src/host.ts'
import type { TadeExtension } from '../src/port.ts'
import { object, string } from '../src/schema.ts'

// Holding extensions and running them. What any one extension finds is its
// own business; this is the part every one of them relies on.

function weather(overrides: Partial<TadeExtension> = {}): TadeExtension {
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
    watches: [
      {
        id: 'rain',
        title: 'Rain',
        means: 'Looks for rain over a project, and starts an agent to bring the washing in.',
        every: '30m',
        input: object({ heavier: string('only rain heavier than this, in mm') }),
        check: async (ctx) => ({
          found:
            ctx.settings.raining === true
              ? [
                  { key: `rain-${ctx.watching.name}`, title: `Rain over ${ctx.watching.name}` },
                  { key: `rain-${ctx.watching.name}`, title: 'the same rain, said twice' },
                ]
              : [],
          since: `after ${ctx.since ?? ctx.turnedOn}`,
        }),
        agent: (finding, ctx) => ({
          title: `bring in ${finding.key}`,
          prompt: `It is raining in ${String(ctx.settings.city)}: ${finding.title}.`,
        }),
      },
    ],
    harness: { pi: { skills: ['skills/umbrella'] } },
    ...overrides,
  }
}

const projects = { shop: { root: '/src/shop' } }

async function host(
  settings: Record<string, unknown> = { city: 'Vienna' },
  extra: Partial<TadeExtension> = {},
  more: { env?: Record<string, string | undefined>; secrets?: Secrets } = {},
) {
  return ExtensionHost.load({
    builtin: [weather(extra)],
    config: { extensions: { weather: settings }, projects },
    home: '/home',
    ...(more.env ? { env: more.env } : {}),
    ...(more.secrets ? { secrets: more.secrets } : {}),
  })
}

/** An extension that wants a key, declared the one way there is to declare one. */
function withKey(overrides: Partial<TadeExtension> = {}): Partial<TadeExtension> {
  return {
    settings: [
      { key: 'city', kind: 'string', means: 'where to look' },
      {
        key: 'key',
        kind: 'secret',
        env: 'WEATHER_API_KEY',
        envFrom: 'key_env',
        means: 'the key the forecast needs',
      },
      { key: 'key_env', kind: 'string', means: 'the variable the key is in' },
    ],
    ready: (ctx) => (ctx.secret('key') ? null : 'weather needs a key'),
    setup: () => ({
      guide: ['Paste your key.'],
      fields: [
        { key: 'key', label: 'API key', kind: 'secret', placeholder: 'wk_…' },
        { key: 'city', label: 'City', kind: 'text' },
      ],
    }),
    ...overrides,
  }
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

  it('loads the ones you turned on, lists the rest off, and a broken one with why', async () => {
    const root = tmp('tade-ext-')
    const mine = join(root, 'greeting')
    mkdirSync(mine, { recursive: true })
    writeFileSync(
      join(mine, 'extension.ts'),
      `export default {
        name: 'greeting', title: 'Greeting', description: 'Says hello.',
        tools: [{ name: 'greeting_hello', description: 'Hello.', parameters: { type: 'object', properties: {} }, for: ['agent'], run: async () => ({ text: 'hello' }) }],
      }\n`,
    )
    const broken = join(root, 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'extension.ts'), 'this is not typescript !!!\n')
    // One nobody has turned on: listed, with what it says it is, and never
    // imported — which is why a file that would throw on import is quiet here.
    const waiting = join(root, 'waiting')
    mkdirSync(waiting, { recursive: true })
    writeFileSync(
      join(waiting, 'extension.ts'),
      '// Reads out yesterday.\nthrow new Error("never run")\n',
    )

    const config = {
      extensions: {
        weather: { city: 'Vienna' },
        greeting: { enabled: true },
        broken: { enabled: true },
      },
      projects,
    }
    const loaded = await ExtensionHost.load({ builtin: [weather()], root, config, home: '/home' })
    expect(loaded.list().map((one) => [one.name, one.source, one.state])).toEqual([
      ['weather', 'built-in', 'ready'],
      ['broken', 'yours', 'broken'],
      ['greeting', 'yours', 'ready'],
      ['waiting', 'yours', 'off'],
    ])
    const off = loaded.list().find((one) => one.name === 'waiting')
    expect(off?.problem).toBe('not turned on')
    expect(off?.description).toBe('Reads out yesterday.')
    expect(loaded.specs('agent').map((spec) => spec.name)).toContain('greeting_hello')

    // Turned on while the window is open: it says when it will run, and does
    // not run now — there is no hot reload, which is the point of it.
    await loaded.reconfigure({ ...config.extensions, waiting: { enabled: true } })
    expect(loaded.list().find((one) => one.name === 'waiting')).toMatchObject({
      state: 'off',
      problem: 'turned on — it loads next time Tade starts',
    })
    expect(loaded.specs('agent').map((spec) => spec.name)).not.toContain('waiting_anything')

    // --safe starts with none of yours, broken or not.
    const safe = await ExtensionHost.load({
      builtin: [weather()],
      root,
      safe: true,
      config,
      home: '/home',
    })
    expect(
      safe
        .list()
        .filter((one) => one.source === 'yours')
        .map((one) => [one.state, one.problem]),
    ).toEqual([
      ['off', 'left out by --safe'],
      ['off', 'left out by --safe'],
      ['off', 'left out by --safe'],
    ])
    expect(safe.list()[0]).toMatchObject({ name: 'weather', state: 'ready' })
  })

  it('refuses one of yours that calls itself something other than its folder', async () => {
    // The folder is what you turn on and what its settings are under, so two
    // names would mean setting it up in one place and switching it in another.
    const root = tmp('tade-ext-named-')
    mkdirSync(join(root, 'greeting'), { recursive: true })
    writeFileSync(
      join(root, 'greeting', 'extension.ts'),
      "export default { name: 'hello', title: 'Hello', description: 'Says hello.' }\n",
    )
    const loaded = await ExtensionHost.load({
      root,
      config: { extensions: { greeting: { enabled: true } }, projects },
      home: '/home',
    })
    expect(loaded.list()[0]).toMatchObject({ state: 'broken' })
    expect(loaded.list()[0]?.problem).toContain('it calls itself hello')
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

  it('marks an agent a tool starts as that extension’s, whatever the tool says', async () => {
    const asked: { title: string; by?: string }[] = []
    const window = {
      pid: 1,
      lanes: () => [],
      startAgent: async (request: { title: string; by?: string }) => {
        asked.push(request)
        return { task: 'shop/umbrella', worktree: '/src/shop' }
      },
    }
    const loaded = await host(
      { city: 'Vienna' },
      {
        tools: [
          {
            name: 'weather_umbrella',
            description: 'Send someone out with an umbrella.',
            parameters: object({}),
            for: ['orchestrator'],
            run: async (_input, ctx) => {
              await ctx.tade?.startAgent({
                project: 'shop',
                title: 'umbrella',
                prompt: 'Fetch one.',
                by: 'you',
              })
              return { text: 'sent' }
            },
          },
        ],
        actions: [],
      },
    )
    await loaded.call('weather_umbrella', {}, { caller: { kind: 'orchestrator' }, tade: window })
    expect(asked.map((one) => one.by)).toEqual(['extension:weather'])
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

describe('watching', () => {
  const look = { project: 'shop', input: {}, since: null, turnedOn: '2026-09-15T08:00:00.000Z' }

  it('offers what it can watch, and turns one on only with input it takes', async () => {
    const loaded = await host()
    expect(loaded.watches()).toEqual([
      {
        id: 'weather.rain',
        extension: 'weather',
        title: 'Rain',
        means: 'Looks for rain over a project, and starts an agent to bring the washing in.',
        every: '30m',
        input: expect.objectContaining({ type: 'object' }),
        problem: null,
      },
    ])
    expect(loaded.watchProblem('weather.rain', { heavier: 3 })).toBe('heavier should be a string')
    expect(loaded.watchProblem('weather.snow', {})).toBe(
      'there is no watch called weather.snow (there is weather.rain)',
    )
    // Not set up yet is no reason to refuse it: it says so, and waits.
    const unready = await host({})
    expect(unready.watchProblem('weather.rain', {})).toBeNull()
    expect(unready.watches()[0]?.problem).toBe(
      'Weather needs setting up: set extensions.weather.city',
    )
  })

  it('looks with what it was turned on with and where it left off, and says what an agent is told', async () => {
    const loaded = await host({ city: 'Vienna', raining: true })
    const first = await loaded.look('weather.rain', look)
    // The same thing found twice in one look is one finding.
    expect(first.found).toEqual([{ key: 'rain-shop', title: 'Rain over shop' }])
    expect(first.since).toBe('after 2026-09-15T08:00:00.000Z')
    const again = await loaded.look('weather.rain', { ...look, since: first.since })
    expect(again.since).toBe('after after 2026-09-15T08:00:00.000Z')
    await expect(first.agent(first.found[0]!)).resolves.toEqual({
      title: 'bring in rain-shop',
      prompt: 'It is raining in Vienna: Rain over shop.',
    })
  })

  it('says why it could not look, and gives up on one that never answers', async () => {
    await expect((await host({})).look('weather.rain', look)).rejects.toThrow(
      'Weather needs setting up: set extensions.weather.city',
    )
    await expect((await host()).look('weather.rain', { ...look, project: 'nope' })).rejects.toThrow(
      'there is no project called nope',
    )
    const rain = weather().watches![0]!
    const slow = await host(
      { city: 'Vienna' },
      { watches: [{ ...rain, check: () => new Promise(() => {}) }] },
    )
    await expect(slow.look('weather.rain', { ...look, timeoutMs: 50 })).rejects.toThrow(
      'weather.rain took longer than 0s to look, and was given up on',
    )
    const nameless = await host(
      { city: 'Vienna' },
      { watches: [{ ...rain, check: async () => ({ found: [{ key: '', title: 'something' }] }) }] },
    )
    await expect(nameless.look('weather.rain', look)).rejects.toThrow('without a key')
  })

  it('refuses a watch put together wrong', async () => {
    const rain = weather().watches![0]!
    for (const [watches, problem] of [
      [[{ ...rain, every: 'fortnight' }], 'not a length like 30m'],
      [[{ ...rain, every: 'week' }], 'not a length like 30m'],
      [[rain, rain], 'two watches called rain'],
      [[{ ...rain, id: 'Rain Now' }], 'not a usable name'],
      [[{ ...rain, input: { type: 'string' } }], 'input that is not an object'],
    ] as const) {
      const loaded = await host({ city: 'Vienna' }, { watches })
      expect(loaded.list()[0]?.problem).toContain(problem)
    }
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
      [
        'Extensions:',
        '- Weather (weather_now, weather_change): Use weather_now before deciding whether to deploy.',
        '  Watch weather.rain (every 30m unless told otherwise): Looks for rain over a project, and starts an agent to bring the washing in.',
      ].join('\n'),
    )
    expect((await host({})).orchestratorPrompt()).toContain(
      'Weather is installed but not set up: set extensions.weather.city',
    )
  })

  it('tells agents, gives each harness its pieces, and knows what text opens where', async () => {
    const root = tmp('tade-ext-root-')
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

  it('keeps a sidebar section from the extension\u2019s own cache, and asks it no oftener than it says', async () => {
    let asked = 0
    const loaded = await host(
      { city: 'Vienna' },
      {
        lists: [
          {
            id: 'warnings',
            title: 'WEATHER',
            every: '60s',
            filters: [{ id: 'all', title: 'all' }],
            async rows() {
              asked++
              return [{ id: 'rain', title: 'Rain this afternoon', marks: [{ text: 'soon' }] }]
            },
          },
        ],
      },
    )
    const tade = {
      pid: 1,
      lanes: () => [],
      startAgent: async () => ({ task: 'x/y', worktree: '/tmp' }),
    }
    const [section] = await loaded.lists(tade)
    expect(section).toMatchObject({ id: 'weather.warnings', title: 'WEATHER', problem: null })
    expect(section?.rows[0]?.title).toBe('Rain this afternoon')
    // Drawing is not a poll: asked again inside its own interval, it is the
    // same answer and the extension was not troubled.
    await loaded.lists(tade)
    expect(asked).toBe(1)
  })

  it('draws a section that could not be filled as a problem, never as a throw', async () => {
    const loaded = await host(
      { city: 'Vienna' },
      {
        lists: [
          {
            id: 'warnings',
            title: 'WEATHER',
            every: '60s',
            rows() {
              throw new Error('the sky could not be reached')
            },
          },
        ],
      },
    )
    const [section] = await loaded.lists({
      pid: 1,
      lanes: () => [],
      startAgent: async () => ({ task: 'x/y', worktree: '/tmp' }),
    })
    expect(section?.rows).toEqual([])
    expect(section?.problem).toBe('the sky could not be reached')
  })

  it('refuses a list that would be asked oftener than every half minute', async () => {
    const loaded = await host(
      { city: 'Vienna' },
      {
        lists: [{ id: 'warnings', title: 'WEATHER', every: '5s', rows: async () => [] }],
      },
    )
    expect(loaded.list()[0]).toMatchObject({ state: 'broken' })
    expect(loaded.list()[0]?.problem).toContain('30s')
  })
})

describe('a key an extension asks for', () => {
  const keys = () => Secrets.open({ home: tmp('tade-secrets-'), platform: 'linux' })

  it('is read from the environment first, whatever has been pasted', async () => {
    const secrets = keys()
    secrets.set('weather.key', 'pasted')
    const loaded = await host({ city: 'Vienna' }, withKey(), {
      secrets,
      env: { WEATHER_API_KEY: 'from-the-shell' },
    })
    expect(loaded.list()[0]).toMatchObject({ state: 'ready' })
    expect(loaded.setupOf('weather')?.fields[0]).toMatchObject({
      kind: 'secret',
      // Never the key: the field it is typed into starts empty, and what is
      // there now is a place.
      value: '',
      have: '$WEATHER_API_KEY',
    })
    // And the variable a setting names comes before the declared one.
    const named = await host({ city: 'Vienna', key_env: 'MY_KEY' }, withKey(), {
      secrets,
      env: { MY_KEY: 'mine', WEATHER_API_KEY: 'theirs' },
    })
    expect(named.setupOf('weather')?.fields[0]?.have).toBe('$MY_KEY')
  })

  it('is kept where Tade keeps keys, and used when the environment has none', async () => {
    const secrets = keys()
    const loaded = await host({ city: 'Vienna' }, withKey(), { secrets, env: {} })
    expect(loaded.list()[0]).toMatchObject({ state: 'needs setup', problem: 'weather needs a key' })
    const saved = loaded.saveSecret('weather', 'key', '  wk_0123456789  ')
    expect(saved.where).toContain('secrets.json')
    // Nothing else is set: the extension works because the key was pasted.
    expect(secrets.get('weather.key')).toBe('wk_0123456789')
    await loaded.reconfigure({ weather: { city: 'Vienna' } })
    expect(loaded.list()[0]).toMatchObject({ state: 'ready' })
    expect(loaded.setupOf('weather')?.fields[0]?.have).toContain('secrets.json')
    // Saved while a variable is set: kept, and told which of the two wins.
    const shadowed = await host({ city: 'Vienna' }, withKey(), {
      secrets,
      env: { WEATHER_API_KEY: 'from-the-shell' },
    })
    expect(shadowed.saveSecret('weather', 'key', 'wk_other').beaten).toBe('$WEATHER_API_KEY')
  })

  it('is listed for whoever draws a field for it, without its value', async () => {
    const secrets = keys()
    secrets.set('weather.key', 'wk_0123456789')
    const loaded = await host({ city: 'Vienna' }, withKey(), { secrets, env: {} })
    const [declared] = loaded.secrets()
    expect(declared).toMatchObject({
      name: 'weather.key',
      extension: 'weather',
      key: 'key',
      label: 'API key',
      variables: ['WEATHER_API_KEY'],
    })
    expect(declared?.from).toContain('secrets.json')
    expect(JSON.stringify(loaded.secrets())).not.toContain('wk_0123456789')
  })

  it('is never read out of the config, and says so when somebody puts it there', async () => {
    const secrets = keys()
    const loaded = await host({ city: 'Vienna', key: 'wk_in_the_config' }, withKey(), {
      secrets,
      env: {},
    })
    // A key in config.yaml is a key in a repository: it is not read, and the
    // panel says as much rather than letting it look like it works.
    expect(loaded.list()[0]).toMatchObject({
      state: 'needs setup',
      unknownSettings: ['key'],
    })
    // Nor can a form save one there by accident.
    expect(settingFrom('wk_0123456789', 'secret')).toBeUndefined()
  })

  it('refuses to hand an extension a secret it never declared', async () => {
    const loaded = await host({ city: 'Vienna' }, {
      ready: (ctx) => (ctx.secret('key') ? null : 'no key'),
    } as Partial<TadeExtension>)
    expect(loaded.list()[0]?.problem).toContain('does not declare')
  })
})
