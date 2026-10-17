import { describe, expect, it } from 'vitest'
import { ACTING_IS_NOT_YOU, ACTING_IS_NOT_YOU_SHORT } from '../src/away.ts'
import { ConfigSchema } from '../src/config.ts'
import { PUSH_BY_DEFAULT } from '../src/project.ts'
import { KEYS_AND_AGENTS, SEEN_BY_AGENTS } from '../src/secrets.ts'
import {
  applySetting,
  describeSetting,
  parseSetting,
  type SettingGroup,
  settingFound,
  settingLabel,
  settingsOf,
  stepped,
  wantedInstead,
} from '../src/settings.ts'
import { DEVICE_MAY } from '../src/settings-away.ts'

// The settings worth putting in front of somebody, and what writing one back
// does to the file they wrote by hand.

const config = (over: Record<string, unknown> = {}) => ConfigSchema.parse(over)
const find = (path: string, over: Record<string, unknown> = {}) => {
  const found = settingsOf(config(over))
    .flatMap((group) => group.settings)
    .find((setting) => setting.path === path)
  if (!found) throw new Error(`no setting called ${path}`)
  return found
}

describe('what there is to change', () => {
  it('says what each one is now', () => {
    expect(find('workspace.driver', { workspace: { driver: 'tmux' } }).value).toBe('tmux')
  })

  it('shows the default in brackets when nothing is set', () => {
    // A blank where a value should be reads as broken. What it will do
    // instead, marked as not-your-choice, reads as a default.
    expect(describeSetting(find('orchestrator.model'))).toContain('(the harness decides)')
  })

  it('says which project a scoped setting is about, where a list crosses them', () => {
    // One project's rows are titled for the *setting* — `Brief`, not
    // `app brief` — because the page shows one project at a time and says
    // which once, above. Everything that draws a list across projects says it
    // per row through the one spelling of it: three rows called Brief are
    // three rows nobody can tell apart.
    const over = { projects: { shop: { root: '/tmp/shop' }, docs: { root: '/tmp/docs' } } }
    const brief = find('projects.shop.brief', over)
    expect(brief.title).toBe('Brief')
    expect(brief.scope).toBe('shop')
    expect(settingLabel(brief)).toBe('shop — Brief')
    expect(describeSetting(brief)).toContain('shop — Brief')
    // And nothing is prefixed that is not one of several: a machine-wide
    // setting has no scope and is drawn as its own name.
    const machine = find('agents.workspace', over)
    expect(machine.scope).toBeUndefined()
    expect(settingLabel(machine)).toBe('Where agents work')
    // Every row of every project carries its project, so the page can show one.
    const projects = settingsOf(config(over))
      .find((group) => group.id === 'projects')
      ?.settings.map((one) => one.scope)
    expect(new Set(projects)).toEqual(new Set(['shop', 'docs']))
  })

  it('says what changing it does, not just what it is called', () => {
    // "workspace.driver: pty" answers nothing for somebody deciding.
    expect(find('workspace.driver').means).toContain('after you close Tade')
    expect(find('approvals.mode').means).toContain('never interrupts')
  })

  it('says what the checks rule can actually hold, where somebody chooses it', () => {
    // `checks.before: push` reads like a gate and is one only under
    // `approvals.mode: policy`; the default is `bypass`, where the agent is
    // told the rule and Tade writes down what happened. That is said in the
    // code that enforces it, and has to be said where somebody picks a value.
    expect(ConfigSchema.parse({}).approvals.mode).toBe('bypass')
    expect(find('checks.before').means).toContain('approvals.mode policy')
    const group = settingsOf(config()).find((one) => one.id === 'checks')
    expect(group?.about).toContain('bypass')
    // And on a project's own answer to the same rule, which is chosen on a
    // different page from the one above it.
    expect(
      find('projects.shop.checks.before', { projects: { shop: { root: '/tmp/shop' } } }).means,
    ).toContain('approvals.mode policy')
  })

  it('shows a check somebody answered about here, and nothing for the rest', () => {
    // A check id is only knowable by reading the repository, which this reads
    // nothing of — so an override is seen, searched for and undone here, and
    // making a new one is the ACTIONS page's, where the checks actually are.
    const over = {
      projects: { shop: { root: '/tmp/shop', checks: { run_here: { coverage: false } } } },
    }
    const row = find('projects.shop.checks.run_here.coverage', over)
    expect(row.type).toEqual({ kind: 'flag' })
    expect(row.value).toBe('false')
    expect(row.fallback).toBe('what the project says')
    // `false` is what the schema wants, and the flag is what parses to it.
    expect(parseSetting(row, 'no')).toBe(false)
    expect(parseSetting(row, '')).toBeUndefined()
    const bare = settingsOf(config({ projects: { shop: { root: '/tmp/shop' } } }))
      .flatMap((group) => group.settings)
      .filter((one) => one.path.includes('run_here'))
    expect(bare).toEqual([])
  })

  it('is found by the symptom, not only by the name of the setting', () => {
    // People reach for this one while complaining that the window is slow,
    // which is not a word in its title or its path. A setting nobody can find
    // is a setting nobody has — and here it is also the words `namedBy` reads,
    // so a legitimate request that uses them is not refused.
    const groups = settingsOf(config())
    const group = groups.find((one) => one.settings.some((s) => s.path === 'agents.give_way'))
    expect(group).toBeDefined()
    if (!group) return
    const setting = group.settings.find((one) => one.path === 'agents.give_way')!
    for (const words of [['slow'], ['priority'], ['give', 'way'], ['laggy']]) {
      expect(settingFound(group, setting, words)).toBe(true)
    }
    // Off is nought, which is what a config that says nothing reads as.
    expect(setting.value).toBe('0')
    expect(parseSetting(setting, '5')).toBe(5)
    // Nought is taken: undefined is what every caller refuses, so a row that
    // read 0 as "not written" could never be put back to off.
    expect(parseSetting(setting, '0')).toBe(0)
    expect(parseSetting(setting, '-1')).toBeUndefined()
    expect(wantedInstead(setting)).toBe('a whole number from 0 up')
    // And the arrows can get back to it, which a count that floors at one
    // could not: from 1, left is off, and that is what gets written.
    const one = find('agents.give_way', { agents: { give_way: 1 } })
    expect(stepped(one, -1)).toBe('0')
    expect(stepped(setting, 1)).toBe('1')
  })

  it('offers only values the schema would accept', () => {
    const driver = find('workspace.driver')
    expect(driver.type).toEqual({ kind: 'choice', options: ['pty', 'tmux'] })
    for (const option of ['pty', 'tmux']) {
      expect(() => config({ workspace: { driver: option } })).not.toThrow()
    }
  })
})

describe('a model and a level belong to a harness', () => {
  it('says which harness each model setting is for', () => {
    // Which harness is part of the question: the list a picker offers is the
    // models that harness runs, and no others.
    expect(find('workers.routes.default.model').type).toEqual({ kind: 'model', harness: 'pi' })
    expect(
      find('workers.routes.default.model', {
        workers: { routes: { default: { harness: 'codex' } } },
      }).type,
    ).toEqual({ kind: 'model', harness: 'codex' })
    expect(find('orchestrator.model', { orchestrator: { harness: 'claude-code' } }).type).toEqual({
      kind: 'model',
      harness: 'claude-code',
    })
  })

  it('says a route’s model with its provider once, however the two were written', () => {
    // A route given a provider beside its model, as switching an agent once
    // kept it, then its model row written as the row offers it: pi takes the
    // pair as one model, and the row says it as one.
    const route = (one: Record<string, string>) =>
      find('workers.routes.default.model', { workers: { routes: { default: one } } }).value
    expect(route({ provider: 'anthropic', model: 'claude-opus-5' })).toBe('anthropic/claude-opus-5')
    expect(route({ provider: 'anthropic', model: 'anthropic/claude-sonnet-5' })).toBe(
      'anthropic/claude-sonnet-5',
    )
    expect(route({ model: 'openrouter/anthropic/claude-opus-4.5' })).toBe(
      'openrouter/anthropic/claude-opus-4.5',
    )
    // A provider that only begins the same way is another provider.
    expect(route({ provider: 'open', model: 'openrouter/x' })).toBe('open/openrouter/x')
  })

  it('offers the levels the harness thinks at, and every level where nobody said', () => {
    const levels = { pi: ['off', 'low', 'high'], 'claude-code': ['low', 'max'] } as const
    const of = (path: string, over: Record<string, unknown>) => {
      const found = settingsOf(config(over), [], levels)
        .flatMap((group) => group.settings)
        .find((setting) => setting.path === path)
      return found?.type
    }
    expect(of('workers.routes.default.thinking', {})).toEqual({
      kind: 'choice',
      options: ['off', 'low', 'high'],
    })
    // The orchestrator is a harness choice like any other, and Claude Code
    // does not think at `off`: offering it is offering a choice that is
    // quietly taken away.
    expect(of('orchestrator.thinking', { orchestrator: { harness: 'claude-code' } })).toEqual({
      kind: 'choice',
      options: ['low', 'max'],
    })
    // Nobody said what codex thinks at, so it is offered all of them, as the
    // window always did.
    expect(
      of('workers.routes.default.thinking', {
        workers: { routes: { default: { harness: 'codex' } } },
      }),
    ).toMatchObject({ options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] })
  })
})

describe('telemetry', () => {
  const group = (over: Record<string, unknown> = {}): SettingGroup => {
    const found = settingsOf(config(over)).find((one) => one.id === 'telemetry')
    if (!found) throw new Error('no telemetry group')
    return found
  }
  /** What a search in the Settings panel would show, out of every group. */
  const searched = (text: string, over: Record<string, unknown> = {}): string[] => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean)
    return settingsOf(config(over))
      .flatMap((one) => one.settings.filter((setting) => settingFound(one, setting, words)))
      .map((setting) => setting.path)
  }

  it('is called what somebody looking for it would call it', () => {
    // It was called "Reporting", so the word people search for — the one the
    // config key, the docs and Sentry itself use — was nowhere in the panel.
    expect(group().title).toBe('Telemetry')
  })

  it('is found by telemetry, sentry and dsn, whatever it is called', () => {
    for (const word of ['telemetry', 'sentry', 'dsn']) {
      expect(searched(word)).toContain('telemetry.dsn')
    }
    expect(searched('sentry org')).toContain('extensions.sentry.org')
    expect(searched('traces')).toContain('telemetry.traces')
  })

  it('has every key the reporter reads, and the extension’s own', () => {
    // A setting Tade accepts and ignores is worse than one it does not have,
    // and one it reads but never shows is a switch nobody can find.
    expect(group().settings.map((setting) => setting.path)).toEqual([
      'telemetry.dsn',
      'telemetry.driver',
      'telemetry.errors',
      'telemetry.logs',
      'telemetry.metrics',
      'telemetry.agents',
      'telemetry.traces',
      'telemetry.environment',
      'extensions.sentry.enabled',
      'extensions.sentry.org',
      'extensions.sentry.projects',
      'extensions.sentry.url',
      'extensions.sentry.token_env',
      'extensions.sentry.brief',
      'extensions.sentry.brief_query',
    ])
  })

  it('says what is sent and what never is, in the panel itself', () => {
    // Somebody should be able to decide from what is in front of them.
    const about = group().about.toLowerCase()
    expect(about).toContain('allow-list')
    expect(about).toContain('never your work')
    expect(about).toContain('~')
    const means = Object.fromEntries(
      group().settings.map((setting) => [setting.path, setting.means]),
    )
    expect(means['telemetry.agents']).toContain('never a prompt')
    expect(means['telemetry.errors']).toContain('never yours')
    expect(means['telemetry.logs']).toContain('never what was said')
    expect(means['telemetry.dsn']).toContain('not a key')
    // Where a DSN comes from when nothing is typed here, said in the one
    // place somebody would look for it.
    expect(find('telemetry.dsn').fallback).toContain('$TADE_TELEMETRY_DSN')
  })

  it('waits honestly: the reporter is read once, when Tade starts', () => {
    for (const setting of group().settings.filter((one) => one.path.startsWith('telemetry.'))) {
      expect(setting.live).toBe(false)
    }
  })

  it('shows the extension’s settings as they are written down', () => {
    const over = {
      extensions: {
        sentry: { org: 'acme', projects: { tade: 'tade-app', web: ['web-a', 'web-b'] } },
      },
    }
    const of = (path: string) => group(over).settings.find((one) => one.path === path)?.value
    expect(of('extensions.sentry.org')).toBe('acme')
    expect(of('extensions.sentry.projects')).toBe('tade=tade-app, web=web-a+web-b')
    // Built-in and on unless somebody turned it off.
    expect(of('extensions.sentry.enabled')).toBe('true')
    expect(
      group({ extensions: { sentry: { enabled: false } } }).settings.find(
        (one) => one.path === 'extensions.sentry.enabled',
      )?.value,
    ).toBe('false')
  })

  it('writes the project mapping back as the map the extension reads', () => {
    const setting = find('extensions.sentry.projects')
    const file: Record<string, unknown> = {}
    applySetting(file, setting.path, parseSetting(setting, 'tade=tade-app, web=web-a+web-b'))
    expect(file).toEqual({
      extensions: { sentry: { projects: { tade: 'tade-app', web: ['web-a', 'web-b'] } } },
    })
    expect(() => config(file)).not.toThrow()
    // Nothing that reads as a pair leaves no setting at all, rather than {}.
    expect(parseSetting(setting, 'nonsense')).toBeUndefined()
  })

  it('takes the share of Tade that is timed as the fraction it is', () => {
    const traces = find('telemetry.traces')
    // A whole number above zero is what every other number setting takes, and
    // it is what made this one impossible to change from the panel.
    expect(parseSetting(traces, '0.25')).toBe(0.25)
    expect(parseSetting(traces, '0')).toBe(0)
    expect(parseSetting(traces, '2')).toBeUndefined()
    expect(stepped(traces, 1)).toBe('0.2')
    expect(stepped(traces, -1)).toBe('0')
    expect(stepped(find('telemetry.traces', { telemetry: { traces: 1 } }), 1)).toBe('1')
    // And a count still steps by one, never below one.
    expect(stepped(find('checks.parallel'), 1)).toBe('3')
    expect(stepped(find('checks.parallel', { checks: { parallel: 1 } }), -1)).toBe('1')
  })

  // A DSN is an ingest endpoint, not a credential: Sentry publishes one in
  // the JavaScript of every page it watches, and all it grants is the right
  // to send events to one project. Drawn as bullets it could not be read back
  // and checked for a typo, which is exactly what somebody pasting seventy
  // characters into a forty-column field needs to do.
  it('is the value it is, everywhere a setting is read', () => {
    const dsn = 'https://abc123def456@o4507.ingest.sentry.io/12345'
    const setting = find('telemetry.dsn', { telemetry: { dsn } })
    expect(setting.value).toBe(dsn)
    expect(describeSetting(setting)).toContain('abc123def456')
  })

  // Tade does not hold this one at all: the setting here is the name of the
  // variable Sentry's own token is read from.
  it('says which variable the read token is in', () => {
    const token = find('extensions.sentry.token_env')
    expect(token.means).toContain('never keeps a copy')
  })
})

describe('keys and tokens', () => {
  const secrets = [
    {
      path: 'extensions.jev.key',
      title: 'Jev api key',
      means: 'the TypeSafe API key',
      value: '',
      from: null,
      placeholder: 'tsk_…',
      variables: ['TYPESAFE_API_KEY'],
    },
  ]

  it('is a group only when something asked for a key', () => {
    expect(settingsOf(config()).some((group) => group.id === 'credentials')).toBe(false)
    expect(settingsOf(config(), secrets).some((group) => group.id === 'credentials')).toBe(true)
  })

  it('is an ordinary setting, written and drawn like any other', () => {
    const [setting] =
      settingsOf(config(), secrets).find((one) => one.id === 'credentials')?.settings ?? []
    if (!setting) throw new Error('no field for the key')
    // The path is the config path it is written to: there is no second place.
    expect(setting.path).toBe('extensions.jev.key')
    expect(setting.type.kind).toBe('text')
    expect(setting.fallback).toBe('not set')
    expect(describeSetting(setting)).toContain('(not set)')
  })

  it('shows the key it has, and says where the one in use comes from', () => {
    const key = 'tsk_0123456789'
    const [set] =
      settingsOf(config(), [{ ...secrets[0]!, value: key, from: 'config.yaml' }]).find(
        (one) => one.id === 'credentials',
      )?.settings ?? []
    expect(set?.value).toBe(key)
    expect(describeSetting(set!)).toContain(key)
    // The environment beats what is written, so that is what the fallback says.
    const [beaten] =
      settingsOf(config(), [{ ...secrets[0]!, value: key, from: '$TYPESAFE_API_KEY' }]).find(
        (one) => one.id === 'credentials',
      )?.settings ?? []
    expect(beaten?.fallback).toBe('in use — $TYPESAFE_API_KEY')
  })

  it('is found by what people look for it as', () => {
    const group = settingsOf(config(), secrets).find((one) => one.id === 'credentials')
    if (!group?.settings[0]) throw new Error('no key group')
    for (const words of [['api', 'key'], ['token'], ['typesafe_api_key'], ['credential']]) {
      expect(settingFound(group, group.settings[0], words)).toBe(true)
    }
  })

  it('says who else can read it under every one of them, not only in the heading', () => {
    // `0600` keeps the file from other people, and agents are not other
    // people: they run as you. The page is options and values, so what a
    // person actually reads is the line under the setting they are on — and
    // the fact is the same for every key, so every key says it.
    const group = settingsOf(config(), [
      secrets[0]!,
      { ...secrets[0]!, path: 'extensions.sentry.token', title: 'Sentry token', means: '' },
    ]).find((one) => one.id === 'credentials')
    expect(group?.about).toContain(KEYS_AND_AGENTS)
    for (const setting of group?.settings ?? []) {
      expect(setting.means, setting.path).toContain(SEEN_BY_AGENTS)
    }
    // What it is for stays the extension's to say, and follows it — the line
    // is cut at two, so the half that must survive the cut is first.
    expect(group?.settings[0]?.means).toBe(`${SEEN_BY_AGENTS}; the TypeSafe API key`)
    // And a credential whose extension said nothing still says this much.
    expect(group?.settings[1]?.means).toBe(SEEN_BY_AGENTS)
  })

  it('says what to do instead, because a warning with no way out is one people scroll past', () => {
    const group = settingsOf(config(), secrets).find((one) => one.id === 'credentials')
    expect(group?.about).toContain('export its variable instead')
    expect(group?.about).toContain('or leave this unset')
  })
})

describe('writing one back', () => {
  it('puts it where the schema expects it', () => {
    const file: Record<string, unknown> = {}
    applySetting(file, 'surfaces.voice.attention.quiet', '22:00-08:00')
    expect(file).toEqual({ surfaces: { voice: { attention: { quiet: '22:00-08:00' } } } })
    // And the result is something the config will actually accept.
    expect(() => config(file)).not.toThrow()
  })

  it('leaves everything else in the file exactly as it was', () => {
    const file: Record<string, unknown> = {
      projects: { app: { root: '/src/app' } },
      workspace: { driver: 'tmux', adopt: false },
    }
    applySetting(file, 'workspace.driver', 'pty')
    expect(file).toEqual({
      projects: { app: { root: '/src/app' } },
      workspace: { driver: 'pty', adopt: false },
    })
  })

  it('removes the key when the value is cleared, rather than writing a blank', () => {
    const file: Record<string, unknown> = { orchestrator: { model: 'claude-opus-5' } }
    applySetting(file, 'orchestrator.model', undefined)
    // Back to the default, which is not the same as "set to empty" — the
    // schema would reject one and silently honour the other.
    expect(file).toEqual({ orchestrator: {} })
  })
})

describe('reading what was typed', () => {
  it('takes yes and no for a flag', () => {
    const flag = find('workspace.adopt')
    expect(parseSetting(flag, 'yes')).toBe(true)
    expect(parseSetting(flag, 'n')).toBe(false)
  })

  it('refuses a number that is not one', () => {
    const budget = find('surfaces.voice.attention.budget')
    expect(parseSetting(budget, '12')).toBe(12)
    // Rejected rather than coerced: `NaN` written to the config would be a
    // setting that fails validation the next time Tade opens.
    expect(parseSetting(budget, 'lots')).toBeUndefined()
    expect(parseSetting(budget, '-3')).toBeUndefined()
  })

  it('takes dollars and cents where the schema does, and whole ones where it does not', () => {
    // Every number was read as a count, so a budget of 12.50 was refused with
    // "needs a whole number" by a schema that takes it.
    const over = { projects: { app: { root: '/src/app' } } }
    for (const path of ['budget.usd_per_day', 'projects.app.budget.usd_per_day']) {
      const budget = find(path, over)
      expect(parseSetting(budget, '12.50')).toBe(12.5)
      expect(wantedInstead(budget)).toBe('a number above zero')
      expect(parseSetting(budget, '0')).toBeUndefined()
    }
    const tokens = find('budget.tokens_per_day')
    expect(parseSetting(tokens, '12.50')).toBeUndefined()
    expect(wantedInstead(tokens)).toBe('a whole number above zero')
  })

  it('takes a fraction at every number row whose schema takes one, and at no other', () => {
    // Asked of the schema by parsing, not of how a row came to say it: a row
    // that refuses what its key accepts, or offers what it refuses, is wrong.
    const file = { projects: { app: { root: '/src/app' } } }
    const numbers = settingsOf(config(file))
      .flatMap((group) => group.settings)
      .filter((setting) => setting.type.kind === 'number')
    expect(numbers.length).toBeGreaterThan(15)
    const wrong: string[] = []
    for (const setting of numbers) {
      const typed = setting.type.kind === 'number' && setting.type.fraction ? 0.5 : 1.5
      const written = structuredClone(file) as Record<string, unknown>
      applySetting(written, setting.path, typed)
      const parsed = ConfigSchema.safeParse(written)
      const schema =
        parsed.success || parsed.error.issues.every((one) => one.path.join('.') !== setting.path)
      const row = parseSetting(setting, String(typed)) !== undefined
      if (schema !== row)
        wrong.push(`${setting.path}: the schema ${schema ? 'takes' : 'refuses'} ${typed}`)
    }
    expect(wrong).toEqual([])
  })

  it('takes, typed, the lowest value its arrows reach', () => {
    // Where nought is off the arrows reached 0 and the row refused it, and
    // every caller refuses what `parseSetting` cannot read, so off could be
    // neither stepped to nor typed.
    const numbers = settingsOf(config({ projects: { app: { root: '/src/app' } } }))
      .flatMap((group) => group.settings)
      .filter((setting) => setting.type.kind === 'number')
    const wrong = numbers.flatMap((setting) => {
      const lowest = stepped({ ...setting, value: '0' }, -1)
      return parseSetting(setting, lowest) === undefined
        ? [`${setting.path} refuses ${lowest}`]
        : []
    })
    expect(wrong).toEqual([])
    // Twelve hours by default, so nought is never asking — not the key taken away.
    const passkey = find('surfaces.web.passkey_hours')
    expect(stepped({ ...passkey, value: '1' }, -1)).toBe('0')
    expect(parseSetting(passkey, '0')).toBe(0)
    expect(parseSetting(passkey, '-1')).toBeUndefined()
  })

  it('keeps the cents a budget was written with when the arrows move it', () => {
    const budget = (usd_per_day?: number) => find('budget.usd_per_day', { budget: { usd_per_day } })
    // 2.3 less one is 1.2999999999999998 in floating point.
    expect(stepped(budget(2.3), -1)).toBe('1.3')
    expect(stepped(budget(12.5), 1)).toBe('13.5')
    expect(stepped(budget(), 1)).toBe('1')
  })

  it('treats an empty answer as clearing it', () => {
    expect(parseSetting(find('orchestrator.model'), '   ')).toBeUndefined()
  })

  it('reads a list as a list, with spaces or commas between', () => {
    const trusted = find('surfaces.web.trusted_hosts')
    expect(parseSetting(trusted, 'studio.ts.net, tunnel.example.com  box.example.com')).toEqual([
      'studio.ts.net',
      'tunnel.example.com',
      'box.example.com',
    ])
    // Nothing on it is the default, which is empty: the key goes away.
    expect(parseSetting(trusted, ' , ')).toBeUndefined()
  })

  it('hands the schema the kind of value it holds, at every path a row offers', () => {
    // Every row a person can save, read from what its field would hold — the
    // example it shows, or what it holds now — and written where it says. A
    // list row read as a line of text was refused on every save:
    // "Invalid input: expected array, received string".
    const file = {
      projects: { app: { root: '/src/app' } },
      extensions: { sentry: { enabled: true }, jev: { enabled: true } },
    }
    const wrong: string[] = []
    for (const setting of settingsOf(config(file)).flatMap((group) => group.settings)) {
      const typed = setting.type.kind === 'text' ? setting.type.placeholder : setting.value
      const value = parseSetting(setting, typed)
      if (value === undefined) continue
      const written = structuredClone(file) as Record<string, unknown>
      applySetting(written, setting.path, value)
      const parsed = ConfigSchema.safeParse(written)
      for (const issue of parsed.success ? [] : parsed.error.issues) {
        if (issue.code === 'invalid_type' && issue.path.join('.') === setting.path) {
          wrong.push(`${setting.path}: ${issue.message}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })
})

describe('a project’s own answer to where its agents work', () => {
  const groups = (over: Record<string, unknown> = {}) =>
    settingsOf(
      ConfigSchema.parse({
        agents: { workspace: 'worktree' },
        projects: { shop: { root: '~/src/shop', ...over } },
      }),
    )
  const setting = (over?: Record<string, unknown>) =>
    groups(over)
      .flatMap((group) => group.settings)
      .find((one) => one.path === 'projects.shop.workspace')

  it('is empty, and falls back to the machine’s, until somebody sets it', () => {
    expect(setting()).toMatchObject({ value: '', fallback: 'worktree' })
  })

  it('shows what the project says once it says something', () => {
    expect(setting({ workspace: 'checkout' })).toMatchObject({
      value: 'checkout',
      fallback: 'worktree',
    })
  })

  it('offers empty as a choice, which is how it is given back to the machine', () => {
    expect(setting()?.type).toEqual({ kind: 'choice', options: ['', 'checkout', 'worktree'] })
    // An empty choice parses to nothing, and `writeSetting` deletes the key.
    const one = setting()
    expect(one && parseSetting(one, '')).toBeUndefined()
  })
})

describe('how many of a project\u2019s agents work at once', () => {
  const setting = (over: Record<string, unknown> = {}) =>
    settingsOf(ConfigSchema.parse({ projects: { shop: { root: '~/src/shop', ...over } } }))
      .flatMap((group) => group.settings)
      .find((one) => one.path === 'projects.shop.max_parallel')

  it('is a setting somebody can find and change, not only a key the queue reads', () => {
    expect(setting()).toMatchObject({ value: '', scope: 'shop', type: { kind: 'number' } })
    expect(setting({ max_parallel: 1 })?.value).toBe('1')
  })

  it('takes a count, and empty gives it back to as many as are started', () => {
    const one = setting()
    expect(one && parseSetting(one, '1')).toBe(1)
    expect(one && parseSetting(one, '0')).toBeUndefined()
    expect(one && parseSetting(one, '')).toBeUndefined()
  })

  it('writes back where the queue and the workbench read it', () => {
    const file: Record<string, unknown> = { projects: { shop: { root: '~/src/shop' } } }
    applySetting(file, 'projects.shop.max_parallel', 1)
    expect(config(file).projects.shop?.max_parallel).toBe(1)
  })
})

describe('a budget', () => {
  it('applies now, at every row, because every start is held to the config as it is', () => {
    // The workbench reads a budget each time an agent starts, out of the
    // config the window last handed it (`guardBudget`): a row that said
    // "on restart" sent somebody to restart Tade for nothing.
    const budgets = settingsOf(config({ projects: { app: { root: '/src/app' } } }))
      .flatMap((group) => group.settings)
      .filter((setting) => /(^|\.)budget\.(usd|tokens)_per_day$/.test(setting.path))
    expect(budgets.map((one) => one.path)).toEqual([
      'budget.usd_per_day',
      'budget.tokens_per_day',
      'projects.app.budget.usd_per_day',
    ])
    expect(budgets.filter((one) => !one.live).map((one) => one.path)).toEqual([])
  })
})

describe('how many suites the machine runs', () => {
  it('is the machine\u2019s, with no row for any one project', () => {
    expect(find('checks.suites')).toMatchObject({ value: '1', type: { kind: 'number' } })
    const paths = settingsOf(config({ projects: { shop: { root: '~/src/shop' } } }))
      .flatMap((group) => group.settings)
      .map((one) => one.path)
    expect(paths).not.toContain('projects.shop.checks.suites')
  })
})

describe('what agents do with finished work', () => {
  const row = (over: Record<string, unknown> = {}) =>
    settingsOf(
      ConfigSchema.parse({
        agents: { workspace: 'worktree', ...over },
        projects: { shop: { root: '~/src/shop' } },
      }),
    )
      .flatMap((group) => group.settings)
      .find((one) => one.path === 'agents.push')

  it('is empty until somebody chooses, and says what the workspace answers instead', () => {
    // Empty is a value here and not a hole: the question belongs to the
    // workspace, which answers it differently in each, and a row that read
    // `never` under `worktree` would have been wrong about what happens.
    expect(row()).toMatchObject({ value: '', fallback: 'branch-and-review' })
    expect(row({ workspace: 'checkout' })?.fallback).toBe('never')
    // The whole rule is in the sentence beside it, which is where there is
    // room for both halves of it.
    expect(row()?.means).toContain(PUSH_BY_DEFAULT)
    expect(row()?.type).toEqual({
      kind: 'choice',
      options: ['', 'never', 'branch', 'branch-and-review'],
    })
    // Which is also the only way back to it once a mode has been chosen.
    const chosen = row({ push: 'branch' })
    expect(chosen?.value).toBe('branch')
    expect(chosen && parseSetting(chosen, '')).toBeUndefined()
  })

  it('tells one project what saying nothing gets it, in its own workspace', () => {
    // The project row's fallback is what *this* project gets by staying empty,
    // so with nothing set on the machine it is the workspace's answer and not
    // the bare word `never`.
    const projectRow = (
      over: Record<string, unknown> = {},
      machine: Record<string, unknown> = {},
    ) =>
      settingsOf(
        ConfigSchema.parse({
          agents: machine,
          projects: { shop: { root: '~/src/shop', ...over } },
        }),
      )
        .flatMap((group) => group.settings)
        .find((one) => one.path === 'projects.shop.push')
    expect(projectRow({ workspace: 'worktree' })?.fallback).toBe('branch-and-review')
    expect(projectRow({ workspace: 'checkout' })?.fallback).toBe('never')
    // And the machine's answer, where there is one, is still what it follows.
    expect(projectRow({ workspace: 'worktree' }, { push: 'branch' })?.fallback).toBe('branch')
  })
})

describe('the Away page', () => {
  const away = settingsOf(ConfigSchema.parse({})).find((group) => group.id === 'away')
  const rows = away?.settings ?? []

  it('names each row in a few words, so nothing on the page is cut', () => {
    // The page cuts a name past half its width with an ellipsis, and eight
    // rows that each began *Let a paired device* were cut on every terminal.
    expect(rows.length).toBe(15)
    for (const one of rows) {
      expect(one.title.length, one.path).toBeLessThanOrEqual(24)
      expect(one.title, one.path).not.toMatch(/^Let a/)
    }
  })

  it('puts what a paired device may do under one heading, and nothing else under it', () => {
    expect(rows.filter((one) => one.section === DEVICE_MAY).map((one) => one.path)).toEqual([
      'surfaces.web.acting',
      'surfaces.web.orchestrator',
      'surfaces.web.drafts',
      'surfaces.web.settings',
      'surfaces.web.install',
      'surfaces.web.offline',
      'surfaces.web.push',
      'surfaces.web.push_details',
    ])
  })

  it('draws what fits in two lines, and keeps the whole of it where search reads', () => {
    for (const one of rows) {
      expect((one.short ?? one.means).length, one.path).toBeLessThanOrEqual(104)
    }
    const row = (path: string) => rows.find((one) => one.path === path)
    // The domain's sentences are cut from the drawing and not from the program.
    expect(row('surfaces.web.acting')?.means).toContain(ACTING_IS_NOT_YOU)
    expect(row('surfaces.web.acting')?.short).toContain(ACTING_IS_NOT_YOU_SHORT)
    expect(row('surfaces.web.push_key')?.short).toContain(SEEN_BY_AGENTS)
    // Every row applies as it is changed, and none says *on restart*: what the
    // listener is built from builds it again (`web-follow.ts`), and the rest is
    // read on the beat.
    expect(rows.filter((one) => !one.live).map((one) => one.path)).toEqual([])
  })
})

describe('the Intake page', () => {
  it('says what reaches it: a clock everywhere, and a webhook where there is a public name', () => {
    // Held because "with no listener and no inbound port" outlived the
    // doorbell: on a machine with a public name a signed delivery from a source
    // rings its door, so the page that turns intake on must say so.
    const about = settingsOf(config()).find((group) => group.id === 'intake')?.about ?? ''
    expect(about).toContain('on a clock')
    expect(about).toContain('public name')
    expect(about).toContain('webhook')
    expect(about).not.toMatch(/no listener|no inbound port/)
  })
})
