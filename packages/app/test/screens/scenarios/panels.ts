import { initialState, withProjects } from '../../../src/model.ts'
import {
  branchMenuItems,
  changeMenuItems,
  fileMenuItems,
  menuItems,
  menuPanel,
  thinkingMenuItems,
} from '../../../src/panels/menu/state.ts'
import { modelPanel } from '../../../src/panels/models/state.ts'
import { openProjectPanel } from '../../../src/panels/project/state.ts'
import {
  closeDonePanel,
  confirmRemovePanel,
  noteHeadlinePanel,
  promptPanel,
} from '../../../src/panels/small/state.ts'
import { base, finished, frame, type Scenario, utcDate } from './fixtures.ts'

// The panels: menus, and the pages that float over the window.
//
// A menu is opened on one thing — an agent, a file, a change, a branch — and
// a panel is a page you are taken to and come back from. They are together
// because they are the same act: something you asked for, over everything else.

export const PANEL_SCREENS: Scenario[] = [
  {
    name: 'writing-a-notes-headline',
    about:
      'Writing the line a note is read by, for one taken before anybody wrote one: the note’s own words above it, and what is asked for said plainly.',
    state: {
      ...base(),
      folded: ['changes', 'files', 'where'],
      panel: noteHeadlinePanel(
        { at: '2026-09-01T09:00:00.000Z', summary: null, scope: 'checkout', by: 'window' },
        'the staging key rotates on the 1st',
      ),
    },
    frame: frame({ date: utcDate }),
  },
  {
    name: 'choosing-a-model',
    about:
      'Clicking the orchestrator’s model: every model you are signed in to, filtered as you type, the current one marked, with what each costs in, out and read back from the cache.',
    state: { ...base(), panel: { ...modelPanel('orchestrator'), index: 1 } },
    frame: frame({
      panel: {
        models: [
          {
            id: 'openrouter/anthropic/claude-opus-5',
            provider: 'openrouter',
            name: 'Claude Opus 5',
            price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          },
          {
            id: 'openrouter/anthropic/claude-sonnet-5',
            provider: 'openrouter',
            name: 'Claude Sonnet 5',
            price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          },
          {
            id: 'openrouter/moonshotai/kimi-k2.6',
            provider: 'openrouter',
            name: 'Kimi K2.6',
            price: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
          },
          {
            id: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
            provider: 'openrouter',
            name: 'Nemotron 3 Super (free)',
            price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            id: 'anthropic/claude-opus-5',
            provider: 'anthropic',
            name: 'Claude Opus 5',
            price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          },
        ],
        // Whose models these are. Every one of them is a model pi runs: a
        // picker is one harness's list, asked of that harness.
        modelsFrom: { harness: 'pi', why: null },
        modelTarget: 'the orchestrator',
        currentModel: 'openrouter/anthropic/claude-opus-5',
      },
    }),
  },
  {
    name: 'a-harness-that-cannot-say-its-models',
    about:
      'Choosing a model for an agent whose harness could not say what it runs: its own sentence, and no list — another harness’s models are names this one never heard of.',
    state: { ...base(), panel: modelPanel('checkout/stripe-v15') },
    frame: frame({
      panel: {
        models: [],
        modelsFrom: {
          harness: 'codex',
          why: 'names its own models (codex debug models), and the codex on this machine did not answer',
        },
        modelTarget: 'stripe-v15',
        currentModel: null,
      },
    }),
  },
  {
    name: 'agent-menu',
    about: "An agent's menu, opened from its ≡: what can be done, and why not where it cannot.",
    state: {
      ...base(),
      panel: menuPanel({ kind: 'task', task: 'checkout/stripe-v15' }, 'stripe-v15', {
        row: 4,
        col: 2,
      }),
    },
    frame: frame({
      panel: {
        items: menuItems({ lane: 'checkout/stripe-v15/agent', state: 'blocked' }, 3),
      },
    }),
  },
  {
    name: 'choosing-how-hard-it-thinks',
    about:
      'The thinking button beside the model, opened: every level from off to max, the one the agent is at marked.',
    state: {
      ...base(),
      panel: menuPanel(
        { kind: 'thinking', task: 'checkout/stripe-v15', current: 'high' },
        'Thinking',
        {
          row: 3,
          col: 84,
        },
      ),
    },
    frame: frame({ panel: { items: thinkingMenuItems('high') } }),
  },
  {
    name: 'choosing-how-hard-tade-thinks',
    about:
      "The thinking button in the strip, beside the orchestrator's model: the same levels an " +
      'agent has, and the one it is at marked. It moves from its next reply.',
    state: {
      ...base(),
      panel: menuPanel({ kind: 'thinking', task: 'orchestrator', current: 'high' }, 'Thinking', {
        row: 32,
        col: 88,
      }),
    },
    frame: frame({ panel: { items: thinkingMenuItems('high') } }),
  },
  {
    name: 'file-menu',
    about:
      'A file in FILES, right-clicked: open it here or in your editor, ask the agent, copy, reveal.',
    state: {
      ...base(),
      hover: { kind: 'file', path: 'src/webhooks.ts' },
      panel: menuPanel({ kind: 'file', path: 'src/webhooks.ts', folder: false }, 'webhooks.ts', {
        row: 19,
        col: 6,
      }),
    },
    frame: frame({
      panel: {
        items: fileMenuItems({
          folder: false,
          open: false,
          changed: true,
          agent: true,
          platform: 'darwin',
        }),
      },
    }),
  },
  {
    name: 'change-menu',
    about:
      'A changed file, right-clicked: its diff, the file, and discarding what is not committed.',
    state: {
      ...base(),
      panel: menuPanel(
        { kind: 'change', task: 'checkout/stripe-v15', path: 'src/webhooks.ts' },
        'webhooks.ts',
        { row: 13, col: 4 },
      ),
    },
    frame: frame({ panel: { items: changeMenuItems({ uncommitted: true, agent: true }) } }),
  },
  {
    name: 'branch-menu',
    about: "The project's branch under GIT: switch it, make a new one, pull.",
    state: {
      ...withProjects(initialState(), ['checkout']),
      panel: menuPanel({ kind: 'branch' }, 'main', { row: 18, col: 4 }),
    },
    frame: frame({
      screen: '',
      changes: [],
      where: {
        repo: '~/src/checkout',
        branch: 'main',
        base: null,
        worktree: null,
        path: '/Users/me/src/checkout',
      },
      panel: { items: branchMenuItems({ agent: false, name: 'main' }) },
    }),
  },
  {
    name: 'adding-a-note',
    about: 'The + beside NOTES: a note, about this project or everything, kept word for word.',
    state: {
      ...base(),
      panel: {
        ...promptPanel('note', 'New note', 'NOTE ABOUT CHECKOUT'),
        text: 'The staging key rotates on the 1st',
      },
    },
    frame: frame(),
  },
  {
    name: 'remove-agent',
    about: 'Removing a task asks first, and says exactly what would be lost.',
    state: { ...base(), panel: confirmRemovePanel('checkout/stripe-v15') },
    frame: frame({ panel: { ahead: 3, branch: 'tade/stripe-v15', base: 'main' } }),
  },
  {
    name: 'cleaning-up-finished-agents',
    about:
      'The X beside the + asks before it closes anything, and names every agent it would close.',
    state: {
      ...finished(),
      panel: closeDonePanel(['checkout/refund-emails', 'checkout/webhook-retries']),
    },
    frame: frame(),
  },
  {
    name: 'open-project',
    about:
      'Opening a project: a folder browser from home, recent projects beside it, git offered where there is none.',
    state: {
      ...base(),
      panel: {
        ...openProjectPanel('/Users/me/src'),
        back: ['/Users/me'],
        index: 2,
      },
    },
    frame: frame({
      panel: {
        browsing: '/Users/me/src',
        homeDir: '/Users/me',
        openRows: [
          {
            row: { kind: 'here', name: 'src', path: '/Users/me/src', git: false },
            branch: null,
            tasks: 0,
            when: null,
          },
          {
            row: { kind: 'folder', name: 'payments', path: '/Users/me/src/payments', git: true },
            branch: 'main',
            tasks: 0,
            when: null,
          },
          {
            row: { kind: 'folder', name: 'payroll', path: '/Users/me/src/payroll', git: false },
            branch: null,
            tasks: 0,
            when: null,
          },
          {
            row: { kind: 'folder', name: 'search', path: '/Users/me/src/search', git: true },
            branch: 'main',
            tasks: 0,
            when: null,
          },
          {
            row: { kind: 'recent', name: 'checkout', path: '/Users/me/src/checkout', git: true },
            branch: 'main',
            tasks: 3,
            when: '2h ago',
          },
          {
            row: { kind: 'recent', name: 'tade', path: '/Users/me/tade', git: true },
            branch: 'main',
            tasks: 0,
            when: '4 days ago',
          },
        ],
      },
    }),
  },
]
