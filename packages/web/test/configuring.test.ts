import {
  ConfigSchema,
  SETTINGS_FROM_AWAY,
  SETTINGS_FROM_AWAY_SHORT,
  type SettingGroup,
  settingReach,
  settingsOf,
} from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  AT_THE_MACHINE,
  awayReach,
  clearOnly,
  isCredential,
  NOT_GRANTED,
  type SettingOut,
  settingsFor,
} from '../src/configuring.ts'
import type { Reach } from '../src/reach.ts'

// What a device is shown of the config, and what it is never shown.
//
// **The rows are `settingsOf`'s own**, built from a parsed config and the
// credential rows an extension would declare — never a hand-written list — so
// a setting added tomorrow is in these tests the day it is added, and the leak
// checks run over every value Settings would draw rather than over the ones
// somebody remembered.

const DEVICE = '00112233445566aa'

/** Three keys, each long enough and shaped unlike anything else here. */
const JEV_KEY = 'jev_live_7fd1c0a9e2b84f6d93a51c2e8b7d4f00'
const ACCOUNT_KEY = 'acct-k3y-91c2e8b7d4f00aa7fd1c0a9e2b84f6'
const PUSH_KEY = 'pVk3_9c0e1d2a3b4c5d6e7f8091a2b3c4d5e6f7a8b9c0d1e2'

function rows(over: { instructions?: string } = {}): SettingGroup[] {
  const config = ConfigSchema.parse({
    projects: {
      app: { root: '/Users/kim/src/app', push: 'branch' },
      ledger: { root: '/Users/kim/src/ledger' },
    },
    extensions: { sentry: {} },
    agents: { instructions: over.instructions ?? 'write tests first' },
    surfaces: { web: { push_key: PUSH_KEY }, window: { editor: 'code' } },
  })
  return settingsOf(config, [
    {
      path: 'extensions.jev.key',
      title: 'Jev API key',
      means: 'what the judge answers with',
      value: JEV_KEY,
      from: null,
    },
    {
      path: 'accounts.work.key',
      title: 'Work API key',
      means: 'the work account',
      value: ACCOUNT_KEY,
      from: '$WORK_API_KEY',
    },
    { path: 'extensions.sentry.token', title: 'Sentry token', means: '', value: '', from: null },
  ])
}

function reach(over: Partial<Reach> = {}): Reach {
  return { device: DEVICE, projects: { kind: 'every' }, granted: ['settings'], ...over }
}

function every(out: ReturnType<typeof settingsFor>): SettingOut[] {
  return out.groups.flatMap((group) => group.settings)
}

function one(out: ReturnType<typeof settingsFor>, path: string): SettingOut {
  const found = every(out).find((row) => row.path === path)
  if (found === undefined) throw new Error(`no row for ${path}`)
  return found
}

describe('reading the settings is a grant, per device', () => {
  it('answers nothing at all to a device that was not granted it', () => {
    // `granted: false` is the whole answer — not an empty config, which would
    // be a different fact — and not one value rides along.
    for (const granted of [[], ['titles', 'notes', 'lanes'] as const]) {
      const out = settingsFor(rows(), reach({ granted: [...granted] }), [])
      expect(out).toEqual(NOT_GRANTED)
    }
  })

  it('lists every setting Settings would draw for a device granted it', () => {
    const groups = rows()
    const out = settingsFor(groups, reach(), [])
    expect(every(out).map((row) => row.path)).toEqual(
      groups.flatMap((group) => group.settings.map((setting) => setting.path)),
    )
    expect(out.withheld).toBe(0)
  })

  it('leaves out every setting of a project this device does not read, and counts them', () => {
    const groups = rows()
    const out = settingsFor(groups, reach({ projects: { kind: 'listed', names: ['app'] } }), [])
    const paths = every(out).map((row) => row.path)
    expect(paths.some((path) => path.startsWith('projects.ledger.'))).toBe(false)
    expect(paths).toContain('projects.app.push')
    const ledger = groups
      .flatMap((group) => group.settings)
      .filter((setting) => setting.path.startsWith('projects.ledger.'))
    expect(ledger.length).toBeGreaterThan(0)
    expect(out.withheld).toBe(ledger.length)
    // And nothing of it is anywhere in the answer, not even its name.
    expect(JSON.stringify(out)).not.toContain('ledger')
  })
})

describe('a key is never readable', () => {
  it('carries no key anywhere in the answer, whatever this device was granted', () => {
    // **By value, over the whole answer**, rather than by looking in the field
    // a key is expected to be in: a key that turned up in a `means`, a
    // fallback or a revision is the leak this exists to catch.
    const out = settingsFor(rows(), reach({ granted: ['settings', 'titles', 'lanes'] }), [])
    const text = JSON.stringify(out)
    for (const key of [JEV_KEY, ACCOUNT_KEY, PUSH_KEY]) {
      expect(text, key).not.toContain(key)
      // Nor a recognisable piece of one.
      expect(text, key).not.toContain(key.slice(0, 12))
    }
  })

  it('says whether a key is held and nothing else, and never offers a revision of one', () => {
    const out = settingsFor(rows(), reach(), [])
    for (const path of ['extensions.jev.key', 'accounts.work.key', 'surfaces.web.push_key']) {
      const row = one(out, path)
      expect(row.held, path).toBe('set')
      expect(row.shown, path).toBe('')
      expect(row.was, path).toBeNull()
      expect(row.may, path).toBe('machine')
      expect(row.why, path).toBe(AT_THE_MACHINE.key)
    }
    expect(one(out, 'extensions.sentry.token').held).toBe('not set')
  })

  it('takes a key out of an ordinary setting it was pasted into', () => {
    // The owner pasted a key into the instructions agents are given. The
    // setting is ordinary and its value is shown — without the key, because
    // every value is cleaned of every key Tade holds, the credential rows'
    // own included.
    const out = settingsFor(rows({ instructions: `use ${JEV_KEY} for the judge` }), reach(), [])
    const row = one(out, 'agents.instructions')
    expect(row.shown).not.toContain(JEV_KEY)
    expect(row.shown).toContain('use')
    // And a value that could not be shown whole is not one a device may change.
    expect(row.may).toBe('machine')
  })

  it('takes out a key the window knows of that no setting holds', () => {
    // An environment variable named like a credential: the window hands it
    // over as known, and a value that quoted it loses it.
    const env = 'ENVKEY_0123456789abcdefABCDEF'
    const out = settingsFor(rows({ instructions: `token ${env}` }), reach(), [env])
    expect(JSON.stringify(out)).not.toContain(env)
  })

  it('takes machine paths out of what is shown', () => {
    const out = settingsFor(rows(), reach(), [])
    expect(JSON.stringify(out)).not.toContain('/Users/kim')
  })

  it('tells a key from a key on a keyboard', () => {
    const groups = rows()
    const find = (path: string) => {
      for (const group of groups) {
        const setting = group.settings.find((row) => row.path === path)
        if (setting) return { group, setting }
      }
      throw new Error(path)
    }
    const credential = (path: string) => {
      const { group, setting } = find(path)
      return isCredential(group, setting)
    }
    expect(credential('extensions.jev.key')).toBe(true)
    expect(credential('surfaces.web.push_key')).toBe(true)
    // Push to talk is a key you press, and redacting `ctrl+space` would teach
    // people to distrust the redaction.
    expect(credential('surfaces.voice.talk.key')).toBe(false)
    // The *name* of the variable a token is read from is not a token.
    expect(credential('extensions.sentry.token_env')).toBe(false)
    const { group, setting } = find('surfaces.web.push_key')
    expect(clearOnly(group, setting)).toBe(true)
  })
})

describe('how far a device reaches into each setting', () => {
  it('reaches the open tier, and nothing in asked or never', () => {
    // Every setting Settings draws, sorted by what a device may do with it —
    // and the set it may change written out, so a setting that moves into the
    // open tier is a diff somebody reads beside `SETTINGS_FROM_AWAY`.
    const out = settingsFor(rows(), reach(), [])
    const changeable = every(out)
      .filter((row) => row.may === 'change')
      .map((row) => row.path)
    expect(changeable).toEqual([
      'surfaces.window.sidebar_width',
      'surfaces.window.strip_height',
      'surfaces.window.editor',
      'projects.app.push',
      'projects.ledger.push',
    ])
    for (const row of every(out)) {
      const tier = settingReach(row.path).reach
      if (tier === 'open') continue
      expect(row.may, row.path).toBe('machine')
      expect(row.was, row.path).toBeNull()
      if (row.held === null) {
        expect(row.why, row.path).toBe(
          tier === 'asked' ? AT_THE_MACHINE.asked : AT_THE_MACHINE.never,
        )
      }
    }
  })

  it('echoes the value itself, exactly, for what may be changed', () => {
    const out = settingsFor(rows(), reach(), [])
    expect(one(out, 'surfaces.window.editor').was).toBe('code')
    expect(one(out, 'projects.app.push').was).toBe('branch')
    // Nothing set is a value too, and echoed as one.
    expect(one(out, 'projects.ledger.push').was).toBe('')
  })

  it('answers by path alone, so a crafted path is decided before anything is looked up', () => {
    expect(awayReach('surfaces.window.editor')).toEqual({ may: 'change' })
    expect(awayReach('projects.anything.push')).toEqual({ may: 'change' })
    for (const path of [
      'approvals.mode',
      'surfaces.web.acting',
      'surfaces.web.settings',
      'accounts.work.key',
      'extensions.jev.enabled',
      'mcp.servers.github.enabled',
      'projects.app.root',
      'telemetry.dsn',
    ]) {
      expect(awayReach(path), path).toEqual({ may: 'machine', why: AT_THE_MACHINE.never })
    }
    for (const path of ['checks.before', 'agents.commit', 'projects.app.title']) {
      expect(awayReach(path), path).toEqual({ may: 'machine', why: AT_THE_MACHINE.asked })
    }
  })
})

describe('the sentence a person reads where they turn this on', () => {
  it('say what changing a setting from away reaches, as a list and not a promise', () => {
    // **The list is the load-bearing half.** Each open-tier setting is named,
    // so one that joins the tier and is not named here is a sentence that fell
    // behind — `configuring.test.ts` holds the tier to the same four.
    for (const reaches of [
      'width of the sidebar',
      'height of the strip',
      'editor',
      'what a project it can read pushes',
    ]) {
      expect(SETTINGS_FROM_AWAY, reaches).toContain(reaches)
    }
    // And why the rest is at the machine, in the same breath: the asked tier's
    // reason and the never tier's absence.
    expect(SETTINGS_FROM_AWAY).toContain('needs your own words')
    expect(SETTINGS_FROM_AWAY).toContain('never your own words')
    expect(SETTINGS_FROM_AWAY).toContain('could pair itself')
    expect(SETTINGS_FROM_AWAY).toContain('no route at all')
    expect(SETTINGS_FROM_AWAY).toContain('set or not set')
    expect(SETTINGS_FROM_AWAY).toContain('never read back')
    expect(SETTINGS_FROM_AWAY).toContain('journal under that device')
    for (const word of ['secure', 'encrypted', 'private', 'safe', 'harmless']) {
      expect(SETTINGS_FROM_AWAY.toLowerCase(), word).not.toContain(word)
    }
    expect(SETTINGS_FROM_AWAY_SHORT.length).toBeLessThan(80)
    expect(SETTINGS_FROM_AWAY_SHORT).toContain('never a key')
  })
})
