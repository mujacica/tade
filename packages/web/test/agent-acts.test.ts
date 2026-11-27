import { describe, expect, it } from 'vitest'
import { type Acted, carryOut } from '../src/acted.ts'
import type { Outcome, WebActing } from '../src/acting.ts'
import { type MenuItemIn, menuFor, menuHere } from '../src/agent-menu.ts'
import { type Reach, reachFor } from '../src/reach.ts'
import type { WebReading } from '../src/reading.ts'
import { Receipts } from '../src/receipts.ts'
import { ACTS, type Route } from '../src/routes.ts'
import { actingStub, BASE, homeFor } from './harness.ts'

// The rest of an agent's menu from away — start, remove, rename, model,
// thinking, account, harness, move — each through the act door every verb
// goes through. Every paired device is the person's own and reaches each
// one's door; a refused act reaches no door at all, and every one of them is a
// line.

const EVERY = { task: 'tade/away-agent', was: 'lrunning', key: 'abcdefgh12345678', rev: 4 }

/** One valid body per verb, by name. */
const BODIES: Readonly<Record<string, Record<string, unknown>>> = {
  start: { ...EVERY },
  remove: { ...EVERY, confirm: true },
  rename: { ...EVERY, title: 'the migration' },
  model: { ...EVERY, model: 'claude-opus-5' },
  thinking: { ...EVERY, level: 'high' },
  account: { ...EVERY, account: 'work' },
  harness: { ...EVERY, harness: 'codex' },
  move: { ...EVERY, machine: 'vps', confirm: true },
}

/** What each verb hands its door, beyond the target. */
const HANDED: Readonly<Record<string, Record<string, unknown>>> = {
  start: {},
  remove: { confirm: true },
  rename: { title: 'the migration' },
  model: { model: 'claude-opus-5' },
  thinking: { level: 'high' },
  account: { account: 'work' },
  harness: { harness: 'codex' },
  move: { machine: 'vps', confirm: true },
}

const ALL = ['start', 'rename', 'model', 'thinking', 'remove', 'account', 'harness', 'move']

/** A window answering each of the eight, and remembering which it was asked. */
function windowOf(): { acting: WebActing; asked: { verb: string; call: unknown }[] } {
  const asked: { verb: string; call: unknown }[] = []
  const did =
    (verb: string) =>
    (call: unknown): Promise<Outcome> => {
      asked.push({ verb, call })
      return Promise.resolve({ did: true, rev: 'after', said: `${verb} done` })
    }
  return {
    asked,
    acting: actingStub(Object.fromEntries(ALL.map((verb) => [verb, did(verb)]))),
  }
}

async function context(acting: WebActing, what: string, over: Partial<Acted> = {}): Promise<Acted> {
  const home = await homeFor(what)
  const receipts = new Receipts({ home, epoch: 'one' })
  await receipts.open()
  return {
    acting,
    receipts,
    surface: { ...BASE, acting: true },
    unlocked: true,
    rev: 4,
    origin: { scheme: 'http', host: '127.0.0.1', listener: 'loopback' },
    device: '00112233445566aa',
    now: Date.parse('2026-11-23T09:00:00.000Z'),
    request: 'req-1',
    ...over,
  }
}

function routeOf(verb: string): Route {
  const route = ACTS.find((one) => one.verb === verb)
  if (route === undefined) throw new Error(`no route for ${verb}`)
  return route
}

describe('each of the rest of an agent’s menu, through the act door', () => {
  it('reaches its own door, once, for a paired device, with what was asked', async () => {
    for (const verb of ALL) {
      const made = windowOf()
      const answered = await carryOut(
        routeOf(verb),
        BODIES[verb],
        await context(made.acting, `agent-${verb}`),
      )
      expect(answered.refusal, verb).toBeNull()
      expect(answered.body, verb).toEqual({ did: true, rev: 'after', said: `${verb} done` })
      expect(made.asked, verb).toEqual([
        { verb, call: { task: EVERY.task, was: EVERY.was, ...HANDED[verb] } },
      ])
      // Provenance is the device, never the person, and the line names the verb.
      expect(answered.did).toMatchObject({ device: '00112233445566aa', tool: verb, why: 'done' })
    }
  })

  it('reaches no door where acting was turned off a second ago, and is a line', async () => {
    for (const verb of ALL) {
      const made = windowOf()
      const answered = await carryOut(
        routeOf(verb),
        BODIES[verb],
        await context(made.acting, `agent-off-${verb}`, { unlocked: false }),
      )
      expect(answered.refusal?.error, verb).toBe('locked')
      expect(made.asked, verb).toEqual([])
      expect(answered.did).toMatchObject({ tool: verb, state: 'refused', why: 'locked' })
    }
  })

  it('runs a repeat of the same key once, and answers it the same', async () => {
    // Idempotency for the one that deletes: a press whose answer never came,
    // pressed again, is not a second removal.
    const made = windowOf()
    const ctx = await context(made.acting, 'agent-repeat')
    const first = await carryOut(routeOf('remove'), BODIES.remove, ctx)
    const again = await carryOut(routeOf('remove'), BODIES.remove, ctx)
    expect(again.body).toEqual(first.body)
    expect(made.asked).toHaveLength(1)
  })

  it('refuses a body that says nothing about meaning it, for the two asking again does not undo', async () => {
    for (const verb of ['remove', 'move']) {
      const made = windowOf()
      const { confirm: _, ...body } = BODIES[verb] as Record<string, unknown>
      const answered = await carryOut(
        routeOf(verb),
        body,
        await context(made.acting, `agent-confirm-${verb}`),
      )
      expect(answered.refusal?.error, verb).toBe('malformed')
      expect(made.asked).toEqual([])
    }
  })
})

/** One item of a window's menu, carried by a verb or the page. */
function item(id: string, act: MenuItemIn['act'], over: Partial<MenuItemIn> = {}): MenuItemIn {
  return { id, label: id, off: null, note: null, danger: false, divider: false, act, ...over }
}

const MENU: MenuItemIn[] = [
  item('open', { kind: 'page', does: 'open' }),
  item('stop', { kind: 'verb', verb: 'stop' }),
  item('rename', { kind: 'type', verb: 'rename', value: 'agent' }),
  item('model', { kind: 'choose', verb: 'model', choices: [], why: null }),
  item('editor', { kind: 'here' }, { off: 'it opens an editor on the machine’s own screen' }),
  item('hand:vps', { kind: 'verb', verb: 'move', with: { machine: 'vps' } }, { divider: true }),
  item('park', { kind: 'verb', verb: 'park' }, { divider: true }),
  item('remove', { kind: 'verb', verb: 'remove' }, { danger: true }),
]

describe('an agent’s menu, for one device', () => {
  it('keeps everything for a paired device, and the reasons for what stays at the machine', () => {
    const kept = menuFor(MENU, { acting: true })
    expect(kept.map((one) => one.id)).toEqual(MENU.map((one) => one.id))
    expect(kept.find((one) => one.id === 'editor')?.off).toContain('machine')
  })

  it('leaves out every act where acting is off, and never opens on a rule', () => {
    const kept = menuFor(MENU, { acting: false })
    expect(kept.map((one) => one.id)).toEqual(['open', 'editor'])
    const ruled = menuFor([MENU[5] as MenuItemIn, MENU[0] as MenuItemIn], { acting: true })
    expect(ruled[0]?.divider).toBe(false)
  })
})

/** A reading that has one task, and nothing else. */
function reading(here: boolean): (reach: Reach) => WebReading {
  return () => ({ agent: () => ({ here }) }) as unknown as WebReading
}

describe('the menu route', () => {
  const standing = { acting: true }
  const params = { project: 'tade', task: 'away-agent' }
  const reach = reachFor('00112233445566aa')

  it('says nothing about a task this device does not read, and asks the window nothing', async () => {
    let asked = 0
    const menus = {
      menu: () => {
        asked += 1
        return Promise.resolve({ items: MENU })
      },
    }
    const out = await menuHere(params, reach, standing, { readingFor: reading(false), menus })
    expect(out).toEqual({ task: 'tade/away-agent', here: false, items: [], why: null })
    expect(asked).toBe(0)
  })

  it('asks the window for the task it reads, and keeps what it offers', async () => {
    const asked: string[] = []
    const menus = {
      menu: (task: string) => {
        asked.push(task)
        return Promise.resolve({ items: MENU })
      },
    }
    const out = await menuHere(params, reach, standing, { readingFor: reading(true), menus })
    expect(asked).toEqual(['tade/away-agent'])
    expect(out.items.map((one) => one.id)).toContain('remove')
  })

  it('says why where the window has no menu or did not have the task, and throws on what broke', async () => {
    const none = await menuHere(params, reach, standing, { readingFor: reading(true) })
    expect(none.why).toContain('does not offer')
    const gone = await menuHere(params, reach, standing, {
      readingFor: reading(true),
      menus: { menu: () => Promise.resolve(null) },
    })
    expect(gone.why).toContain('does not have this agent')
    // A window that threw is the server's one catch to answer — `broke`, with
    // the detail as a warning at the machine — so it is thrown on, never
    // answered here with its words, which could hold a path.
    await expect(
      menuHere(params, reach, standing, {
        readingFor: reading(true),
        menus: { menu: () => Promise.reject(new Error('/Users/someone/secret broke')) },
      }),
    ).rejects.toThrow('secret broke')
  })
})
