import { describe, expect, it } from 'vitest'
import { chosenAfter, TURNED_OFF, withChoices } from '../src/choice.ts'
import type { Check } from '../src/port.ts'

// Which of a project's checks Tade runs on this machine: the reading's answer,
// with a person's over it.
//
// The reading says what a repository says and which of it cannot run here,
// which is a fact about the machine. The two acts it cannot make are a
// person's, and both of them are here.

const check = (over: Partial<Check> = {}): Check => ({
  id: 'tests',
  title: 'Tests',
  run: 'pnpm test',
  alone: true,
  minutes: 10,
  required: true,
  ...over,
})

describe('what somebody said about running a check here', () => {
  it('leaves a check nobody answered about exactly as it was read', () => {
    const read = [check(), check({ id: 'format', run: 'biome ci .' })]
    expect(withChoices(read, {})).toEqual(read)
    expect(withChoices(read, { nothing: false })).toEqual(read)
  })

  it('gives one turned off a skip like any other, so nothing downstream learns a second word', () => {
    const [off] = withChoices([check()], { tests: false })
    expect(off?.skip).toBe(TURNED_OFF)
  })

  it('takes a check turned off out of what merging waits on', () => {
    // A required check nothing ever runs would leave every commit `unknown`
    // for good, which is worse than what it found.
    const [off] = withChoices([check({ required: true })], { tests: false })
    expect(off?.required).toBe(false)
  })

  it('lifts the reading’s skip from one turned on, and nothing else', () => {
    const read = [check({ id: 'integration', skip: 'its job needs a database', required: false })]
    const [on] = withChoices(read, { integration: true })
    expect(on?.skip).toBeUndefined()
    // CI is willing to be red on some of these for reasons of its own, and
    // that half of `required: false` is not what anybody just answered.
    expect(on?.required).toBe(false)
  })

  it('does not turn one off twice, or on when it already runs', () => {
    const cannot = [check({ skip: 'its job needs a database' })]
    expect(withChoices(cannot, { tests: false })).toEqual(cannot)
    const runs = [check()]
    expect(withChoices(runs, { tests: true })).toEqual(runs)
  })
})

describe('what the config holds after the control is pressed', () => {
  it('says the opposite of the reading where nothing was written down', () => {
    expect(chosenAfter({}, 'tests', true)).toBe(false)
    expect(chosenAfter({}, 'integration', false)).toBe(true)
  })

  it('takes the key away rather than writing an answer that agrees with the reading', () => {
    // Pressed twice, the file is exactly as it was found.
    expect(chosenAfter({ tests: false }, 'tests', false)).toBeUndefined()
    expect(chosenAfter({ integration: true }, 'integration', true)).toBeUndefined()
  })
})
