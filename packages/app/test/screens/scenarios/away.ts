import {
  DEVICES_SEEN_BY_AGENTS,
  LAN_IS_PLAINTEXT_SHORT,
  PUBLIC_IS_THE_INTERNET_SHORT,
} from '@tade/core'
import { blocksFor, codeFor } from '@tade/web'
import { AWAY_CONTROLS, awayPanel, onTab } from '../../../src/panels/away/state.ts'
import type { AwayTab, AwayView } from '../../../src/panels/away/view.ts'
import { base, frame, type Scenario, utcDate } from './fixtures.ts'

// The away view, as the window shows it.
//
// Five states worth a golden, because each is a different thing a person is
// deciding: it is off; it is on and there is a code to scan; it is on the
// network and that has to be said before anybody holds a phone up; a device is
// at the door; and the devices already in, every one of them the person's own,
// which is the list read to answer whether one of them should not be.

const URL = 'http://studio.local:7654/pair#t=Qp3vNn1bXg7kQ2mPvR4tLz8'

/** The strip's chip while it listens, with the one device below that has a page open. */
const LISTENING = { on: true, devices: 1 }

/** What the away subject hands the panel: on, a code, two devices. Settings' scenario draws it too. */
export function awayFixture(over: Partial<AwayView> = {}): AwayView {
  return view(over)
}

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
      {
        id: '00112233445566bb',
        label: 'MacBook',
        from: 'this Mac',
        pairedAt: Date.parse('2026-09-11T09:40:00.000Z'),
        live: false,
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

/** The public link a code ipax wrote carries: its public name, never `localhost`. */
const IPAX_URL = 'https://tade.mujacic.com/pair#t=Hn4sQw9ZkVb2LcR7xPt3mYa'

/** The other machines' tabs: ipax up, vps down. */
const TABS: readonly AwayTab[] = [
  { name: 'ipax', on: true },
  { name: 'vps', on: false },
]

/** ipax's away view as its tab draws it: what ipax answered, over a link that is up. */
function ipax(over: Partial<AwayView> = {}): AwayView {
  const code = codeFor(IPAX_URL)
  return view({
    machine: 'ipax',
    bound: ['127.0.0.1:7654'],
    reachable: ['tade.mujacic.com'],
    ticket: { url: IPAX_URL, secondsLeft: 287 },
    code: code === null ? [] : blocksFor(code),
    public: {
      name: 'tade.mujacic.com',
      up: true,
      lines: [{ said: 'certificate good until 14 Feb 2027', loud: false }],
    },
    devices: [
      {
        id: '00112233445566dd',
        label: 'iPhone',
        from: 'outside your network',
        pairedAt: Date.parse('2026-11-02T08:20:00.000Z'),
        passkey: Date.parse('2026-11-27T22:10:00.000Z'),
        passkeyMade: Date.parse('2026-11-02T08:21:00.000Z'),
        live: true,
      },
      {
        id: '00112233445566ee',
        label: 'studio',
        from: 'over SSH',
        owner: true,
        pairedAt: Date.parse('2026-10-20T10:00:00.000Z'),
        live: true,
      },
    ],
    streams: 2,
    agents: DEVICES_SEEN_BY_AGENTS.replace('this machine', 'ipax'),
    there: { name: 'ipax', linked: true, up: true, asOf: utcNow, asking: false, said: null },
    ...over,
  })
}

/** A moment the scenarios' clock reads as now. */
const utcNow = Date.parse('2026-11-28T09:00:00.000Z')

export const AWAY_SCREENS: Scenario[] = [
  {
    name: 'away-off',
    about:
      'The away view before anybody turns it on: one line saying it is off, with the way to the ' +
      'switch beside it, and the devices — none — because the list is the mitigation whether ' +
      'or not anything listens.',
    state: { ...base(), panel: awayPanel() },
    frame: frame({
      date: utcDate,
      panel: {
        away: view({
          listening: false,
          bound: [],
          ticket: null,
          code: [],
          devices: [],
          streams: 0,
        }),
      },
    }),
  },
  {
    name: 'away-pairing',
    about:
      'On, on this machine alone: the code to scan, the address under it, how long it has left, ' +
      'and every device already paired — because seeing the whole list is the real answer to ' +
      'one having been added by something running here.',
    state: { ...base(), panel: awayPanel() },
    frame: frame({ date: utcDate, remote: LISTENING, panel: { away: view() } }),
  },
  {
    name: 'away-on-the-network',
    about:
      'On the network, which is a second decision from being on at all: that anybody on the ' +
      'same wifi can read it is one clause above the code, before anybody holds a phone up.',
    state: { ...base(), panel: awayPanel() },
    frame: frame({
      date: utcDate,
      remote: LISTENING,
      panel: {
        away: view({
          bind: 'lan',
          bound: ['0.0.0.0:7654', '[::]:7654'],
          reachable: ['192.168.1.10'],
        }),
      },
    }),
  },
  {
    name: 'away-on-a-narrow-terminal',
    about:
      'Too narrow for the code: said, with the address, rather than drawn cut — a QR with its ' +
      'right-hand side missing scans as nothing while looking exactly like one that works.',
    state: { ...base(), panel: awayPanel() },
    frame: frame({
      date: utcDate,
      remote: LISTENING,
      width: 60,
      height: 24,
      panel: { away: view() },
    }),
  },
  {
    name: 'away-a-device-asking',
    about:
      'A device at the door, as a card above the code: what it calls itself, where it came from ' +
      'in words with the address beside them, that a yes gives full access until it is signed ' +
      'out, the minute it has as a bar, and Approve in green and Refuse in red with the ' +
      'window’s own approve and deny keys drawn as key caps beside them — the same act in the ' +
      'same vocabulary as approving a tool call. Above the code because it is the one question ' +
      'here: under twenty rows of code it was scrolled out of sight.',
    state: { ...base(), panel: awayPanel() },
    frame: frame({
      date: utcDate,
      remote: LISTENING,
      panel: {
        away: view({
          asking: {
            label: 'iPhone',
            from: 'your network',
            address: '192.168.1.42',
            secondsLeft: 47,
            seconds: 60,
          },
        }),
      },
    }),
  },
  {
    name: 'away-devices',
    about:
      'The devices already in, which is the list for answering whether one of them should not ' +
      'be: each with whether it is connected now, what it is, where it paired from and when, ' +
      'and its passkey — a machine link said as that first, a phone paired in the clear said ' +
      'to read only. Nothing to tick, because every paired device is the person’s own; Sign ' +
      'out on each row and Disconnect everything are grey until pointed at, and the pointer is ' +
      'on the first one’s. No code outstanding, because the panel somebody opens to read their ' +
      'own devices is not the one they opened to add a phone.',
    state: {
      ...base(),
      hover: { kind: 'control', id: `${AWAY_CONTROLS.revoke}00112233445566aa` },
      panel: awayPanel(),
    },
    frame: frame({
      date: utcDate,
      remote: LISTENING,
      panel: {
        away: view({
          // Nothing to scan: a claim burns the ticket, and a person who came
          // here to read the list rather than to add a phone has none
          // outstanding either. It is also what keeps this picture about the
          // list — the code is `away-pairing`'s subject and is twenty rows.
          ticket: null,
          code: [],
          devices: [
            {
              id: '00112233445566aa',
              label: 'iPhone',
              from: 'your network',
              pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
              passkey: Date.parse('2026-09-12T07:30:00.000Z'),
              passkeyMade: Date.parse('2026-09-11T09:13:00.000Z'),
              live: true,
            },
            {
              id: '00112233445566bb',
              label: 'studio',
              from: 'over SSH',
              owner: true,
              pairedAt: Date.parse('2026-09-11T09:40:00.000Z'),
              live: false,
            },
            {
              id: '00112233445566cc',
              label: 'kitchen screen',
              from: 'your network',
              pairedAt: Date.parse('2026-09-10T18:02:00.000Z'),
              readsOnly: 'in the clear',
              live: false,
            },
          ],
        }),
      },
    }),
  },
  {
    name: 'away-tabs-this-mac',
    about:
      'With other machines linked, a tab per machine along the top — this Mac first, then each ' +
      'linked one in the order the config names them — with ● where its away view is up and ○ ' +
      'where it is not. This Mac’s tab is the panel as it always was.',
    state: { ...base(), panel: awayPanel() },
    frame: frame({
      date: utcDate,
      remote: LISTENING,
      panel: { away: view({ ticket: null, code: [] }), awayTabs: TABS },
    }),
  },
  {
    name: 'away-on-another-machine',
    about:
      'ipax’s tab: its away view as ipax answered over the link — on, reached at its public ' +
      'name with its certificate, the code ipax wrote as `tade web pair` writes one carrying ' +
      'the public https link and not localhost, how long it is good for, and the devices paired ' +
      'there with Sign out on each. Every press on this tab is done by ipax.',
    state: { ...base(), panel: onTab(awayPanel(), 'ipax') },
    frame: frame({
      date: utcDate,
      remote: LISTENING,
      panel: { away: view(), awayTabs: TABS, awayThere: ipax() },
    }),
  },
  {
    name: 'away-another-machine-down',
    about:
      'A machine whose link is down: said as that, with when it last answered and the way to ' +
      'connect it — Settings › Remotes — and the devices it listed then. No code can be made ' +
      'and Disconnect everything waits, because nothing reaches it to do either.',
    state: { ...base(), panel: onTab(awayPanel(), 'vps') },
    frame: frame({
      date: utcDate,
      remote: LISTENING,
      panel: {
        away: view(),
        awayTabs: TABS,
        awayThere: ipax({
          machine: 'vps',
          ticket: null,
          code: [],
          public: null,
          devices: [
            {
              id: '00112233445566ff',
              label: 'iPad',
              from: 'Tailscale',
              pairedAt: Date.parse('2026-11-12T19:05:00.000Z'),
              live: false,
            },
          ],
          streams: 0,
          agents: DEVICES_SEEN_BY_AGENTS.replace('this machine', 'vps'),
          there: {
            name: 'vps',
            linked: true,
            up: false,
            asOf: Date.parse('2026-11-28T06:42:00.000Z'),
            asking: false,
            said: 'no answer over ssh',
          },
        }),
      },
    }),
  },
]
