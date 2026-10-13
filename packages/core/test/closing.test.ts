import { describe, expect, it } from 'vitest'
import { closeBy } from '../src/closing.ts'

// Closing on the way out by one moment: what never answers is named and given
// up on, never waited for, and never what decides how long quitting takes.

const never = () => new Promise<void>(() => {})

describe('closeBy', () => {
  it('gives up on a close that never answers at the moment, and names it', async () => {
    const began = Date.now()
    const late = await closeBy(
      [
        { name: 'the listener', close: never },
        { name: 'the journal', close: async () => {} },
        { name: 'the reporter', close: never },
      ],
      began + 50,
    )
    expect(late).toEqual(['the listener', 'the reporter'])
    // A bound, not a measurement: a hang would be the test's own timeout.
    expect(Date.now() - began).toBeLessThan(2_000)
  })

  it('does not wait for the moment when everything has closed', async () => {
    const began = Date.now()
    expect(await closeBy([{ name: 'quick', close: async () => {} }], began + 60_000)).toEqual([])
    expect(Date.now() - began).toBeLessThan(2_000)
  })

  it('counts a close that threw, or threw before it began, as closed rather than late', async () => {
    const late = await closeBy(
      [
        {
          name: 'rejects',
          close: async () => {
            throw new Error('gone already')
          },
        },
        {
          name: 'throws',
          close: () => {
            throw new Error('not even a promise')
          },
        },
        { name: 'says nothing', close: () => undefined },
      ],
      Date.now() + 50,
    )
    expect(late).toEqual([])
  })

  it('closes them side by side, so one slow close is not every close late', async () => {
    const order: string[] = []
    const late = await closeBy(
      [
        { name: 'slow', close: never },
        {
          name: 'second',
          close: async () => {
            order.push('second')
          },
        },
      ],
      Date.now() + 50,
    )
    expect(order).toEqual(['second'])
    expect(late).toEqual(['slow'])
  })

  it('has already given up on a moment that has passed', async () => {
    expect(await closeBy([{ name: 'hung', close: never }], Date.now() - 1)).toEqual(['hung'])
  })
})
