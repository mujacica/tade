import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { ConfigSchema } from '@tade/core'
import { surfaceOf } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { awayPanel } from '../src/panels/away/state.ts'
import type { PanelContext } from '../src/panels/context.ts'
import { drawPanel } from '../src/panels/context.ts'
import { skinFor } from '../src/skin.ts'
import { awayView, type PanelFacts } from '../src/wire/web-panel.ts'

// A device row that says a device reads only, where that is why: bound to the
// public name, asked for a passkey there before it acts (`proven`), and with
// none — it missed the minutes after pairing in which one is made. Otherwise it
// looks exactly like a device that was never asked, which is the question about
// a phone somebody is deciding whether to trust (remote-passkeys' leftover).

const PUBLIC = { surfaces: { web: { enabled: true, public: 'tade.example.com' } } }

function device(over: Record<string, unknown> = {}) {
  return {
    id: '00112233445566aa',
    label: 'iPhone',
    digest: 'a'.repeat(64),
    host: 'tade.example.com',
    csrf: 'x'.repeat(43),
    pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
    until: Date.parse('2026-12-11T09:12:00.000Z'),
    scopes: ['read', 'act'],
    projects: null,
    granted: [],
    from: '203.0.113.9',
    revoked: null,
    owner: false,
    passkey: null,
    ...over,
  }
}

function facts(devices: Record<string, unknown>[], config: object = PUBLIC): PanelFacts {
  return {
    surface: surfaceOf(ConfigSchema.parse(config).surfaces.web),
    bound: [],
    listening: true,
    ticket: null,
    asking: null,
    devices: devices as unknown as PanelFacts['devices'],
    live: new Set<string>(),
    streams: 0,
    problem: null,
    publicAt: null,
    publicTrouble: null,
    health: [],
    now: 0,
  }
}

/** The panel drawn over these facts, as the words on its rows. */
function drawn(over: PanelFacts): string {
  const ctx = {
    width: 120,
    height: 64,
    skin: skinFor({}, false),
    pointer: { hover: null, pressed: null },
    date: (at: number) => new Date(at).toISOString(),
    bindings: {},
    away: awayView(over),
  } as unknown as PanelContext
  return drawPanel(awayPanel(), ctx)
    .panel.rows.map((row) => stripTerminalSequences(row))
    .join('\n')
}

describe('a device that may act and, from where it paired, cannot', () => {
  it('says it reads only for want of a passkey', () => {
    expect(awayView(facts([device()])).devices[0]?.readsOnly).toBe(true)
    expect(drawn(facts([device()]))).toContain('reads only: no passkey')
  })

  it('says nothing of the kind where a passkey would add nothing or was never asked', () => {
    const proved = {
      id: 'k',
      key: '',
      alg: -7,
      counter: 0,
      synced: false,
      transports: [],
      at: 1,
      proved: 2,
    }
    const never = {
      surfaces: { web: { enabled: true, public: 'tade.example.com', passkey_hours: 0 } },
    }
    for (const [why, one] of [
      ['a tailnet name, never asked', facts([device({ host: 'studio.yak-bebop.ts.net' })])],
      ['this machine, never asked', facts([device({ host: 'localhost:7654' })])],
      ['one that may only read', facts([device({ scopes: ['read'] })])],
      ['one with a passkey', facts([device({ passkey: proved })])],
      ['a machine that never asks for one', facts([device()], never)],
    ] as const) {
      expect(awayView(one).devices[0]?.readsOnly, why).toBeUndefined()
      expect(drawn(one), why).not.toContain('reads only')
    }
  })
})
