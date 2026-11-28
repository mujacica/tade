import { describe, expect, it } from 'vitest'
import { THERE_VERBS, thereCtx } from '../src/assets/there.js'

// A press on another machine's agent, from the overview (§10 T5 of the Duo
// plan): carried through this door's outbox (`pressed-there.ts`) as the press
// that machine takes, and refused here, in words, for anything that outbox
// does not take — so a card never asks this door to do another machine's work.

/** A door that writes down what it was asked and answers as `answer` says. */
function door(answer: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const asked: { method: string; path: string; body: Record<string, unknown> }[] = []
  const ctx = {
    ask: async (method: string, path: string, body: Record<string, unknown>) => {
      asked.push({ method, path, body })
      return answer(body)
    },
  }
  return { ctx, asked }
}

describe('a press on another machine’s agent', () => {
  it('takes setting work aside alone: the one of the overview’s presses that outbox carries', () => {
    expect(THERE_VERBS).toEqual(['park'])
  })

  it('is carried through this door as the press that machine takes, with its key and task', async () => {
    const { ctx, asked } = door(() => ({ status: 200, body: { ok: true, said: 'set aside' } }))
    const there = thereCtx(ctx, 'mac')
    expect(there.machine).toBe('mac')
    const got = await there.ask('POST', '/api/act/park', {
      key: 'k1',
      task: 'tade/window',
      parked: true,
      was: 'r1',
      rev: 3,
    })
    expect(got).toEqual({ status: 200, body: { ok: true, said: 'set aside' } })
    expect(asked).toEqual([
      {
        method: 'POST',
        path: '/api/there/press',
        body: { machine: 'mac', key: 'k1', verb: 'park', task: 'tade/window', parked: true },
      },
    ])
  })

  it('asks this door nothing for what that machine’s outbox does not take, and says so', async () => {
    const { ctx, asked } = door(() => ({ status: 200, body: { ok: true } }))
    const there = thereCtx(ctx, 'mac')
    for (const verb of ['answer', 'done', 'steer', 'stop']) {
      const got = await there.ask('POST', `/api/act/${verb}`, { key: 'k', task: 'tade/window' })
      expect(got.status, verb).toBe(409)
      expect(got.body.said, verb).toBe('mac takes that only at its own screen: ask Tade')
    }
    expect(asked).toEqual([])
  })

  it('answers what that machine would not do in its own words, and a refusal of this door as it came', async () => {
    const would = door(() => ({
      status: 200,
      body: { ok: false, said: 'it is not running there' },
    }))
    const no = await thereCtx(would.ctx, 'mac').ask('POST', '/api/act/park', {
      key: 'k',
      task: 't',
    })
    expect(no).toEqual({ status: 409, body: { error: 'there', said: 'it is not running there' } })
    const silent = door(() => ({ status: 200, body: { ok: false } }))
    const quiet = await thereCtx(silent.ctx, 'mac').ask('POST', '/api/act/park', { key: 'k' })
    expect(quiet.body.said).toBe('mac did not do it')
    const refused = door(() => ({ status: 403, body: { error: 'unproven' } }))
    const here = await thereCtx(refused.ctx, 'mac').ask('POST', '/api/act/park', { key: 'k' })
    expect(here).toEqual({ status: 403, body: { error: 'unproven' } })
  })
})
