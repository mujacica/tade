import { stripTerminalSequences } from '@earendil-works/pi-tui'
import {
  ACTING_IS_NOT_YOU,
  ACTING_IS_NOT_YOU_SHORT,
  ConfigSchema,
  DEVICES_SEEN_BY_AGENTS,
  LAN_IS_PLAINTEXT_SHORT,
  PUBLIC_IS_THE_INTERNET_SHORT,
  TALKING_IS_NOT_YOU,
  TALKING_IS_NOT_YOU_SHORT,
} from '@tade/core'
import { blocksFor, codeFor, surfaceOf } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { sameTarget, type Target } from '../src/hits.ts'
import { AWAY_CONTROLS, awayClick, awayKey, awayPanel } from '../src/panels/away/state.ts'
import type { AwayView } from '../src/panels/away/view.ts'
import type { PanelContext } from '../src/panels/context.ts'
import { drawPanel } from '../src/panels/context.ts'
import { settingsClick, settingsPanel } from '../src/panels/settings/state.ts'
import { COLOUR, type Skin, skinFor } from '../src/skin.ts'
import { awayView, codeShownOn, grantsHelp } from '../src/wire/web-panel.ts'

// The away panel's rules that no golden can be trusted to notice: that the
// clause about this machine's agents cannot be scrolled away, that what a
// grant does is one clause under the pointer and never a paragraph, that a
// code is never drawn cut, that the region offers a bar when it scrolls, and
// that the only way to say yes to a device is the key that means yes.
//
// The goldens are `test/screens/__screens__/away-*`; this is what they cannot
// say, because a golden passes on a drawing that is wrong in a way nobody
// wrote down.

const URL = 'http://studio.local:7654/pair#t=Qp3vNn1bXg7kQ2mPvR4tLz8'

function view(over: Partial<AwayView> = {}): AwayView {
  const code = codeFor(URL)
  const made: AwayView = {
    listening: true,
    bind: 'loopback',
    bound: ['127.0.0.1:7654', '[::1]:7654'],
    reachable: ['localhost'],
    machine: 'this Mac',
    ticket: { url: URL, secondsLeft: 84 },
    code: code === null ? [] : blocksFor(code),
    asking: null,
    talking: false,
    configuring: false,
    help: {},
    devices: [
      {
        id: '00112233445566aa',
        label: 'iPhone',
        from: 'your network',
        pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
        reads: ['titles'],
        mayAct: false,
        mayTalk: false,
        maySee: false,
        mayStop: false,
        mayClose: false,
        mayReadSettings: false,
        mayConfigure: false,
        full: false,
        live: true,
      },
    ],
    streams: 1,
    acting: false,
    lan: LAN_IS_PLAINTEXT_SHORT,
    internet: PUBLIC_IS_THE_INTERNET_SHORT,
    public: null,
    agents: DEVICES_SEEN_BY_AGENTS,
    problem: null,
    ...over,
  }
  return { ...made, help: over.help ?? grantsHelp(made) }
}

interface Size {
  width?: number
  height?: number
  date?: (at: number) => string
  /** What the pointer is on. */
  hover?: Target
  /** Painted, for a test about an escape the plain skin never writes. */
  skin?: Skin
}

function drawn(over: Partial<AwayView> = {}, size: Size = {}) {
  const ctx = {
    width: size.width ?? 120,
    height: size.height ?? 34,
    skin: size.skin ?? skinFor({}, false),
    pointer: { hover: size.hover ?? null, pressed: null },
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

/** What the panel says, its box and its lines taken away: one run of words. */
const words = (text: string) =>
  text
    .split('\n')
    .map((line) =>
      line
        .replace(/^[^│]*│/, '')
        .replace(/│[^│]*$/, '')
        .trim(),
    )
    .filter((line) => line !== '')
    .join(' ')

const said = (over?: Partial<AwayView>, size?: Size) =>
  drawn(over, size)
    .rows.map((row) => stripTerminalSequences(row))
    .join('\n')

describe('the two clauses', () => {
  it('says what a LAN bind is above the code, in the domain’s one clause', () => {
    const text = said({ bind: 'lan', reachable: ['192.168.1.10'] })
    // Before the code, because the moment to say it is before somebody holds a
    // phone up to the screen; the whole of it, with the way out, is the bind
    // setting's own `means`.
    expect(text).toContain(LAN_IS_PLAINTEXT_SHORT)
    expect(text.indexOf(LAN_IS_PLAINTEXT_SHORT)).toBeLessThan(text.indexOf('█'))
  })

  it('does not say it on a loopback bind, where it is not true', () => {
    expect(said()).not.toContain('same wifi')
  })

  it('says a public name is the internet, and what its health look found, above the code', () => {
    const text = said({
      public: {
        name: 'tade.example.com',
        up: true,
        lines: [
          { said: 'this Tade is out of date (0.2.4 is out)', loud: true },
          { said: 'certificate: 60 days left', loud: false },
        ],
      },
    })
    const all = words(text)
    expect(all).toContain(`● tade.example.com: ${PUBLIC_IS_THE_INTERNET_SHORT}`)
    expect(all).toContain('▲ this Tade is out of date (0.2.4 is out)')
    expect(all).toContain('certificate: 60 days left')
    for (const line of ['tade.example.com', 'out of date', 'certificate'])
      expect(text.indexOf(line), line).toBeLessThan(text.indexOf('█'))
  })

  it('says why nothing listens for Caddy where a name is set and the socket is not up', () => {
    const all = words(
      said({
        public: {
          name: 'tade.example.com',
          up: false,
          lines: [{ said: '/run/tade is not there, so nothing listens for Caddy', loud: true }],
        },
      }),
    )
    expect(all).toContain('○ tade.example.com')
    expect(all).not.toContain(PUBLIC_IS_THE_INTERNET_SHORT)
    expect(all).toContain('▲ /run/tade is not there')
  })

  it('draws the one about this machine’s agents however short the window is', () => {
    // In the foot, which is never scrolled: the device list is the mitigation
    // and the clause is what says so, and a person who cannot see it is a
    // person who was not told.
    for (const height of [40, 24, 14, 10]) {
      expect(said({}, { height }), String(height)).toContain(DEVICES_SEEN_BY_AGENTS)
    }
  })

  it('keeps Disconnect everything reachable at every height and width', () => {
    for (const [width, height] of [
      [120, 40],
      [120, 24],
      [120, 14],
      [120, 10],
      [60, 24],
      [44, 24],
    ] as const) {
      const ids = drawn({}, { width, height }).hits.map((hit) =>
        hit.target.kind === 'control' ? hit.target.id : '',
      )
      expect(ids, `${width}×${height}`).toContain(AWAY_CONTROLS.all)
      // And the clause with it, whole — wrapped onto lines of its own where the
      // two do not fit beside each other, never cut.
      expect(words(said({}, { width, height })), `${width}×${height}`).toContain(
        DEVICES_SEEN_BY_AGENTS,
      )
    }
  })
})

describe('what a grant does', () => {
  const everything = { acting: true, talking: true, configuring: true }
  const onAct: Target = { kind: 'control', id: `${AWAY_CONTROLS.act}00112233445566aa` }
  const onTalk: Target = { kind: 'control', id: `${AWAY_CONTROLS.talk}00112233445566aa` }

  it('is no paragraph at all, with every capability on', () => {
    // What it once was: the whole of acting and the whole of talking above the
    // list, read every time the panel opened. The whole sentences are each
    // setting's `means` and the README's.
    const text = said(everything, { height: 80 })
    for (const word of ['overrule', 'refused in code', 'Trusted hostnames', 'which is why']) {
      expect(text, word).not.toContain(word)
    }
    expect(text).not.toContain(ACTING_IS_NOT_YOU.slice(0, 40))
    expect(text).not.toContain(TALKING_IS_NOT_YOU.slice(0, 40))
  })

  it('is one clause in the foot while the pointer is on its control', () => {
    expect(said(everything, { height: 80, hover: onAct })).toContain(
      `answer & steer: ${ACTING_IS_NOT_YOU_SHORT}`,
    )
    // Wrapped where it does not fit, so read as words rather than as one row.
    expect(words(said(everything, { height: 80, hover: onTalk }))).toContain(
      `talk to Tade: ${TALKING_IS_NOT_YOU_SHORT}`,
    )
    // Nothing pointed at, nothing said.
    expect(said(everything, { height: 80 })).not.toContain(ACTING_IS_NOT_YOU_SHORT)
  })

  it('moves nothing when it appears: the foot keeps its rows whatever is pointed at', () => {
    // A foot that grew under the pointer would move the chip it explains out
    // from under it — so every row of the panel is the same row with or
    // without the clause in it, the clause's own rows excepted.
    for (const width of [120, 60]) {
      const still = drawn(everything, { width, height: 80 }).rows
      const pointed = drawn(everything, { width, height: 80, hover: onAct }).rows
      expect(pointed.length, String(width)).toBe(still.length)
      const differ = still.filter((row, at) => row !== pointed[at])
      expect(differ.length, String(width)).toBeGreaterThan(0)
      expect(differ.length, String(width)).toBeLessThanOrEqual(3)
    }
  })

  it('names only the controls that are drawn', () => {
    const off = grantsHelp({ acting: false, talking: false, configuring: false })
    expect(Object.keys(off)).not.toContain(AWAY_CONTROLS.act)
    expect(Object.keys(off)).not.toContain(AWAY_CONTROLS.talk)
    // The reading grants and the `×` are drawn on every row, whatever is on.
    for (const always of [AWAY_CONTROLS.see, AWAY_CONTROLS.settings, AWAY_CONTROLS.revoke]) {
      expect(Object.keys(off)).toContain(always)
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

  it('cuts neither how long the code has left nor the port, however narrow', () => {
    // The two figures on the panel somebody reads off it — moved onto lines
    // of their own rather than cut at the edge, the control beside them too.
    // Two addresses bound to one port are one port: the addresses were what
    // the status line was read as, and what the link already says.
    for (const width of [120, 60, 44]) {
      const text = words(said({}, { width, height: 60 }))
      expect(text, String(width)).toContain('1:24 left')
      expect(text, String(width)).toContain('port 7654')
      expect(text, String(width)).not.toContain('127.0.0.1')
      const ids = drawn({}, { width, height: 60 }).hits.map((hit) =>
        hit.target.kind === 'control' ? hit.target.id : '',
      )
      expect(ids, String(width)).toContain(AWAY_CONTROLS.code)
    }
  })

  it('says there is no network rather than offering a code nobody can reach', () => {
    const text = said({ bind: 'lan', reachable: [] })
    expect(text).toContain('No network')
    expect(text).not.toContain('/pair#t=')
  })

  it('says it is off in one line, offers no code, and the way to the switch', () => {
    const off = { listening: false, bound: [], ticket: null, code: [] }
    const text = said(off)
    expect(text).toContain('Off — nothing is listening')
    expect(text).not.toContain('/pair#t=')
    // A control and not a sentence saying where the switch is: the strip's own
    // action, so the panel and the chip go to the same place.
    const actions = drawn(off).hits.map((hit) =>
      hit.target.kind === 'action' ? hit.target.name : '',
    )
    expect(actions).toContain('away-settings')
    for (const gone of ['nothing to pair with', 'open Tade again', 'Turn it on']) {
      expect(text).not.toContain(gone)
    }
  })
})

describe('the link the code carries', () => {
  const OPEN: Target = { kind: 'control', id: AWAY_CONTROLS.open }
  const COPY: Target = { kind: 'control', id: AWAY_CONTROLS.copy }
  const on = (target: Target, over: Partial<AwayView> = {}, size?: Size) =>
    drawn(over, size).hits.filter((hit) => sameTarget(hit.target, target))

  it('is the Open control on every row it is drawn on, with Open and Copy beside it', () => {
    for (const width of [120, 60, 44, 40]) {
      const size = { width, height: 60 }
      const text = drawn({}, size).rows.map((row) => stripTerminalSequences(row))
      const opens = on(OPEN, {}, size)
      // Every row the address is on is pressable along the whole of it: a
      // link you have to find the one clickable cell of is not one.
      const rows = text.flatMap((row, at) => (/studio\.local|Lz8/.test(row) ? [at] : []))
      expect(rows.length, String(width)).toBeGreaterThan(0)
      for (const at of rows) {
        expect(
          opens.some((hit) => hit.row === at),
          `${width}: row ${at}`,
        ).toBe(true)
      }
      // Both buttons drawn at every width — never the half `Row` drops.
      const drawnAs = (hit: { row: number; from: number; to: number }) =>
        text[hit.row]?.slice(hit.from, hit.to + 1)
      expect(opens.map(drawnAs), String(width)).toContain('[Open]')
      expect(on(COPY, {}, size).map(drawnAs), String(width)).toEqual(['[Copy]'])
    }
  })

  it('puts the buttons on the line the address ends on, where they fit there', () => {
    const lines = said({}, { height: 60 }).split('\n')
    const at = lines.findIndex((line) => line.includes(URL))
    expect(lines[at]).toMatch(/Lz8\s+\[Open\] \[Copy\]/)
  })

  it('is a link in the terminal’s own sense when painted, to the whole address', () => {
    const open = `\x1b]8;;${URL}\x07`
    const close = '\x1b]8;;\x07'
    const rows = drawn({}, { width: 60, height: 60, skin: COLOUR }).rows
    const linked = rows.filter((row) => row.includes(open))
    // Over two rows here, and each of them opens the whole address and closes
    // it again on that row, so nothing after it is part of the link.
    expect(linked).toHaveLength(2)
    for (const row of linked) {
      expect(row.split(close).length).toBe(row.split(open).length)
      expect(row.lastIndexOf(close)).toBeGreaterThan(row.lastIndexOf(open))
    }
    // A pipe gets the words and no escape it would print.
    expect(drawn({}, { width: 60, height: 60 }).rows.join('')).not.toContain('\x1b]8')
  })

  it('is no link at all where the address would end the sequence early', () => {
    expect(COLOUR.hyperlink('http://x/\x07y', 'x')).toBe('x')
    expect(COLOUR.hyperlink(URL, 'x')).toBe(`\x1b]8;;${URL}\x07x\x1b]8;;\x07`)
  })

  it('is not drawn where there is no code, and neither is what it would do', () => {
    for (const over of [
      { ticket: null, code: [] },
      { listening: false, ticket: null },
    ]) {
      expect(on(OPEN, over).length + on(COPY, over).length).toBe(0)
    }
  })

  it('hands both controls to the subject that holds the ticket, and stays open', () => {
    for (const control of [AWAY_CONTROLS.open, AWAY_CONTROLS.copy]) {
      const panel = awayPanel()
      expect(awayClick(panel, control)).toEqual({ panel, submit: true, choice: control })
      const page = settingsPanel('away')
      expect(settingsClick(page, control, {})).toMatchObject({ submit: true, choice: control })
    }
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
  it('says nothing of a device but its label, where in words, its grants and when it paired', () => {
    const text = said(
      {
        devices: [
          {
            id: '00112233445566aa',
            label: 'iPhone',
            from: 'your network',
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            reads: [],
            mayAct: false,
            mayTalk: false,
            maySee: false,
            mayStop: false,
            mayClose: false,
            mayReadSettings: false,
            mayConfigure: false,
            full: false,
            live: false,
          },
        ],
      },
      // Tall enough that the whole region is drawn: the code comes first,
      // because it is what somebody opened this for, so on an ordinary
      // terminal the device list is a scroll away and is correct to be.
      { height: 64 },
    )
    // Not its address and not its digest: what another device is, from here,
    // is a name, a place in words and a date.
    expect(text).toContain('iPhone')
    expect(text).toContain('from your network')
    expect(text).toMatch(/reads\s+\(names\)\s+\(states\)\s+\(counts\)/)
    expect(text).not.toContain('192.168')
  })

  it('says an owner is one before anything else about it, and how it came in', () => {
    // REMOTE-TADE.md §11 item 4: its turns reach what the keyboard does, which
    // the boxes cannot say on their own — so the row's first word says it.
    const text = said(
      {
        devices: [
          {
            id: '00112233445566aa',
            label: 'mac',
            from: 'over SSH',
            owner: true,
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            reads: [],
            mayAct: true,
            mayTalk: true,
            maySee: true,
            mayStop: true,
            mayClose: true,
            mayReadSettings: true,
            mayConfigure: true,
            full: true,
            live: true,
          },
        ],
      },
      { height: 64 },
    )
    expect(text).toMatch(/owner · over SSH · paired/)
    expect(text).not.toContain('from over SSH')
  })
})

describe('letting one device act', () => {
  it('draws no control for it at all while the setting is off', () => {
    // **Absent, not greyed out.** With `surfaces.web.acting` off there is no
    // route a grant could reach, so a button here would be one that cannot do
    // what it says — and the row is byte-identical to what it was before any
    // of this existed.
    const text = said({}, { height: 64 })
    expect(text).not.toContain('answer & steer')
    // Nor the lifecycle's two: they are acting routes, and with acting off
    // there is no route a grant of either could reach.
    expect(text).not.toContain('stop agents')
    expect(text).not.toContain('close projects')
  })

  it('offers it per device once a person has turned acting on', () => {
    // Tall enough that the whole scrolling region is drawn: the code comes
    // first, so on an ordinary terminal the device list is a scroll away and
    // is correct to be.
    const text = said({ acting: true }, { height: 64 })
    expect(text).toContain('□ answer & steer')
    // A box each for the lifecycle, beside it and implied by it in neither
    // direction.
    expect(text).toContain('□ stop agents')
    expect(text).toContain('□ close projects')
  })

  it('says which devices may, and offers to take it back from those', () => {
    const text = said(
      {
        acting: true,
        devices: [
          {
            id: '00112233445566aa',
            label: 'iPhone',
            from: 'your network',
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            reads: ['titles'],
            mayAct: true,
            mayTalk: false,
            maySee: false,
            mayStop: false,
            mayClose: false,
            mayReadSettings: false,
            mayConfigure: false,
            full: false,
            live: true,
          },
        ],
      },
      { height: 64 },
    )
    // **On the row, without colour.** The list is what somebody reads to
    // answer *can any of these change my work*, and a capability visible only
    // as the colour of a button is one nobody audits — and one a screenshot
    // cannot carry. A ticked box is the answer and the control in one.
    expect(text).toContain('■ answer & steer')
    expect(text).not.toContain('□ answer & steer')
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
            from: 'your network',
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            reads: [],
            mayAct: true,
            mayTalk: false,
            maySee: false,
            mayStop: false,
            mayClose: false,
            mayReadSettings: false,
            mayConfigure: false,
            full: false,
            live: false,
          },
        ],
      },
      { height: 64 },
    )
    expect(text).not.toContain('answer & steer')
    for (const word of ['never your own words', 'overrule']) expect(text).not.toContain(word)
  })
})

describe('letting one device talk to Tade', () => {
  it('draws no control for it at all while the setting is off', () => {
    // Absent, not greyed out, and **not implied by acting**: these are two
    // decisions with two settings, and a person who turned the first on has
    // not answered the second.
    const text = said({ acting: true }, { height: 72 })
    expect(text).toContain('answer & steer')
    expect(text).not.toContain('talk to Tade')
  })

  it('offers it per device once a person has turned talking on', () => {
    const text = said({ talking: true }, { height: 72 })
    expect(text).toContain('□ talk to Tade')
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
            from: 'your network',
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            reads: ['titles'],
            mayAct: true,
            mayTalk: true,
            maySee: false,
            mayStop: false,
            mayClose: false,
            mayReadSettings: false,
            mayConfigure: false,
            full: false,
            live: true,
          },
        ],
      },
      // **The date the window actually draws**, because this is the one test
      // about what fits on a row: a row that fills its width loses its pinned
      // chips whole rather than half-drawn (`Row.build`), and `×` is the chip
      // that must never be the one that goes. Tall enough for the code, how to
      // use it and the two sentences above the list, so the row is in view.
      { height: 76, date: () => '11 Sep' },
    )
    // **Both, on the row, in words.** Two grants is two facts, and a list that
    // folded them into one would be a list somebody reads to answer the wrong
    // question — *can this change my work* and *can this ask Tade for
    // anything* have different answers.
    expect(text).toContain('■ answer & steer')
    expect(text).toContain('■ talk to Tade')
    // And Sign out, which a long row of boxes must never push off.
    const ids = drawn(
      { acting: true, talking: true, configuring: true },
      { height: 76, date: () => '11 Sep' },
    ).hits.map((hit) => (hit.target.kind === 'control' ? hit.target.id : ''))
    expect(ids).toContain(`${AWAY_CONTROLS.revoke}00112233445566aa`)
  })

  it('says nothing about talking where it is off, even with a device granted it', () => {
    const text = said(
      {
        talking: false,
        devices: [
          {
            id: '00112233445566aa',
            label: 'iPhone',
            from: 'your network',
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            reads: [],
            mayAct: false,
            mayTalk: true,
            maySee: false,
            mayStop: false,
            mayClose: false,
            mayReadSettings: false,
            mayConfigure: false,
            full: false,
            live: false,
          },
        ],
      },
      { height: 72 },
    )
    expect(text).not.toContain('talk to Tade')
    expect(text).not.toContain('refused in code')
  })
})

describe('on the Away page of Settings', () => {
  it('is drawn on that page and the panel, and nowhere else — not in a search', () => {
    expect(codeShownOn(awayPanel())).toBe('panel')
    expect(codeShownOn(settingsPanel('away'))).toBe('settings')
    // A search's rows are every page's, and a code among them would be nobody's.
    expect(codeShownOn(settingsPanel('away', 'serve'))).toBeNull()
    expect(codeShownOn(settingsPanel('voice'))).toBeNull()
    expect(codeShownOn(null)).toBeNull()
  })

  it('hands the panel’s own controls to the subject that holds them, and stays', () => {
    const page = settingsPanel('away')
    for (const control of [AWAY_CONTROLS.code, `${AWAY_CONTROLS.act}00112233445566aa`]) {
      const outcome = settingsClick(page, control, {})
      expect(outcome.submit, control).toBe(true)
      expect(outcome.choice, control).toBe(control)
      expect(outcome.panel, control).toBe(page)
    }
  })

  it('says what a device may do in the domain’s own clauses, there and in the panel', () => {
    const facts = {
      surface: surfaceOf(ConfigSchema.parse({ surfaces: { web: { enabled: true } } }).surfaces.web),
      bound: [],
      listening: true,
      ticket: null,
      asking: null,
      devices: [],
      live: new Set<string>(),
      streams: 0,
      problem: null,
      publicAt: null,
      publicTrouble: null,
      health: [],
      now: 0,
    }
    const view = awayView(facts)
    // Never a third wording: the clause the domain says once, after the chip's name.
    expect(view.help[AWAY_CONTROLS.act]).toBe(`answer & steer: ${ACTING_IS_NOT_YOU_SHORT}`)
    expect(view.help[AWAY_CONTROLS.talk]).toBe(`talk to Tade: ${TALKING_IS_NOT_YOU_SHORT}`)
    expect(view.lan).toBe(LAN_IS_PLAINTEXT_SHORT)
    expect(view.agents).toBe(DEVICES_SEEN_BY_AGENTS)
    expect(view.internet).toBe(PUBLIC_IS_THE_INTERNET_SHORT)
    // No public name, nothing said about one.
    expect(view.public).toBeNull()
  })

  it('never leaves a public name somebody set silent: up with its health, or why not', () => {
    const web = { surfaces: { web: { enabled: true, public: 'tade.example.com' } } }
    const facts = {
      surface: surfaceOf(ConfigSchema.parse(web).surfaces.web),
      bound: ['127.0.0.1:7654'],
      listening: true,
      ticket: null,
      asking: null,
      devices: [],
      live: new Set<string>(),
      streams: 0,
      problem: null,
      publicAt: null,
      publicTrouble: '/run/tade is not there, so nothing listens for Caddy',
      health: [{ said: 'certificate: looking', loud: false }],
      now: 0,
    }
    expect(awayView(facts).public).toEqual({
      name: 'tade.example.com',
      up: false,
      lines: [{ said: '/run/tade is not there, so nothing listens for Caddy', loud: true }],
    })
    expect(awayView({ ...facts, publicAt: '/run/tade/away.sock' }).public).toEqual({
      name: 'tade.example.com',
      up: true,
      lines: [{ said: 'certificate: looking', loud: false }],
    })
    // Off, there is no listener of either kind to say anything about.
    expect(awayView({ ...facts, listening: false }).public).toBeNull()
  })
})
