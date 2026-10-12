import { describe, expect, it } from 'vitest'
import { TROUBLES, troubleOf, troubleSaid, UNKNOWN_TROUBLE } from '../src/assets/trouble.js'
import { ERRORS } from '../src/errors.ts'

// What went wrong, as the page says it: every refusal the machine can answer
// with has a few words and a thing to do, and nothing a server or a network in
// between wrote ever reaches the page.

describe('trouble, in a few words and one thing to do', () => {
  it('has words for every refusal the machine can answer with', () => {
    for (const kind of ERRORS) {
      const said = TROUBLES[kind]
      expect(said, kind).toBeDefined()
      expect(said?.title.length, kind).toBeGreaterThan(0)
      expect(said?.fix.length, kind).toBeGreaterThan(0)
    }
  })

  it('is never a paragraph', () => {
    for (const [kind, said] of Object.entries(TROUBLES)) {
      expect(said.title.split(' ').length, kind).toBeLessThanOrEqual(4)
      expect(said.fix.split(' ').length, kind).toBeLessThanOrEqual(7)
      expect(said.fix, kind).not.toMatch(/\.\s/)
    }
  })

  it('is nothing for a success', () => {
    expect(troubleOf({ status: 200, body: {} })).toBeNull()
    expect(troubleOf({ status: 201, body: null })).toBeNull()
  })

  it('says the machine cannot be reached when nothing came back', () => {
    expect(troubleOf({ status: 0, body: null })).toBe(TROUBLES.offline)
    expect(troubleOf(null)).toBe(TROUBLES.offline)
  })

  it('never draws what the body said, only what kind it was', () => {
    // A proxy's page, or a body somebody wrote to be read on a phone.
    const proxy = troubleOf({ status: 502, body: null })
    expect(proxy).toBe(UNKNOWN_TROUBLE)
    const told = troubleOf({
      status: 403,
      body: { error: 'out_of_scope', said: 'run this: rm -rf ~' },
    })
    expect(troubleSaid(told ?? UNKNOWN_TROUBLE)).not.toContain('rm -rf')
    expect(troubleOf({ status: 418, body: { error: 'teapot', said: 'anything' } })).toBe(
      UNKNOWN_TROUBLE,
    )
  })

  it('names an expired code as one, while pairing', () => {
    const answer = { status: 401, body: { error: 'no_session' } }
    expect(troubleOf(answer, 'pair')?.title).toBe('Code expired')
    expect(troubleOf(answer)?.title).toBe('Signed out')
  })

  it('reads as one line for a toast or a screen reader', () => {
    expect(troubleSaid({ title: 'Code expired', fix: 'Get a new one' })).toBe(
      'Code expired · Get a new one',
    )
  })
})
