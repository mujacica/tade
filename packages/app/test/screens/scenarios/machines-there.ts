import type { Frame } from '../../../src/frame.ts'
import type { MachineDetail } from '../../../src/machine-there.ts'
import { goElsewhere, type Machines } from '../../../src/machines.ts'
import { requestTherePanel } from '../../../src/panels/intake/there.ts'
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
      externalId: 'acme/checkout#412',
      url: 'https://github.com/acme/checkout/issues/412',
      grant: 'intake.grants.github-issues',
      stamp: { name: 'triage', version: 3 },
      revision: 'r2',
      moved: false,
      watch: 'github.issues',
      attempts: 0,
      tries: 3,
      work: [
        { task: 'tade/webhook-load', parked: true, started: false, finished: false, held: null },
      ],
      material: {
        words:
          'Under load the webhook endpoint drops deliveries: GitHub shows 502s for about one in\n' +
          'twenty during a burst of pushes.\n\nSteps: push ten commits in a minute and watch the\n' +
          'deliveries page.',
        more: false,
      },
      materialSays: null,
      would: {
        starts: [
          {
            task: 'tade/webhook-load',
            workspace: 'worktree',
            done: 'review',
            produces: null,
            after: [],
            parked: true,
          },
        ],
        grant: ['intake.grants.github-issues lets acme/checkout issues in, and approves none'],
        limits: ['$5.00 a day for this project, $1.20 spent today'],
        problems: [],
        warnings: [],
      },
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
      externalId: 'C04/1712',
      url: null,
      grant: 'intake.grants.slack-ops',
      stamp: null,
      revision: 'r1',
      moved: false,
      watch: 'slack.mentions',
      attempts: 0,
      tries: 3,
      work: [
        { task: 'tade/linear-door', parked: false, started: true, finished: false, held: null },
      ],
      material: null,
      materialSays: 'nothing here has read it yet',
      would: null,
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
    name: 'a-request-on-another-machine',
    about:
      'A request in the VPS’s INTAKE pressed: the page a request here opens, read-only and ' +
      'labelled with the VPS — where it stands there and why, what let it in and what it was ' +
      'stamped from, what approving it would start there, and the request itself under the ' +
      'label that says whose words those are — and at its foot, that approving it is the VPS’s.',
    state: {
      ...goElsewhere(onThisMac(), { machine: 'vps', project: 'tade' }),
      panel: requestTherePanel('vps', 'github:412', 'Webhook deliveries are dropped under load'),
    },
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
