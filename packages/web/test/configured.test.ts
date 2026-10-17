import { readFileSync } from 'node:fs'
import { ConfigSchema, settingReach, settingsOf } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { type From, Moved, NotOffered, NotThere, type Outcome, OutOfScope } from '../src/acting.ts'
import {
  admitSetting,
  CHANGES,
  type Configured,
  carryChange,
  readSettingChange,
} from '../src/configured.ts'
import type { SettingCall, WebConfiguring } from '../src/configuring.ts'
import type { Reach } from '../src/reach.ts'
import { Receipts, readReceipts } from '../src/receipts.ts'
import type { Scope, Surface } from '../src/surface.ts'
import { homeFor } from './harness.ts'

// One setting changed from away, end to end, with a real receipt store on disk
// and a window that answers whatever the test wants it to — the sibling of
// `drafted.test.ts`, and with no sockets for the same reason.
//
// **The tier matrix is the point.** Every path Settings draws is put through
// the door, and what comes out is decided by `settingReach` alone: `open` goes
// through to the window, `asked` and `never` never reach it, never claim a key,
// and are written down as refused under the device that asked.

const SURFACE: Surface = {
  enabled: true,
  bind: 'loopback',
  port: 7654,
  trustedHosts: [],
  publicName: null,
  passkeyMs: 0,
  acting: false,
  talking: false,
  drafting: false,
  configuring: true,
  installing: false,
  keepsView: false,
  pushing: false,
  pushDetails: false,
}

const DEVICE = '00112233445566aa'

const BODY = {
  path: 'surfaces.window.editor',
  was: 'code',
  value: 'zed',
  confirm: true,
  key: 'abcdefgh12345678',
  rev: 4,
}

/** A window that does what the test says, and remembers being asked. */
function window_(
  over: { change?: (call: SettingCall, from: From) => Promise<Outcome>; unlocked?: boolean } = {},
): { configuring: WebConfiguring; calls: { call: SettingCall; from: From }[] } {
  const calls: { call: SettingCall; from: From }[] = []
  return {
    calls,
    configuring: {
      unlocked: () => over.unlocked ?? true,
      change: (call, from) => {
        calls.push({ call, from })
        return (
          over.change?.(call, from) ??
          Promise.resolve<Outcome>({ did: true, rev: call.value, said: 'Editor: Saved.' })
        )
      },
    },
  }
}

function granted(over: Partial<Reach> = {}): Reach {
  return { device: DEVICE, projects: { kind: 'every' }, granted: ['settings'], ...over }
}

async function context(
  configuring: WebConfiguring,
  over: Partial<Configured> = {},
  what = 'configured',
): Promise<Configured> {
  const home = await homeFor(what)
  const receipts = new Receipts({ home, epoch: 'one' })
  await receipts.open()
  return {
    configuring,
    receipts,
    surface: SURFACE,
    unlocked: true,
    rev: 4,
    reach: granted(),
    scopes: ['read', 'configure'] as readonly Scope[],
    origin: { scheme: 'http', host: '127.0.0.1', listener: 'loopback' },
    device: DEVICE,
    now: Date.parse('2026-10-11T14:30:00.000Z'),
    request: 'req_1',
    ...over,
  }
}

/** Every path Settings draws, with credentials and two projects in it. */
function everyPath(): string[] {
  const config = ConfigSchema.parse({
    projects: { app: { root: '/src/app' }, ledger: { root: '/src/ledger' } },
    extensions: { sentry: {} },
  })
  const groups = settingsOf(config, [
    { path: 'extensions.jev.key', title: 'Jev API key', means: '', value: 'k', from: null },
    { path: 'accounts.work.key', title: 'Work API key', means: '', value: 'k', from: null },
  ])
  return groups.flatMap((group) => group.settings.map((setting) => setting.path))
}

/** Paths no setting on the page has, crafted at each `never` subtree. */
const CRAFTED_NEVER = [
  'approvals.mode',
  'approvals.rules',
  'accounts.work.key',
  'accounts.work.harness',
  'workers.routes.default.provider',
  'extensions.sentry.enabled',
  'extensions.jev.key',
  'mcp.servers.github.enabled',
  'orchestrator.extensions',
  'telemetry.dsn',
  'projects.app.root',
  'surfaces.web.enabled',
  'surfaces.web.acting',
  'surfaces.web.settings',
  'surfaces.web.push_key',
  'surfaces.web.trusted_hosts',
  'surfaces.intake.enabled',
]

describe('the tier matrix, over every setting there is', () => {
  it('lets a path through only where settingReach says open', () => {
    const tiers = { open: 0, asked: 0, never: 0 }
    for (const path of [...everyPath(), ...CRAFTED_NEVER]) {
      const tier = settingReach(path).reach
      tiers[tier] += 1
      const read = readSettingChange({ ...BODY, path })
      if (tier === 'open') {
        expect(read.ok, path).toBe(true)
      } else {
        // **Not a change at all**: there is no `Changing` for it to be.
        expect(read, path).toEqual({ ok: false, why: 'out_of_reach', path })
      }
    }
    // All three tiers were actually asked, so a passing run is not one where
    // every path happened to land in one of them.
    expect(tiers.open).toBeGreaterThan(0)
    expect(tiers.asked).toBeGreaterThan(10)
    expect(tiers.never).toBeGreaterThan(10)
  })

  it('never reaches the window, never claims a key, and writes the refusal down', async () => {
    for (const path of [...everyPath(), ...CRAFTED_NEVER]) {
      if (settingReach(path).reach === 'open') continue
      const one = window_()
      const ctx = await context(one.configuring, {}, 'configured-matrix')
      const answered = await carryChange('change', { ...BODY, path }, ctx)
      // The `404` of a path nobody built: an off capability is not a thing to
      // probe, and the tier's name is not on the wire.
      expect(answered.refusal?.status, path).toBe(404)
      expect(answered.refusal?.error, path).toBe('not_offered')
      expect(one.calls, path).toEqual([])
      // And it is in the journal under the device, naming what it asked for.
      expect(answered.did.device, path).toBe(DEVICE)
      expect(answered.did.tool, path).toBe('setting')
      expect(answered.did.task, path).toBe(path)
      expect(answered.did.state, path).toBe('refused')
    }
  })

  it('claims no key for a path out of reach, so a replay cannot be one either', async () => {
    const home = await homeFor('configured-nokey')
    const receipts = new Receipts({ home, epoch: 'one' })
    await receipts.open()
    const ctx = await context(window_().configuring, { receipts })
    await carryChange('change', { ...BODY, path: 'approvals.mode', value: 'bypass' }, ctx)
    expect((await readReceipts(home)).receipts).toEqual([])
    // And the same store does record a change that was in reach, so the line
    // above is about the tier and not about a store that writes nothing.
    await carryChange('change', BODY, ctx)
    expect((await readReceipts(home)).receipts.length).toBeGreaterThan(0)
  })

  it('refuses the asked tier however the request is worded', async () => {
    // The tier passed by the person's own words — and a device has none to
    // bring. Nothing a body can carry changes that: there is no `said` field,
    // and one would fail the strict parse.
    for (const path of ['checks.before', 'agents.commit', 'agents.push', 'projects.app.title']) {
      expect(readSettingChange({ ...BODY, path }).ok, path).toBe(false)
      expect(readSettingChange({ ...BODY, path, said: `please change ${path}` }).ok, path).toBe(
        false,
      )
    }
  })
})

describe('reading a change out of a body', () => {
  it('takes the six fields and nothing else', () => {
    const read = readSettingChange(BODY)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.changing.path).toBe('surfaces.window.editor')
    expect(read.changing.project).toBeNull()
    expect(read.changing.said).toBe('changed surfaces.window.editor')
    // Tade's own words never carry the value.
    expect(read.changing.said).not.toContain('zed')
  })

  it('refuses a field nobody declared, and a body that does not mean it', () => {
    for (const extra of ['scope', 'scopes', 'setting', 'device', 'said', 'grant', 'file']) {
      expect(readSettingChange({ ...BODY, [extra]: 'x' }), extra).toEqual({
        ok: false,
        why: 'malformed',
      })
    }
    for (const confirm of [false, 'true', 1, undefined]) {
      expect(readSettingChange({ ...BODY, confirm }).ok, String(confirm)).toBe(false)
    }
  })

  it('refuses anything shaped like a path to a file', () => {
    for (const path of ['../config.yaml', '/etc/passwd', 'a/b.c', 'surfaces..window', '', 'X.y']) {
      expect(readSettingChange({ ...BODY, path }), path).toEqual({ ok: false, why: 'malformed' })
    }
  })

  it('names the project a project setting belongs to', () => {
    const read = readSettingChange({ ...BODY, path: 'projects.app.push', was: '', value: 'branch' })
    expect(read.ok && read.changing.project).toBe('app')
  })
})

describe('the gate, re-asked at every change', () => {
  const changing = () => {
    const read = readSettingChange(BODY)
    if (!read.ok) throw new Error('the body')
    return read.changing
  }

  it('is locked when the setting is off now, whatever the table was built with', async () => {
    const ctx = await context(window_().configuring)
    expect(admitSetting(changing(), { ...ctx, unlocked: false })).toMatchObject({ ok: false })
    expect(
      admitSetting(changing(), { ...ctx, surface: { ...SURFACE, configuring: false } }),
    ).toMatchObject({ ok: false, refusal: { error: 'locked' } })
  })

  it('needs configure, which no other scope implies', async () => {
    const ctx = await context(window_().configuring)
    const every: Scope[] = ['read', 'answer', 'steer', 'ask', 'draft', 'agents', 'projects']
    expect(admitSetting(changing(), { ...ctx, scopes: every })).toMatchObject({
      ok: false,
      refusal: { error: 'out_of_scope' },
    })
    expect(admitSetting(changing(), ctx)).toEqual({ ok: true })
  })

  it('needs the settings reading grant beside it', async () => {
    // A device may not change what it was not allowed to see.
    const ctx = await context(window_().configuring)
    expect(
      admitSetting(changing(), { ...ctx, reach: granted({ granted: ['titles', 'lanes'] }) }),
    ).toMatchObject({ ok: false, refusal: { error: 'out_of_scope' } })
  })

  it('holds the per-project boundary for a project setting', async () => {
    const ctx = await context(window_().configuring)
    const read = readSettingChange({ ...BODY, path: 'projects.ledger.push', was: '' })
    if (!read.ok) throw new Error('the body')
    const listed = granted({ projects: { kind: 'listed', names: ['app'] } })
    expect(admitSetting(read.changing, { ...ctx, reach: listed })).toMatchObject({
      ok: false,
      refusal: { error: 'out_of_scope' },
    })
    // A machine-wide setting has no project to hold it to.
    expect(admitSetting(changing(), { ...ctx, reach: listed })).toEqual({ ok: true })
  })

  it('needs a trusted origin, re-asked here because the network changes', async () => {
    const ctx = await context(window_().configuring)
    expect(
      admitSetting(changing(), {
        ...ctx,
        origin: { scheme: 'http', host: '192.168.1.20', listener: 'public' },
      }),
    ).toMatchObject({ ok: false, refusal: { error: 'locked' } })
  })

  it('refuses a screen from too long ago, and one from the future', async () => {
    const ctx = await context(window_().configuring)
    expect(admitSetting({ ...changing(), rev: 5 }, ctx)).toMatchObject({
      refusal: { error: 'stale' },
    })
    expect(admitSetting({ ...changing(), rev: 0 }, { ...ctx, rev: 400 })).toMatchObject({
      refusal: { error: 'stale' },
    })
  })
})

describe('a change, carried out', () => {
  it('reaches the window as the device that asked, never as the person', async () => {
    const one = window_()
    const ctx = await context(one.configuring)
    const answered = await carryChange('change', BODY, ctx)
    expect(answered.refusal).toBeNull()
    expect(answered.body).toEqual({ did: true, rev: 'zed', said: 'Editor: Saved.' })
    expect(one.calls).toEqual([
      {
        call: { path: 'surfaces.window.editor', was: 'code', value: 'zed' },
        from: { how: 'remote', device: DEVICE },
      },
    ])
    expect(answered.did).toEqual({
      device: DEVICE,
      tool: 'setting',
      task: 'surfaces.window.editor',
      state: 'changed surfaces.window.editor',
      why: 'done',
    })
  })

  it('puts a project setting’s project on its journal line', async () => {
    const one = window_()
    const ctx = await context(one.configuring)
    const body = { ...BODY, path: 'projects.app.push', was: '', value: 'branch' }
    const answered = await carryChange('change', body, ctx)
    expect(answered.did.project).toBe('app')
  })

  it('answers a repeat out of the record and changes nothing twice', async () => {
    const one = window_()
    const ctx = await context(one.configuring)
    const first = await carryChange('change', BODY, ctx)
    const again = await carryChange('change', BODY, ctx)
    expect(first.body).toEqual(again.body)
    expect(again.did.why).toBe('already changed')
    expect(one.calls).toHaveLength(1)
  })

  it('refuses a key bound to another value, which is a captured request edited', async () => {
    const one = window_()
    const ctx = await context(one.configuring)
    await carryChange('change', BODY, ctx)
    const edited = await carryChange('change', { ...BODY, value: 'vim' }, ctx)
    expect(edited.refusal?.error).toBe('reused')
    expect(one.calls).toHaveLength(1)
  })

  it('turns what the window found into the refusal it is', async () => {
    const cases: [Error, string][] = [
      [new Moved('it moved', 'cursor'), 'gone'],
      [new NotThere('no such setting'), 'no_such'],
      [new NotOffered('needs a number'), 'not_offered'],
      [new OutOfScope('that device is not paired'), 'out_of_scope'],
    ]
    for (const [error, kind] of cases) {
      const one = window_({ change: () => Promise.reject(error) })
      const ctx = await context(one.configuring, {}, `configured-${kind}`)
      const answered = await carryChange('change', BODY, ctx)
      expect(answered.refusal?.error, kind).toBe(kind)
      expect(answered.did.state, kind).toBe('refused')
      expect(answered.warning, kind).toBeNull()
    }
    // What is true now goes back with a `gone`, so the page draws the truth.
    const moved = window_({ change: () => Promise.reject(new Moved('it moved', 'cursor')) })
    const ctx = await context(moved.configuring, {}, 'configured-moved')
    expect((await carryChange('change', BODY, ctx)).refusal?.rev).toBe('cursor')
  })

  it('says a throw is broken, with the detail for the person at the machine only', async () => {
    const one = window_({ change: () => Promise.reject(new Error('disk full at /Users/kim')) })
    const ctx = await context(one.configuring)
    const answered = await carryChange('change', BODY, ctx)
    expect(answered.refusal?.error).toBe('broke')
    expect(answered.refusal?.said).not.toContain('/Users/kim')
    expect(answered.warning).toContain('disk full')
  })

  it('is a 404 for a name the table does not have', async () => {
    const one = window_()
    const ctx = await context(one.configuring)
    expect((await carryChange('set', BODY, ctx)).refusal?.error).toBe('no_such')
    expect(one.calls).toEqual([])
  })
})

describe('what a change can never be, in the code rather than the sentence', () => {
  it('declares exactly the one method the changing table has, and nothing else', () => {
    // Both directions, as `WebDrafting` is held to `SAVINGS`. The direction
    // that matters is a method being added: a `read` here would be a key one
    // route away, and a `grant` the authority deciding about itself.
    const text = readFileSync(new URL('../src/configuring.ts', import.meta.url), 'utf8')
    const block = /export interface WebConfiguring \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
    expect(block, 'the WebConfiguring block').not.toBe('')
    const methods = [...block.matchAll(/^ {2}([a-z][A-Za-z]*)\(/gm)].map((one) => one[1])
    expect(methods.filter((one) => one !== 'unlocked')).toEqual(Object.keys(CHANGES))
  })

  it('takes no path to a file, no command and no grant in a change’s body', () => {
    const every = {
      path: 'surfaces.window.editor',
      was: 'code',
      value: 'zed',
      confirm: true,
      key: 'abcdefgh12345678',
      rev: 0,
    }
    expect(readSettingChange(every).ok).toBe(true)
    for (const name of ['file', 'cwd', 'cmd', 'command', 'prompt', 'scopes', 'grant', 'said']) {
      expect(readSettingChange({ ...every, [name]: 'anything' }).ok, name).toBe(false)
    }
    for (const path of ['../../config.yaml', '/etc/passwd', 'a/b', '~/x']) {
      expect(readSettingChange({ ...every, path }).ok, path).toBe(false)
    }
  })
})
