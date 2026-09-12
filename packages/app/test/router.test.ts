import { describe, expect, it } from 'vitest'
import { initialRouter, PREFIX, pending, type RouterState, route } from '../src/router.ts'

// Typing at an agent must feel like typing at the agent. The only thing that
// may be delayed is a handful of characters at the start of a line, and only
// while they might still be addressed to Wilco.

/** Type a string one character at a time, as a terminal delivers it. */
function type(text: string, from: RouterState = initialRouter()) {
  let state = from
  let toLane = ''
  const said: string[] = []
  for (const char of text) {
    const routed = route(state, char)
    state = routed.state
    toLane += routed.toLane
    if (routed.toWilco !== null) said.push(routed.toWilco)
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
    // "wilco" typed in the middle of a sentence is just a word.
    const { toLane, said } = type('echo wilco park this\r')
    expect(toLane).toBe('echo wilco park this\r')
    expect(said).toEqual([])
  })

  it('flushes in order the moment it is not the prefix', () => {
    const { toLane } = type('wild guess\r')
    // Nothing is lost or reordered by having been held.
    expect(toLane).toBe('wild guess\r')
  })

  it('gives every keystroke back even if the line never finishes', () => {
    const { toLane } = type('wil')
    expect(toLane).toBe('')
    // They are held, not dropped, and the window shows them.
    expect(pending(type('wil').state)).toBe('wil')
  })
})

describe('speaking to Wilco', () => {
  it('takes a line addressed to it, and the agent sees none of it', () => {
    const { toLane, said } = type('wilco park this\r')
    expect(said).toEqual(['park this'])
    expect(toLane).toBe('')
  })

  it('does not care how you capitalise it', () => {
    expect(type('WILCO park this\r').said).toEqual(['park this'])
  })

  it('works when a whole line arrives at once, as a paste does', () => {
    const routed = route(initialRouter(), 'wilco park this\r')
    expect(routed.toWilco).toBe('park this')
    expect(routed.toLane).toBe('')
  })

  it('only counts at the start of a line', () => {
    const { toLane, said } = type('ls\rwilco park this\r')
    // The first line is the agent's; the second is Wilco's.
    expect(toLane).toBe('ls\r')
    expect(said).toEqual(['park this'])
  })

  it('leaves the agent ready for the next line', () => {
    const { toLane, said } = type('wilco park this\rnpm test\r')
    expect(said).toEqual(['park this'])
    expect(toLane).toBe('npm test\r')
  })

  it('takes more than one in a row', () => {
    expect(type('wilco park this\rwilco resume it\r').said).toEqual(['park this', 'resume it'])
  })

  it('ignores an empty line addressed to it', () => {
    expect(type('wilco \r').said).toEqual([''])
  })
})

describe('changing your mind', () => {
  it('rubs out a held character', () => {
    const { state } = type('wil\x7f')
    expect(pending(state)).toBe('wi')
  })

  it('rubs out back past the prefix, and it is a candidate again', () => {
    // "wilco p" then erased back to "wilco" is not yet addressed to anything.
    const { state } = type('wilco p\x7f\x7f')
    expect(state.capturing).toBe(false)
    expect(pending(state)).toBe('wilco')
  })

  it('retypes back into a command', () => {
    expect(type('wilco p\x7f\x7f park this\r').said).toEqual(['park this'])
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

  it('is the whole line once it is addressed to Wilco', () => {
    expect(pending(type('wilco park').state)).toBe('wilco park')
  })
})

describe('PREFIX', () => {
  it('ends in a space, so "wilcox" is not addressed to Wilco', () => {
    expect(PREFIX).toBe('wilco ')
    expect(type('wilcox\r').toLane).toBe('wilcox\r')
  })
})
