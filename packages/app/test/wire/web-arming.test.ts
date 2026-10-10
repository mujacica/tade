import { type Arm, LOCAL } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { armingFor, narrowed, type Paired } from '../../src/wire/web-asking.ts'

// What the `ToolHost` is asked at every call, over the cases the lease cannot
// answer on its own.
//
// **The lease is taken when the words are handed over and held until the turn
// ends**, which is right for attributing a tool call and wrong as the last
// word on what that call may do: one turn is seconds, and seconds is exactly
// long enough for somebody who has just realised they lost a phone to press
// Disconnect. So the arm is re-checked against the device record at every
// call, and it can only ever take away.

const DEVICE = 'a1b2c3d4e5f60718'

const away = (over: Partial<Extract<Arm, { how: 'remote' }>> = {}): Arm => ({
  how: 'remote',
  device: DEVICE,
  projects: null,
  may: ['answer', 'steer'],
  ...over,
})

describe('the arm, re-checked against the record', () => {
  it('leaves a local turn alone, because there is nothing to narrow', () => {
    expect(narrowed(LOCAL, () => null)).toBe(LOCAL)
  })

  it('takes every grant off a device that is no longer paired', () => {
    // The id stays — the audit needs it — and everything else goes. What is
    // left reaches nothing: every gated method refuses, and the one read it
    // could make is answered by `seen`, which throws for a device that is gone.
    expect(narrowed(away(), () => null)).toEqual({
      how: 'remote',
      device: DEVICE,
      projects: [],
      may: [],
    })
  })

  it('narrows a grant that was narrowed while the turn was running', () => {
    const paired = (): Paired => ({ projects: ['sentry'], scopes: ['read', 'ask', 'answer'] })
    expect(narrowed(away(), paired)).toEqual({
      how: 'remote',
      device: DEVICE,
      projects: ['sentry'],
      may: ['answer'],
    })
  })

  it('never widens one, because a grant made during a turn is not one it was given', () => {
    const wide = (): Paired => ({
      projects: null,
      scopes: ['read', 'ask', 'answer', 'steer'],
    })
    expect(narrowed(away({ projects: ['sentry'], may: ['answer'] }), wide)).toEqual({
      how: 'remote',
      device: DEVICE,
      projects: ['sentry'],
      may: ['answer'],
    })
  })

  it('keeps the projects both lists agree on', () => {
    const some = (): Paired => ({ projects: ['sentry', 'docs'], scopes: ['read', 'ask'] })
    expect(narrowed(away({ projects: ['sentry', 'payments'], may: [] }), some)).toMatchObject({
      projects: ['sentry'],
    })
  })
})

describe('what is handed over, and what it writes down', () => {
  it('narrows the lease before anything is asked of it', async () => {
    const lines: Record<string, unknown>[] = []
    const seen: Arm[] = []
    const arming = armingFor({
      arm: () => away(),
      paired: () => null,
      seen: async (arm) => {
        seen.push(arm)
        return {}
      },
      log: async (event) => {
        lines.push(event)
        return {}
      },
      note: () => {},
    })
    expect(arming.arm()).toMatchObject({ may: [] })
    await arming.seen(arming.arm())
    expect(seen[0]).toMatchObject({ may: [] })
  })

  it('writes a refusal down under the device, and never one for a local turn', () => {
    const lines: Record<string, unknown>[] = []
    const arming = armingFor({
      arm: () => away(),
      paired: () => ({ projects: null, scopes: ['read', 'ask'] }),
      seen: async () => ({}),
      log: async (event) => {
        lines.push(event)
        return {}
      },
      note: () => {},
    })
    arming.refused(away(), 'config/change', 'needs the person at the machine')
    arming.refused(LOCAL, 'config/change', 'never happens')
    expect(lines).toEqual([
      {
        type: 'web_did',
        detail: {
          device: DEVICE,
          tool: 'config/change',
          state: 'refused',
          why: 'needs the person at the machine',
        },
      },
    ])
  })

  it('says so in the window when the journal would not take the line', async () => {
    // A journal that will not take a line is not a reason the refusal does not
    // happen — but it may not be swallowed either, because `web_did` is the
    // audit and "every act one takes is in the journal under its id" would
    // quietly stop being true.
    const said: string[] = []
    const arming = armingFor({
      arm: () => away(),
      paired: () => null,
      seen: async () => ({}),
      log: () => Promise.reject(new Error('the disk is full')),
      note: (one) => said.push(one),
    })
    arming.refused(away(), 'worker/steer', 'not granted')
    await Promise.resolve()
    await Promise.resolve()
    expect(said).toEqual([`a refusal from ${DEVICE} could not be written down`])
  })
})
