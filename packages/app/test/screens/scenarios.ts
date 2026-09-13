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
  withTerminals,
} from '../../src/model.ts'
import {
  branchMenuItems,
  branchPanel,
  changeMenuItems,
  confirmRemovePanel,
  diffPanel,
  fileMenuItems,
  filePanel,
  findPanel,
  imageMenuItems,
  menuItems,
  menuPanel,
  openProjectPanel,
  promptPanel,
  searchPanel,
  settingsPanel,
  spendPanel,
} from '../../src/panels.ts'
import { type SearchEntry, searchResults } from '../../src/search.ts'
import { COLOUR } from '../../src/skin.ts'
import { spendView } from '../../src/spend.ts'
import {
  emptyTranscript,
  fromThinker,
  problem,
  type Transcript,
  thinking,
  youSaid,
} from '../../src/transcript.ts'
import type { Frame } from '../../src/view.ts'
import { formattedLines, sourceLines, type ViewedFile } from '../../src/viewer.ts'

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
    path: '/Users/me/.wilco/worktrees/checkout-stripe-v15',
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

const webhooksFile: ViewedFile = {
  path: '/Users/me/src/checkout/src/webhooks.ts',
  size: 1_184,
  binary: false,
  truncated: false,
  language: 'typescript',
  error: null,
  text: [
    "import Stripe from 'stripe'",
    "import { refund } from './ledger.ts'",
    '',
    '/** Every event Stripe sends us, checked before anything acts on it. */',
    'export async function handle(body: string, sig: string): Promise<void> {',
    '  const key = process.env.STRIPE_WEBHOOK_SECRET',
    "  if (!key) throw new Error('no webhook secret')",
    '  const cryptoProvider = Stripe.createSubtleCryptoProvider()',
    '  const event = await stripe.webhooks.constructEventAsync(',
    '    body, sig, key, undefined, cryptoProvider,',
    '  )',
    "  if (event.type === 'charge.refunded') {",
    '    await refund(event)',
    '  }',
    '}',
    '',
  ].join('\n'),
}

const readmeFile: ViewedFile = {
  path: '/Users/me/src/checkout/README.md',
  size: 412,
  binary: false,
  truncated: false,
  language: 'markdown',
  error: null,
  text: [
    '# checkout',
    '',
    'Takes the **money**, and gives it back when it has to.',
    '',
    '## Running it',
    '',
    '- `pnpm dev` starts it against the Stripe test keys',
    '- `pnpm test` runs everything, webhooks included',
    '',
    '```ts',
    'const event = await stripe.webhooks.constructEventAsync(body, sig, key)',
    '```',
    '',
    '> Never force-push to main.',
    '',
  ].join('\n'),
}

function viewing(file: ViewedFile, width?: number) {
  return {
    file,
    source: sourceLines(file, false),
    formatted: width ? formattedLines(file, width, false) : null,
  }
}

const checkout = { path: '/Users/me/src/checkout', label: 'checkout', task: null }
const stripeTree = {
  path: '/Users/me/.wilco/worktrees/checkout-stripe-v15',
  label: 'checkout › stripe-v15',
  task: 'checkout/stripe-v15',
}

/** What search shows for a query, from the same function the window uses. */
function searched(query: string): SearchEntry[] {
  const agents: SearchEntry[] = [
    {
      id: 'approve:checkout/stripe-v15',
      kind: 'approval',
      label: 'Allow once: npm i stripe@15',
      detail: 'stripe-v15',
      mark: '▲',
      tone: 'waiting',
    },
    {
      id: 'task:checkout/stripe-v15',
      kind: 'agent',
      label: 'stripe-v15',
      detail: 'in checkout',
      mark: '●',
      tone: 'waiting',
      note: 'waiting on you',
      complete: '@stripe-v15',
    },
    { id: 'run:new-agent', kind: 'action', label: 'New agent', mark: '›' },
    {
      id: 'setting:approvals',
      kind: 'setting',
      label: 'Approvals › Tools that always ask',
      mark: '◇',
    },
  ]
  const files = ['src/webhooks.ts', 'src/webhooks.test.ts', 'src/ledger.ts', 'README.md']
  return searchResults(query, {
    entries: agents,
    files: [
      ...files.map((path) => ({ root: checkout, path })),
      ...files.map((path) => ({ root: stripeTree, path })),
    ],
    matches: [
      {
        root: stripeTree,
        path: 'src/webhooks.ts',
        line: 9,
        text: '  const event = await stripe.webhooks.constructEventAsync(',
      },
      {
        root: checkout,
        path: 'README.md',
        line: 7,
        text: '- `pnpm test` runs everything, webhooks included',
      },
    ],
  })
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
    name: 'pointing-at-a-file',
    about: 'The pointer over a file in FILES: its row is shaded, so the click is plain.',
    state: { ...base(), hover: { kind: 'file', path: 'src/webhooks.ts' } },
    frame: frame(),
  },
  {
    name: 'terminals',
    about:
      'Terminals along the bottom: a tab each beside the orchestrator, the one in front typed into.',
    state: {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
        { id: 'checkout/terminals/2', project: 'checkout', name: 'server' },
      ]),
      bottom: 'checkout/terminals/1',
      keyboard: 'terminal',
    },
    frame: frame({
      terminal: {
        screen: [
          '~/src/checkout (main) $ pnpm test src/webhooks',
          '',
          ' ✓ src/webhooks.test.ts (12 tests) 48ms',
          ' ✗ refunds once when the webhook retries',
          '   AssertionError: expected 2 charges to be 1',
          '',
          '~/src/checkout (main) $ ',
        ].join('\n'),
      },
    }),
  },
  {
    name: 'finding-in-a-terminal',
    about:
      "Find in a terminal: its scrollback, the line found lit, and the box on the panel's edge.",
    state: {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
      ]),
      bottom: 'checkout/terminals/1',
      panel: findPanel('checkout/terminals/1', 'assert', 0),
    },
    frame: frame({
      panel: { found: 2, terminalName: 'tests' },
      terminal: {
        screen: '',
        find: {
          query: 'assert',
          line: 6,
          lines: [
            '$ pnpm test',
            ' ✓ src/ledger.test.ts (4 tests)',
            ' ✗ charges once',
            '   AssertionError: expected 2 charges to be 1',
            ' ✓ src/webhooks.test.ts (12 tests)',
            ' ✗ refunds once when the webhook retries',
            '   AssertionError: expected 2 refunds to be 1',
            '$ ',
          ],
        },
      },
    }),
  },
  {
    name: 'bottom-panel-folded',
    about: 'The bottom panel folded to its tabs, giving the agent the height.',
    state: { ...base(), bottomMode: 'min' },
    frame: frame(),
  },
  {
    name: 'dragging-the-sidebar',
    about: 'A divider under the pointer lights up; dragged, the sidebar follows.',
    state: { ...base(), resizing: 'sidebar', sizes: { sidebarWidth: 40 } },
    frame: frame({ layout: { sidebarWidth: 40 } }),
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
    name: 'orchestrator-at-work',
    about:
      'The conversation as it happens: what you said, each tool as it runs or fails with its reason, the answer arriving.',
    state: {
      ...base(),
      focused: null,
      chose: true,
      sizes: { stripHeight: 16 },
      transcript: [
        (t: Transcript) => youSaid(t, 'run the webhook tests and tell me what broke', 0),
        (t: Transcript) => thinking(t, 0),
        (t: Transcript) =>
          fromThinker(t, { type: 'tool', id: '1', tool: 'wilco_status', input: {} }, 1),
        (t: Transcript) =>
          fromThinker(t, { type: 'tool_done', id: '1', ok: true, text: '2 agents, 1 waiting' }, 2),
        (t: Transcript) =>
          fromThinker(
            t,
            {
              type: 'tool',
              id: '2',
              tool: 'wilco_terminal_run',
              input: { terminal: 'tests', command: 'pnpm test src/webhooks' },
            },
            3,
          ),
        (t: Transcript) =>
          fromThinker(
            t,
            {
              type: 'tool_done',
              id: '2',
              ok: false,
              text: 'no terminal called tests is open in checkout: open one first, or name another',
            },
            4,
          ),
        (t: Transcript) =>
          fromThinker(
            t,
            {
              type: 'tool',
              id: '3',
              tool: 'wilco_terminal_open',
              input: { project: 'checkout', name: 'tests' },
            },
            5,
          ),
        (t: Transcript) =>
          fromThinker(t, { type: 'delta', text: 'Opening a **tests** terminal first, then' }, 6),
      ].reduce((t, step) => step(t), emptyTranscript()),
    },
    frame: frame({ screen: '', now: 1_300 }),
  },
  {
    name: 'orchestrator-did-not-start',
    about: 'The orchestrator failing to start, said where you would wait for it, with the reason.',
    state: {
      ...base(),
      focused: null,
      chose: true,
      transcript: problem(
        youSaid(emptyTranscript(), 'where are we', 0),
        'The orchestrator did not start: claude-opus-5 is not offered by anything you are signed in to (openrouter): pick one in Settings',
        1,
      ),
    },
    frame: frame({ screen: '' }),
  },
  {
    name: 'dropping-a-screenshot',
    about:
      'A screenshot dropped on the window: who it is for, starting on whoever you were typing to.',
    state: {
      ...base(),
      panel: menuPanel(
        { kind: 'images', paths: ['/Users/me/Desktop/Screenshot 2026-09-14 at 09.12.33.png'] },
        'Screenshot 2026-09-14 at 09.12.33.png',
      ),
    },
    frame: frame({
      panel: {
        items: imageMenuItems({
          agents: [
            { task: 'checkout/refunds', name: 'refunds', running: true, focused: true },
            { task: 'checkout/stripe-v15', name: 'stripe-v15', running: false, focused: false },
          ],
          terminal: { id: 'checkout/terminals/1', name: 'tests' },
        }),
      },
    }),
  },
  {
    name: 'a-screenshot-attached',
    about: 'A picture waiting to go to the orchestrator with what you type next.',
    state: {
      ...setDictation(
        { ...base(), focused: null, chose: true },
        'why does the refund button look like this',
      ),
      attached: ['/var/folders/T/wilco-clipboard-1.png'],
    },
    frame: frame({ screen: '' }),
  },
  {
    name: 'pointing-at-a-terminal-tab',
    about: "A terminal's tab under the pointer: its menu and close button appear.",
    state: {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
        { id: 'checkout/terminals/2', project: 'checkout', name: 'server' },
      ]),
      hover: { kind: 'bottom-tab', tab: 'checkout/terminals/2' },
    },
    frame: frame(),
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
    name: 'switching-branch',
    about: 'Switching the checkout: branches newest first, and a new one for a name nobody has.',
    state: {
      ...withProjects(initialState(), ['checkout']),
      panel: { ...branchPanel(), query: 'fix' },
    },
    frame: frame({
      screen: '',
      changes: [],
      panel: {
        checkout: 'main',
        branches: [
          { name: 'main', current: true, when: '2 hours ago' },
          { name: 'fix/refund-retries', current: false, when: '3 days ago' },
          { name: 'fix/webhook-signature', current: false, when: '2 weeks ago' },
          { name: 'spike/ledger', current: false, when: '5 weeks ago' },
        ],
      },
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
    name: 'files-marked-by-git',
    about: 'FILES coloured the way git sees them: changed, new, and the folders they are in.',
    state: toggleSection(toggleSection(base(), 'changes'), 'agents'),
    frame: frame({
      fileMarks: {
        'src/webhooks.ts': 'M',
        'src/webhooks.test.ts': 'U',
        'test/refunds.test.ts': 'M',
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
    name: 'searching',
    about:
      'ctrl+k: agents, files in every worktree and lines inside them, grouped, with what matched lit.',
    state: { ...base(), panel: { ...searchPanel('webhook'), index: 1 } },
    frame: frame({ panel: { entries: searched('webhook'), searching: false } }),
  },
  {
    name: 'searching-to-a-line',
    about: 'A file and a line: tab completes the name, enter opens it there.',
    state: { ...base(), panel: searchPanel('hooks.ts:42') },
    frame: frame({ panel: { entries: searched('hooks.ts:42'), searching: false } }),
  },
  {
    name: 'reading-a-file',
    about: 'A file opened from FILES or search: coloured, numbered, at the line asked for.',
    state: {
      ...base(),
      panel: filePanel('/Users/me/src/checkout/src/webhooks.ts', 9),
    },
    frame: frame({ panel: { homeDir: '/Users/me', viewing: viewing(webhooksFile) } }),
  },
  {
    name: 'reading-markdown',
    about: 'Markdown laid out as it reads, with its source a tab away.',
    state: {
      ...base(),
      panel: filePanel('/Users/me/src/checkout/README.md', null, true),
    },
    frame: frame({ panel: { homeDir: '/Users/me', viewing: viewing(readmeFile, 112) } }),
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
      where: {
        repo: '~/src/checkout',
        branch: 'main',
        base: null,
        worktree: null,
        path: '/Users/me/src/checkout',
      },
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
