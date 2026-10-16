import { describe, expect, it } from 'vitest'
import { appKey, forLane, normalKey, pasteKey } from '../src/keys.ts'

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

  // Laid out once per set of bindings rather than once a keystroke, so the set
  // a key is looked up in has to be the one it was handed — never the last one
  // somebody asked about, and never a default that a config has moved.
  it('answer from the bindings they are handed, whatever was asked before', () => {
    const moved = { search: 'ctrl+g' }
    expect(appKey('\x0b', held)).toBe('search')
    expect(appKey('\x07', { ...held, bindings: moved })).toBe('search')
    expect(appKey('\x0b', { ...held, bindings: moved })).toBeNull()
    // The defaults again, and a second set that only looks like the first.
    expect(appKey('\x07', held)).toBeNull()
    expect(appKey('\x0b', held)).toBe('search')
    expect(appKey('\x07', { ...held, bindings: { search: 'ctrl+g' } })).toBe('search')
    // Two meanings on one key: the first binding a key has is the one it means.
    expect(appKey('\x14', { ...held, bindings: { new_agent: 'ctrl+t' } })).toBe('new-agent')
  })
})

describe('keys the shell claims', () => {
  it('takes the few it needs', () => {
    expect(appKey('\t', held)).toBe('tab')
    expect(appKey('\x1b[Z', held)).toBe('shift+tab')
    expect(appKey('\x03', held)).toBe('ctrl+c')
    // Named, not claimed: what escape does depends on where you are, and
    // `escapeMeans` is what decides. Naming it is how the window gets the
    // chance to stop its own turn with it.
    expect(appKey('\x1b', held)).toBe('escape')
    // Search: ctrl+k, and Cmd+K where the terminal reports Cmd (kitty protocol).
    expect(appKey('\x0b', held)).toBe('search')
    expect(appKey('\x1b[107;9u', held)).toBe('search')
    expect(appKey('a', held)).toBe('a')
    expect(appKey('d', held)).toBe('d')
  })

  it('leaves ordinary typing alone', () => {
    // `?` included: it is a character, and a question to an agent ends in one.
    // ctrl+g too, now that search has a key of its own: pi opens your editor with it.
    for (const data of ['x', 'hello', '?', '\r', '\x1b[A', '\x07']) {
      expect(appKey(data, held)).toBeNull()
    }
  })

  it('ignores the release half of every other key', () => {
    // Kitty reports both halves; acting twice on one keystroke would be a bug.
    expect(appKey('\x1b[97;1:3u', held)).toBeNull()
  })
})

describe('a key on its way into a lane', () => {
  // What Ghostty 1.3.1 sent, read off it with the flags pi-tui asks for (7):
  // `git ` typed, then ctrl+c, escape, ctrl+b, shift+enter, ctrl+enter, and an
  // `a` held down. A letter comes as itself, a held one as itself again, and
  // every one of them is let go of in kitty's own words.
  const GHOSTTY: readonly (readonly [string, string])[] = [
    ['g', 'g'],
    ['\x1b[103;1:3u', ''],
    ['i', 'i'],
    ['\x1b[105;1:3u', ''],
    ['t', 't'],
    ['\x1b[116;1:3u', ''],
    [' ', ' '],
    ['\x1b[32;1:3u', ''],
    ['\x1b[99;5u', '\x03'],
    ['\x1b[99;5:3u', ''],
    ['\x1b[27u', '\x1b'],
    ['\x1b[27;1:3u', ''],
    ['\x1b[98;5u', '\x02'],
    ['\x1b[98;5:3u', ''],
    ['a', 'a'],
    ['a', 'a'],
    ['\x1b[97;1:3u', ''],
  ]

  it('is what Terminal would have sent, and nothing for letting go', () => {
    for (const [sent, typed] of GHOSTTY) expect(forLane(sent), JSON.stringify(sent)).toBe(typed)
  })

  it('stays as kitty spelt it where legacy has no bytes for it', () => {
    // shift+enter is the newline an agent's editor wants; legacy would make it enter.
    expect(forLane('\x1b[13;2u')).toBe('\x1b[13;2u')
    expect(forLane('\x1b[13;5u')).toBe('\x1b[13;5u')
    // Super has no byte in any legacy terminal.
    expect(forLane('\x1b[99;9u')).toBe('\x1b[99;9u')
    expect(forLane('\x1b[99;9:2u')).toBe('\x1b[99;9u')
  })

  it('is the legacy bytes for alt, shift and ctrl on the keys that have them', () => {
    expect(forLane('\x1b[98;3u')).toBe('\x1bb')
    expect(forLane('\x1b[9;2u')).toBe('\x1b[Z')
    expect(forLane('\x1b[13;3u')).toBe('\x1b\r')
    expect(forLane('\x1b[127;5u')).toBe('\b')
    expect(forLane('\x1b[127;3u')).toBe('\x1b\x7f')
    expect(forLane('\x1b[32;5u')).toBe('\x00')
    expect(forLane('\x1b[99;6u')).toBe('\x03')
    // Shift with the alternate key kitty reports, and caps lock changing nothing.
    expect(forLane('\x1b[97:65;2u')).toBe('A')
    expect(forLane('\x1b[99;69u')).toBe('\x03')
  })

  it('drops an arrow let go of, and takes one held for pressed again', () => {
    expect(forLane('\x1b[1;1:3A')).toBe('')
    expect(forLane('\x1b[1;1:2A')).toBe('\x1b[A')
    expect(forLane('\x1b[1;5:2C')).toBe('\x1b[1;5C')
    expect(forLane('\x1b[3;1:3~')).toBe('')
    expect(forLane('\x1b[3;1:2~')).toBe('\x1b[3~')
    expect(forLane('\x1b[1;1:2P')).toBe('\x1bOP')
  })

  it('leaves alone what was never kitty: legacy keys, a paste, text', () => {
    for (const sent of ['\x1b[A', '\x1b[1;5C', '\x03', '\x1b', '\x1b[200~git\x1b[201~', 'héllo']) {
      expect(forLane(sent), JSON.stringify(sent)).toBe(sent)
    }
  })
})

describe('ctrl+v and Cmd+V, as two terminals send them', () => {
  // Read off Ghostty 1.3.1 and Terminal 2.15 on macOS 27, with the modes the
  // window asks for (alternate screen, the mouse, bracketed paste, kitty's
  // flags 7 and modifyOtherKeys where kitty is not spoken), by a person
  // pressing the keys: synthetic key events are dropped on this machine.
  const GHOSTTY = {
    ctrlV: '\x1b[118;5u',
    ctrlVReleased: '\x1b[118;5:3u',
    // The clipboard holding text: Ghostty pastes it, in two reads.
    cmdV: ['\x1b[200~', 'tade-paste-text\x1b[201~'],
    // Holding only a picture: no paste, the key itself.
    cmdVPicture: '\x1b[118;9u',
    cmdVPictureReleased: '\x1b[118;9:3u',
  }
  const TERMINAL = {
    // Terminal answers neither kitty nor modifyOtherKeys: ctrl+v is the byte.
    ctrlV: '\x16',
    cmdV: '\x1b[200~tade-paste-text\x1b[201~',
    // Two lines, broken by a bare CR where Ghostty pastes `\n`.
    cmdVLines: '\x1b[200~line one\rline two',
    // Holding only a picture, Terminal sends nothing at all.
  }

  it('reads ctrl+v as asking for the clipboard however it is spelt, and its release as nothing', () => {
    expect(pasteKey(GHOSTTY.ctrlV)).toBe('ctrl+v')
    expect(pasteKey(TERMINAL.ctrlV)).toBe('ctrl+v')
    // xterm's modifyOtherKeys, and kitty with caps lock on.
    expect(pasteKey('\x1b[27;5;118~')).toBe('ctrl+v')
    expect(pasteKey('\x1b[118;69u')).toBe('ctrl+v')
    expect(pasteKey(GHOSTTY.ctrlVReleased)).toBeNull()
  })

  it('reads Cmd+V that arrived as a key as asking too, and never a paste or another key', () => {
    expect(pasteKey(GHOSTTY.cmdVPicture)).toBe('cmd+v')
    expect(pasteKey(GHOSTTY.cmdVPictureReleased)).toBeNull()
    for (const other of [
      ...GHOSTTY.cmdV,
      TERMINAL.cmdV,
      TERMINAL.cmdVLines,
      'v',
      '\x1b[118;3u',
      '\x1b[99;5u',
      '\x1b[<35;50;34M',
    ]) {
      expect(pasteKey(other), JSON.stringify(other)).toBeNull()
    }
  })

  it('goes into a lane as the byte Terminal sends, from either terminal', () => {
    expect(forLane(GHOSTTY.ctrlV)).toBe('\x16')
    expect(forLane(GHOSTTY.ctrlVReleased)).toBe('')
    expect(forLane(TERMINAL.ctrlV)).toBe('\x16')
    // A terminal speaking modifyOtherKeys spells every modified key this way.
    expect(forLane('\x1b[27;5;118~')).toBe('\x16')
    expect(forLane('\x1b[27;5;99~')).toBe('\x03')
    expect(forLane('\x1b[27;3;98~')).toBe('\x1bb')
    expect(forLane('\x1b[27;2;65~')).toBe('A')
  })
})
