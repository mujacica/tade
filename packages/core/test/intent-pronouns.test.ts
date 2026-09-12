import { describe, expect, it } from 'vitest'
import { isPronoun, parseUtterance, type Vocabulary } from '../src/intent.ts'

// Saying "park it" is the normal way to talk. The grammar recognises the verb
// and hands the question of *which one* to the resolver, rather than guessing
// or throwing the sentence away.

const vocabulary: Vocabulary = {
  tasks: ['checkout/refunds', 'search/pagination'],
  projects: ['checkout', 'search'],
}
const parse = (text: string) => parseUtterance(text, vocabulary)

describe('isPronoun', () => {
  it('knows the words that stand in for a name', () => {
    for (const word of ['it', 'that', 'this', 'that one', 'them', 'the same', '  That  ']) {
      expect(isPronoun(word)).toBe(true)
    }
    for (const word of ['refunds', 'checkout', 'the refund flow', '']) {
      expect(isPronoun(word)).toBe(false)
    }
  })
})

describe('pronouns keep the verb and drop the name', () => {
  it('park it', () => {
    expect(parse('park it')).toEqual({ kind: 'park', task: '' })
    expect(parse('park that')).toEqual({ kind: 'park', task: '' })
  })

  it('pick it back up', () => {
    expect(parse('pick it back up')).toEqual({ kind: 'resume', task: '' })
  })

  it('show me that', () => {
    expect(parse('show me that')).toEqual({ kind: 'focus', task: '' })
  })

  it('tell it something, keeping the message whole', () => {
    expect(parse('tell it to also update the docs')).toEqual({
      kind: 'steer',
      task: '',
      message: 'to also update the docs',
    })
  })

  it('still resolves a real name when you give one', () => {
    expect(parse('park refunds')).toEqual({ kind: 'park', task: 'checkout/refunds' })
  })

  it('still refuses a name it has never heard of', () => {
    expect(parse('park the thing I mentioned yesterday').kind).toBe('free')
  })
})
