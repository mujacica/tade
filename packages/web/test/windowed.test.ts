import { describe, expect, it } from 'vitest'
import { NotOffered, type Outcome } from '../src/acting.ts'
import { Receipts } from '../src/receipts.ts'
import { routesFor, WINDOW } from '../src/routes.ts'
import type { Surface } from '../src/surface.ts'
import {
  carryLook,
  carryWindow,
  TYPE_BOUND,
  type WindowDoor,
  type WindowIntent,
  type Windowing,
} from '../src/windowed.ts'
import { homeFor } from './harness.ts'

// The window itself, shared with a phone that draws its own copy (§10 T3): the
// look and the one act, with a real receipt store on disk and a window that
// answers whatever the test wants — and no sockets, as `asked.test.ts` has none.

const SURFACE: Surface = {
  enabled: true,
  bind: 'loopback',
  port: 7654,
  trustedHosts: [],
  publicName: null,
  passkeyMs: 0,
  acting: true,
  talking: false,
  drafting: false,
  configuring: false,
  installing: false,
  keepsView: false,
  pushing: false,
  pushDetails: false,
}

const DEVICE = '00112233445566aa'

/** A window that does what the test says, and remembers what it was handed. */
function door(over: { act?: (intent: WindowIntent) => Outcome; unlocked?: boolean } = {}): {
  window: WindowDoor
  acts: { intent: WindowIntent; own: Record<string, unknown> | undefined }[]
  looks: unknown[]
} {
  const acts: { intent: WindowIntent; own: Record<string, unknown> | undefined }[] = []
  const looks: unknown[] = []
  return {
    acts,
    looks,
    window: {
      unlocked: () => over.unlocked ?? true,
      look: (_device, look) => {
        looks.push(look)
        return { rev: null }
      },
      act: (_device, intent, own) => {
        acts.push({ intent, own })
        return over.act?.(intent) ?? { did: true, rev: '3', said: `window ${intent.kind}` }
      },
      leave: () => {},
    },
  }
}

async function context(window: WindowDoor, over: Partial<Windowing> = {}): Promise<Windowing> {
  const home = await homeFor('windowed')
  const receipts = new Receipts({ home, epoch: 'one' })
  await receipts.open()
  return {
    window,
    receipts,
    surface: SURFACE,
    unlocked: true,
    rev: 0,
    origin: { scheme: 'http', host: '127.0.0.1', listener: 'loopback' },
    device: DEVICE,
    now: Date.parse('2026-11-27T09:00:00.000Z'),
    request: 'req-1',
    ...over,
  }
}

const KEY = 'abcdefgh12345678'

describe('the one act', () => {
  it('reaches the window once, with where the phone was looking, and is written down as names only', async () => {
    const made = door()
    const body = {
      key: KEY,
      intent: { kind: 'type', data: 'hello agent\r', pasted: false },
      own: { focused: 'app/search' },
    }
    const answered = await carryWindow(body, await context(made.window))
    expect(answered.refusal).toBeNull()
    expect(made.acts).toEqual([
      {
        intent: { kind: 'type', data: 'hello agent\r', pasted: false },
        own: { focused: 'app/search' },
      },
    ])
    // The line is the tool and Tade's own words, never the bytes typed.
    expect(answered.did).toMatchObject({ tool: 'window type', state: 'window type', why: 'done' })
    expect(JSON.stringify(answered.did)).not.toContain('hello agent')
  })

  it('answers a repeat of the key out of the record, and a key reused for another intent not at all', async () => {
    const made = door()
    const ctx = await context(made.window)
    const body = { key: KEY, intent: { kind: 'interrupt' } }
    await carryWindow(body, ctx)
    const again = await carryWindow(body, ctx)
    expect(again.did.why).toBe('already done')
    expect(made.acts, 'carried out once').toHaveLength(1)
    const reused = await carryWindow({ key: KEY, intent: { kind: 'search' } }, ctx)
    expect(reused.refusal?.error).toBe('reused')
    expect(made.acts).toHaveLength(1)
  })

  it('refuses with acting off now, from an origin that is not trusted, and what does not parse', async () => {
    const made = door()
    const body = { key: KEY, intent: { kind: 'interrupt' } }
    const off = await carryWindow(body, await context(made.window, { unlocked: false }))
    expect(off.refusal?.error).toBe('locked')
    const plain = await carryWindow(
      body,
      await context(made.window, {
        origin: { scheme: 'http', host: '192.168.1.4', listener: 'public' },
      }),
    )
    expect(plain.refusal?.error).toBe('locked')
    for (const odd of [
      { key: KEY, intent: { kind: 'format-disk' } },
      { key: KEY, intent: { kind: 'run', action: 'settings', extra: 1 } },
      { key: KEY, intent: { kind: 'say', said: '   ' } },
      { key: KEY, intent: { kind: 'type', data: 'x'.repeat(TYPE_BOUND + 1), pasted: false } },
      { key: 'short', intent: { kind: 'interrupt' } },
    ]) {
      const answered = await carryWindow(odd, await context(made.window))
      expect(answered.refusal?.error, JSON.stringify(odd).slice(0, 60)).toBe('malformed')
    }
    expect(made.acts).toHaveLength(0)
  })

  it('says what a phone cannot ask as not offered', async () => {
    const made = door({
      act: () => {
        throw new NotOffered('closing the window is for this machine’s own keyboard')
      },
    })
    const answered = await carryWindow(
      { key: KEY, intent: { kind: 'quit' } },
      await context(made.window),
    )
    expect(answered.refusal?.error).toBe('not_offered')
  })

  it('carries a press on what the phone drew as the window’s own hit, bounded where it landed', async () => {
    // A tap the phone cannot answer itself (§10 T4): the hit as the drawing
    // made it, read field by field by the window's own mouse over there.
    const made = door()
    const click = {
      kind: 'click',
      target: { kind: 'file', path: 'src/a.ts' },
      button: 'left',
      at: { x: 12, y: 4, cell: 2, clicks: 1 },
    }
    const answered = await carryWindow({ key: KEY, intent: click }, await context(made.window))
    expect(answered.refusal).toBeNull()
    expect(made.acts[0]?.intent).toEqual(click)
    expect(answered.did.tool).toBe('window click')
    // Off the screen, a fourth press, a hit with no kind: none of them parse.
    for (const odd of [
      { ...click, at: { x: 5_000, y: 4 } },
      { ...click, at: { x: 1, y: 1, clicks: 4 } },
      { ...click, target: { path: 'x' } },
      { ...click, button: 'middle' },
    ]) {
      const refused = await carryWindow(
        { key: `${KEY}x`, intent: odd },
        await context(door().window),
      )
      expect(refused.refusal?.error, JSON.stringify(odd)).toBe('malformed')
    }
  })
})

describe('the look', () => {
  it('is handed to the window parsed, and is the 404 of a path nobody wired without one', () => {
    const made = door()
    const look = { columns: 132, rows: 39, rev: null, own: { project: 'app' } }
    expect(carryLook(look, DEVICE, made.window)).toEqual({ body: { rev: null } })
    expect(made.looks).toEqual([look])
    expect(carryLook({ columns: 5, rows: 39, rev: null }, DEVICE, made.window)).toEqual({
      refusal: expect.objectContaining({ error: 'malformed' }),
    })
    expect(carryLook(look, DEVICE, undefined)).toEqual({
      refusal: expect.objectContaining({ error: 'no_such' }),
    })
  })
})

describe('the routes', () => {
  it('answers the look whatever acting says, and builds the act only where acting is on', () => {
    const names = (acting: boolean) =>
      routesFor({ ...SURFACE, acting })
        .filter((route) => route.windows !== undefined)
        .map((route) => route.name)
    expect(names(true)).toEqual(['window look', 'window act'])
    expect(names(false)).toEqual(['window look'])
    expect(WINDOW.find((route) => route.windows === 'act')?.needs).toBe('steer')
  })
})
