import { describe, expect, it } from 'vitest'
import { modelNamed, startingModel } from '../src/model.ts'

// Which model the orchestrator starts on, and what a name it cannot place
// comes to.
//
// The whole of this is "never a refusal", and a refusal is exactly what cannot
// be tested by starting one: a window that will not open has nothing to assert
// against. So the rule is pure and this is the test of it; `orchestrator.test.ts`
// is where a real one starts.

describe('the model a route names', () => {
  it('is the provider and the id together, or the id alone where there is no provider', () => {
    expect(modelNamed({ name: 'orchestrator', harness: 'pi' })).toBeNull()
    expect(modelNamed({ name: 'orchestrator', harness: 'pi', model: 'claude-opus-5' })).toBe(
      'claude-opus-5',
    )
    expect(
      modelNamed({
        name: 'orchestrator',
        harness: 'pi',
        provider: 'openrouter',
        model: 'anthropic/claude-opus-4.5',
      }),
    ).toBe('openrouter/anthropic/claude-opus-4.5')
  })
})

describe('what the orchestrator starts on', () => {
  it('takes a model that was asked for outright, and resolves nothing', () => {
    const asked = { provider: 'tade-test', id: 'fake' }
    expect(startingModel(asked, 'ignored', null, 'pi')).toEqual({ model: asked, warning: null })
  })

  it('takes the exact provider and id the harness placed, and says nothing', () => {
    const found = { ok: true, provider: 'openrouter', id: 'anthropic/claude-opus-4.5' } as const
    expect(startingModel(undefined, 'opus', found, 'pi')).toEqual({
      model: { provider: 'openrouter', id: 'anthropic/claude-opus-4.5' },
      warning: null,
    })
  })

  it('starts on the harness’s own default when the name cannot be placed, and says so', () => {
    // This is the bug, in one line: the config said `pi` — a harness id, in
    // the model key — and the orchestrator refused to start at all, so the
    // model picker and Settings, which are the only two ways to fix it, were
    // both behind a window that would not open.
    const found = {
      ok: false,
      reason: '"pi" could be claude-opus-5, claude-fable-5: say which',
    } as const
    const starting = startingModel(undefined, 'pi', found, 'pi')
    expect(starting.model).toBeUndefined()
    // Said, not swallowed: the name that was dropped, the harness's own reason,
    // and where to choose another.
    expect(starting.warning).toContain('"pi"')
    expect(starting.warning).toContain('could be claude-opus-5')
    expect(starting.warning).toContain('Settings')
  })

  it('says nothing at all where no model was named: that is the harness deciding', () => {
    // Unset is where the setting sits before anybody chooses, and where
    // changing the harness puts it back. It is not a problem and must not
    // read as one.
    expect(startingModel(undefined, null, null, 'claude-code')).toEqual({
      model: undefined,
      warning: null,
    })
  })
})
