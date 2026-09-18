import { describe, expect, it } from 'vitest'
import { initialRouter, PREFIX, pending, type RouterState, route } from '../src/router.ts'

// Typing at an agent must feel like typing at the agent. The only thing that
// may be delayed is a handful of characters at the start of a line, and only
// while they might still be addressed to Tade.

/** Type a string one character at a time, as a terminal delivers it. */
function type(text: string, from: RouterState = initialRouter()) {
  let state = from
  let toLane = ''
  const said: string[] = []
  for (const char of text) {
    const routed = route(state, char)
    state = routed.state
    toLane += routed.toLane
    if (routed.toTade !== null) said.push(routed.toTade)
  }
  return { state, toLane, said }
}

describe('typing at an agent', () => {
  it('passes ordinary typing straight through', () => {
    const { toLane, said } = type('npm test\r')
    expect(toLane).toBe('npm test\r')
    expect(said).toEqual([])
  })

  it('holds nothing back once a line is under way', () => {
    // "tade" typed in the middle of a sentence is just a word.
    const { toLane, said } = type('echo tade park this\r')
    expect(toLane).toBe('echo tade park this\r')
    expect(said).toEqual([])
  })

  it('flushes in order the moment it is not the prefix', () => {
    const { toLane } = type('tadpole guess\r')
    // Nothing is lost or reordered by having been held.
    expect(toLane).toBe('tadpole guess\r')
  })

  it('gives every keystroke back even if the line never finishes', () => {
    const { toLane } = type('tad')
    expect(toLane).toBe('')
    // They are held, not dropped, and the window shows them.
    expect(pending(type('tad').state)).toBe('tad')
  })
})

describe('speaking to Tade', () => {
  it('takes a line addressed to it, and the agent sees none of it', () => {
    const { toLane, said } = type('tade park this\r')
    expect(said).toEqual(['park this'])
    expect(toLane).toBe('')
  })

  it('does not care how you capitalise it', () => {
    expect(type('TADE park this\r').said).toEqual(['park this'])
  })

  it('works when a whole line arrives at once, as a paste does', () => {
    const routed = route(initialRouter(), 'tade park this\r')
    expect(routed.toTade).toBe('park this')
    expect(routed.toLane).toBe('')
  })

  it('only counts at the start of a line', () => {
    const { toLane, said } = type('ls\rtade park this\r')
    // The first line is the agent's; the second is Tade's.
    expect(toLane).toBe('ls\r')
    expect(said).toEqual(['park this'])
  })

  it('leaves the agent ready for the next line', () => {
    const { toLane, said } = type('tade park this\rnpm test\r')
    expect(said).toEqual(['park this'])
    expect(toLane).toBe('npm test\r')
  })

  it('takes more than one in a row', () => {
    expect(type('tade park this\rtade resume it\r').said).toEqual(['park this', 'resume it'])
  })

  it('ignores an empty line addressed to it', () => {
    expect(type('tade \r').said).toEqual([''])
  })
})

describe('changing your mind', () => {
  it('rubs out a held character', () => {
    const { state } = type('tad\x7f')
    expect(pending(state)).toBe('ta')
  })

  it('rubs out back past the prefix, and it is a candidate again', () => {
    // "tade p" then erased back to "tade" is not yet addressed to anything.
    const { state } = type('tade p\x7f\x7f')
    expect(state.capturing).toBe(false)
    expect(pending(state)).toBe('tade')
  })

  it('retypes back into a command', () => {
    expect(type('tade p\x7f\x7f park this\r').said).toEqual(['park this'])
  })

  it('hands an escape sequence to the agent rather than holding it', () => {
    // An arrow key at the prompt has to reach the agent.
    expect(type('\x1b[A').toLane).toBe('\x1b[A')
  })
})

describe('pending', () => {
  it('is nothing until something is held', () => {
    expect(pending(initialRouter())).toBeNull()
    expect(pending(type('npm').state)).toBeNull()
  })

  it('is the whole line once it is addressed to Tade', () => {
    expect(pending(type('tade park').state)).toBe('tade park')
  })
})

describe('PREFIX', () => {
  it('ends in a space, so "tadex" is not addressed to Tade', () => {
    expect(PREFIX).toBe('tade ')
    expect(type('tadex\r').toLane).toBe('tadex\r')
  })
})
