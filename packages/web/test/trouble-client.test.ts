import { describe, expect, it } from 'vitest'
import {
  AWAY_PLACE,
  TOO_OLD,
  TROUBLES,
  theirsTrouble,
  troubleOf,
  troubleSaid,
  UNKNOWN_TROUBLE,
} from '../src/assets/trouble.js'
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

  it('says every cause in one sentence and the fix as a few steps', () => {
    for (const [kind, said] of Object.entries({ ...TROUBLES, TOO_OLD, UNKNOWN_TROUBLE })) {
      expect(said.why, kind).toMatch(/^[^.]+\.$/)
      expect(said.why.split(' ').length, kind).toBeLessThanOrEqual(14)
      expect(said.steps.length, kind).toBeGreaterThan(0)
      expect(said.steps.length, kind).toBeLessThanOrEqual(4)
      for (const step of said.steps) expect(step.split(' ').length, kind).toBeLessThanOrEqual(12)
    }
  })

  it('names no box to tick, because every paired device is the person’s own', () => {
    // A name it does not know is dropped: only `https` is drawn out of a body.
    const odd = troubleOf({ status: 403, body: { error: 'out_of_scope', needs: ['rm -rf ~'] } })
    expect(odd).toBe(TROUBLES.out_of_scope)
    const said = troubleOf({ status: 403, body: { error: 'out_of_scope', needs: ['steer'] } })
    expect(said).toBe(TROUBLES.out_of_scope)
    for (const words of Object.values(TROUBLES)) {
      expect(JSON.stringify(words)).not.toMatch(/tick|granted|full access/i)
    }
  })

  it('tells a connection that is not https from a setting turned off', () => {
    const https = troubleOf({ status: 403, body: { error: 'locked', needs: ['https'] } })
    expect(https?.title).toBe('Needs https')
    expect(troubleOf({ status: 403, body: { error: 'locked' } })).toBe(TROUBLES.locked)
  })

  it('says pairing again is at Settings › Away view, and names the passkey', () => {
    expect(troubleOf({ status: 401, body: { error: 'no_session' } })?.steps.join(' ')).toContain(
      AWAY_PLACE,
    )
    expect(
      troubleOf({ status: 401, body: { error: 'no_session' } }, 'pair')?.steps.join(' '),
    ).toContain('tade web pair')
    expect(troubleOf({ status: 403, body: { error: 'unproven' } })?.title).toBe('Passkey needed')
  })

  it('reads a page the Tade answering is too old for as too old', () => {
    const missing = { status: 404, body: { error: 'no_such' } }
    expect(theirsTrouble(missing)).toBe(TOO_OLD)
    expect(theirsTrouble({ status: 404, body: { error: 'not_offered' } })).toBe(TOO_OLD)
    // Anything else is the ordinary words.
    expect(theirsTrouble({ status: 0, body: null })).toBe(TROUBLES.offline)
  })

  it('reads as one line for a toast or a screen reader', () => {
    expect(troubleSaid({ title: 'Code expired', fix: 'Get a new one' })).toBe(
      'Code expired · Get a new one',
    )
  })
})
