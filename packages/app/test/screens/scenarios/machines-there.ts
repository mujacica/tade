import type { Frame } from '../../../src/frame.ts'
import type { MachineDetail } from '../../../src/machine-there.ts'
import { goElsewhere, type Machines } from '../../../src/machines.ts'
import { frame, NOW, type Scenario } from './fixtures.ts'
import { elsewhere, onThisMac } from './machines.ts'

// The rest of a project on another machine, down the side under its agents:
// the requests handed to it there and its doors, its checks, its schedules and
// watches with their last looks, and the documents its work produced
// (`view/elsewhere-more.ts`) — each the VPS's, as of when it last said.

const MINUTE = 60_000

/** What the VPS says about tade there, beyond its agents. */
const DETAIL: Partial<MachineDetail> = {
  requests: [
    {
      item: 'github:412',
      source: 'github',
      project: 'tade',
      state: 'proposed',
      because: 'waiting for you to approve it',
      title: 'Webhook deliveries are dropped under load',
      who: 'kim',
      at: NOW - 20 * MINUTE,
      tasks: ['tade/webhook-load'],
    },
    {
      item: 'slack:C04/1712',
      source: 'slack',
      project: 'tade',
      state: 'started',
      because: 'an agent is on it',
      title: 'Can the VPS watch Linear too?',
      who: 'amir',
      at: NOW - 3 * 60 * MINUTE,
      tasks: ['tade/linear-door'],
    },
  ],
  doors: [
    {
      source: 'github',
      state: 'found',
      because: 'found 1 new',
      lookedAt: NOW - 4 * MINUTE,
      found: 12,
      fresh: 1,
    },
    {
      source: 'linear',
      state: 'trouble',
      because: 'Linear said 401: the key was revoked',
      lookedAt: NOW - 9 * MINUTE,
      found: 0,
      fresh: 0,
    },
  ],
  checks: [
    {
      project: 'tade',
      task: null,
      check: 'tests',
      required: true,
      streak: { state: 'fail', since: NOW - 35 * MINUTE, runs: 2 },
      last: { state: 'fail', at: NOW - 12 * MINUTE },
      by: 'tade/remote-link',
    },
    {
      project: 'tade',
      task: null,
      check: 'types',
      required: true,
      streak: { state: 'pass', since: NOW - 26 * 60 * MINUTE, runs: 14 },
      last: { state: 'pass', at: NOW - 12 * MINUTE },
      by: 'tade/remote-link',
    },
    {
      project: 'tade',
      task: 'tade/mirror-branches',
      check: 'tests',
      required: true,
      streak: { state: 'pass', since: NOW - 50 * MINUTE, runs: 1 },
      last: { state: 'pass', at: NOW - 50 * MINUTE },
      by: null,
    },
  ],
  about: {
    at: NOW - MINUTE,
    roundTrip: 38,
    version: '0.2.3',
    newer: null,
    public: null,
    problems: [],
    schedules: [
      {
        id: 'new-sentry-errors',
        name: 'New Sentry errors',
        project: 'tade',
        kind: 'watch',
        when: 'every hour',
        paused: false,
        next: NOW + 20 * MINUTE,
        watch: {
          id: 'sentry.new-errors',
          looks: [
            { at: NOW - 40 * MINUTE, found: 3, fresh: 2, problem: null, said: null, on: null },
          ],
          found: [
            {
              at: NOW - 40 * MINUTE,
              key: 'TADE-1QF',
              title: 'TypeError: held.projection is null',
              task: 'tade/fix-held-projection',
            },
            {
              at: NOW - 40 * MINUTE,
              key: 'TADE-1QE',
              title: 'ECONNRESET in the follower',
              task: null,
            },
          ],
        },
      },
      {
        id: 'nightly-deps',
        name: 'Nightly dependency check',
        project: 'tade',
        kind: 'agent',
        when: 'every day at 03:00',
        paused: true,
        next: null,
        watch: null,
      },
    ],
    documents: [
      {
        task: 'tade/research',
        project: 'tade',
        name: 'REMOTE-TADE.md',
        state: 'written',
        at: NOW - 5 * 60 * MINUTE,
        bytes: 148_393,
        triaged: false,
      },
      {
        task: 'tade/audit',
        project: 'tade',
        name: 'AUDIT.md',
        state: 'gone',
        at: NOW - 30 * 60 * MINUTE,
        bytes: null,
        triaged: true,
      },
    ],
  },
}

/** The VPS up or down, with all of the above, and the lab box beside it. */
function told(down: boolean): Machines {
  const both = down ? elsewhere.down() : elsewhere.up()
  return {
    ...both,
    remotes: both.remotes.map((one) =>
      one.name === 'vps' ? { ...one, detail: { ...one.detail, ...DETAIL } } : one,
    ),
  }
}

const tall = (over: Partial<Frame>): Frame => frame({ width: 160, height: 60, ...over })

export const MACHINE_THERE_SCREENS: Scenario[] = [
  {
    name: 'a-project-on-another-machine-all-of-it',
    about:
      'Standing in tade on the VPS, the side goes on under its agents and its queue: the ' +
      'requests handed to it there and each door, its checks and how each has been answering, ' +
      'its watches with their last looks, and the documents its work produced — one a press ' +
      'away, read here over the link.',
    state: goElsewhere(onThisMac(), { machine: 'vps', project: 'tade' }),
    frame: tall({ machines: told(false) }),
  },
  {
    name: 'a-project-on-another-machine-all-of-it-down',
    about:
      'The same with the link down: every section as the VPS last said it, each heading saying ' +
      'as of when, and a document read once the VPS is linked again rather than offered.',
    state: goElsewhere(onThisMac(), { machine: 'vps', project: 'tade' }),
    frame: tall({ machines: told(true) }),
  },
]
