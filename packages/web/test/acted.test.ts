import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Acted, carryOut } from '../src/acted.ts'
import {
  type From,
  Moved,
  NotThere,
  type Outcome,
  type ParkCall,
  type WebActing,
} from '../src/acting.ts'
import { namesOnly } from '../src/reach.ts'
import { Receipts } from '../src/receipts.ts'
import { ACTS, type Route } from '../src/routes.ts'
import type { Scope, Surface } from '../src/surface.ts'
import { homeFor } from './harness.ts'

// One act, end to end, with a real receipt store on disk and a window that
// answers whatever the test wants it to.
//
// **No sockets**, which is the whole reason `acted.ts` is its own file: the
// cases these are about — a repeat under load, a key reused for another
// payload, a window that died mid-act, a park that moved under the caller —
// are each one line of setup here and a paragraph of ceremony through HTTP.
// `acting.test.ts` does the door; this does the decisions.

const ROUTE: Route = ACTS[0] as Route

const SURFACE: Surface = {
  enabled: true,
  bind: 'loopback',
  port: 7654,
  trustedHosts: [],
  acting: true,
}

const BODY = {
  task: 'tade/away-action-gate',
  parked: true,
  was: 'p0',
  key: 'abcdefgh12345678',
  rev: 4,
}

/** A window that does what the test says, and remembers being asked. */
function window_(
  over: { park?: (call: ParkCall, from: From) => Promise<Outcome>; unlocked?: boolean } = {},
): { acting: WebActing; calls: { call: ParkCall; from: From }[] } {
  const calls: { call: ParkCall; from: From }[] = []
  return {
    calls,
    acting: {
      unlocked: () => over.unlocked ?? true,
      park: (call, from) => {
        calls.push({ call, from })
        return (
          over.park?.(call, from) ??
          Promise.resolve<Outcome>({ did: true, rev: 'p1', said: 'set aside' })
        )
      },
    },
  }
}

async function context(
  acting: WebActing,
  over: Partial<Acted> = {},
  what = 'acted',
): Promise<Acted> {
  const home = await homeFor(what)
  const receipts = new Receipts({ home, epoch: 'one' })
  await receipts.open()
  return {
    acting,
    receipts,
    surface: SURFACE,
    unlocked: true,
    rev: 4,
    reach: namesOnly('00112233445566aa'),
    scopes: ['read', 'steer'] as readonly Scope[],
    origin: { scheme: 'http', host: '127.0.0.1' },
    device: '00112233445566aa',
    now: Date.parse('2026-10-09T09:00:00.000Z'),
    request: 'req-1',
    ...over,
  }
}

describe('an act that goes through', () => {
  it('reaches the window once and answers with what is true now', async () => {
    const made = window_()
    const ctx = await context(made.acting, {}, 'acted-ok')
    const answered = await carryOut(ROUTE, BODY, ctx)
    expect(answered.refusal).toBeNull()
    expect(answered.body).toEqual({ did: true, rev: 'p1', said: 'set aside' })
    expect(made.calls).toHaveLength(1)
  })

  it('carries the device in as the provenance, never as the person', async () => {
    // DECISIONS §4.5's correction, one layer down: a remote act recorded as
    // `you` would make `historyFrom` count it as the person's own doing.
    const made = window_()
    const answered = await carryOut(ROUTE, BODY, await context(made.acting, {}, 'acted-from'))
    expect(answered.refusal).toBeNull()
    expect(made.calls[0]?.from).toEqual({ how: 'remote', device: '00112233445566aa' })
  })

  it('writes a line naming the device, the verb and the task', async () => {
    const answered = await carryOut(ROUTE, BODY, await context(window_().acting, {}, 'acted-did'))
    expect(answered.did).toEqual({
      device: '00112233445566aa',
      tool: 'park',
      task: 'tade/away-action-gate',
      state: 'parked',
      why: 'done',
    })
  })

  it('says `nothing to do` where the window did nothing, rather than claiming it did', async () => {
    const made = window_({
      park: () => Promise.resolve<Outcome>({ did: false, rev: 'p1', said: 'already set aside' }),
    })
    const answered = await carryOut(ROUTE, BODY, await context(made.acting, {}, 'acted-nothing'))
    expect(answered.did.why).toBe('nothing to do')
    expect(answered.body).toEqual({ did: false, rev: 'p1', said: 'already set aside' })
  })
})

describe('what is written down whatever happened', () => {
  it('is a line for a refusal too, which is the case audit matters most', async () => {
    const made = window_()
    const ctx = await context(made.acting, { scopes: ['read'] }, 'acted-refused')
    const answered = await carryOut(ROUTE, BODY, ctx)
    expect(answered.refusal?.error).toBe('out_of_scope')
    expect(answered.did).toEqual({
      device: '00112233445566aa',
      tool: 'park',
      task: 'tade/away-action-gate',
      state: 'refused',
      why: 'out_of_scope',
    })
    expect(made.calls).toEqual([])
  })

  it('is a line with no target for a body nobody could read', async () => {
    const answered = await carryOut(
      ROUTE,
      { ...BODY, parked: 'yes' },
      await context(window_().acting, {}, 'acted-malformed'),
    )
    expect(answered.refusal?.error).toBe('malformed')
    expect(answered.did).toEqual({
      device: '00112233445566aa',
      tool: 'park',
      task: '',
      state: 'refused',
      why: 'malformed',
    })
  })

  it('answers a route with no verb behind it as a `404`, telling nothing', async () => {
    const answered = await carryOut(
      { ...ROUTE, verb: 'exec' },
      BODY,
      await context(window_().acting, {}, 'acted-no-verb'),
    )
    expect(answered.refusal?.error).toBe('no_such')
    expect(answered.refusal?.status).toBe(404)
  })
})

describe('a repeat', () => {
  it('runs the verb once under load, and answers both calls the same', async () => {
    // Two presses, or one press and the phone's own retry. The second awaits
    // the first rather than parking anything twice.
    const made = window_({
      park: () =>
        new Promise<Outcome>((done) =>
          setTimeout(() => done({ did: true, rev: 'p1', said: 'set aside' }), 10),
        ),
    })
    const ctx = await context(made.acting, {}, 'acted-load')
    const [one, two] = await Promise.all([carryOut(ROUTE, BODY, ctx), carryOut(ROUTE, BODY, ctx)])
    expect(made.calls).toHaveLength(1)
    expect(one.body).toEqual(two.body)
    expect(one.refusal).toBeNull()
    expect(two.refusal).toBeNull()
  })

  it('answers from the record once the first has finished', async () => {
    const made = window_()
    const ctx = await context(made.acting, {}, 'acted-again')
    const one = await carryOut(ROUTE, BODY, ctx)
    const two = await carryOut(ROUTE, BODY, ctx)
    expect(made.calls).toHaveLength(1)
    expect(two.body).toEqual(one.body)
    expect(two.did.why).toBe('already done')
  })

  it('refuses the same key with an altered payload, and runs nothing', async () => {
    const made = window_()
    const ctx = await context(made.acting, {}, 'acted-reused')
    await carryOut(ROUTE, BODY, ctx)
    const altered = await carryOut(ROUTE, { ...BODY, parked: false }, ctx)
    expect(altered.refusal?.error).toBe('reused')
    expect(altered.refusal?.status).toBe(409)
    expect(made.calls).toHaveLength(1)
  })

  it('is unsure, and runs nothing, when the window died in the middle of the first', async () => {
    // **The restart case, through the whole path.** The first act's `asked`
    // line is on disk; nothing recorded what came of it. A new lifetime reads
    // the file and refuses to do it again.
    const home = await homeFor('acted-restart')
    const first = new Receipts({ home, epoch: 'one' })
    await first.open()
    const died = window_({ park: () => Promise.reject(new Error('the window went')) })
    const broke = await carryOut(ROUTE, BODY, await context(died.acting, { receipts: first }))
    expect(broke.refusal?.error).toBe('broke')
    expect(broke.warning).toContain('could not carry out park')

    const next = new Receipts({ home, epoch: 'two' })
    await next.open()
    const made = window_()
    const after = await carryOut(ROUTE, BODY, await context(made.acting, { receipts: next }))
    expect(after.refusal?.error).toBe('unsure')
    expect(after.refusal?.status).toBe(409)
    expect(made.calls).toEqual([])
  })
})

describe('when the record cannot be written', () => {
  it('runs nothing, and says why where a person can read it', async () => {
    // **The order is the fail-closed story.** An act Tade cannot write down
    // beforehand is an act it would not be able to say anything true about
    // afterwards, so it does not happen — and the exception's words go in a
    // `warning`, never to the phone.
    const made = window_()
    const base = await homeFor('acted-nowrite')
    const file = join(base, 'not-a-folder')
    await writeFile(file, '')
    const receipts = new Receipts({ home: join(file, 'under'), epoch: 'one' })
    await receipts.open()
    const answered = await carryOut(ROUTE, BODY, await context(made.acting, { receipts }))
    expect(answered.refusal?.error).toBe('broke')
    expect(answered.warning).toContain('could not write down that park was asked for')
    expect(answered.did.state).toBe('refused')
    expect(made.calls).toEqual([])
  })
})

describe('what the window says back', () => {
  it('turns a park that moved under the caller into a `gone` with the truth on it', async () => {
    // **The stale-screen case, and it is the guarantee rather than the key.**
    // The page redraws from `rev` instead of showing an error it cannot act on.
    const made = window_({
      park: () =>
        Promise.reject(new Moved('tade/x is parked now, which is not what you saw', 'p1')),
    })
    const answered = await carryOut(ROUTE, BODY, await context(made.acting, {}, 'acted-moved'))
    expect(answered.refusal?.error).toBe('gone')
    expect(answered.refusal?.status).toBe(409)
    expect(answered.refusal?.rev).toBe('p1')
    // And the page's own sentence names no state: the next frame carries it.
    expect(answered.refusal?.said).toBe('something changed while you were looking')
  })

  it('turns a task that is not there into a `404`', async () => {
    const made = window_({ park: () => Promise.reject(new NotThere('no task file for tade/x')) })
    const answered = await carryOut(ROUTE, BODY, await context(made.acting, {}, 'acted-nothere'))
    expect(answered.refusal?.error).toBe('no_such')
    expect(answered.warning).toBeNull()
  })

  it('turns anything else into a request id, with the detail in a warning', async () => {
    const made = window_({ park: () => Promise.reject(new Error('a disk full of nothing')) })
    const answered = await carryOut(ROUTE, BODY, await context(made.acting, {}, 'acted-broke'))
    expect(answered.refusal?.error).toBe('broke')
    expect(answered.refusal?.request).toBe('req-1')
    // The exception's words reach a person at the machine and never the phone.
    expect(answered.warning).toContain('a disk full of nothing')
    expect(answered.refusal?.said).not.toContain('disk')
  })

  it('leaves a `gone` able to be asked again, because nothing happened', async () => {
    // A refusal is not a completed act, so the same key with the same payload
    // is not answered from a record that says it worked — it meets the state
    // re-check again, which is the only thing that can say.
    let moved = true
    const made = window_({
      park: () =>
        moved
          ? Promise.reject(new Moved('moved', 'p1'))
          : Promise.resolve<Outcome>({ did: true, rev: 'p1', said: 'set aside' }),
    })
    const ctx = await context(made.acting, {}, 'acted-retry')
    expect((await carryOut(ROUTE, BODY, ctx)).refusal?.error).toBe('gone')
    moved = false
    expect((await carryOut(ROUTE, BODY, ctx)).refusal?.error).toBe('unsure')
  })
})
