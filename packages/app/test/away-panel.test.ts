import { stripTerminalSequences } from '@earendil-works/pi-tui'
import {
  ACTING_IS_NOT_YOU,
  DEVICES_SEEN_BY_AGENTS,
  LAN_IS_PLAINTEXT,
  TALKING_IS_NOT_YOU,
} from '@tade/core'
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
    talking: false,
    talks: TALKING_IS_NOT_YOU,
    devices: [
      {
        id: '00112233445566aa',
        label: 'iPhone',
        pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
        reads: ['titles'],
        mayAct: false,
        mayTalk: false,
        live: true,
      },
    ],
    streams: 1,
    acting: false,
    acts: ACTING_IS_NOT_YOU,
    lan: LAN_IS_PLAINTEXT,
    agents: `${DEVICES_SEEN_BY_AGENTS}, which is why this list shows every device there is.`,
    problem: null,
    ...over,
  }
}

function drawn(
  over: Partial<AwayView> = {},
  size: { width?: number; height?: number; date?: (at: number) => string } = {},
) {
  const ctx = {
    width: size.width ?? 120,
    height: size.height ?? 34,
    skin: skinFor({}, false),
    pointer: { hover: null, pressed: null },
    // A whole ISO string by default, so a golden is a golden — and twenty-odd
    // columns the real window spends on `11 Sep`. A test about **what fits on
    // a row** has to use the shape the window actually draws, or it is a test
    // about this line.
    date: size.date ?? ((at: number) => new Date(at).toISOString()),
    bindings: {},
    away: view(over),
  } as unknown as PanelContext
  return drawPanel(awayPanel(), ctx).panel
}

const said = (
  over?: Partial<AwayView>,
  size?: { width?: number; height?: number; date?: (at: number) => string },
) =>
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
            mayAct: false,
            mayTalk: false,
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

describe('letting one device act', () => {
  it('draws no control for it at all while the setting is off', () => {
    // **Absent, not greyed out.** With `surfaces.web.acting` off there is no
    // route a grant could reach, so a button here would be one that cannot do
    // what it says — and the row is byte-identical to what it was before any
    // of this existed.
    const text = said({}, { height: 56 })
    expect(text).not.toContain('[act]')
    expect(text).not.toContain('may act')
  })

  it('offers it per device once a person has turned acting on', () => {
    // Tall enough that the whole scrolling region is drawn: the code comes
    // first, so on an ordinary terminal the device list is a scroll away and
    // is correct to be.
    const text = said({ acting: true }, { height: 56 })
    expect(text).toContain('[act]')
  })

  it('says which devices may, and offers to take it back from those', () => {
    const text = said(
      {
        acting: true,
        devices: [
          {
            id: '00112233445566aa',
            label: 'iPhone',
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            reads: ['titles'],
            mayAct: true,
            mayTalk: false,
            live: true,
          },
        ],
      },
      { height: 56 },
    )
    // **On the row, in words.** The list is what somebody reads to answer
    // *can any of these change my work*, and a capability visible only as the
    // colour of a button is one nobody audits — and one a screenshot cannot
    // carry. The chip is the same word either way; what changes is its
    // colour, which is the window's own `danger`/`go` pair.
    expect(text).toContain('may act')
    expect(text).toContain('[act]')
  })

  it('says what a device acting is, whole, above the list', () => {
    // The same placement and the same argument as the LAN warning above the
    // code: the moment to read what a device will be able to do is before
    // granting it.
    const text = said({ acting: true }, { height: 56 })
    for (const word of ACTING_IS_NOT_YOU.split(/\s+/)) expect(text, word).toContain(word)
  })

  it('says nothing about acting where it is off, even with a device granted it', () => {
    // A grant that was made and then the setting turned off: the honest
    // drawing is the one that matches what the server will do, which is
    // nothing.
    const text = said(
      {
        acting: false,
        devices: [
          {
            id: '00112233445566aa',
            label: 'iPhone',
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            reads: [],
            mayAct: true,
            mayTalk: false,
            live: false,
          },
        ],
      },
      { height: 56 },
    )
    expect(text).not.toContain('may act')
    for (const word of ['never your own words', 'overrule']) expect(text).not.toContain(word)
  })
})

describe('letting one device talk to Tade', () => {
  it('draws no control for it at all while the setting is off', () => {
    // Absent, not greyed out, and **not implied by acting**: these are two
    // decisions with two settings, and a person who turned the first on has
    // not answered the second.
    const text = said({ acting: true }, { height: 72 })
    expect(text).toContain('[act]')
    expect(text).not.toContain('[talk]')
    expect(text).not.toContain('may talk')
  })

  it('offers it per device once a person has turned talking on', () => {
    const text = said({ talking: true }, { height: 72 })
    expect(text).toContain('[talk]')
  })

  it('says which devices may, and says both where a device has both', () => {
    const text = said(
      {
        acting: true,
        talking: true,
        devices: [
          {
            id: '00112233445566aa',
            label: 'iPhone',
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            reads: ['titles'],
            mayAct: true,
            mayTalk: true,
            live: true,
          },
        ],
      },
      // **The date the window actually draws**, because this is the one test
      // about what fits on a row: a row that fills its width loses its pinned
      // chips whole rather than half-drawn (`Row.build`), and `×` is the chip
      // that must never be the one that goes.
      { height: 72, date: () => '11 Sep' },
    )
    // **Both, on the row, in words.** Two grants is two facts, and a list that
    // folded them into one would be a list somebody reads to answer the wrong
    // question — *can this change my work* and *can this ask Tade for
    // anything* have different answers.
    expect(text).toContain('may act')
    expect(text).toContain('may talk')
    expect(text).toContain('[act]')
    expect(text).toContain('[talk]')
  })

  it('says what a device talking to Tade is, whole, above the list', () => {
    // The whole sentence, never cut: the half that says what the narrowing
    // actually is — a closed list of tools, in code — is the half somebody
    // deciding needs, and the half that would go first.
    const text = said({ talking: true }, { height: 96 })
    for (const word of TALKING_IS_NOT_YOU.split(/\s+/)) expect(text, word).toContain(word)
  })

  it('says nothing about talking where it is off, even with a device granted it', () => {
    const text = said(
      {
        talking: false,
        devices: [
          {
            id: '00112233445566aa',
            label: 'iPhone',
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            reads: [],
            mayAct: false,
            mayTalk: true,
            live: false,
          },
        ],
      },
      { height: 72 },
    )
    expect(text).not.toContain('may talk')
    expect(text).not.toContain('refused in code')
  })
})
