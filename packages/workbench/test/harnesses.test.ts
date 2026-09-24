import { HARNESS_FACTS } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { HARNESS_ADAPTERS, type HarnessOptions } from '../src/harnesses.ts'

// A reader of the journal has a harness id and nothing else — the run is over,
// and the adapter that ran it may not even be installed here any more — so
// what is true of a harness's runs is a table in core (`HARNESS_FACTS`). This
// is what stops that table from drifting away from the adapters it describes:
// the provider a harness reaches and what its money is worth are declared
// once, by the adapter, and asserted to be the same fact here.

/** Enough to construct an adapter: none of these reads or writes anything. */
const NOTHING: HarnessOptions = { runDir: '', socketDir: '', approvals: 'bypass' }

describe('what a reader may believe about a harness', () => {
  for (const [id, make] of Object.entries(HARNESS_ADAPTERS)) {
    it(`${id} is in the table, and the table says what the adapter says`, () => {
      const adapter = make(NOTHING)
      const facts = HARNESS_FACTS[id]
      expect(facts, `${id} runs agents and no reader of the journal knows what it is`).toBeDefined()
      expect(facts?.provider).toBe(adapter.provider)
      expect(facts?.usd).toBe(adapter.capabilities.spend.usd)
    })
  }

  it('describes no harness Tade does not run', () => {
    expect(Object.keys(HARNESS_FACTS).sort()).toEqual(Object.keys(HARNESS_ADAPTERS).sort())
  })
})
