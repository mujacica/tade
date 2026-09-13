import { ConfigSchema, settingsOf, type WilcoEvent } from '@wilco/core'
import { parseDiff } from '../../src/diff.ts'
import {
  type AppState,
  focusTask,
  initialState,
  setDictation,
  setListening,
  type TaskSnapshot,
  toggleSection,
  withProjects,
  withTasks,
} from '../../src/model.ts'
import {
  confirmRemovePanel,
  diffPanel,
  menuItems,
  menuPanel,
  openProjectPanel,
  palettePanel,
  settingsPanel,
  spendPanel,
} from '../../src/panels.ts'
import { COLOUR } from '../../src/skin.ts'
import { spendView } from '../../src/spend.ts'
import type { Frame } from '../../src/view.ts'

// The screens the window must keep looking like.
//
// Each scenario is a state and a frame, drawn with fixed data so the result is
// the same on every machine: no clock, no git, no terminal. They are what the
// golden files under `__screens__/` are drawn from, and what the gallery shows
// a person reviewing a change to how Wilco looks.
//
// Add one whenever the window gains a state worth protecting. Name it for what
// somebody would be doing when they saw it.

export interface Scenario {
  name: string
  /** What it shows, for the gallery. */
  about: string
  state: AppState
  frame: Frame
}

const NOW = Date.parse('2026-09-13T14:00:04Z')

const tasks: TaskSnapshot[] = [
  {
    task: 'checkout/stripe-v15',
    state: 'blocked',
    lane: 'checkout/stripe-v15/agent',
    lanes: [
      { id: 'checkout/stripe-v15/agent', kind: 'agent' },
      { id: 'checkout/stripe-v15/shell', kind: 'shell' },
    ],
    waiting: true,
    approval: { tool: 'bash', summary: 'npm i stripe@15' },
  },
  { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
  { task: 'search/pagination', state: 'review' },
]

const agentScreen = [
  '',
  '  ● Upgrading stripe to v15. The webhook signature API changed,',
  '    so src/webhooks.ts needs the new constructEvent signature.',
  '',
  '  ▸ Read src/webhooks.ts',
  '  ▸ Edit src/webhooks.ts  +12 −4',
  '  ▸ bash npm i stripe@15',
].join('\n')

const base = (): AppState =>
  focusTask(
    withTasks(withProjects(initialState(), ['checkout', 'search', 'infra']), tasks),
    'checkout/stripe-v15',
  )

const frame = (over: Partial<Frame> = {}): Frame => ({
  width: 120,
  height: 34,
  screen: agentScreen,
  skin: COLOUR,
  now: NOW,
  home: '~/.wilco',
  files: [
    { path: 'src', name: 'src', depth: 0, folder: true, open: true },
    {
      path: 'src/webhooks.test.ts',
      name: 'webhooks.test.ts',
      depth: 1,
      folder: false,
      open: false,
    },
    { path: 'src/webhooks.ts', name: 'webhooks.ts', depth: 1, folder: false, open: false },
    { path: 'test', name: 'test', depth: 0, folder: true, open: false },
    { path: 'package.json', name: 'package.json', depth: 0, folder: false, open: false },
    { path: 'README.md', name: 'README.md', depth: 0, folder: false, open: false },
  ],
  where: {
    repo: '~/src/checkout',
    branch: 'wilco/stripe-v15',
    base: 'main',
    worktree: '~/.wilco/worktrees/checkout-stripe-v15',
  },
  changes: [
    { path: 'package.json', mark: 'M', added: 2, removed: 1 },
    { path: 'src/webhooks.test.ts', mark: 'A', added: 48, removed: null },
    { path: 'src/webhooks.ts', mark: 'M', added: 12, removed: 4 },
  ],
  notes: [
    'the staging key rotates on the 1st',
    'we pin major versions',
    'refunds go through the ledger service',
    'never force-push to main',
  ],
  base: 'main',
  spend: {
    tokens: 1_900_000,
    usd: 2.66,
    hasCost: true,
    byTask: {
      'checkout/stripe-v15': { tokens: 880_000, usd: 1.26 },
      'checkout/refunds': { tokens: 460_000, usd: 0.62 },
    },
  },
  route: {
    harness: 'pi',
    model: 'anthropic/claude-opus-5',
    provider: 'anthropic',
    credential: 'signed in',
  },
  vitals: { model: 'anthropic/claude-opus-5', contextPercent: 41 },
  voice: { keys: ['ctrl', 'space'], available: true },
  ...over,
})

let seq = 0
const usage = (task: string | null, model: string, tokens: number, usd: number): WilcoEvent => ({
  seq: ++seq,
  ts: '2026-09-13T13:00:00.000Z',
  type: 'usage',
  urgency: 'routine',
  task,
  lane: null,
  run: null,
  detail: { model, tokens, usd, ...(task ? {} : { by: 'orchestrator' }) },
})

/** A morning's spend, the one the design was drawn with. */
const spent = [
  usage(null, 'anthropic/claude-opus-5', 412_000, 0.58),
  usage('checkout/stripe-v15', 'anthropic/claude-opus-5', 880_000, 1.26),
  usage('checkout/refunds', 'anthropic/claude-opus-5', 460_000, 0.62),
  usage('search/pagination', 'anthropic/claude-sonnet-5', 148_000, 0.2),
]

/** What the Settings panel is shown: a machine set up the way the design was drawn. */
function settingsFacts() {
  const config = ConfigSchema.parse({
    projects: {
      checkout: { root: '~/src/checkout', budget: { usd_per_day: 5 } },
      search: { root: '~/src/search' },
      infra: { root: '~/src/infra' },
    },
    surfaces: {
      voice: {
        mic: { device: 'MacBook Pro Microphone' },
        attention: { budget: 6, quiet: '22:00-07:00' },
      },
    },
  })
  return {
    settings: settingsOf(config),
    accounts: ['anthropic'],
    configPath: '~/.wilco/config.yaml',
    releases: true,
    budgetWarnings: 1,
  }
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'watching-an-agent',
    about: 'The window with an agent waiting on an approval, its changes, spend and the talk key.',
    state: base(),
    frame: frame(),
  },
  {
    name: 'pointing-at-a-button',
    about: 'The pointer over Open project: hover is drawn, not left to the terminal.',
    state: { ...base(), hover: { kind: 'action', name: 'open-project' } },
    frame: frame(),
  },
  {
    name: 'every-section-open',
    about: 'Notes unfolded too, as they are after a click on the heading.',
    state: toggleSection(base(), 'notes'),
    frame: frame(),
  },
  {
    name: 'an-agent-not-running',
    about: 'An agent that is not running: one button opens it again.',
    state: focusTask(base(), 'search/pagination'),
    frame: frame({ screen: '', changes: [] }),
  },
  {
    name: 'talking',
    about: 'The microphone is open: the chip and the strip both say so, in red.',
    state: {
      ...setListening(base(), true),
      talkingSince: NOW - 4_000,
      levels: [
        0.05, 0.1, 0.2, 0.4, 0.7, 0.9, 1, 0.9, 0.6, 0.35, 0.15, 0.1, 0.2, 0.4, 0.6, 0.75, 0.85, 0.7,
        0.55, 0.35, 0.2, 0.1,
      ],
    },
    frame: frame(),
  },
  {
    name: 'typing-to-wilco',
    about: 'The orchestrator line, open and being typed into.',
    state: setDictation(
      { ...base(), focused: null, chose: true },
      'what is going on with checkout',
    ),
    frame: frame({ screen: '' }),
  },
  {
    name: 'spend',
    about:
      'The Spend panel: the orchestrator and every agent today, and each project against its budget.',
    state: { ...base(), panel: spendPanel() },
    frame: frame({
      spendView: spendView(spent, {
        window: 'today',
        by: 'agent',
        now: NOW,
        openedAt: NOW - 3_600_000,
        projects: ['checkout', 'search', 'infra'],
        budgets: { checkout: { usd_per_day: 5 } },
      }),
    }),
  },
  {
    name: 'agent-menu',
    about: "A task's menu, opened from its ≡: what can be done, and why not where it cannot.",
    state: { ...base(), panel: menuPanel('checkout/stripe-v15', { row: 4, col: 2 }) },
    frame: frame({
      panel: {
        items: menuItems({ lane: 'checkout/stripe-v15/agent', state: 'blocked' }, 3),
      },
    }),
  },
  {
    name: 'remove-agent',
    about: 'Removing a task asks first, and says exactly what would be lost.',
    state: { ...base(), panel: confirmRemovePanel('checkout/stripe-v15') },
    frame: frame({ panel: { ahead: 3, branch: 'wilco/stripe-v15', base: 'main' } }),
  },
  {
    name: 'diff',
    about: 'A changed file, read-only, over the window.',
    state: {
      ...base(),
      panel: diffPanel(
        'checkout/stripe-v15',
        ['package.json', 'src/webhooks.ts', 'src/webhooks.test.ts'],
        1,
      ),
    },
    frame: frame({
      panel: {
        diff: parseDiff(
          [
            'diff --git a/src/webhooks.ts b/src/webhooks.ts',
            '--- a/src/webhooks.ts',
            '+++ b/src/webhooks.ts',
            '@@ -38,5 +38,7 @@ export async function handle(req, res) {',
            "   const sig = req.headers['stripe-signature']",
            '-  const event = stripe.webhooks.constructEvent(body, sig, key)',
            '+  const event = await stripe.webhooks.constructEventAsync(',
            '+    body, sig, key, undefined, cryptoProvider,',
            '+  )',
            "   if (event.type === 'charge.refunded') {",
            '     await refund(event)',
          ].join('\n'),
        ),
      },
    }),
  },
  {
    name: 'settings',
    about: 'Settings over the window: categories down the side, real controls on the right.',
    state: { ...base(), panel: { ...settingsPanel('voice'), row: 0 } },
    frame: frame({ panel: settingsFacts() }),
  },
  {
    name: 'settings-list-open',
    about:
      'A setting whose choices need explaining opens as a list, grouped, with what each needs.',
    state: {
      ...base(),
      panel: {
        ...settingsPanel('voice'),
        row: 2,
        dropdown: { path: 'surfaces.voice.stt.driver', query: '', index: 0 },
      },
    },
    frame: frame({ panel: settingsFacts() }),
  },
  {
    name: 'choosing-the-talk-key',
    about: 'Pressing a key to talk with, and being told what it would take away.',
    state: {
      ...base(),
      panel: {
        ...settingsPanel('voice'),
        capture: { path: 'surfaces.voice.talk.key', key: 'ctrl+r' },
      },
    },
    frame: frame({ panel: settingsFacts() }),
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
            row: { kind: 'recent', name: 'wilco', path: '/Users/me/wilco', git: true },
            branch: 'main',
            tasks: 0,
            when: '4 days ago',
          },
        ],
      },
    }),
  },
  {
    name: 'go-to-anything',
    about: 'ctrl+g: every task, approval, action and setting, narrowed by what you type.',
    state: { ...base(), panel: { ...palettePanel(), query: 'stri' } },
    frame: frame({
      panel: {
        entries: [
          {
            id: 'task:checkout/stripe-v15',
            label: 'stripe-v15',
            kind: 'agent in checkout',
            mark: '●',
            tone: 'waiting',
            note: 'waiting on you',
          },
          {
            id: 'approve:checkout/stripe-v15',
            label: 'Allow once: npm i stripe@15',
            kind: 'approval',
            mark: '▸',
            tone: 'waiting',
          },
          { id: 'stop:checkout/stripe-v15', label: 'Stop stripe-v15', kind: 'agent', mark: '■' },
          {
            id: 'changes:checkout/stripe-v15',
            label: 'Show the changes in stripe-v15',
            kind: 'agent',
            mark: '±',
          },
          {
            id: 'setting:approvals',
            label: 'Settings › Approvals › strict tools',
            kind: 'setting',
            mark: '◇',
          },
        ],
      },
    }),
  },
  {
    name: 'keys',
    about: 'The keys Wilco keeps, talking first.',
    state: { ...base(), panel: { kind: 'keys', busy: false } },
    frame: frame({ panel: { talkKey: 'ctrl+space', talkMode: 'hold', releases: true } }),
  },
  {
    name: 'closing',
    about: 'Closing asks only when it would stop agents, and says what happens to them.',
    state: { ...base(), panel: { kind: 'quit', field: 'cancel', busy: false } },
    frame: frame({ panel: { running: 2 } }),
  },
  {
    name: 'another-project-needs-you',
    about:
      'An agent in a project you are not looking at wants approval: a toast, answerable where it is.',
    state: {
      ...focusTask(
        withTasks(withProjects(initialState(), ['checkout', 'search', 'infra']), [
          ...tasks.slice(1, 2),
          {
            task: 'search/pagination',
            state: 'blocked',
            lane: 'search/pagination/agent',
            waiting: true,
            approval: { tool: 'bash', summary: 'rm -rf node_modules && npm ci' },
          },
        ]),
        'checkout/refunds',
      ),
      toasts: [{ task: 'search/pagination', at: NOW - 12_000 }],
    },
    frame: frame(),
  },
  {
    name: 'voice-off',
    about: 'No microphone or speech engine: the chip says so, and offers setup.',
    state: base(),
    frame: frame({ voice: { keys: ['ctrl', 'space'], available: false } }),
  },
  {
    name: 'first-open',
    about:
      'A project and nothing running yet: its repository and files, and what to do next, as buttons.',
    state: withProjects(initialState(), ['checkout']),
    frame: frame({
      screen: '',
      changes: [],
      notes: [],
      base: null,
      where: { repo: '~/src/checkout', branch: 'main', base: null, worktree: null },
      files: [
        { path: 'src', name: 'src', depth: 0, folder: true, open: false },
        { path: 'test', name: 'test', depth: 0, folder: true, open: false },
        { path: 'package.json', name: 'package.json', depth: 0, folder: false, open: false },
        { path: 'README.md', name: 'README.md', depth: 0, folder: false, open: false },
      ],
      spend: { tokens: 0, usd: 0, hasCost: false, byTask: {} },
    }),
  },
  {
    name: 'pointing-at-a-link',
    about:
      'Links and file references on an agent screen are clickable, and underline under the pointer.',
    state: {
      ...base(),
      hover: { kind: 'link', url: 'https://docs.stripe.com/webhooks/signatures' },
    },
    frame: frame({
      screen: `${agentScreen}\n\n  See https://docs.stripe.com/webhooks/signatures — the failure is in src/webhooks.ts:42:7`,
    }),
  },
  {
    name: 'small-terminal',
    about: 'An 80×24 terminal: everything still fits, and nothing wraps.',
    state: base(),
    frame: frame({ width: 80, height: 24 }),
  },
]
