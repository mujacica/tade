import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { ConfigSchema } from '@tade/core'
import { surfaceOf } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { sameTarget, type Target } from '../src/hits.ts'
import { AWAY_CONTROLS, awayPanel } from '../src/panels/away/state.ts'
import { type AwayView, awayLines } from '../src/panels/away/view.ts'
import type { PanelContext } from '../src/panels/context.ts'
import { drawPanel } from '../src/panels/context.ts'
import { COLOUR, type Skin, skinFor } from '../src/skin.ts'
import { awayView, whereFrom } from '../src/wire/web-panel.ts'
import { awayFixture } from './screens/scenarios/away.ts'

// The away panel's two things about one device (`panels/away/cards.ts`): the
// card a device at the door is drawn as, and a paired device's block in the
// list — and `whereFrom`, which says where either came from in words. Beside
// `away-panel.test.ts`, which holds the panel's own rules.

const view = (over: Partial<AwayView> = {}): AwayView => awayFixture(over)

function drawn(
  over: Partial<AwayView> = {},
  size: { height?: number; hover?: Target; skin?: Skin; bindings?: Record<string, string> } = {},
) {
  const ctx = {
    width: 120,
    height: size.height ?? 34,
    skin: size.skin ?? skinFor({}, false),
    pointer: { hover: size.hover ?? null, pressed: null },
    date: (at: number) => new Date(at).toISOString(),
    bindings: size.bindings ?? {},
    away: view(over),
  } as unknown as PanelContext
  return { ctx, panel: drawPanel(awayPanel(), ctx).panel }
}

const said = (over?: Partial<AwayView>, size?: Parameters<typeof drawn>[1]) =>
  drawn(over, size)
    .panel.rows.map((row) => stripTerminalSequences(row))
    .join('\n')

/** The 256-colour ground a painted control's label is drawn on. */
function groundOf(painted: string, label: string): string | undefined {
  const ESC = String.fromCharCode(27)
  const codes = `(?:${ESC}\\[[0-9;]*m)*`
  return painted.match(new RegExp(`${ESC}\\[48;5;(\\d+)m${codes}\\s*${label}`))?.[1]
}

describe('a device at the door', () => {
  const asking = {
    label: 'iPhone',
    from: 'your network',
    address: '192.168.1.42',
    secondsLeft: 47,
    seconds: 60,
  }
  const ALLOW: Target = { kind: 'control', id: AWAY_CONTROLS.allow }
  const DENY: Target = { kind: 'control', id: AWAY_CONTROLS.deny }

  it('is drawn above the code, where a short terminal still shows it', () => {
    // Under twenty rows of code it was scrolled out of sight at the window's
    // ordinary size, which is what made the question look like it never came.
    const text = said({ asking })
    expect(text).toContain('A DEVICE WANTS TO PAIR')
    expect(text.indexOf('A DEVICE WANTS TO PAIR')).toBeLessThan(text.indexOf('█▀▀▀▀▀█'))
    for (const height of [34, 24]) {
      const ids = drawn({ asking }, { height }).panel.hits.map((hit) =>
        hit.target.kind === 'control' ? hit.target.id : '',
      )
      expect(ids, String(height)).toContain(AWAY_CONTROLS.allow)
      expect(ids, String(height)).toContain(AWAY_CONTROLS.deny)
    }
  })

  it('says who, from where in words, that a yes grants everything, and how long is left', () => {
    const text = said({ asking })
    expect(text).toMatch(/iPhone\s+from your network · 192\.168\.1\.42/)
    // Everything, opt-out: said before the press, with where it is taken back.
    expect(text).toMatch(/will get\s+\(full access\)\s+· untick any of it in its row below/)
    // A bar to read from across the room, and a figure to read without colour.
    expect(text).toMatch(/█+░+ 47s left/)
  })

  it('answers in green and red, each with its key as a cap of its own', () => {
    const plain = said({ asking })
    // The key apart from the word, not glued to the front of it.
    expect(plain).toMatch(/\[ a \] \[ Approve \]\s+\[ d \] \[ Refuse \]/)
    expect(plain).not.toContain('a let it in')
    const painted = drawn({ asking }, { skin: COLOUR }).panel.rows.join('\n')
    expect(groundOf(painted, 'Approve')).toBe('114')
    expect(groundOf(painted, 'Refuse')).toBe('203')
    // The cap is part of the control it names: pressing it presses the answer.
    const hits = drawn({ asking }).panel.hits
    const row = (target: Target) => hits.filter((hit) => sameTarget(hit.target, target))
    expect(row(ALLOW).length).toBeGreaterThanOrEqual(2)
    expect(row(DENY).length).toBeGreaterThanOrEqual(2)
  })

  it('draws the keys as they are set, and none where they would not answer', () => {
    const ctx = {
      width: 120,
      height: 60,
      skin: skinFor({}, false),
      pointer: { hover: null, pressed: null },
      date: (at: number) => new Date(at).toISOString(),
      bindings: { approve: 'y', deny: 'n' },
      away: view({ asking }),
    } as unknown as PanelContext
    const panel = drawPanel(awayPanel(), ctx).panel.rows.join('\n')
    expect(panel).toContain('[ y ] [ Approve ]')
    expect(panel).toContain('[ n ] [ Refuse ]')
    // The Settings page walks its settings with the keyboard, so a cap there
    // would be a key that does not do what it says. The answers stay.
    const page = awayLines(view({ asking }), ctx, 70)
      .map((line) => line.text)
      .join('\n')
    expect(page).toContain('[ Approve ]')
    expect(page).not.toContain('[ y ]')
  })
})

describe('a paired device', () => {
  it('is a box per grant, each pressing the control for that grant on that device', () => {
    const hits = drawn({ acting: true, talking: true, configuring: true }, { height: 80 }).panel
      .hits
    for (const control of [
      AWAY_CONTROLS.act,
      AWAY_CONTROLS.agents,
      AWAY_CONTROLS.projects,
      AWAY_CONTROLS.talk,
      AWAY_CONTROLS.configure,
      AWAY_CONTROLS.see,
      AWAY_CONTROLS.settings,
      AWAY_CONTROLS.revoke,
    ]) {
      const id = `${control}00112233445566aa`
      expect(
        hits.some((hit) => hit.target.kind === 'control' && hit.target.id === id),
        id,
      ).toBe(true)
    }
  })

  it('says whether it is connected now, in words and not only in colour', () => {
    const text = said({}, { height: 64 })
    expect(text).toMatch(/● iPhone\s+connected now/)
    expect(text).toMatch(/○ MacBook\s+not connected/)
    expect(text).toContain('DEVICES  2 paired · 1 connected')
  })

  it('keeps sign-out and disconnecting everything grey until they are pointed at', () => {
    // Destructive and not what the panel is for: red on every row was the
    // loudest thing on it.
    const all: Target = { kind: 'control', id: AWAY_CONTROLS.all }
    const rest = drawn({}, { skin: COLOUR }).panel.rows.join('\n')
    const pointed = drawn({}, { skin: COLOUR, hover: all }).panel.rows.join('\n')
    expect(groundOf(rest, 'Disconnect everything')).toBe('238')
    expect(groundOf(pointed, 'Disconnect everything')).toBe('210')
  })
})

describe('where a device came from', () => {
  it('is this machine, in its own name, for a loopback that reached a local name', () => {
    expect(whereFrom('::1', 'localhost:7654', 'this Mac')).toBe('this Mac')
    expect(whereFrom('127.0.0.1', '127.0.0.1:7654', 'this Mac')).toBe('this Mac')
    expect(whereFrom('::ffff:127.0.0.1', '[::1]:7654', 'this machine')).toBe('this machine')
  })

  it('is the name a proxy answered on, never this machine, for a loopback that did not', () => {
    // `tailscale serve` connects from 127.0.0.1: the device is not here.
    expect(whereFrom('127.0.0.1', 'studio.tail1234.ts.net', 'this Mac')).toBe(
      'through studio.tail1234.ts.net',
    )
  })

  it('is your network, Tailscale or outside it for everything else', () => {
    for (const near of [
      '192.168.1.42',
      '10.0.0.7',
      '172.20.1.1',
      '::ffff:192.168.0.2',
      'fd12:3::1',
    ]) {
      expect(whereFrom(near, 'studio.local:7654', 'this Mac'), near).toBe('your network')
    }
    expect(whereFrom('100.101.102.103', 'studio:7654', 'this Mac')).toBe('Tailscale')
    expect(whereFrom('fd7a:115c:a1e0::1', 'studio:7654', 'this Mac')).toBe('Tailscale')
    expect(whereFrom('172.32.0.1', 'studio:7654', 'this Mac')).toBe('outside your network')
    expect(whereFrom('8.8.8.8', 'studio:7654', 'this Mac')).toBe('outside your network')
  })

  it('hands the card the address only where it is somebody else’s', () => {
    const facts = {
      surface: surfaceOf(ConfigSchema.parse({ surfaces: { web: { enabled: true } } }).surfaces.web),
      bound: [],
      listening: true,
      ticket: null,
      devices: [],
      live: new Set<string>(),
      streams: 0,
      problem: null,
      publicAt: null,
      publicTrouble: null,
      health: [],
      now: 1_000,
    }
    const at = (from: string, host: string) =>
      awayView({ ...facts, asking: { ask: { label: 'Mac', from, host }, at: 0 } }).asking
    expect(at('::1', 'localhost:7654')).toMatchObject({ address: '', seconds: 60, secondsLeft: 59 })
    expect(at('::ffff:192.168.1.9', 'studio.local:7654')).toMatchObject({
      from: 'your network',
      address: '192.168.1.9',
    })
  })
})
