import { isText } from '@tade/core'
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

const setup: Setup = { kept: [], pressed: [], here: [], files: [] }

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
    expect(answer.machine).toBe('vps')
    expect(answer.unsaid).toBe('nothing said')
    expect(JSON.stringify(answer)).not.toContain('pwned')
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
    expect(said).toBe('vps would not take it (400): no')
  })
})
