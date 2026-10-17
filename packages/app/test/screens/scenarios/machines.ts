import { IDLE_REASON } from '@tade/core'
import type { Frame } from '../../../src/frame.ts'
import {
  goElsewhere,
  type Machine,
  type Machines,
  type Missed,
  NO_DETAIL,
  type RemoteAgent,
  type RemoteTalk,
} from '../../../src/machines.ts'
import {
  focusTask,
  initialState,
  withProjects,
  withTasks,
  withTerminals,
} from '../../../src/model.ts'
import { menuPanel, projectsMenuItems } from '../../../src/panels/menu/state.ts'
import { showTalk, talkSays, talkTab, talkTabsOf, talkTranscript } from '../../../src/talk-tab.ts'
import { frame, NOW, type Scenario, tasks } from './fixtures.ts'

// Other machines' projects in this window (REMOTE-TADE.md §9.4): a tab per
// project under the name of the machine it is on, the side listing a remote
// project's agents with the marks and ages that machine gave them, and what
// the window says while the link to one is down.
//
// The machines are drawn as `machines.ts` folds them — text, marks this Tade
// knows, moments in this machine's clock — which is what reaches the drawing
// whatever the remote sent; `test/machines.test.ts` is where what it sent is.

const MINUTE = 60_000

/** A remote agent as the fold leaves it. */
const agent = (over: Partial<RemoteAgent> & Pick<RemoteAgent, 'name' | 'mark'>): RemoteAgent => ({
  id: `tade/${over.name}`,
  title: null,
  counts: over.mark,
  queued: false,
  reason: '',
  movedAt: NOW - 4 * MINUTE,
  rev: 'r1',
  approval: null,
  parked: false,
  lane: over.mark === 'done' || over.mark === 'stopped' ? 'stopped' : 'running',
  can: [],
  ...over,
})

/** The VPS: two projects, one of them busy, and its link up. */
const vps = (over: Partial<Machine> = {}): Machine => ({
  name: 'vps',
  link: 'live',
  rev: 12,
  said: null,
  asOf: NOW - 3_000,
  heard: true,
  projects: [
    {
      name: 'tade',
      title: null,
      more: 0,
      watching: null,
      agents: [
        agent({
          name: 'intake-webhooks',
          title: 'Webhooks ring the doorbell',
          mark: 'needs-you',
          reason: 'wants approval: gh api',
          movedAt: NOW - 12 * MINUTE,
          approval: { id: 'call-1', tool: 'gh api' },
          can: ['park', 'answer', 'steer', 'stop'],
        }),
        agent({
          name: 'remote-link',
          mark: 'working',
          reason: 'running the suite',
          movedAt: NOW - 2 * MINUTE,
          can: ['park', 'steer', 'stop'],
        }),
        agent({
          name: 'mirror-branches',
          mark: 'working',
          movedAt: NOW - 41 * MINUTE,
        }),
        agent({
          name: 'notes-shared',
          title: 'Notes are shared both ways',
          mark: 'done',
          reason: 'finished: set union, tombstones applied',
          movedAt: NOW - 95 * MINUTE,
        }),
        agent({
          name: 'linear-door',
          mark: 'stopped',
          counts: 'queued',
          queued: true,
          reason: 'waits on intake-webhooks',
          movedAt: NOW - 30 * MINUTE,
        }),
      ],
    },
    {
      name: 'web',
      title: null,
      more: 0,
      watching: null,
      agents: [agent({ name: 'og-images', mark: 'done', movedAt: NOW - 3 * 60 * MINUTE })],
    },
  ],
  spend: {
    usd: 4.18,
    usdExact: 4.18,
    usdEstimated: 0,
    usdListed: 0,
    usdOnPlan: 0,
    tokens: 2_310_000,
    hasCost: true,
    partial: false,
  },
  talk: null,
  detail: NO_DETAIL,
  ...over,
})

/** A second remote, a box in the office nothing has been asked of yet. */
const lab: Machine = {
  name: 'lab',
  link: 'live',
  rev: 3,
  said: null,
  asOf: NOW - 9_000,
  heard: true,
  projects: [{ name: 'firmware', title: null, more: 0, watching: null, agents: [] }],
  spend: null,
  talk: null,
  detail: NO_DETAIL,
}

const machines = (...remotes: Machine[]): Machines => ({ here: 'this Mac', remotes })

/** What was said to the VPS's orchestrator last night, from this Mac, as its projection carries it. */
const TALK: RemoteTalk = {
  lines: [
    {
      id: 'l0041',
      at: NOW - 13 * 60 * MINUTE,
      kind: 'asked',
      from: 'device mac',
      text: 'overnight: land the deps bump, and get the webhook doorbell as far as you can',
      tool: null,
      outcome: null,
      streaming: false,
    },
    {
      id: 'l0042',
      at: NOW - 13 * 60 * MINUTE + 20_000,
      kind: 'tool',
      from: null,
      text: '',
      tool: 'tade_plan',
      outcome: 'ok',
      streaming: false,
    },
    {
      id: 'l0043',
      at: NOW - 13 * 60 * MINUTE + 40_000,
      kind: 'reply',
      from: null,
      text: 'Planned both: the deps bump runs first, and intake-webhooks starts once it lands.',
      tool: null,
      outcome: null,
      streaming: false,
    },
  ],
  rev: 'b0',
  busy: false,
  whose: null,
  mine: true,
  more: 0,
}

/** What the VPS said happened since the person was last there, as its link came back this morning. */
const MISSED: Missed = {
  machine: 'vps',
  since: NOW - 12 * 60 * MINUTE,
  waiting: {
    rows: [{ task: 'tade/intake-webhooks', at: NOW, said: 'wants an answer about Bash' }],
    more: 0,
  },
  finished: {
    rows: [
      { task: 'tade/deps-bump', at: NOW - 9 * 60 * MINUTE, said: 'its rule was met' },
      { task: 'web/landing-copy', at: NOW - 7 * 60 * MINUTE, said: 'its agent said so' },
    ],
    more: 0,
  },
  documents: { rows: [], more: 0 },
  held: {
    rows: [
      {
        task: 'tade/release-notes',
        at: NOW - 6 * 60 * MINUTE,
        said: 'waiting on tade/intake-webhooks',
      },
    ],
    more: 0,
  },
  proposed: { rows: [], more: 0 },
  spend: { usd: 6.4, tokens: 3_900_000, hasCost: true },
}

/**
 * The VPS down since a train went into a tunnel: what it last said, eight
 * minutes ago — so every moment in it is eight minutes older too.
 */
const down = ((): Machine => {
  const was = vps()
  const older = (at: number | null) => (at === null ? null : at - 8 * MINUTE)
  return {
    ...was,
    link: 'down',
    said: 'timed out: nothing answered in 30s',
    asOf: older(was.asOf),
    projects: was.projects.map((project) => ({
      ...project,
      agents: project.agents.map((one) => ({ ...one, movedAt: older(one.movedAt) })),
    })),
  }
})()

/** The machines as other scenarios draw them: the VPS up, or down, and the lab box. */
export const elsewhere = { up: () => machines(vps(), lab), down: () => machines(down, lab) }

/** Two projects on this Mac, one agent waiting on you here. */
const onThisMac = () =>
  focusTask(
    withTasks(withProjects(initialState(), ['checkout', 'search']), [
      ...tasks.slice(0, 2),
      { task: 'search/rankings', state: 'blocked', reason: IDLE_REASON },
    ]),
    'checkout/refunds',
  )

const wide = (over: Partial<Frame> = {}): Frame => frame({ width: 160, height: 34, ...over })

/** What the agent waiting on you there shows on its own screen, as the VPS read it. */
const DOORBELL = [
  '> wire the GitHub webhook to the doorbell, then prove a delivery wakes the watch',
  '',
  '● I will register the hook on acme/checkout and send a test delivery.',
  '',
  '● Bash(gh api repos/acme/checkout/hooks --method POST -f name=web …)',
  '',
  '  Do you want to proceed?',
  '  ❯ 1. Yes',
  '    2. Yes, and don’t ask again for gh api commands',
  '    3. No, and tell Claude what to do differently',
]

/** Looking at that agent there: its screen, read a few seconds ago. */
const looking = () =>
  goElsewhere(onThisMac(), { machine: 'vps', project: 'tade', agent: 'tade/intake-webhooks' })

export const MACHINE_SCREENS: Scenario[] = [
  {
    name: 'projects-on-two-machines',
    about:
      'This Mac’s two projects first, then each remote under its own name: the VPS with tade, ' +
      'where an agent wants you and two are working, and web, which is done — and the lab box, ' +
      'where nothing has been asked of firmware yet. Each tab carries the marks its own machine ' +
      'gave its agents, so two projects called tade are never two tabs nobody can tell apart.',
    state: onThisMac(),
    frame: wide({ machines: machines(vps(), lab) }),
  },
  {
    name: 'a-project-on-another-machine',
    about:
      'Standing in tade on the VPS: the side lists its agents with the marks the VPS drew and how ' +
      'long ago each moved, its queued work under them, and the pane says where it is and how it ' +
      'stands. The keyboard is on the line you talk to Tade on, as in a project with no agents here.',
    state: goElsewhere(onThisMac(), { machine: 'vps', project: 'tade' }),
    frame: wide({ machines: machines(vps(), lab) }),
  },
  {
    name: 'a-machine-whose-link-is-down',
    about:
      'The link to the VPS is down: its name wears `○`, the rows stay as it last said them with ' +
      'their ages as of then, the heading says `as of 13:52`, and the pane says why — never an ' +
      'empty list, which would read as nothing running on a machine whose agents are working.',
    state: goElsewhere(onThisMac(), { machine: 'vps', project: 'tade' }),
    frame: wide({ machines: machines(down, lab) }),
  },
  {
    name: 'machines-in-a-narrow-window',
    about:
      'No room for every tab: each remote folds its projects into its name — `vps ⋯2 !` says two ' +
      'projects and the most urgent mark among them — before any tab of this Mac’s goes in the `⋯`, ' +
      'and the project you are standing in keeps its tab wherever it is.',
    state: goElsewhere(onThisMac(), { machine: 'vps', project: 'web' }),
    frame: frame({ width: 100, height: 28, machines: machines(vps(), lab) }),
  },
  {
    name: 'an-agent-on-another-machine',
    about:
      'An agent on the VPS pressed down the side: the pane says what it is and how it stands there, ' +
      'offers what the VPS says may be asked of it — type into it, steer it, park it, stop it, and ' +
      'allow or deny the `gh api` call it is held on — and shows its screen there, read-only, as ' +
      'the VPS last read it.',
    state: looking(),
    frame: wide({
      machines: machines(vps(), lab),
      remoteScreen: {
        task: 'tade/intake-webhooks',
        lines: DOORBELL,
        at: NOW - 4_000,
        above: 0,
        why: null,
      },
    }),
  },
  {
    name: 'typing-into-an-agent-on-another-machine',
    about:
      'Enter on it: a terminal here that is the agent there, in front of the lower pane with the ' +
      'room to read it — the VPS’s own tmux, a view of its own so two agents side by side stay two ' +
      'agents, over ssh, or mosh where both machines have it. Closing the tab ends the terminal, ' +
      'never the agent.',
    state: {
      ...withTerminals(looking(), [
        { id: 'remotes/vps/1', project: '', name: 'vps · intake-webhooks' },
      ]),
      bottom: 'remotes/vps/1',
      keyboard: 'terminal',
      bottomMode: 'max',
    },
    frame: wide({
      machines: machines(vps(), lab),
      terminal: { screen: ['', ...DOORBELL, '', '1'].join('\n') },
    }),
  },
  {
    name: 'another-machines-orchestrator',
    about:
      'The laptop opened: beside this Mac’s orchestrator, a tab for the VPS’s, marked with ' +
      'something unread. On it, what was said to it last night, then what the VPS says happened ' +
      'since the person was last there — what waits on them, what finished, what is held, what ' +
      'it cost — and where a sentence typed here goes: to the orchestrator on the VPS.',
    state: { ...showTalk(onThisMac(), talkTab('vps')), sizes: { stripHeight: 16 } },
    frame: wide({
      machines: machines(vps({ talk: TALK }), lab),
      talkTabs: talkTabsOf(machines(vps({ talk: TALK }), lab), [], NOW),
      talk: {
        machine: 'vps',
        transcript: talkTranscript(TALK, 'device mac', []),
        missed: MISSED,
        says: talkSays(vps({ talk: TALK }), 'device mac', false),
      },
    }),
  },
  {
    name: 'a-machines-projects',
    about:
      'A machine’s name opened: its projects, each saying what its tab says, and choosing one ' +
      'stands in it.',
    state: {
      ...onThisMac(),
      panel: menuPanel({ kind: 'machine', machine: 'vps' }, 'vps', { row: 1, col: 61 }),
    },
    frame: wide({
      machines: machines(vps(), lab),
      panel: {
        items: projectsMenuItems([
          { project: 'tade', label: 'tade', says: '! ⠋2 ◌' },
          { project: 'web', label: 'web', says: '✓' },
        ]),
      },
    }),
  },
]
