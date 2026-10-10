import {
  ACTING_IS_NOT_YOU,
  DEVICES_SEEN_BY_AGENTS,
  LAN_IS_PLAINTEXT,
  TALKING_IS_NOT_YOU,
} from '@tade/core'
import { blocksFor, codeFor } from '@tade/web'
import { awayPanel } from '../../../src/panels/away/state.ts'
import type { AwayView } from '../../../src/panels/away/view.ts'
import { base, frame, type Scenario, utcDate } from './fixtures.ts'

// The away view, as the window shows it.
//
// Four states worth a golden, because each is a different thing a person is
// deciding: it is off; it is on and there is a code to scan; it is on the
// network and that has to be said before anybody holds a phone up; and a
// device is at the door.

const URL = 'http://studio.local:7654/pair#t=Qp3vNn1bXg7kQ2mPvR4tLz8'

const AGENTS = `${DEVICES_SEEN_BY_AGENTS[0]?.toUpperCase() ?? ''}${DEVICES_SEEN_BY_AGENTS.slice(
  1,
)}, which is why this list shows every device there is.`

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
        reads: ['titles', 'intent'],
        mayAct: false,
        mayTalk: false,
        live: true,
      },
      {
        id: '00112233445566bb',
        label: 'MacBook',
        pairedAt: Date.parse('2026-09-11T09:40:00.000Z'),
        reads: [],
        mayAct: false,
        mayTalk: false,
        live: false,
      },
    ],
    streams: 1,
    acting: false,
    talking: false,
    acts: ACTING_IS_NOT_YOU,
    talks: TALKING_IS_NOT_YOU,
    lan: LAN_IS_PLAINTEXT,
    agents: AGENTS,
    problem: null,
    ...over,
  }
}

export const AWAY_SCREENS: Scenario[] = [
  {
    name: 'away-off',
    about:
      'The away view before anybody turns it on: nothing is listening, nothing can be paired, ' +
      'and what would turn it on said plainly rather than offered as a button that writes a ' +
      'setting the window would not read until it restarted.',
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
    frame: frame({ date: utcDate, panel: { away: view() } }),
  },
  {
    name: 'away-on-the-network',
    about:
      'On the network, which is a second decision from being on at all: what anybody on the ' +
      'same wifi can read is said above the code, with the way out in the same breath.',
    state: { ...base(), panel: awayPanel() },
    frame: frame({
      date: utcDate,
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
    frame: frame({ date: utcDate, width: 60, height: 24, panel: { away: view() } }),
  },
  {
    name: 'away-a-device-asking',
    about:
      'A device at the door: what it calls itself, where it came from, what it will be able to ' +
      'read — and the window’s own approve and deny keys, because letting a device in is the ' +
      'same act in the same vocabulary as approving a tool call.',
    state: { ...base(), panel: awayPanel() },
    frame: frame({
      date: utcDate,
      panel: {
        away: view({
          asking: {
            label: 'iPhone',
            from: '192.168.1.42',
            host: 'studio.local:7654',
            secondsLeft: 47,
          },
        }),
      },
    }),
  },
]
