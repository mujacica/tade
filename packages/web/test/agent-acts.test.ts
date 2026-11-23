import { describe, expect, it } from 'vitest'
import { type Acted, carryOut } from '../src/acted.ts'
import type { Outcome, WebActing } from '../src/acting.ts'
import { type MenuItemIn, menuFor, menuHere } from '../src/agent-menu.ts'
import { namesOnly, type Reach } from '../src/reach.ts'
import type { WebReading } from '../src/reading.ts'
import { Receipts } from '../src/receipts.ts'
import { ACTS, type Route } from '../src/routes.ts'
import type { Scope } from '../src/surface.ts'
import { actingStub, BASE, homeFor } from './harness.ts'

// The rest of an agent's menu from away — start, remove, rename, model,
// thinking, account, harness, move — each through the act door every verb
// goes through, and refused for a device narrower than it needs.
//
// **Three devices, every verb.** The person's own (full access, `theirs`)
// reaches each one's door; a device granted the `agents` scope and not
// everything reaches the four that change an agent and is refused the four
// that delete work, change whose sign-in or harness it runs on, or hand it
// away (`Verb.theirs`); a device without `agents` reaches none. A refused act
// reaches no door at all, and every one of them is a line.

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

const MINE = ['start', 'rename', 'model', 'thinking'] as const
const THEIRS = ['remove', 'account', 'harness', 'move'] as const
const ALL = [...MINE, ...THEIRS]

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

const SCOPES_ALL: readonly Scope[] = [
  'read',
  'answer',
  'steer',
  'ask',
  'draft',
  'agents',
  'projects',
  'configure',
]

/** The three devices: the person's own, one with `agents` only, one without it. */
const DEVICES: Readonly<Record<string, { reach: Reach; scopes: readonly Scope[] }>> = {
  theirs: { reach: { ...namesOnly('00112233445566aa'), theirs: true }, scopes: SCOPES_ALL },
  agents: { reach: namesOnly('00112233445566aa'), scopes: ['read', 'steer', 'agents'] },
  steer: { reach: namesOnly('00112233445566aa'), scopes: ['read', 'answer', 'steer'] },
}

async function context(acting: WebActing, device: string, what: string): Promise<Acted> {
  const home = await homeFor(what)
  const receipts = new Receipts({ home, epoch: 'one' })
  await receipts.open()
  const { reach, scopes } = DEVICES[device] as { reach: Reach; scopes: readonly Scope[] }
  return {
    acting,
    receipts,
    surface: { ...BASE, acting: true },
    unlocked: true,
    rev: 4,
    reach,
    scopes,
    origin: { scheme: 'http', host: '127.0.0.1', listener: 'loopback' },
    device: '00112233445566aa',
    now: Date.parse('2026-11-23T09:00:00.000Z'),
    request: 'req-1',
  }
}

function routeOf(verb: string): Route {
  const route = ACTS.find((one) => one.verb === verb)
  if (route === undefined) throw new Error(`no route for ${verb}`)
  return route
}

describe('each of the rest of an agent’s menu, through the act door', () => {
  it('reaches its own door, once, for the person’s own device, with what was asked', async () => {
    for (const verb of ALL) {
      const made = windowOf()
      const answered = await carryOut(
        routeOf(verb),
        BODIES[verb],
        await context(made.acting, 'theirs', `agent-${verb}`),
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

  it('reaches the four that change an agent for a device granted `agents`', async () => {
    for (const verb of MINE) {
      const made = windowOf()
      const answered = await carryOut(
        routeOf(verb),
        BODIES[verb],
        await context(made.acting, 'agents', `agent-mine-${verb}`),
      )
      expect(answered.refusal, verb).toBeNull()
      expect(made.asked.map((one) => one.verb)).toEqual([verb])
    }
  })

  it('refuses the four that are the person’s own device’s alone to any other, reaching no door', async () => {
    for (const verb of THEIRS) {
      const made = windowOf()
      const answered = await carryOut(
        routeOf(verb),
        BODIES[verb],
        await context(made.acting, 'agents', `agent-theirs-${verb}`),
      )
      expect(answered.refusal?.error, verb).toBe('out_of_scope')
      expect(answered.refusal?.status, verb).toBe(403)
      expect(made.asked, verb).toEqual([])
      // A refusal is a line too: the case audit matters most in.
      expect(answered.did).toMatchObject({ tool: verb, state: 'refused', why: 'out_of_scope' })
    }
  })

  it('refuses every one of them to a device not granted `agents`, whatever else it may do', async () => {
    for (const verb of ALL) {
      const made = windowOf()
      const answered = await carryOut(
        routeOf(verb),
        BODIES[verb],
        await context(made.acting, 'steer', `agent-none-${verb}`),
      )
      expect(answered.refusal?.error, verb).toBe('out_of_scope')
      expect(made.asked, verb).toEqual([])
    }
  })

  it('runs a repeat of the same key once, and answers it the same', async () => {
    // Idempotency for the one that deletes: a press whose answer never came,
    // pressed again, is not a second removal.
    const made = windowOf()
    const ctx = await context(made.acting, 'theirs', 'agent-repeat')
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
        await context(made.acting, 'theirs', `agent-confirm-${verb}`),
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
  it('keeps everything for the person’s own device', () => {
    const kept = menuFor(MENU, { scopes: SCOPES_ALL, acting: true, theirs: true })
    expect(kept.map((one) => one.id)).toEqual(MENU.map((one) => one.id))
  })

  it('leaves out what a narrower device may not ask, and keeps the page’s own and the reasons', () => {
    const kept = menuFor(MENU, { scopes: ['read', 'steer', 'agents'], acting: true, theirs: false })
    expect(kept.map((one) => one.id)).toEqual(['open', 'stop', 'rename', 'model', 'editor', 'park'])
    // What stays at the machine is still said, with why.
    expect(kept.find((one) => one.id === 'editor')?.off).toContain('machine')
  })

  it('leaves out every act where acting is off, and never opens on a rule', () => {
    const kept = menuFor(MENU, { scopes: SCOPES_ALL, acting: false, theirs: true })
    expect(kept.map((one) => one.id)).toEqual(['open', 'editor'])
    const ruled = menuFor([MENU[5] as MenuItemIn, MENU[0] as MenuItemIn], {
      scopes: SCOPES_ALL,
      acting: true,
      theirs: true,
    })
    expect(ruled[0]?.divider).toBe(false)
  })
})

/** A reading that has one task, and nothing else. */
function reading(here: boolean): (reach: Reach) => WebReading {
  return () => ({ agent: () => ({ here }) }) as unknown as WebReading
}

describe('the menu route', () => {
  const standing = { scopes: SCOPES_ALL, acting: true, theirs: true }
  const params = { project: 'tade', task: 'away-agent' }
  const reach = namesOnly('00112233445566aa')

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

  it('asks the window for the task it reads, with whether the device is theirs', async () => {
    const theirs: boolean[] = []
    const menus = {
      menu: (_task: string, mine: boolean) => {
        theirs.push(mine)
        return Promise.resolve({ items: MENU })
      },
    }
    const out = await menuHere(
      params,
      reach,
      { ...standing, theirs: false },
      { readingFor: reading(true), menus },
    )
    expect(theirs).toEqual([false])
    expect(out.items.map((one) => one.id)).not.toContain('remove')
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
