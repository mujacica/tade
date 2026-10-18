import { type Config, ConfigSchema, type SettingGroup, settingsOf } from '@tade/core'
import { type Device, GRANTS, Moved, NotOffered, NotThere, OutOfScope, SCOPES } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { type ConfiguringDeps, webConfiguring } from '../../src/wire/web-settings.ts'

// The window's end of a change from away, with everything it re-checks at the
// write: who is asking **now**, how far a device reaches, the value it echoed,
// the schema, and who the record says did it.
//
// **The rows are `settingsOf`'s own**, and the write is recorded rather than
// performed: `away-settings.test.ts` drives the real `Settings.write` through a
// real listener. This file is the table of what is refused before it, which
// through HTTP would be a request per row.

const DEVICE = '00112233445566aa'
const KEY = 'jev_live_7fd1c0a9e2b84f6d93a51c2e8b7d4f00'

function device(over: Partial<Device> = {}): Device {
  return {
    id: DEVICE,
    label: 'iPhone',
    pairedAt: 0,
    until: Date.now() + 86_400_000,
    digest: '',
    host: '127.0.0.1:7654',
    csrf: '',
    scopes: ['read', 'configure'],
    projects: null,
    granted: ['settings'],
    revoked: null,
    from: '127.0.0.1',
    ...over,
  } as Device
}

function setup(
  over: {
    devices?: readonly Device[] | (() => readonly Device[])
    config?: Config
    write?: ConfiguringDeps['write']
  } = {},
) {
  let config =
    over.config ??
    ConfigSchema.parse({
      projects: { app: { root: '/src/app' }, ledger: { root: '/src/ledger' } },
      surfaces: { window: { editor: 'code' } },
    })
  const rows = (): SettingGroup[] =>
    settingsOf(config, [
      { path: 'extensions.jev.key', title: 'Jev API key', means: '', value: KEY, from: null },
    ])
  const wrote: { path: string; value: string; by: string }[] = []
  const deps: ConfiguringDeps = {
    configuring: () => true,
    devices: () =>
      typeof over.devices === 'function' ? over.devices() : (over.devices ?? [device()]),
    rows,
    known: () => [],
    write:
      over.write ??
      (async (path, value, by) => {
        wrote.push({ path, value, by })
        // What the real door does to what the window holds: the next read is
        // of the new value.
        if (path === 'surfaces.window.editor') {
          config = ConfigSchema.parse({
            ...config,
            surfaces: { ...config.surfaces, window: { ...config.surfaces.window, editor: value } },
          })
        }
        return 'Saved. It applies now.'
      }),
  }
  return { half: webConfiguring(deps), wrote, rows }
}

const REMOTE = { how: 'remote', device: DEVICE } as const
const EDITOR = { path: 'surfaces.window.editor', was: 'code', value: 'zed' }

describe('who is asking, read at the write', () => {
  it('writes as the device, never as the window or the person', async () => {
    const one = setup()
    const outcome = await one.half.change(EDITOR, REMOTE)
    expect(one.wrote).toEqual([
      { path: 'surfaces.window.editor', value: 'zed', by: `device ${DEVICE}` },
    ])
    expect(outcome).toEqual({ did: true, rev: 'zed', said: 'Editor: Saved. It applies now.' })
  })

  it('refuses a change that claims to be the person at the machine', async () => {
    // The keyboard's door is the Settings page; nothing local ever comes this
    // way, so one that does is refused rather than quietly allowed.
    const one = setup()
    await expect(one.half.change(EDITOR, { how: 'local' })).rejects.toBeInstanceOf(OutOfScope)
    expect(one.wrote).toEqual([])
  })

  it('refuses a device revoked, narrowed or never granted since the request came in', async () => {
    const cases: [string, Device[]][] = [
      ['gone', []],
      ['revoked', [device({ revoked: new Date().toISOString() } as Partial<Device>)]],
      ['no configure', [device({ scopes: ['read', 'answer', 'steer'] })]],
      ['no settings grant', [device({ granted: ['titles', 'lanes'] })]],
    ]
    for (const [why, devices] of cases) {
      const one = setup({ devices })
      await expect(one.half.change(EDITOR, REMOTE), why).rejects.toBeInstanceOf(OutOfScope)
      expect(one.wrote, why).toEqual([])
    }
  })

  it('holds the per-project boundary against the record now', async () => {
    const one = setup({ devices: [device({ projects: ['app'] })] })
    const ledger = { path: 'projects.ledger.push', was: '', value: 'branch' }
    await expect(one.half.change(ledger, REMOTE)).rejects.toBeInstanceOf(OutOfScope)
    const app = { path: 'projects.app.push', was: '', value: 'branch' }
    await expect(one.half.change(app, REMOTE)).resolves.toMatchObject({ did: true })
    expect(one.wrote.map((wrote) => wrote.path)).toEqual(['projects.app.push'])
  })
})

describe('how far a device reaches, asked of core again', () => {
  it('refuses the asked and never tiers even if a call got this far', async () => {
    // The parse already refuses these; this is the window not taking that on
    // trust, because the tier is core's decision and asking again costs a call.
    for (const path of [
      'checks.before',
      'agents.commit',
      'approvals.mode',
      'surfaces.web.acting',
    ]) {
      const one = setup()
      await expect(
        one.half.change({ path, was: '', value: 'x' }, REMOTE),
        path,
      ).rejects.toBeInstanceOf(NotOffered)
      expect(one.wrote, path).toEqual([])
    }
  })

  it('refuses a setting the window does not list', async () => {
    const one = setup()
    const ghost = { path: 'projects.ghost.push', was: '', value: 'branch' }
    await expect(one.half.change(ghost, REMOTE)).rejects.toBeInstanceOf(NotThere)
  })
})

describe('the value, against the row the window lists now', () => {
  it('refuses a change from a screen drawn against another value, and says what it is', async () => {
    const one = setup()
    const stale = one.half.change({ ...EDITOR, was: 'vim' }, REMOTE)
    await expect(stale).rejects.toBeInstanceOf(Moved)
    await expect(stale).rejects.toMatchObject({ rev: 'code' })
    expect(one.wrote).toEqual([])
  })

  it('refuses a value the schema would refuse, before anything is written', async () => {
    const one = setup()
    await expect(
      one.half.change({ ...EDITOR, value: 'notepad.exe' }, REMOTE),
    ).rejects.toBeInstanceOf(NotOffered)
    await expect(
      one.half.change({ path: 'surfaces.window.sidebar_width', was: '', value: 'wide' }, REMOTE),
    ).rejects.toBeInstanceOf(NotOffered)
    // A choice is one of its options exactly, not a word near one.
    await expect(one.half.change({ ...EDITOR, value: ' zed' }, REMOTE)).rejects.toBeInstanceOf(
      NotOffered,
    )
    expect(one.wrote).toEqual([])
  })

  it('says nothing changed where the value was already that', async () => {
    const one = setup()
    const outcome = await one.half.change({ ...EDITOR, value: 'code' }, REMOTE)
    expect(outcome.did).toBe(false)
    expect(one.wrote).toEqual([])
  })

  it('lets a write that failed after every check say so, rather than calling it a refusal', async () => {
    // Every reason a value could be refused is asked before the write, so a
    // throw from the door is the machine, and it is not dressed up as a `404`:
    // `carryChange` turns it into `broke` with the detail in a warning.
    const broke = new Error('the config would not load with that')
    const one = setup({ write: () => Promise.reject(broke) })
    await expect(one.half.change(EDITOR, REMOTE)).rejects.toBe(broke)
  })

  it('carries one change at a time, so two from away cannot both read the old value', async () => {
    // Two phones, one screen each, both drawn against `code`. The first lands;
    // the second meets the value the first wrote and is refused with it.
    const one = setup()
    const first = one.half.change(EDITOR, REMOTE)
    const second = one.half.change({ ...EDITOR, value: 'vim' }, REMOTE)
    await expect(first).resolves.toMatchObject({ did: true })
    await expect(second).rejects.toMatchObject({ rev: 'zed' })
    expect(one.wrote.map((wrote) => wrote.value)).toEqual(['zed'])
  })
})

describe('a key, which is never read and never set from here', () => {
  it('refuses the key, whatever it is sent, because it is changed at the machine', async () => {
    const one = setup()
    for (const value of ['', 'sk-something-else']) {
      await expect(
        one.half.change({ path: 'extensions.jev.key', was: 'set', value }, REMOTE),
        value,
      ).rejects.toBeInstanceOf(NotOffered)
    }
    expect(one.wrote).toEqual([])
  })
})

describe('the person’s own device, which changes any setting as the keyboard does', () => {
  // Full access — every scope and every reading grant — and not a machine
  // link: what pairing gives unless something is unticked (`theirsOf`).
  const theirs = (over: Partial<Device> = {}) =>
    device({ scopes: [...SCOPES], granted: [...GRANTS], owner: false, ...over })
  const value = (one: ReturnType<typeof setup>, path: string) =>
    one
      .rows()
      .flatMap((group) => group.settings)
      .find((row) => row.path === path)?.value ?? ''

  it('changes an asked and a never setting, written under the device', async () => {
    for (const path of ['agents.commit', 'approvals.mode']) {
      const one = setup({ devices: [theirs()] })
      const row = one
        .rows()
        .flatMap((group) => group.settings)
        .find((it) => it.path === path)
      const other = row?.type.kind === 'choice' ? row.type.options.find((o) => o !== row.value) : ''
      if (other === undefined || other === '') throw new Error(`no other value for ${path}`)
      await expect(
        one.half.change({ path, was: value(one, path), value: other }, REMOTE),
        path,
      ).resolves.toMatchObject({ did: true })
      // **Under the device**, never `you`: the record says it came from the phone.
      expect(one.wrote, path).toEqual([{ path, value: other, by: `device ${DEVICE}` }])
    }
  })

  it('sets a key it was never shown, echoing only whether one is held', async () => {
    const one = setup({ devices: [theirs()] })
    const next = 'jev_live_00000000000000000000000000000000'
    await expect(
      one.half.change({ path: 'extensions.jev.key', was: 'set', value: next }, REMOTE),
    ).resolves.toMatchObject({ did: true, rev: 'set' })
    expect(one.wrote).toEqual([{ path: 'extensions.jev.key', value: next, by: `device ${DEVICE}` }])
    // And the key itself is still not the thing a change echoes.
    await expect(
      one.half.change({ path: 'extensions.jev.key', was: KEY, value: next }, REMOTE),
    ).rejects.toBeInstanceOf(Moved)
  })

  it('is an ordinary device again the moment it is revoked or anything is unticked', async () => {
    // **Read at the write**, against the record now: the same request that
    // went through a second ago is refused once the panel changed the record.
    const commit = (one: ReturnType<typeof setup>) => ({
      path: 'agents.commit',
      was: value(one, 'agents.commit'),
      value: 'never',
    })
    const revoked = setup({ devices: [theirs({ revoked: new Date().toISOString() })] })
    await expect(revoked.half.change(commit(revoked), REMOTE)).rejects.toBeInstanceOf(OutOfScope)
    const cases: [string, Device][] = [
      ['one scope unticked', theirs({ scopes: SCOPES.filter((scope) => scope !== 'agents') })],
      ['one grant unticked', theirs({ granted: GRANTS.filter((grant) => grant !== 'spend') })],
      // A machine link reaches as far in a turn, but its words may be another
      // machine's model's, and the Settings page is never one.
      ['a machine link', theirs({ owner: true })],
    ]
    for (const [why, held] of cases) {
      const one = setup({ devices: [held] })
      await expect(one.half.change(commit(one), REMOTE), why).rejects.toBeInstanceOf(NotOffered)
      await expect(
        one.half.change({ path: 'extensions.jev.key', was: 'set', value: 'x' }, REMOTE),
        why,
      ).rejects.toBeInstanceOf(NotOffered)
      expect(one.wrote, why).toEqual([])
    }
    // Revoked between two presses of the same phone: the first lands, the
    // second does not.
    let devices: Device[] = [theirs()]
    const flipping = setup({ devices: () => devices })
    await expect(flipping.half.change(commit(flipping), REMOTE)).resolves.toMatchObject({
      did: true,
    })
    devices = [theirs({ revoked: new Date().toISOString() })]
    await expect(flipping.half.change(commit(flipping), REMOTE)).rejects.toBeInstanceOf(OutOfScope)
    expect(flipping.wrote.length).toBe(1)
  })
})
