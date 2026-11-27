import {
  ConfigSchema,
  SETTINGS_FROM_AWAY,
  SETTINGS_FROM_AWAY_SHORT,
  type SettingGroup,
  settingsOf,
} from '@tade/core'
import { describe, expect, it } from 'vitest'
import { AT_THE_MACHINE, isCredential, type SettingOut, settingsFor } from '../src/configuring.ts'

// What a device is shown of the config, and what it is never shown.
//
// **The rows are `settingsOf`'s own**, built from a parsed config and the
// credential rows an extension would declare — never a hand-written list — so
// a setting added tomorrow is in these tests the day it is added, and the leak
// checks run over every value Settings would draw rather than over the ones
// somebody remembered.

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

function every(out: ReturnType<typeof settingsFor>): SettingOut[] {
  return out.groups.flatMap((group) => group.settings)
}

function one(out: ReturnType<typeof settingsFor>, path: string): SettingOut {
  const found = every(out).find((row) => row.path === path)
  if (found === undefined) throw new Error(`no row for ${path}`)
  return found
}

describe('reading the settings', () => {
  it('lists every setting Settings would draw, to every paired device', () => {
    const groups = rows()
    const out = settingsFor(groups, [])
    expect(every(out).map((row) => row.path)).toEqual(
      groups.flatMap((group) => group.settings.map((setting) => setting.path)),
    )
  })
})

describe('a key is never readable', () => {
  it('carries no key anywhere in the answer', () => {
    // **By value, over the whole answer**, rather than by looking in the field
    // a key is expected to be in: a key that turned up in a `means`, a
    // fallback or a revision is the leak this exists to catch.
    const text = JSON.stringify(settingsFor(rows(), []))
    for (const key of [JEV_KEY, ACCOUNT_KEY, PUSH_KEY]) {
      expect(text, key).not.toContain(key)
      // Nor a recognisable piece of one.
      expect(text, key).not.toContain(key.slice(0, 12))
    }
  })

  it('says whether a key is held and nothing else, and a new one may be typed in', () => {
    const out = settingsFor(rows(), [])
    for (const path of ['extensions.jev.key', 'accounts.work.key', 'surfaces.web.push_key']) {
      const row = one(out, path)
      expect(row.held, path).toBe('set')
      expect(row.shown, path).toBe('')
      // Whether one is held is all a change echoes, never the key.
      expect(row.was, path).toBe('set')
      expect(row.may, path).toBe('change')
      expect(row.sets, path).toBe(true)
    }
    expect(one(out, 'extensions.sentry.token').held).toBe('not set')
  })

  it('takes a key out of an ordinary setting it was pasted into', () => {
    // The owner pasted a key into the instructions agents are given. The
    // setting is ordinary and its value is shown — without the key, because
    // every value is cleaned of every key Tade holds, the credential rows'
    // own included.
    const out = settingsFor(rows({ instructions: `use ${JEV_KEY} for the judge` }), [])
    const row = one(out, 'agents.instructions')
    expect(row.shown).not.toContain(JEV_KEY)
    expect(row.shown).toContain('use')
    // And a value that could not be shown whole is not one a device may change.
    expect(row.may).toBe('machine')
    expect(row.why).toBe(AT_THE_MACHINE.partial)
    expect(row.was).toBeNull()
  })

  it('takes out a key the window knows of that no setting holds', () => {
    // An environment variable named like a credential: the window hands it
    // over as known, and a value that quoted it loses it.
    const env = 'ENVKEY_0123456789abcdefABCDEF'
    const out = settingsFor(rows({ instructions: `token ${env}` }), [env])
    expect(JSON.stringify(out)).not.toContain(env)
  })

  it('takes machine paths out of what is shown', () => {
    expect(JSON.stringify(settingsFor(rows(), []))).not.toContain('/Users/kim')
  })

  it('tells a key from a key on a keyboard', () => {
    const groups = rows()
    const credential = (path: string) => {
      for (const group of groups) {
        const setting = group.settings.find((row) => row.path === path)
        if (setting) return isCredential(group, setting)
      }
      throw new Error(path)
    }
    expect(credential('extensions.jev.key')).toBe(true)
    expect(credential('surfaces.web.push_key')).toBe(true)
    // Push to talk is a key you press, and redacting `ctrl+space` would teach
    // people to distrust the redaction.
    expect(credential('surfaces.voice.talk.key')).toBe(false)
    // The *name* of the variable a token is read from is not a token.
    expect(credential('extensions.sentry.token_env')).toBe(false)
  })
})

describe('how far a device reaches into each setting', () => {
  it('changes every setting it is shown whole, every tier', () => {
    // Every paired device is the person's own, so `asked` and `never` are
    // reached as the keyboard reaches them.
    const out = settingsFor(rows(), [])
    let changed = 0
    for (const row of every(out)) {
      // A value cleaned for the screen — a project's root, with the machine's
      // path taken out — has nothing exact to echo.
      if (row.why === AT_THE_MACHINE.partial) continue
      changed += 1
      expect(row.may, row.path).toBe('change')
      expect(row.why, row.path).toBe('')
      if (row.held === null) expect(row.sets, row.path).toBe(false)
    }
    // Every tier, so the loop above was not over the open one alone.
    expect(changed).toBeGreaterThan(30)
    expect(one(out, 'approvals.mode').may).toBe('change')
    expect(one(out, 'agents.commit').may).toBe('change')
    expect(one(out, 'surfaces.web.acting').may).toBe('change')
  })

  it('echoes the value itself, exactly, for what may be changed', () => {
    const out = settingsFor(rows(), [])
    expect(one(out, 'surfaces.window.editor').was).toBe('code')
    expect(one(out, 'projects.app.push').was).toBe('branch')
    // Nothing set is a value too, and echoed as one.
    expect(one(out, 'projects.ledger.push').was).toBe('')
  })
})

describe('the sentence a person reads where they turn this on', () => {
  it('says what changing a setting from away reaches, and what a key is', () => {
    expect(SETTINGS_FROM_AWAY).toContain('could pair itself')
    expect(SETTINGS_FROM_AWAY).toContain('set or not set')
    expect(SETTINGS_FROM_AWAY).toContain('never read back')
    expect(SETTINGS_FROM_AWAY).toContain('journal under that device')
    for (const word of ['secure', 'encrypted', 'private', 'safe', 'harmless']) {
      expect(SETTINGS_FROM_AWAY.toLowerCase(), word).not.toContain(word)
    }
    expect(SETTINGS_FROM_AWAY_SHORT.length).toBeLessThan(80)
    expect(SETTINGS_FROM_AWAY_SHORT).toContain('any setting')
    expect(SETTINGS_FROM_AWAY_SHORT).toContain('never shown')
  })
})
