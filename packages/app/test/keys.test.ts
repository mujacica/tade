import { describe, expect, it } from 'vitest'
import { appKey } from '../src/keys.ts'

// The shell claims as little as possible. Anything it names here is a key the
// focused agent will never see, so each one has to earn its place.

const held = { kitty: true, listening: false }
const toggled = { kitty: false, listening: false }

/** ctrl+space, as a terminal actually sends it. */
const TALK_PRESS = '\x1b[32;5u'
const TALK_RELEASE = '\x1b[32;5:3u'

describe('talk', () => {
  it('is held down where the terminal reports releases', () => {
    expect(appKey(TALK_PRESS, held)).toBe('talk-down')
    expect(appKey(TALK_RELEASE, { ...held, listening: true })).toBe('talk-up')
  })

  it('toggles where it cannot, so it still works everywhere', () => {
    expect(appKey(TALK_PRESS, toggled)).toBe('talk-down')
    expect(appKey(TALK_PRESS, { ...toggled, listening: true })).toBe('talk-up')
  })

  it('is not a character an agent could have wanted', () => {
    // A literal space has to reach the agent, or you cannot type.
    expect(appKey(' ', held)).toBeNull()
  })
})

describe('keys the shell claims', () => {
  it('takes the few it needs', () => {
    expect(appKey('\t', held)).toBe('tab')
    expect(appKey('\x1b[Z', held)).toBe('shift+tab')
    expect(appKey('\x03', held)).toBe('ctrl+c')
    // Search: ctrl+k, and Cmd+K where the terminal reports Cmd (kitty protocol).
    expect(appKey('\x0b', held)).toBe('search')
    expect(appKey('\x1b[107;9u', held)).toBe('search')
    expect(appKey('a', held)).toBe('a')
    expect(appKey('d', held)).toBe('d')
  })

  it('leaves ordinary typing alone', () => {
    // `?` included: it is a character, and a question to an agent ends in one.
    // ctrl+g too, now that search has a key of its own: pi opens your editor with it.
    for (const data of ['x', 'hello', '?', '\r', '\x1b[A', '\x1b', '\x07']) {
      expect(appKey(data, held)).toBeNull()
    }
  })

  it('ignores the release half of every other key', () => {
    // Kitty reports both halves; acting twice on one keystroke would be a bug.
    expect(appKey('\x1b[97;1:3u', held)).toBeNull()
  })
})
