import { describe, expect, it } from 'vitest'
import { GRANT_MEANS, GRANTS, has, namesOnly, readsOf, sees } from '../src/reach.ts'

describe('a device’s reach', () => {
  it('starts at names and counts, which is what pairing alone buys', () => {
    const one = namesOnly('dev_1')
    expect(one.granted).toEqual([])
    expect(GRANTS.every((grant) => !has(one, grant))).toBe(true)
  })

  it('has a sentence for every grant, in the words it is offered in', () => {
    // A grant with no sentence is a switch somebody is asked to flip with
    // nothing said about what it lets through.
    expect(Object.keys(GRANT_MEANS).sort()).toEqual([...GRANTS].sort())
    expect(Object.values(GRANT_MEANS).every((said) => said.length > 10)).toBe(true)
  })

  it('answers in the order the grants are declared, whatever order they were given in', () => {
    expect(readsOf({ ...namesOnly('d'), granted: ['spend', 'titles', 'notes'] })).toEqual([
      'titles',
      'notes',
      'spend',
    ])
  })

  it('drops a grant nothing implements rather than drawing the word', () => {
    expect(readsOf({ ...namesOnly('d'), granted: ['notes', 'everything' as never] })).toEqual([
      'notes',
    ])
  })

  it('says which projects explicitly, and has no spelling for whatever is there', () => {
    // A scope arrived at by forgetting is the one that is wrong, so `every` is
    // a choice that reads as one.
    const listed = { ...namesOnly('d'), projects: { kind: 'listed' as const, names: ['tade'] } }
    expect(sees(listed, 'tade')).toBe(true)
    expect(sees(listed, 'sentry')).toBe(false)
    expect(sees(namesOnly('d'), 'sentry')).toBe(true)
  })

  it('names a device by its id and never by its label or its address', () => {
    // A label is a person's own words about their own phone and an address is
    // a fact about a network that goes stale in a minute.
    expect(Object.keys(namesOnly('dev_1')).sort()).toEqual(['device', 'granted', 'projects'])
  })
})
