import { IDLE_REASON } from '@tade/core'
import type { Frame } from '../../../src/frame.ts'
import {
  goElsewhere,
  type Machine,
  type Machines,
  type RemoteAgent,
} from '../../../src/machines.ts'
import { focusTask, initialState, withProjects, withTasks } from '../../../src/model.ts'
import { menuPanel, projectsMenuItems } from '../../../src/panels/menu/state.ts'
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
  ...over,
})

/** The VPS: two projects, one of them busy, and its link up. */
const vps = (over: Partial<Machine> = {}): Machine => ({
  name: 'vps',
  link: 'live',
  said: null,
  asOf: NOW - 3_000,
  heard: true,
  projects: [
    {
      name: 'tade',
      title: null,
      more: 0,
      agents: [
        agent({
          name: 'intake-webhooks',
          title: 'Webhooks ring the doorbell',
          mark: 'needs-you',
          reason: 'wants approval: gh api',
          movedAt: NOW - 12 * MINUTE,
        }),
        agent({
          name: 'remote-link',
          mark: 'working',
          reason: 'running the suite',
          movedAt: NOW - 2 * MINUTE,
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
  ...over,
})

/** A second remote, a box in the office nothing has been asked of yet. */
const lab: Machine = {
  name: 'lab',
  link: 'live',
  said: null,
  asOf: NOW - 9_000,
  heard: true,
  projects: [{ name: 'firmware', title: null, more: 0, agents: [] }],
  spend: null,
}

const machines = (...remotes: Machine[]): Machines => ({ here: 'this Mac', remotes })

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
