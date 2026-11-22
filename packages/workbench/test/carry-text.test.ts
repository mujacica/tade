import { CARRY_SCHEMA, isText } from '@tade/core'
import type { Answer, RemoteLink } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { CarryRefused, carryTo, type Setup } from '../src/carry.ts'

// What another machine answers a carry with is drawn on Settings › Remotes and
// printed by `tade remote carry`, so none of it may reach a terminal as it
// came: every string in it is reduced to text where it arrives (`carryTo`).

const ESCAPES = '\x1b]0;pwned\x07\x1b[2J\u009b6n\x1b]8;;https://evil.example\x1b\\'

const remote = {
  name: 'vps',
  address: 'vps',
  tade: 'tade',
  session: { device: 'd', cookie: 'd.s', csrf: 'c', host: 'localhost:7654' },
}

const setup: Setup = {
  kept: [],
  registers: new Map(),
  changes: [],
  pinned: [],
  pressed: [],
  here: [],
  files: [],
  secrets: new Set(),
}

/** A link that answers every call with the one answer, and does nothing else. */
const answering = (answer: Answer) => ({ call: async () => answer }) as unknown as RemoteLink

/** Every code point anywhere in a JSON value that is not text. */
function notText(value: unknown): number[] {
  return [...JSON.stringify(value)]
    .map((one) => one.codePointAt(0) ?? 0)
    .filter((point) => !isText(point))
}

describe('a carry answered with escapes', () => {
  it('comes back as text, every field of it', async () => {
    const answer = await carryTo(
      answering({
        status: 200,
        body: {
          schema: CARRY_SCHEMA,
          machine: `vps${ESCAPES}`,
          settings: [{ path: 'agents.keep_awake', outcome: `kept${ESCAPES}`, said: ESCAPES }],
          files: [{ name: `persona${ESCAPES}`, outcome: 'written' }],
          signIns: [{ harness: 'claude-code', said: `signed in${ESCAPES}` }],
          unsaid: `nothing said${ESCAPES}`,
        },
      }),
      remote,
      setup,
      { from: 'mac', keys: false },
    )
    expect(notText(answer)).toEqual([])
    // What was taken out is marked where it was, never dropped in silence.
    expect(answer.machine).toBe('vps␛')
    expect(answer.unsaid).toBe('nothing said␛')
    expect(JSON.stringify(answer)).not.toContain('pwned')
  })

  it('keeps a setting’s value as it came, which goes into the config and onto no screen', async () => {
    const rule = 'Read the change first.\nThen say what you found.'
    const answer = await carryTo(
      answering({
        status: 200,
        body: {
          schema: CARRY_SCHEMA,
          machine: 'vps',
          settings: [
            { path: 'agents.instructions', outcome: 'newer', value: rule, by: `window${ESCAPES}` },
          ],
          files: [],
          signIns: [],
        },
      }),
      remote,
      setup,
      { from: 'mac', keys: false },
    )
    expect(answer.settings[0]?.value).toBe(rule)
    expect(answer.settings[0]?.by).toBe('window␛')
  })

  it('refuses to carry to an older Tade, or a newer one, and says which to update', async () => {
    const older = await carryTo(
      answering({
        status: 400,
        body: { error: 'malformed', said: 'that request did not make sense' },
      }),
      remote,
      setup,
      { from: 'mac', keys: false },
    ).catch((err: unknown) => err)
    expect((older as Error).message).toMatch(/vps's Tade is older than this one.*tade host upgrade/)
    const unstamped = await carryTo(
      answering({ status: 200, body: { machine: 'vps', settings: [], files: [], signIns: [] } }),
      remote,
      setup,
      { from: 'mac', keys: false },
    ).catch((err: unknown) => err)
    expect((unstamped as Error).message).toMatch(/older than this one/)
    const newer = await carryTo(
      answering({ status: 426, body: { error: 'malformed', said: 'older' } }),
      remote,
      setup,
      { from: 'mac', keys: false },
    ).catch((err: unknown) => err)
    expect((newer as Error).message).toMatch(/vps's Tade is newer than this one.*tade update/)
  })

  it('says why it was refused in the remote’s words, as text', async () => {
    const refused = await carryTo(
      answering({ status: 400, body: { said: `no${ESCAPES}` } }),
      remote,
      setup,
      { from: 'mac', keys: false },
    ).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(CarryRefused)
    const said = (refused as Error).message
    expect(said).toBe('vps would not take it (400): no␛')
  })
})
