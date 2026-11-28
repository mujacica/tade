import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type RemoteConfig } from '@tade/core'
import type { RemoteLink } from '@tade/remotes-core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import { type Device, readDevices, type Surface, Tickets } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { initialState } from '../../src/model.ts'
import { AWAY_CONTROLS, awayPanel, onTab } from '../../src/panels/away/state.ts'
import type { Panel } from '../../src/panels.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { askOf, RemoteAways } from '../../src/wire/remote-away.ts'
import { Remotes } from '../../src/wire/remotes.ts'
import { awayThereFrom } from '../../src/wire/web-away-there.ts'
import type { PanelFacts } from '../../src/wire/web-panel.ts'

// Another machine's away view on its tab of the AWAY VIEW panel
// (`remote-away.ts`), against a real far away view (`far.ts`) answering with
// the window's own half (`web-away-there.ts`) over its home: asked while its
// tab is in front, drawn as that machine answered, a code that machine wrote
// held here in memory and opened or copied on a press, a device signed out
// there — and a link that is down, or a Tade too old to answer, said as that.

const made: { fars: FarEnd[]; homes: string[]; remotes: Remotes[] } = {
  fars: [],
  homes: [],
  remotes: [],
}

afterEach(async () => {
  await Promise.all(made.remotes.map((one) => one.stop()))
  await Promise.all(made.fars.map((far) => far.close()))
  await Promise.all(
    [...made.fars.map((far) => far.home), ...made.homes].map((home) =>
      rm(home, { recursive: true, force: true }),
    ),
  )
  made.fars.length = 0
  made.homes.length = 0
  made.remotes.length = 0
})

const SURFACE: Surface = {
  enabled: true,
  bind: 'loopback',
  port: 7654,
  trustedHosts: ['tade.example.com'],
  publicName: 'tade.example.com',
  passkeyMs: 0,
  acting: true,
  talking: true,
  installing: true,
  keepsView: false,
  pushing: false,
  pushDetails: false,
}

/** A phone paired at the far machine's own loopback door. */
const PHONE: Device = {
  id: '00112233445566aa',
  label: 'iPhone',
  digest: 'd',
  host: 'localhost:7654',
  csrf: 'c',
  until: Date.now() + 86_400_000,
  pairedAt: Date.now() - 3_600_000,
  clear: false,
  from: '127.0.0.1',
  revoked: null,
  owner: false,
  passkey: null,
}

/** A window as far as this subject reaches it: a clock, a frame, a state, and how a link opens. */
function wiring(opened: string[]): Wiring {
  const wire = {
    state: initialState(),
    now: () => Date.now(),
    draw: () => {},
    put(state: Wiring['state']) {
      wire.state = state
    },
    opts: {
      open: async (opener: { args: readonly string[] }) => {
        opened.push(opener.args.join(' '))
      },
    },
  }
  return wire as unknown as Wiring
}

/** This window's remotes, linked to one far end as `vps`, its away view answered by the window's own half. */
async function linked() {
  const far = await startFarEnd({ projects: ['far'], publicName: 'tade.example.com' })
  made.fars.push(far)
  const facts = (): PanelFacts => ({
    surface: SURFACE,
    bound: ['127.0.0.1:7654'],
    listening: true,
    publicAt: '/run/tade/away.sock',
    publicTrouble: null,
    health: [{ said: 'certificate good until 14 Feb 2027', loud: false }],
    ticket: null,
    asking: null,
    devices: [PHONE],
    live: new Set([PHONE.id]),
    streams: 1,
    problem: null,
    now: Date.now(),
  })
  far.away = awayThereFrom({
    home: far.home,
    facts,
    sessions: () => ({
      home: far.home,
      now: () => Date.now(),
      listening: () => [],
      keep: () => {},
      letGo: () => {},
      news: () => {},
      reread: async () => {},
    }),
    tickets: new Tickets(),
    log: async () => {},
  })
  const home = await mkdtemp(join(tmpdir(), 'tade-remote-away-'))
  made.homes.push(home)
  const configPath = join(home, 'config.yaml')
  await writeFile(configPath, '')
  const session = await far.pair('mac')
  const vps: RemoteConfig = {
    ssh: 'north',
    tade: 'tade',
    device: session.device,
    session: session.cookie,
    csrf: session.csrf,
    host: session.host,
  }
  const table = new Map<string, ScriptedRemote>([['north', far]])
  const config = ConfigSchema.parse({ remotes: { vps } })
  const opened: string[] = []
  const copied: string[] = []
  const said: string[] = []
  const wire = wiring(opened)
  let shown: Panel | null = null
  const remotes = new Remotes({
    home,
    remotes: () => config.remotes,
    configPath,
    lastInputAt: () => null,
    now: () => Date.now(),
    log: async () => {},
    say: (line) => said.push(line),
    links: { ssh: (options) => makeScriptedLink({ ...options, remotes: table }) },
    here: 'this Mac',
    go: () => {},
    draw: () => {},
    carrying: {
      config: () => config,
      fold: async () => {},
      secrets: () => new Set(),
      from: () => 'mac',
      onScreenWith: async () => {},
      said: () => {},
      draw: () => {},
      lines: async () => [],
      found: async () => {},
      take: async () => {},
      conflicted: async () => {},
    },
    settingsOpen: () => false,
    panel: () => shown,
  }).withAways(
    (one) =>
      new RemoteAways(wire, {
        reach: (name) => one.reachFor(name),
        copy: async (text) => {
          copied.push(text)
          return true
        },
      }),
  )
  made.remotes.push(remotes)
  const until = async (what: string, holds: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (!holds()) {
      if (Date.now() > deadline) throw new Error(`waited ${ms}ms for ${what}`)
      remotes.beat()
      await new Promise((done) => setTimeout(done, 25))
    }
  }
  const show = (panel: Panel | null) => {
    shown = panel
  }
  return { far, remotes, until, show, opened, copied, said }
}

describe('another machine’s away view, on its tab', () => {
  it('is asked while its tab is in front, and drawn as that machine answered', async () => {
    const { far, remotes, until, show } = await linked()
    await until('vps linked', () => remotes.reachFor('vps')?.live === true)
    // Not in front: nothing asks it, and the tabs are there all the same.
    show(awayPanel())
    expect(remotes.panel()).toMatchObject({ awayTabs: [{ name: 'vps' }] })
    expect(remotes.panel()).not.toHaveProperty('awayThere')
    expect(remotes.inputs()).toEqual({ awayMachines: ['vps'] })
    show(onTab(awayPanel(), 'vps'))
    const view = () => remotes.panel()?.awayThere
    await until('vps answered', () => view()?.there?.asOf !== null && view() !== undefined)
    expect(view()).toMatchObject({
      machine: 'vps',
      listening: true,
      public: { name: 'tade.example.com', up: true },
      there: { name: 'vps', linked: true, up: true, said: null },
      ticket: null,
      agents: 'an agent on vps could pair itself',
    })
    // A phone paired at that machine's own door is named as that machine, not "this machine".
    expect(view()?.devices).toEqual([
      expect.objectContaining({ id: PHONE.id, label: 'iPhone', from: 'vps', live: true }),
    ])
    expect(remotes.panel()?.awayTabs).toEqual([{ name: 'vps', on: true }])
    expect(far.home).toBeTruthy()
  })

  it('pairs with a code that machine wrote — its public link, opened or copied here — and signs it out there', async () => {
    const { far, remotes, until, show, opened, copied } = await linked()
    await until('vps linked', () => remotes.reachFor('vps')?.live === true)
    const panel = onTab(awayPanel(), 'vps')
    show(panel)
    const press = remotes.submitsThere().away as (one: Panel, choice?: string) => Promise<void>
    await press(panel, AWAY_CONTROLS.code)
    const view = remotes.panel()?.awayThere
    const url = view?.ticket?.url ?? ''
    expect(url.startsWith('https://tade.example.com/pair#t=')).toBe(true)
    expect(view?.code.length).toBeGreaterThan(0)
    const written = (await readDevices(far.home)).pending
    expect(written).toHaveLength(1)
    // Opened and copied from where it is held, never out of anything drawn.
    await press(panel, AWAY_CONTROLS.open)
    expect(opened.some((line) => line.includes(url))).toBe(true)
    await press(panel, AWAY_CONTROLS.copy)
    expect(copied).toEqual([url])
    // Signed out there, it is gone here: there is no code left to scan.
    await press(panel, `${AWAY_CONTROLS.revoke}${written[0]?.id}`)
    expect(remotes.panel()?.awayThere?.ticket).toBeNull()
    expect((await readDevices(far.home)).pending).toEqual([])
    await press(panel, AWAY_CONTROLS.open)
    expect(remotes.panel()?.awayThere?.problem).toBe(
      'That code has run out: press New code for another.',
    )
  })

  it('says a link that is down, and does nothing there on a press', async () => {
    const { far, remotes, until, show } = await linked()
    await until('vps linked', () => remotes.reachFor('vps')?.live === true)
    const panel = onTab(awayPanel(), 'vps')
    show(panel)
    await until('vps answered', () => (remotes.panel()?.awayThere?.there?.asOf ?? null) !== null)
    await far.close()
    await until('vps down', () => remotes.reachFor('vps')?.live !== true)
    const press = remotes.submitsThere().away as (one: Panel, choice?: string) => Promise<void>
    await press(panel, AWAY_CONTROLS.code)
    const view = remotes.panel()?.awayThere
    // Down, as of when it last answered: the devices it listed then stay.
    expect(view?.there).toMatchObject({ name: 'vps', up: false })
    expect(view?.there?.asOf).not.toBeNull()
    expect(view?.devices).toHaveLength(1)
    expect(view?.there?.said).toBe('vps is not linked now, so nothing was done there')
    expect(remotes.panel()?.awayTabs).toEqual([{ name: 'vps', on: false }])
  })

  it('says a Tade too old to answer as that, rather than as a machine with nothing paired', async () => {
    const link = {
      request: async () => ({ status: 404, body: { error: 'no_such' } }),
    } as unknown as RemoteLink
    const aways = new RemoteAways(wiring([]), { reach: () => ({ link, live: true }) })
    aways.looking('box')
    await new Promise((done) => setTimeout(done, 10))
    const machine = { name: 'box', link: 'live' } as Parameters<RemoteAways['view']>[1]
    expect(aways.view('box', machine).there).toMatchObject({
      asOf: null,
      said: 'box runs a Tade that does not show its away view to another machine yet: update it there',
    })
  })

  it('carries only presses its tab has, and answers this machine’s own door at this machine', () => {
    expect(askOf(AWAY_CONTROLS.code)).toEqual({ press: 'code' })
    expect(askOf(AWAY_CONTROLS.all)).toEqual({ press: 'revoke all' })
    expect(askOf(`${AWAY_CONTROLS.revoke}00112233445566aa`)).toEqual({
      press: 'revoke',
      device: '00112233445566aa',
    })
    expect(askOf(`${AWAY_CONTROLS.revoke}../../etc`)).toBeNull()
    expect(askOf(AWAY_CONTROLS.allow)).toBeNull()
  })
})
