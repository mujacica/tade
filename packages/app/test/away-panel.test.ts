import { stripTerminalSequences } from '@earendil-works/pi-tui'
import {
  ConfigSchema,
  DEVICES_SEEN_BY_AGENTS,
  LAN_IS_PLAINTEXT_SHORT,
  PUBLIC_IS_THE_INTERNET_SHORT,
} from '@tade/core'
import { blocksFor, codeFor, surfaceOf } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { sameTarget, type Target } from '../src/hits.ts'
import { initialState, panelMoved, scrollBy } from '../src/model.ts'
import {
  ASKING_OUT_OF_VIEW,
  AWAY_CONTROLS,
  type AwayPanel,
  awayClick,
  awayKey,
  awayPanel,
} from '../src/panels/away/state.ts'
import type { AwayView } from '../src/panels/away/view.ts'
import type { PanelContext } from '../src/panels/context.ts'
import { drawPanel } from '../src/panels/context.ts'
import { settingsClick, settingsPanel } from '../src/panels/settings/state.ts'
import { reachOf } from '../src/scroll.ts'
import { COLOUR, type Skin, skinFor } from '../src/skin.ts'
import { awayView, codeShownOn } from '../src/wire/web-panel.ts'

// The away panel's rules that no golden can be trusted to notice: that the
// clause about this machine's agents cannot be scrolled away, that a device's
// block has nothing to tick, that a code is never drawn cut, that the region offers a bar when it scrolls, and
// that the only way to say yes to a device is the key that means yes.
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
    machine: 'this Mac',
    ticket: { url: URL, secondsLeft: 84 },
    code: code === null ? [] : blocksFor(code),
    asking: null,
    devices: [
      {
        id: '00112233445566aa',
        label: 'iPhone',
        from: 'your network',
        pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
        live: true,
      },
    ],
    streams: 1,
    lan: LAN_IS_PLAINTEXT_SHORT,
    internet: PUBLIC_IS_THE_INTERNET_SHORT,
    public: null,
    agents: DEVICES_SEEN_BY_AGENTS,
    problem: null,
    ...over,
  }
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

function drawn(over: Partial<AwayView> = {}, size: Size = {}, panel: AwayPanel = awayPanel()) {
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
  return drawPanel(panel, ctx).panel
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

const said = (over?: Partial<AwayView>, size?: Size, panel?: AwayPanel) =>
  drawn(over, size, panel)
    .rows.map((row) => stripTerminalSequences(row))
    .join('\n')

/** Six paired devices, each its own: a list long enough to scroll on a short window. */
function sixDevices(): AwayView['devices'] {
  const one = view().devices[0]
  if (one === undefined) throw new Error('the view has a device')
  return Array.from({ length: 6 }, (_, at) => ({ ...one, id: `${at}`, label: `Phone ${at}` }))
}

/** The panel after the keyboard has walked down to the last of the devices. */
function onTheLast(devices: number): AwayPanel {
  let panel = awayPanel()
  for (let press = 1; press < devices; press++) {
    const next = awayKey(panel, 'down', { devices }).panel
    if (next?.kind !== 'away') throw new Error('the panel stays open')
    panel = next
  }
  return panel
}

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

  it('lets go of the chosen device on a notch, and moves from where it is drawn', () => {
    const devices = sixDevices()
    // The keyboard walked down to the last device, which pulls the region down
    // to it: its own `scroll` is still the 0 it opened at, and is not on screen.
    const panel = onTheLast(devices.length)
    const reach = reachOf(drawn({ devices }, { height: 24 }, panel).hits, 'panel')
    expect(reach.at).toBeGreaterThan(3)
    const notch = (from: AwayPanel, at: number) => {
      const moved = scrollBy({ ...initialState(), panel: from }, 'panel', -3, {
        ...reach,
        at,
      }).panel
      if (moved?.kind !== 'away') throw new Error('the panel stays open')
      return { moved, at: reachOf(drawn({ devices }, { height: 24 }, moved).hits, 'panel').at }
    }
    // Three rows up from the rows on screen, and the next three more: the
    // chosen device no longer pulls the region back to itself.
    const first = notch(panel, reach.at ?? 0)
    expect(first.at).toBe((reach.at ?? 0) - 3)
    expect(notch(first.moved, first.at ?? 0).at).toBe((reach.at ?? 0) - 6)
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

  it('answers a device only from where its card was drawn, and says why not', () => {
    const asking = {
      label: 'iPhone',
      from: 'your network',
      address: '192.168.1.42',
      secondsLeft: 47,
      seconds: 60,
    }
    const over = { asking, devices: sixDevices() }
    const size = { height: 24 }
    // The keyboard on the last device pulls the region down to it, and the
    // card at the top of the region out of view.
    const panel = onTheLast(over.devices.length)
    const reach = reachOf(drawn(over, size, panel).hits, 'panel')
    expect(reach.at).toBeGreaterThan(0)
    expect(said(over, size, panel)).not.toContain('A DEVICE WANTS TO PAIR')
    const inputs = { asking: true, drawnFrom: reach.at, devices: 6, bindings: {} }
    for (const key of ['a', 'd']) {
      const refused = awayKey(panel, key, inputs)
      expect(refused, key).toEqual({ panel: { ...panel, said: ASKING_OUT_OF_VIEW }, submit: false })
    }
    // Nor one that was never drawn at all.
    expect(awayKey(panel, 'a', { ...inputs, drawnFrom: undefined }).submit).toBe(false)
    // Said in the foot, which nothing scrolls: the card is what is out of view.
    const told = awayKey(panel, 'a', inputs).panel
    if (told?.kind !== 'away') throw new Error('the panel stays open')
    expect(words(said(over, size, told))).toContain(ASKING_OUT_OF_VIEW)

    // `home` brings the card back, through the one move, and from there the key
    // answers it and the sentence goes.
    const home = panelMoved(
      { ...initialState(), panel: told },
      awayKey(told, 'home', inputs),
      reach,
    )
    if (home.panel?.kind !== 'away') throw new Error('the panel stays open')
    const top = reachOf(drawn(over, size, home.panel).hits, 'panel').at
    expect(top).toBe(0)
    expect(said(over, size, home.panel)).toContain('A DEVICE WANTS TO PAIR')
    expect(words(said(over, size, home.panel))).not.toContain(ASKING_OUT_OF_VIEW)
    expect(awayKey(home.panel, 'a', { ...inputs, drawnFrom: top })).toMatchObject({
      submit: true,
      choice: AWAY_CONTROLS.allow,
    })
  })

  it('hands the key on with nobody asking, wherever the list is', () => {
    // To the window's own rule (`Away.decide`, `approvalInFront`), which
    // answers no agent from behind the panel: `wire/away-keys.test.ts`.
    const panel = onTheLast(6)
    expect(awayKey(panel, 'a', { asking: false, drawnFrom: 40, bindings: {} })).toMatchObject({
      submit: true,
      choice: AWAY_CONTROLS.allow,
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
  it('says nothing of a device but its label, where in words and when it paired', () => {
    const text = said(
      {
        devices: [
          {
            id: '00112233445566aa',
            label: 'iPhone',
            from: 'your network',
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
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
    expect(text).not.toContain('192.168')
  })

  it('says an owner is one before anything else about it, and how it came in', () => {
    // Another machine's link and not a phone, so the row's first word says it.
    const text = said(
      {
        devices: [
          {
            id: '00112233445566aa',
            label: 'mac',
            from: 'over SSH',
            owner: true,
            pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
            live: true,
          },
        ],
      },
      { height: 64 },
    )
    expect(text).toMatch(/owner · over SSH · paired/)
    expect(text).not.toContain('from over SSH')
  })

  it('says when a device last used its passkey, and nothing where it made none', () => {
    const phone = view().devices[0]
    if (phone === undefined) throw new Error('the fixture has a phone')
    const used = Date.parse('2026-09-12T08:00:00.000Z')
    // After the date it paired, wrapped where the row runs out.
    const text = said({ devices: [{ ...phone, passkey: used }] }, { height: 64 })
    expect(text).toContain('passkey used 2026-09-12T08:00:00.000Z')
    expect(said({ devices: [phone] }, { height: 64 })).not.toContain('passkey')
  })

  it('says when a device made its passkey, beside when it paired, so one made from a copied cookie shows', () => {
    // For minutes after pairing the session alone may make one: whoever held
    // the cookie then. When it was made is what tells the two apart.
    const phone = view().devices[0]
    if (phone === undefined) throw new Error('the fixture has a phone')
    const made = Date.parse('2026-09-12T07:58:00.000Z')
    const used = Date.parse('2026-09-12T08:00:00.000Z')
    // Read across the rows it wraps over, as a person reads it.
    const text = said({ devices: [{ ...phone, passkey: used, passkeyMade: made }] }, { height: 64 })
      .replace(/[│╭╮╰╯─]/g, ' ')
      .replace(/\s+/g, ' ')
    expect(text).toContain('passkey made 2026-09-12T07:58:00.000Z, used 2026-09-12T08:00:00.000Z')
    expect(text).toMatch(/paired \S+ · passkey made/)
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
    for (const control of [AWAY_CONTROLS.code, `${AWAY_CONTROLS.revoke}00112233445566aa`]) {
      const outcome = settingsClick(page, control, {})
      expect(outcome.submit, control).toBe(true)
      expect(outcome.choice, control).toBe(control)
      expect(outcome.panel, control).toBe(page)
    }
  })

  it('says what is true of every device in the domain’s own clauses, there and in the panel', () => {
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
    // Never a third wording: the clauses the domain says once.
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

describe('a tab per machine', () => {
  const TABS = [
    { name: 'ipax', on: true },
    { name: 'vps', on: false },
  ]
  /** ipax's tab, as the remotes hand it over: what ipax answered, over a link that is up or not. */
  const there = (over: Partial<AwayView> = {}, up = true): AwayView =>
    view({
      machine: 'ipax',
      ticket: null,
      code: [],
      there: { name: 'ipax', linked: true, up, asOf: 0, asking: false, said: null },
      ...over,
    })
  const drawnOn = (
    panel: AwayPanel,
    extra: { awayTabs?: typeof TABS; awayThere?: AwayView | null },
    size: Size = {},
  ) => {
    const ctx = {
      width: size.width ?? 120,
      height: size.height ?? 34,
      skin: skinFor({}, false),
      pointer: { hover: null, pressed: null },
      date: (at: number) => new Date(at).toISOString(),
      bindings: {},
      away: view(),
      ...extra,
    } as unknown as PanelContext
    return drawPanel(panel, ctx).panel
  }
  const text = (one: { rows: string[] }) =>
    one.rows.map((row) => stripTerminalSequences(row)).join('\n')
  const ipaxTab = (): AwayPanel => {
    const next = awayClick(awayPanel(), `${AWAY_CONTROLS.tab}ipax`).panel
    if (next?.kind !== 'away') throw new Error('the panel stays open')
    return next
  }

  it('draws none with no other machine linked, so a window of one machine draws what it did', () => {
    expect(text(drawnOn(awayPanel(), {}))).not.toContain('this Mac    ')
    expect(said()).toBe(text(drawnOn(awayPanel(), { awayTabs: [] })))
  })

  it('draws this machine first, then each other, with whether its away view is up', () => {
    const shown = text(drawnOn(awayPanel(), { awayTabs: TABS }))
    expect(shown).toMatch(/on +\[ ● this Mac \] +● ipax +○ vps/)
    const hits = drawnOn(awayPanel(), { awayTabs: TABS }).hits
    for (const id of ['', 'ipax', 'vps']) {
      expect(hits.some((hit) => sameTarget(hit.target, control(`${AWAY_CONTROLS.tab}${id}`)))).toBe(
        true,
      )
    }
  })

  it('goes to a tab on a press, scrolled to its top with nothing chosen, and asks nobody', () => {
    const walked = onTheLast(4)
    const out = awayClick({ ...walked, scroll: 9 }, `${AWAY_CONTROLS.tab}ipax`)
    expect(out.submit).toBe(false)
    expect(out.panel).toEqual({ ...awayPanel(), there: 'ipax' })
    const back = awayClick(ipaxTab(), AWAY_CONTROLS.tab).panel
    expect(back).toEqual(awayPanel())
    expect(back).not.toHaveProperty('there')
  })

  it('walks the tabs on tab and shift+tab, round the ends, and not at all with none', () => {
    const machines = ['ipax', 'vps']
    const step = (panel: AwayPanel, key: string) => {
      const next = awayKey(panel, key, { awayMachines: machines }).panel
      if (next?.kind !== 'away') throw new Error('the panel stays open')
      return next
    }
    expect(step(awayPanel(), 'tab').there).toBe('ipax')
    expect(step(step(awayPanel(), 'tab'), 'tab').there).toBe('vps')
    expect(step(step(step(awayPanel(), 'tab'), 'tab'), 'tab').there).toBeUndefined()
    expect(step(awayPanel(), 'shift+tab').there).toBe('vps')
    expect(awayKey(awayPanel(), 'tab', {}).panel).toEqual(awayPanel())
  })

  it('answers no door with the window’s own yes and no on another machine’s tab', () => {
    for (const key of ['a', 'd']) {
      const out = awayKey(ipaxTab(), key, { awayMachines: ['ipax'] })
      expect(out.submit).toBe(false)
      expect(out.panel).toMatchObject({ there: 'ipax', said: expect.any(String) })
    }
  })

  it('draws another machine’s tab from what it answered, with its own controls and New code', () => {
    const one = drawnOn(ipaxTab(), { awayTabs: TABS, awayThere: there() })
    const shown = text(one)
    expect(shown).toContain('● On — only ipax can reach it')
    expect(shown).toContain('New code writes one on ipax that pairs whoever opens it first')
    expect(shown).toContain('Sign out')
    for (const id of [
      AWAY_CONTROLS.code,
      AWAY_CONTROLS.all,
      `${AWAY_CONTROLS.revoke}00112233445566aa`,
    ]) {
      expect(one.hits.some((hit) => sameTarget(hit.target, control(id)))).toBe(true)
    }
  })

  it('says a machine that is down, as of when, with the way to connect it — and offers nothing it cannot carry out', () => {
    const one = drawnOn(ipaxTab(), {
      awayTabs: TABS,
      awayThere: there(
        {
          there: {
            name: 'ipax',
            linked: true,
            up: false,
            asOf: 0,
            asking: false,
            said: 'no answer',
          },
        },
        false,
      ),
    })
    const shown = text(one)
    expect(shown).toContain('○ ipax is down: no answer · as of 1970-01-01T00:00:00.000Z')
    expect(shown).toContain('Settings › Remotes')
    expect(shown).toContain('iPhone')
    expect(shown).not.toContain('PAIR A DEVICE')
    expect(shown).not.toContain('Sign out')
    const press = (id: string) => one.hits.some((hit) => sameTarget(hit.target, control(id)))
    expect(press(AWAY_CONTROLS.code)).toBe(false)
    expect(
      one.hits.some((hit) => sameTarget(hit.target, { kind: 'action', name: 'remotes-settings' })),
    ).toBe(true)
  })

  it('says a machine not linked, and one being asked, rather than drawing it as nothing paired', () => {
    const unlinked = there(
      { there: { name: 'ipax', linked: false, up: false, asOf: null, asking: false, said: null } },
      false,
    )
    expect(text(drawnOn(ipaxTab(), { awayTabs: TABS, awayThere: unlinked }))).toContain(
      '○ ipax is not linked here',
    )
    const asking = there({
      there: { name: 'ipax', linked: true, up: true, asOf: null, asking: true, said: null },
    })
    const shown = text(drawnOn(ipaxTab(), { awayTabs: TABS, awayThere: asking }))
    expect(shown).toContain('… asking ipax')
    expect(shown).not.toContain('DEVICES')
  })

  it('keeps the geometry at every size, every tab', () => {
    for (const [width, height] of [
      [40, 12],
      [60, 24],
      [120, 34],
      [200, 60],
    ] as const) {
      for (const panel of [awayPanel(), ipaxTab()]) {
        const one = drawnOn(panel, { awayTabs: TABS, awayThere: there() }, { width, height })
        const widths = new Set(one.rows.map((row) => stripTerminalSequences(row).length))
        expect(widths.size, `${width}×${height}`).toBe(1)
      }
    }
  })
})

/** A control on the panel, by its id. */
function control(id: string): Target {
  return { kind: 'control', id }
}
