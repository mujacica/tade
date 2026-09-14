import { describe, expect, it } from 'vitest'
import { exitReason } from '../src/adapter.ts'
import { type AvailableModel, chooseModel, findModel } from '../src/models.ts'

// Which model a configured name means. A bare name the harness would find in
// four catalogs made it exit before reading a word, and no name at all took
// whatever an agent had used last.

const usable: AvailableModel[] = [
  { id: 'openrouter/moonshotai/kimi-k2.6', provider: 'openrouter', name: 'Kimi K2.6' },
  { id: 'openrouter/anthropic/claude-opus-5', provider: 'openrouter', name: 'Claude Opus 5' },
]

describe('choosing a model', () => {
  it('finds a bare name under the vendor a provider offers it as', () => {
    expect(chooseModel({ model: 'claude-opus-5' }, usable)).toEqual({
      ok: true,
      provider: 'openrouter',
      id: 'anthropic/claude-opus-5',
    })
  })

  it('takes provider/id as written, and a provider given separately as given', () => {
    expect(chooseModel({ model: 'openrouter/moonshotai/kimi-k2.6' }, usable)).toEqual({
      ok: true,
      provider: 'openrouter',
      id: 'moonshotai/kimi-k2.6',
    })
    expect(chooseModel({ provider: 'anthropic', model: 'claude-opus-5' }, usable)).toEqual({
      ok: true,
      provider: 'anthropic',
      id: 'claude-opus-5',
    })
  })

  it('says what you are signed in to when nothing there offers it', () => {
    const chosen = chooseModel({ model: 'gpt-9' }, usable)
    expect(chosen?.ok).toBe(false)
    expect(chosen && !chosen.ok ? chosen.reason : '').toContain('openrouter')
  })

  it('leaves the choice to the caller when nothing was asked for', () => {
    expect(chooseModel({}, usable)).toBeNull()
  })

  it('passes a provider/id on untouched when there is no catalog to check', () => {
    expect(chooseModel({ model: 'anthropic/claude-opus-5' }, [])).toEqual({
      ok: true,
      provider: 'anthropic',
      id: 'claude-opus-5',
    })
    expect(chooseModel({ model: 'claude-opus-5' }, [])?.ok).toBe(false)
  })
})

describe('why pi went away', () => {
  it("is pi's own error line, without its colour or prefix", () => {
    const stderr = '\x1b[31mError: Model "claude-opus-5" is ambiguous across providers\x1b[39m\n'
    expect(exitReason(1, stderr)).toBe('Model "claude-opus-5" is ambiguous across providers')
  })

  it('falls back to the exit code when it said nothing', () => {
    expect(exitReason(3, '')).toBe('pi exited with code 3')
    expect(exitReason(null, '')).toBe('pi was stopped')
  })
})

describe('the model someone meant', () => {
  const catalog: AvailableModel[] = [
    {
      id: 'openrouter/anthropic/claude-opus-5',
      provider: 'openrouter',
      name: 'Anthropic: Claude Opus 5',
    },
    {
      id: 'openrouter/anthropic/claude-opus-5:batch',
      provider: 'openrouter',
      name: 'Claude Opus 5 (batch)',
    },
    { id: 'openrouter/anthropic/claude-opus-4.5', provider: 'openrouter', name: 'Claude Opus 4.5' },
    { id: 'openrouter/moonshotai/kimi-k2.6', provider: 'openrouter', name: 'Kimi K2.6' },
    { id: 'openrouter/moonshotai/kimi-k3', provider: 'openrouter', name: 'Kimi K3' },
  ]

  it('is found from how it is said, the plainest of equals first', () => {
    expect(findModel('opus 5', catalog)).toEqual({
      ok: true,
      provider: 'openrouter',
      id: 'anthropic/claude-opus-5',
    })
    expect(findModel('Kimi K2.6', catalog)).toMatchObject({ ok: true, id: 'moonshotai/kimi-k2.6' })
  })

  it('means the newest of a line when no version is said', () => {
    const opuses: AvailableModel[] = [
      { id: 'openrouter/anthropic/claude-opus-4', provider: 'openrouter', name: 'Claude Opus 4' },
      { id: 'openrouter/anthropic/claude-opus-5', provider: 'openrouter', name: 'Claude Opus 5' },
      { id: 'openrouter/anthropic/claude-opus-4.1', provider: 'openrouter', name: 'Opus 4.1' },
      { id: 'openrouter/anthropic/claude-opus-4.6', provider: 'openrouter', name: 'Opus 4.6' },
      // A release date is not a version: this is Opus 4, whatever the number says.
      { id: 'anthropic/claude-opus-4-20250514', provider: 'anthropic', name: 'Claude Opus 4' },
      // An alias for the newest is not a version either.
      {
        id: 'openrouter/~anthropic/claude-opus-latest',
        provider: 'openrouter',
        name: 'Opus Latest',
      },
    ]
    // "Use opus for it" is Opus 5, as anyone saying it means.
    expect(findModel('opus', opuses)).toEqual({
      ok: true,
      provider: 'openrouter',
      id: 'anthropic/claude-opus-5',
    })
    // Opus 4, released on 2025-05-14, is older than 4.6, however large its date.
    expect(findModel('Opus', opuses.slice(2))).toMatchObject({
      ok: true,
      id: 'anthropic/claude-opus-4.6',
    })
    // A version said is the one meant, or a question: never the newest instead.
    expect(findModel('opus 4.6', opuses)).toMatchObject({
      ok: true,
      id: 'anthropic/claude-opus-4.6',
    })
    const four = findModel('opus 4', opuses)
    expect(four.ok ? four.id : four.reason).not.toMatch(/4\.[16]|opus-5/)
    // Asked for by name, the alias is what was meant.
    expect(findModel('opus latest', opuses)).toMatchObject({
      ok: true,
      id: '~anthropic/claude-opus-latest',
    })
  })

  it('knows a line by its words, however it was spelled over the years', () => {
    const haikus: AvailableModel[] = [
      { id: 'openrouter/anthropic/claude-3-haiku', provider: 'openrouter', name: 'Claude 3 Haiku' },
      { id: 'openrouter/anthropic/claude-haiku-4.5', provider: 'openrouter', name: 'Haiku 4.5' },
      {
        id: 'openrouter/anthropic/claude-haiku-4.5:batch',
        provider: 'openrouter',
        name: 'Haiku 4.5 (batch)',
      },
    ]
    expect(findModel('haiku', haikus)).toMatchObject({ ok: true, id: 'anthropic/claude-haiku-4.5' })
  })

  it('asks which when two different models fit', () => {
    const found = findModel('kimi', catalog)
    expect(found.ok).toBe(false)
    expect(found.ok ? '' : found.reason).toMatch(
      /could be kimi-k3, kimi-k2.6|could be kimi-k2.6, kimi-k3/,
    )
    expect(findModel('gemini', catalog).ok).toBe(false)
  })
})
