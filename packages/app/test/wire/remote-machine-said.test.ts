import type { Answer, RemoteLink } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { AGAIN_MS, RemoteMachines } from '../../src/wire/remote-machine.ts'

// What asking another machine what it is says when it cannot be answered
// (`remote-machine.ts`): an older Tade with no such door, an answer of the
// wrong shape, a request that failed while the link stayed up — each said as
// the reason beside what was last held, never as a machine with nothing — and a
// request that failed because the link went down, which is the link's news.

/** A link to `vps` that answers every request the way the test says, live or not. */
function linked(answer: () => Promise<Answer>) {
  const state = { live: true, asked: 0 }
  const link = {
    request: async () => {
      state.asked++
      return answer()
    },
  } as unknown as RemoteLink
  const clock = { at: 1_000_000 }
  const machines = new RemoteMachines({
    home: '/nowhere',
    reach: (name) => (name === 'vps' ? { link, remote: {} as never, live: state.live } : null),
    now: () => clock.at,
    draw: () => {},
  })
  return { machines, state, clock }
}

const WHAT = {
  at: '2026-10-17T12:00:00.000Z',
  version: '0.2.3',
  newer: null,
  public: null,
  problems: [],
  schedules: [],
  documents: [],
}

describe('asking another machine what it is, when the answer is not one', () => {
  it('says an older Tade with no such door is to be updated there', async () => {
    const { machines } = linked(async () => ({ status: 404, body: null }))
    await machines.ask('vps')
    expect(machines.held('vps')).toMatchObject({
      answer: null,
      said: 'vps runs a Tade that does not say what it is yet: update it there',
    })
  })

  it('keeps what it last said, and says why the newest answer was not read', async () => {
    let body: unknown = WHAT
    const { machines } = linked(async () => ({ status: 200, body }))
    await machines.ask('vps')
    expect(machines.held('vps')?.answer?.version).toBe('0.2.3')
    body = { ...WHAT, problems: [{ from: 'telepathy', at: null, said: 'x' }] }
    await machines.ask('vps')
    expect(machines.held('vps')).toMatchObject({
      answer: { version: '0.2.3' },
      said: 'vps said what it is in a shape this Tade does not read',
    })
  })

  it('says a request that failed while the link stayed up, and leaves a link that went down to the link', async () => {
    const { machines } = linked(async () => {
      throw new Error('the request timed out')
    })
    await machines.ask('vps')
    expect(machines.held('vps')?.said).toBe(
      'vps could not be asked what it is: the request timed out',
    )
    const goes = { state: { live: true } }
    const quiet = linked(async () => {
      goes.state.live = false
      throw new Error('the link went down')
    })
    goes.state = quiet.state
    await quiet.machines.ask('vps')
    expect(quiet.machines.held('vps')?.said).toBeNull()
  })

  it('asks a linked one on the beat when due, and not again before `AGAIN_MS` unless its link came up', async () => {
    const { machines, state, clock } = linked(async () => ({ status: 200, body: WHAT }))
    machines.beat(['vps', 'lab'])
    await new Promise((done) => setTimeout(done, 0))
    expect(state.asked).toBe(1)
    clock.at += AGAIN_MS - 1
    machines.beat(['vps'])
    expect(state.asked).toBe(1)
    machines.up('vps')
    machines.beat(['vps'])
    await new Promise((done) => setTimeout(done, 0))
    expect(state.asked).toBe(2)
    state.live = false
    clock.at += AGAIN_MS
    machines.beat(['vps'])
    expect(state.asked).toBe(2)
  })
})
