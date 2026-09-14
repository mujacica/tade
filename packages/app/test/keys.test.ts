import { describe, expect, it } from 'vitest'
import { appKey, normalKey } from '../src/keys.ts'

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

describe('the window’s own keys', () => {
  it('are ctrl keys: a new terminal, a new agent, a project, mute', () => {
    expect(appKey('\x14', held)).toBe('new-terminal')
    expect(appKey('\x0e', held)).toBe('new-agent')
    expect(appKey('\x0f', held)).toBe('open-project')
    // ctrl+m is enter's own byte without the Kitty protocol: only with it is it mute.
    expect(appKey('\x1b[109;5u', held)).toBe('mute')
    expect(appKey('\r', held)).toBeNull()
  })

  it('go to an agent with ctrl and its number, and to a project with ctrl+shift', () => {
    expect(appKey('\x1b[49;5u', held)).toBe('agent-1')
    expect(appKey('\x1b[57;5u', held)).toBe('agent-9')
    expect(appKey('\x1b[50;6u', held)).toBe('project-2')
    expect(appKey('\x1b[50:64;6u', held)).toBe('project-2')
    // Held with something else, or turned off, a number is the agent's.
    expect(appKey('\x1b[49;5u', { ...held, bindings: { agent_by_number: 'off' } })).toBeNull()
    expect(appKey('\x1b[49;3u', held)).toBeNull()
  })

  it('are the ones set, however their modifiers are written', () => {
    expect(normalKey('Shift+Ctrl+E')).toBe('ctrl+shift+e')
    expect(normalKey('ctrl++')).toBe('ctrl++')
    expect(appKey('\x07', { ...held, bindings: { orchestrator: 'ctrl+g' } })).toBe('orchestrator')
    expect(appKey('\x1b[101;6u', held)).toBe('extensions')
    expect(appKey('\x1b[114;6u', held)).toBe('reload')
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
