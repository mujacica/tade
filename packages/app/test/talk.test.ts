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

// Holding a key down needs the terminal to say when it came back up, and most
// of them never do. So there are two modes and one pair of events: whichever
// way you talk, the model sees `talk-down` and then `talk-up`.
describe('holding versus toggling', () => {
  const PRESS = '\x1b[32;5u'
  const RELEASE = '\x1b[32;5:3u'

  it('lets a held key repeat without stopping the recording', () => {
    // A terminal sends the press again and again while a key is held down.
    // Read as a toggle, the second one would stop the recording mid-word.
    const held = { kitty: true, listening: true }
    expect(appKey(PRESS, held)).toBe('talk-down')
    expect(appKey(PRESS, held)).toBe('talk-down')
    expect(appKey(RELEASE, held)).toBe('talk-up')
  })

  it('ignores the release in toggle mode, however loudly the terminal reports it', () => {
    // The whole of what toggle mode is for: letting go must not stop it, or
    // pressing to start would stop the instant you took your finger off.
    const toggled = { kitty: true, toggle: true, listening: false }
    expect(appKey(PRESS, toggled)).toBe('talk-down')
    expect(appKey(RELEASE, { ...toggled, listening: true })).toBeNull()
    expect(appKey(PRESS, { ...toggled, listening: true })).toBe('talk-up')
  })

  it('never sees a release at all where the terminal cannot send one', () => {
    // Nothing here reports releases, so a press is all there is, and what it
    // means comes from whether talk is already open.
    const plain = { kitty: false, listening: false }
    expect(appKey(PRESS, plain)).toBe('talk-down')
    expect(appKey(RELEASE, plain)).toBeNull()
    expect(appKey(RELEASE, { ...plain, listening: true })).toBeNull()
    expect(appKey(PRESS, { ...plain, listening: true })).toBe('talk-up')
  })

  it('holds the key you chose, not only the default one', () => {
    // ctrl+t, pressed and released, on a terminal that reports both.
    const held = { kitty: true, listening: false, talk: 'ctrl+t' }
    expect(appKey('\x1b[116;5u', held)).toBe('talk-down')
    expect(appKey('\x1b[116;5:3u', { ...held, listening: true })).toBe('talk-up')
  })

  it('leaves the releases of every other key to the agent', () => {
    // Releases of anything else are protocol noise: the shell acts on presses.
    expect(appKey('\x1b[97;1:3u', { kitty: true, listening: false })).toBeNull()
    expect(appKey('\x1b[9;1:3u', { kitty: true, listening: false })).toBeNull()
  })
})
