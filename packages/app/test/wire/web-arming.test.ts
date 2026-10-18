import { type Arm, LOCAL } from '@tade/core'
import { chatRev, type Device, GRANTS, SCOPES } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { armingFor, narrowed, type Paired, webAsking } from '../../src/wire/web-asking.ts'

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

  it('keeps an owner’s reach only while the record still says owner', () => {
    // REMOTE-TADE.md §11 item 4. The lease can only ever take away: revoked is
    // a remote arm that reaches nothing, and a record that stopped saying owner
    // is the device's own grants — never wider than the keyboard it had.
    const owner: Arm = { how: 'owner', device: DEVICE }
    const still = (): Paired => ({ projects: null, scopes: ['read', 'ask'], owner: true })
    expect(narrowed(owner, still)).toBe(owner)
    expect(narrowed(owner, () => null)).toEqual({
      how: 'remote',
      device: DEVICE,
      projects: [],
      may: [],
    })
    const ordinary = (): Paired => ({ projects: ['sentry'], scopes: ['read', 'ask', 'answer'] })
    expect(narrowed(owner, ordinary)).toEqual({
      how: 'remote',
      device: DEVICE,
      projects: ['sentry'],
      may: ['answer'],
    })
  })

  it('keeps the person’s own device as them only while it has full access', () => {
    // Revoking is the safety net and it is instant: a device disconnected
    // mid-turn reaches nothing from the next call on. Unticking any one box
    // makes it a device with exactly what is left, mid-turn included.
    const yours: Arm = { how: 'owner', device: DEVICE, theirs: true }
    const full = (): Paired => ({
      projects: null,
      scopes: [...SCOPES],
      granted: [...GRANTS],
    })
    expect(narrowed(yours, full)).toBe(yours)
    expect(narrowed(yours, () => null)).toEqual({
      how: 'remote',
      device: DEVICE,
      projects: [],
      may: [],
    })
    const lessOne = (): Paired => ({
      projects: null,
      scopes: SCOPES.filter((scope) => scope !== 'steer'),
      granted: [...GRANTS],
    })
    expect(narrowed(yours, lessOne)).toEqual({
      how: 'remote',
      device: DEVICE,
      projects: null,
      may: ['answer'],
    })
    // A machine link with full access is still a link: its words are not theirs.
    expect(narrowed(yours, () => ({ ...full(), owner: true }))).toMatchObject({ how: 'remote' })
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

describe('an owner device’s arm, built at the turn', () => {
  // Both halves, and neither is the request's word: the record says owner, and
  // the door says the message came in on this machine. Either alone is an
  // ordinary device's narrowed turn.
  const record = (owner: boolean): Device => ({
    id: DEVICE,
    label: 'mac',
    digest: 'a'.repeat(64),
    host: 'localhost:7654',
    csrf: 'x'.repeat(43),
    until: Date.now() + 86_400_000,
    pairedAt: Date.now(),
    scopes: ['read', 'ask', 'steer'],
    projects: null,
    granted: [],
    from: '',
    revoked: null,
    owner,
    passkey: null,
  })

  async function armedFor(owner: boolean, here: boolean): Promise<Arm[]> {
    const armed: Arm[] = []
    const asking = webAsking({
      talking: () => true,
      devices: () => [record(owner)],
      seen: () => ({ busy: false, whose: '' }),
      ask: async (_said, arm) => {
        armed.push(arm)
      },
      stop: async () => false,
      said: () => {},
      theirs: () => {},
      now: () => Date.now(),
    })
    await asking.ask(
      { was: chatRev({ busy: false }), said: 'hello' },
      { how: 'remote', device: DEVICE },
      here,
    )
    return armed
  }

  it('is the owner arm where the record says owner and the door says here', async () => {
    expect(await armedFor(true, true)).toEqual([{ how: 'owner', device: DEVICE }])
  })

  it('is a device’s ordinary arm anywhere else', async () => {
    const remote = { how: 'remote', device: DEVICE, projects: null, may: ['steer'] }
    expect(await armedFor(true, false)).toEqual([remote])
    expect(await armedFor(false, true)).toEqual([remote])
  })
})

describe('the person’s own device, built at the turn', () => {
  // Full access — every scope and every reading grant, what pairing gives —
  // is the person: the keyboard's reach from any door the guard let it
  // through, and what they typed kept as their own words.
  const device = (over: Partial<Device> = {}): Device => ({
    id: DEVICE,
    label: 'phone',
    digest: 'a'.repeat(64),
    host: 'tade.example.com',
    csrf: 'x'.repeat(43),
    until: Date.now() + 86_400_000,
    pairedAt: Date.now(),
    scopes: [...SCOPES],
    projects: null,
    granted: [...GRANTS],
    from: '203.0.113.9',
    revoked: null,
    owner: false,
    passkey: null,
    ...over,
  })

  async function asked(one: Device, here: boolean) {
    const armed: Arm[] = []
    const theirs: string[] = []
    const asking = webAsking({
      talking: () => true,
      devices: () => [one],
      seen: () => ({ busy: false, whose: '' }),
      ask: async (_said, arm) => {
        armed.push(arm)
      },
      stop: async () => false,
      said: () => {},
      theirs: (text) => theirs.push(text),
      now: () => Date.now(),
    })
    await asking.ask(
      { was: chatRev({ busy: false }), said: 'turn the commit judge on' },
      { how: 'remote', device: DEVICE },
      here,
    )
    return { armed, theirs }
  }

  it('is the keyboard’s reach from a public name, and its words are theirs', async () => {
    const { armed, theirs } = await asked(device(), false)
    expect(armed).toEqual([{ how: 'owner', device: DEVICE, theirs: true }])
    expect(theirs).toEqual(['turn the commit judge on'])
  })

  it('keeps exactly its grant once anything is taken away, and nothing is theirs', async () => {
    const narrowedOne = device({ granted: GRANTS.filter((grant) => grant !== 'lanes') })
    const { armed, theirs } = await asked(narrowedOne, false)
    expect(armed).toEqual([
      { how: 'remote', device: DEVICE, projects: null, may: ['answer', 'steer'] },
    ])
    expect(theirs).toEqual([])
  })

  it('is refused at once once revoked', async () => {
    await expect(asked(device({ revoked: 'revoked at the machine' }), false)).rejects.toThrow(
      /not paired/,
    )
  })

  it('never makes a machine link’s words theirs', async () => {
    const { armed, theirs } = await asked(device({ owner: true, host: 'localhost:7654' }), true)
    expect(armed).toEqual([{ how: 'owner', device: DEVICE }])
    expect(theirs).toEqual([])
  })
})
