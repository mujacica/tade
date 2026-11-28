import { ConfigSchema, type SettingGroup, settingsOf } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { isCredential } from '../src/configuring.ts'

// Which settings are credentials, which the window's Settings never shows.
//
// **The rows are `settingsOf`'s own**, built from a parsed config and the
// credential rows an extension would declare — never a hand-written list — so
// a setting added tomorrow is in these tests the day it is added.

/** Three keys, each long enough and shaped unlike anything else here. */
const JEV_KEY = 'jev_live_7fd1c0a9e2b84f6d93a51c2e8b7d4f00'
const ACCOUNT_KEY = 'acct-k3y-91c2e8b7d4f00aa7fd1c0a9e2b84f6'
const PUSH_KEY = 'pVk3_9c0e1d2a3b4c5d6e7f8091a2b3c4d5e6f7a8b9c0d1e2'

function rows(): SettingGroup[] {
  const config = ConfigSchema.parse({
    projects: {
      app: { root: '/Users/kim/src/app', push: 'branch' },
      ledger: { root: '/Users/kim/src/ledger' },
    },
    extensions: { sentry: {} },
    agents: { instructions: 'write tests first' },
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

describe('a credential', () => {
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
