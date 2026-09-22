import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/config.ts'
import {
  applySetting,
  describeSetting,
  parseSetting,
  type SettingGroup,
  settingFound,
  settingsOf,
  shownValue,
  stepped,
} from '../src/settings.ts'

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

  it('says what changing it does, not just what it is called', () => {
    // "workspace.driver: pty" answers nothing for somebody deciding.
    expect(find('workspace.driver').means).toContain('after you close Tade')
    expect(find('approvals.mode').means).toContain('never interrupts')
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
    expect(means['telemetry.dsn']).toContain('empty sends nothing')
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

  it('never repeats the DSN away from the field it is typed into', () => {
    const dsn = 'https://abc123def456@o4507.ingest.sentry.io/12345'
    const setting = find('telemetry.dsn', { telemetry: { dsn } })
    expect(setting.secret).toBe(true)
    // Enough to tell which project it is; never the key that writes to it.
    expect(shownValue(setting)).toBe('https://…@o4507.ingest.sentry.io/12345')
    expect(describeSetting(setting)).not.toContain('abc123def456')
  })
})

describe('keys and tokens', () => {
  const secrets = [
    {
      name: 'jev.key',
      title: 'Jev api key',
      means: 'the TypeSafe API key',
      from: null,
      placeholder: 'tsk_…',
      variables: ['TYPESAFE_API_KEY'],
    },
  ]

  it('is a group only when something asked for a key', () => {
    expect(settingsOf(config()).some((group) => group.id === 'credentials')).toBe(false)
    expect(settingsOf(config(), secrets).some((group) => group.id === 'credentials')).toBe(true)
  })

  it('offers a field for one, kept out of the config and never shown', () => {
    const [setting] =
      settingsOf(config(), secrets).find((one) => one.id === 'credentials')?.settings ?? []
    if (!setting) throw new Error('no field for the key')
    expect(setting).toMatchObject({ secret: true, kept: 'jev.key', value: '' })
    // Nothing is written to the config for it: `kept` says where it goes, and
    // the path is not a config path at all.
    expect(setting.path).toBe('secrets.jev.key')
    expect(setting.fallback).toBe('not set')
    expect(describeSetting(setting)).toContain('(not set)')
    // With one kept, it says where — the place, never the key.
    const [set] =
      settingsOf(config(), [{ ...secrets[0]!, from: 'the macOS keychain' }]).find(
        (one) => one.id === 'credentials',
      )?.settings ?? []
    expect(set?.fallback).toBe('kept — the macOS keychain')
    expect(shownValue(set!, 'tsk_0123456789')).not.toContain('tsk_')
  })

  it('is found by what people look for it as', () => {
    const group = settingsOf(config(), secrets).find((one) => one.id === 'credentials')
    if (!group?.settings[0]) throw new Error('no key group')
    for (const words of [['api', 'key'], ['token'], ['typesafe_api_key'], ['keychain']]) {
      expect(settingFound(group, group.settings[0], words)).toBe(true)
    }
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

  it('treats an empty answer as clearing it', () => {
    expect(parseSetting(find('orchestrator.model'), '   ')).toBeUndefined()
  })
})
