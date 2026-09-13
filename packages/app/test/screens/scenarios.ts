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
import { newTaskPanel, panelFailed } from '../../src/panels.ts'
import { COLOUR } from '../../src/skin.ts'
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
    withTasks(withProjects(initialState(), ['checkout', 'infra', 'search']), tasks),
    'checkout/stripe-v15',
  )

const frame = (over: Partial<Frame> = {}): Frame => ({
  width: 120,
  height: 34,
  screen: agentScreen,
  skin: COLOUR,
  now: NOW,
  home: '~/.wilco',
  files: ['src/', 'test/', 'package.json', 'README.md'],
  changes: [
    { path: 'package.json', mark: 'M', added: 2, removed: 1 },
    { path: 'src/webhooks.test.ts', mark: 'A', added: 48, removed: null },
    { path: 'src/webhooks.ts', mark: 'M', added: 12, removed: 4 },
  ],
  notes: ['the staging key rotates on the 1st', 'we pin major versions'],
  spend: {
    tokens: 1_900_000,
    usd: 2.66,
    hasCost: true,
    byTask: {
      'checkout/stripe-v15': { tokens: 880_000, usd: 1.26 },
      'checkout/refunds': { tokens: 460_000, usd: 0.62 },
    },
  },
  route: { harness: 'pi', model: 'anthropic/claude-opus-5', provider: 'anthropic' },
  voice: { keys: ['ctrl', 'space'], available: true },
  ...over,
})

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
    about: 'Files and notes unfolded, as they are after a click on their headings.',
    state: toggleSection(toggleSection(base(), 'files'), 'notes'),
    frame: frame(),
  },
  {
    name: 'a-task-with-no-agent',
    about: 'A task whose agent is not running: one button opens it again.',
    state: focusTask(base(), 'search/pagination'),
    frame: frame({ screen: '', changes: [] }),
  },
  {
    name: 'talking',
    about: 'The microphone is open: the chip and the strip both say so, in red.',
    state: { ...setListening(base(), true), talkingSince: NOW - 4_000 },
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
    name: 'new-task',
    about: 'The New task panel over the faded window, half filled in.',
    state: {
      ...base(),
      panel: {
        ...newTaskPanel(['checkout', 'infra', 'search'], 'checkout'),
        intent: 'refunds are charged twice when the webhook retries',
      },
    },
    frame: frame(),
  },
  {
    name: 'new-task-refused',
    about: 'The New task panel saying why it did not start, in the panel rather than behind it.',
    state: {
      ...base(),
      panel: panelFailed(
        {
          ...newTaskPanel(['checkout', 'infra', 'search'], 'checkout'),
          intent: 'add a file',
          field: 'go',
        },
        'branch already exists: wilco/add-a-file',
      ),
    },
    frame: frame(),
  },
  {
    name: 'first-open',
    about: 'A project and nothing running yet: what to do next, as buttons.',
    state: withProjects(initialState(), ['checkout']),
    frame: frame({
      screen: '',
      changes: [],
      notes: [],
      spend: { tokens: 0, usd: 0, hasCost: false, byTask: {} },
    }),
  },
  {
    name: 'small-terminal',
    about: 'An 80×24 terminal: everything still fits, and nothing wraps.',
    state: base(),
    frame: frame({ width: 80, height: 24 }),
  },
]
