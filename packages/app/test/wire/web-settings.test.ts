import { type Config, ConfigSchema, type SettingGroup, settingsOf } from '@tade/core'
import { type Device, Moved, NotOffered, NotThere, OutOfScope } from '@tade/web'
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
  over: { devices?: readonly Device[]; config?: Config; write?: ConfiguringDeps['write'] } = {},
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
    devices: () => over.devices ?? [device()],
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
  return { half: webConfiguring(deps), wrote }
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

  it('turns a write the door refused into a refusal, not a break', async () => {
    const one = setup({
      write: () => Promise.reject(new Error('the config would not load with that')),
    })
    await expect(one.half.change(EDITOR, REMOTE)).rejects.toBeInstanceOf(NotOffered)
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
