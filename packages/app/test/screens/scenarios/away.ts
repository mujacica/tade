import { DEVICES_SEEN_BY_AGENTS, LAN_IS_PLAINTEXT_SHORT } from '@tade/core'
import { blocksFor, codeFor } from '@tade/web'
import { AWAY_CONTROLS, awayPanel } from '../../../src/panels/away/state.ts'
import type { AwayView } from '../../../src/panels/away/view.ts'
import { grantsHelp } from '../../../src/wire/web-panel.ts'
import { base, frame, type Scenario, utcDate } from './fixtures.ts'

// The away view, as the window shows it.
//
// Five states worth a golden, because each is a different thing a person is
// deciding: it is off; it is on and there is a code to scan; it is on the
// network and that has to be said before anybody holds a phone up; a device is
// at the door; and acting is on, which is the list read to answer whether any
// of these can change the work.

const URL = 'http://studio.local:7654/pair#t=Qp3vNn1bXg7kQ2mPvR4tLz8'

/** The strip's chip while it listens, with the one device below that has a page open. */
const LISTENING = { on: true, devices: 1 }

/** What the away subject hands the panel: on, a code, two devices. Settings' scenario draws it too. */
export function awayFixture(over: Partial<AwayView> = {}): AwayView {
  return view(over)
}

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
    devices: [
      {
        id: '00112233445566aa',
        label: 'iPhone',
        from: 'your network',
        pairedAt: Date.parse('2026-09-11T09:12:00.000Z'),
        reads: ['titles', 'intent'],
        mayAct: false,
        mayTalk: false,
        maySee: false,
        mayStop: false,
        mayClose: false,
        mayReadSettings: false,
        mayConfigure: false,
        live: true,
      },
      {
        id: '00112233445566bb',
        label: 'MacBook',
        from: 'this Mac',
        pairedAt: Date.parse('2026-09-11T09:40:00.000Z'),
        reads: [],
        mayAct: false,
        mayTalk: false,
        maySee: false,
        mayStop: false,
        mayClose: false,
        mayReadSettings: false,
        mayConfigure: false,
        live: false,
      },
    ],
    streams: 1,
    acting: false,
    talking: false,
    configuring: false,
    help: {},
    lan: LAN_IS_PLAINTEXT_SHORT,
    agents: DEVICES_SEEN_BY_AGENTS,
    problem: null,
    ...over,
  }
  // The clauses for the controls the flags draw, as the subject hands them over.
  return { ...made, help: over.help ?? grantsHelp(made) }
}

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
      'and every device already paired with what each may read — because seeing the whole list ' +
      'is the real answer to one having been added by something running here.',
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
      'in words with the address beside them, that a yes grants full access and that any of ' +
      'it is untick-able in its row, the minute it has as a bar, and Approve in green and Refuse in red with the ' +
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
    name: 'away-acting-granted',
    about:
      'Acting on, which is the state the list exists for: each device with whether it is ' +
      'connected now, what it is, where it paired from and when, what it reads as pills, and a ' +
      'box per thing it may do — ticked where a person here granted it, so the answer to *can ' +
      'any of these change my work* reads without colour. The pointer is on the first ' +
      'device’s `answer & steer`, so the foot says in one clause what it grants. Sign out on ' +
      'each row and Disconnect everything are grey until pointed at. No code outstanding, ' +
      'because the panel somebody opens to read their own devices is not the one they opened ' +
      'to add a phone.',
    state: {
      ...base(),
      hover: { kind: 'control', id: `${AWAY_CONTROLS.act}00112233445566aa` },
      panel: awayPanel(),
    },
    frame: frame({
      date: utcDate,
      remote: LISTENING,
      // Three devices of five rows each, and the foot: taller than the
      // default 34, so the picture of the list is the whole list.
      height: 44,
      panel: {
        away: view({
          // Nothing to scan: a claim burns the ticket, and a person who came
          // here to read the list rather than to add a phone has none
          // outstanding either. It is also what keeps this picture about the
          // list — the code is `away-pairing`'s subject and is twenty rows.
          ticket: null,
          code: [],
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
              mayStop: true,
              mayClose: false,
              mayReadSettings: false,
              mayConfigure: false,
              live: true,
            },
            {
              id: '00112233445566bb',
              label: 'iPad',
              from: 'Tailscale',
              pairedAt: Date.parse('2026-09-11T09:40:00.000Z'),
              reads: ['titles', 'requests', 'workflows'],
              mayAct: false,
              mayTalk: false,
              maySee: false,
              mayStop: false,
              mayClose: false,
              mayReadSettings: false,
              mayConfigure: false,
              live: false,
            },
            {
              id: '00112233445566cc',
              label: 'kitchen screen',
              from: 'your network',
              pairedAt: Date.parse('2026-09-10T18:02:00.000Z'),
              reads: [],
              mayAct: false,
              mayTalk: false,
              maySee: false,
              mayStop: false,
              mayClose: false,
              mayReadSettings: false,
              mayConfigure: false,
              live: false,
            },
          ],
        }),
      },
    }),
  },
]
