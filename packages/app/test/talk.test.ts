import { describe, expect, it } from 'vitest'
import { appKey, checkTalkKey, keyCaps } from '../src/keys.ts'

// The key you talk with is yours to choose, within what would not cost you
// something you need.

describe('choosing a talk key', () => {
  it('refuses a key that types a character', () => {
    for (const key of ['a', 'space', 'shift+a', '/']) expect(checkTalkKey(key).ok).toBe(false)
  })

  it('refuses the keys nothing can do without', () => {
    expect(checkTalkKey('ctrl+c').ok).toBe(false)
    expect(checkTalkKey('enter').ok).toBe(false)
  })

  it('allows a taken key, but says what you would lose', () => {
    const check = checkTalkKey('ctrl+r')
    expect(check.ok).toBe(true)
    expect(check.ok && check.warning).toContain('search history')
  })

  it('has nothing to say about a free key', () => {
    expect(checkTalkKey('f5')).toEqual({ ok: true, warning: null })
    expect(checkTalkKey('ctrl+space')).toEqual({ ok: true, warning: null })
  })

  it('draws a combination as the caps you press', () => {
    expect(keyCaps('ctrl+space')).toEqual(['ctrl', 'space'])
    expect(keyCaps('ctrl+t')).toEqual(['ctrl', 't'])
    expect(keyCaps('f5')).toEqual(['F5'])
  })
})

describe('the chosen key', () => {
  it('talks with the key you chose, and not with the default', () => {
    // ctrl+t, as a terminal without the Kitty protocol sends it.
    expect(appKey('\x14', { kitty: false, listening: false, talk: 'ctrl+t' })).toBe('talk-down')
    expect(appKey('\x00', { kitty: false, listening: false, talk: 'ctrl+t' })).toBeNull()
  })

  it('toggles when asked to, even where holding would work', () => {
    const release = '\x1b[32;5:3u'
    expect(appKey(release, { kitty: true, listening: true, toggle: true })).toBeNull()
  })
})
