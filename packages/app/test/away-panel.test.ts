import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { DEVICES_SEEN_BY_AGENTS, LAN_IS_PLAINTEXT } from '@tade/core'
import { blocksFor, codeFor } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { AWAY_CONTROLS, awayClick, awayKey, awayPanel } from '../src/panels/away/state.ts'
import type { AwayView } from '../src/panels/away/view.ts'
import type { PanelContext } from '../src/panels/context.ts'
import { drawPanel } from '../src/panels/context.ts'
import { skinFor } from '../src/skin.ts'

// The away panel's rules that no golden can be trusted to notice: that the two
// sentences are drawn whole and cannot be scrolled away, that a code is never
// drawn cut, that the region offers a bar when it scrolls, and that the only
// way to say yes to a device is the key that means yes.
//
// The goldens are `test/screens/__screens__/away-*`; this is what they cannot
// say, because a golden passes on a drawing that is wrong in a way nobody
// wrote down.

const URL = 'http://studio.local:7654/pair#t=Qp3vNn1bXg7kQ2mPvR4tLz8'

function view(over: Partial<AwayView> = {}): AwayView {
  const code = codeFor(URL)
  return {
    listening: true,
    bind: 'loopback',
    bound: ['127.0.0.1:7654', '[::1]:7654'],
    reachable: ['localhost'],
    ticket: { url: URL, secondsLeft: 84 },
    code: code === null ? [] : blocksFor(code),
    asking: null,
    devices: [
      {
        id: '00112233445566aa',
        label: 'iPhone',
        pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
        reads: ['titles'],
        live: true,
      },
    ],
    streams: 1,
    lan: LAN_IS_PLAINTEXT,
    agents: `${DEVICES_SEEN_BY_AGENTS}, which is why this list shows every device there is.`,
    problem: null,
    ...over,
  }
}

function drawn(over: Partial<AwayView> = {}, size: { width?: number; height?: number } = {}) {
  const ctx = {
    width: size.width ?? 120,
    height: size.height ?? 34,
    skin: skinFor({}, false),
    pointer: { hover: null, pressed: null },
    date: (at: number) => new Date(at).toISOString(),
    bindings: {},
    away: view(over),
  } as unknown as PanelContext
  return drawPanel(awayPanel(), ctx).panel
}

const said = (over?: Partial<AwayView>, size?: { width?: number; height?: number }) =>
  drawn(over, size)
    .rows.map((row) => stripTerminalSequences(row))
    .join('\n')

describe('the two sentences', () => {
  it('draws the LAN one whole, on the bind that earns it', () => {
    const text = said({ bind: 'lan', reachable: ['192.168.1.10'] })
    // Whole, in the words the domain says once: a warning cut at *anybody on
    // the same* is a warning that stopped being one.
    for (const word of LAN_IS_PLAINTEXT.split(/\s+/)) expect(text, word).toContain(word)
  })

  it('does not say it on a loopback bind, where it is not true', () => {
    expect(said()).not.toContain('same wifi')
  })

  it('draws the one about this machine’s agents however short the window is', () => {
    // In the foot, which is never scrolled: the device list is the mitigation
    // and the sentence is what says so, and a person who cannot see it is a
    // person who was not told.
    for (const height of [40, 24, 14, 10]) {
      expect(said({}, { height }), String(height)).toContain('could pair itself')
    }
  })

  it('keeps Disconnect everything reachable at every height', () => {
    for (const height of [40, 24, 14, 10]) {
      const ids = drawn({}, { height }).hits.map((hit) =>
        hit.target.kind === 'control' ? hit.target.id : '',
      )
      expect(ids, String(height)).toContain(AWAY_CONTROLS.all)
    }
  })
})

describe('the code', () => {
  it('is drawn when there is room for it', () => {
    expect(said()).toContain('█')
  })

  it('is never drawn cut, and says why not', () => {
    // A QR with its right-hand side missing scans as nothing while looking
    // exactly like one that works, which is the single worst thing this panel
    // could draw.
    const text = said({}, { width: 40 })
    expect(text).toContain('too narrow')
    expect(text).not.toContain('█▀▀▀▀▀█')
    // The address is still there, whole, over as many lines as it takes: it is
    // the half a narrow window can carry, and a cut address is no address.
    const joined = text
      .split('\n')
      .map((line) => line.replace(/^.*?│/, '').replace(/│.*$/, '').trim())
      .join('')
    expect(joined).toContain(URL)
  })

  it('says there is no network rather than offering a code nobody can reach', () => {
    const text = said({ bind: 'lan', reachable: [] })
    expect(text).toContain('No network')
    expect(text).not.toContain('/pair#t=')
  })

  it('says nothing is listening when nothing is, and offers no code', () => {
    const text = said({ listening: false, bound: [], ticket: null, code: [] })
    expect(text).toContain('Nothing is listening')
    expect(text).toContain('Settings → Away view')
  })
})

describe('what scrolls', () => {
  it('offers a bar when the region has more than it can draw', () => {
    const bars = drawn({}, { height: 24 }).hits.filter((hit) => hit.target.kind === 'scrollbar')
    // How much is in view is the rows the region drew, so a region with more
    // than that offers the one move everything else in the window offers.
    expect(bars.length).toBeGreaterThan(0)
  })

  it('cuts nothing to fit: no `+n more` anywhere', () => {
    expect(said({}, { height: 12 })).not.toMatch(/\+\d+ more/)
  })
})

describe('answering the device at the door', () => {
  it('says yes only on the key that means yes', () => {
    const panel = awayPanel()
    expect(awayKey(panel, 'a', { bindings: {} })).toMatchObject({
      submit: true,
      choice: AWAY_CONTROLS.allow,
    })
    expect(awayKey(panel, 'd', { bindings: {} })).toMatchObject({
      submit: true,
      choice: AWAY_CONTROLS.deny,
    })
    // Escape and enter close and answer nothing: a pairing refused by accident
    // is a code to mint again, and one allowed by accident is a device in your
    // control room.
    for (const key of ['escape', 'enter']) {
      expect(awayKey(panel, key, { bindings: {} })).toEqual({ panel: null, submit: false })
    }
  })

  it('uses the window’s own keys, as they are set', () => {
    const panel = awayPanel()
    expect(awayKey(panel, 'y', { bindings: { approve: 'y', deny: 'n' } })).toMatchObject({
      choice: AWAY_CONTROLS.allow,
    })
    // And the default key is then not the key: one pair of keys, as set.
    expect(awayKey(panel, 'a', { bindings: { approve: 'y', deny: 'n' } })).toMatchObject({
      submit: false,
    })
  })

  it('reads down the devices, and only once somebody has', () => {
    const panel = awayPanel()
    expect(panel.moved).toBe(false)
    const after = awayKey(panel, 'down', { devices: 3 })
    expect(after.panel).toMatchObject({ kind: 'away', chosen: 1, moved: true })
    // Clamped to the list: a chosen row past the end is a row nothing draws.
    expect(awayKey({ ...panel, chosen: 2 }, 'down', { devices: 3 }).panel).toMatchObject({
      chosen: 2,
    })
  })

  it('hands every other control through, and keeps the panel open', () => {
    expect(awayClick(awayPanel(), AWAY_CONTROLS.all)).toMatchObject({
      submit: true,
      choice: AWAY_CONTROLS.all,
    })
    expect(awayClick(awayPanel(), 'close')).toEqual({ panel: null, submit: false })
  })
})

describe('what the panel never carries', () => {
  it('says nothing of a device but its label, its grant and when it paired', () => {
    const text = said(
      {
        devices: [
          {
            id: '00112233445566aa',
            label: 'iPhone',
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            reads: [],
            live: false,
          },
        ],
      },
      // Tall enough that the whole region is drawn: the code comes first,
      // because it is what somebody opened this for, so on an ordinary
      // terminal the device list is a scroll away and is correct to be.
      { height: 56 },
    )
    // Not its address and not its digest: what another device is, from here,
    // is a name and a date.
    expect(text).toContain('iPhone')
    expect(text).toContain('names and counts')
    expect(text).not.toContain('192.168')
  })
})
