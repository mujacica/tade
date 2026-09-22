import { IDLE_REASON } from '@tade/core'
import {
  focusTask,
  initialState,
  setDictation,
  setListening,
  toggleSection,
  withProjects,
  withTasks,
  withTerminals,
} from '../../../src/model.ts'
import { imageMenuItems, menuPanel } from '../../../src/panels/menu/state.ts'
import { findPanel, notePanel } from '../../../src/panels/small/state.ts'
import {
  emptyTranscript,
  fromThinker,
  problem,
  type Transcript,
  thinking,
  youSaid,
} from '../../../src/transcript.ts'
import { agentScreen, base, frame, NOW, type Scenario, tasks, utcDate } from './fixtures.ts'

// The window itself: the side, the middle, the terminals along the bottom,
// and the line you talk to Tade on.
//
// What is here is the chrome rather than any one subject — where the panes
// are, what the pointer lights, what a first open looks like, and what the
// window does with no room.

/**
 * Four projects in four different states: one with agents at work, one whose
 * agent went quiet without anybody saying it was finished, one holding queued
 * work somebody has to decide about, and one where everything asked for is
 * done. What the tabs along the top are for.
 */
const inFourProjects = () =>
  withTasks(withProjects(initialState(), ['checkout', 'search', 'infra', 'docs']), [
    ...tasks.slice(0, 2),
    { task: 'search/rankings', state: 'blocked', reason: IDLE_REASON },
    {
      task: 'infra/rotate-keys',
      state: 'queued',
      by: 'orchestrator',
      queued: {
        state: {
          kind: 'held',
          on: 'infra/bump-node',
          because: 'infra/bump-node failed: the image no longer builds',
        },
        after: [{ task: 'infra/bump-node', why: 'both change the Dockerfile' }],
        prompt: 'Rotate the deploy keys and put the new ones in the secret store.',
        touches: ['deploy/'],
        at: null,
      },
    },
    {
      task: 'infra/tidy-logs',
      state: 'queued',
      by: 'orchestrator',
      queued: {
        state: { kind: 'waiting', on: ['infra/rotate-keys'] },
        after: [{ task: 'infra/rotate-keys', why: 'it writes the log shipper’s key' }],
        prompt: 'Drop the log lines nobody reads.',
        touches: ['deploy/logs.ts'],
        at: null,
      },
    },
    {
      task: 'infra/prune-images',
      state: 'queued',
      queued: {
        state: { kind: 'ready' },
        after: [],
        prompt: 'Prune the images nothing runs any more.',
        touches: [],
        at: null,
      },
    },
    { task: 'docs/api-reference', state: 'merged' },
    {
      task: 'docs/readme-pictures',
      state: 'blocked',
      reason: IDLE_REASON,
      finished: { by: 'agent', summary: 'The pictures are redrawn and committed' },
    },
  ])

export const WINDOW_SCREENS: Scenario[] = [
  {
    name: 'watching-an-agent',
    about:
      'The window with an agent waiting on an approval, its changes, spend and the talk key. The bar down the right of the sidebar and of the agent says where in each you are, and the block on the agent’s screen is where what you type would land.',
    state: base(),
    frame: frame({ paneScreen: { lines: 180, cursor: { back: 0, column: 25 } } }),
  },
  {
    name: 'pointing-at-a-button',
    about: 'The pointer over Open project: hover is drawn, not left to the terminal.',
    state: { ...base(), hover: { kind: 'action', name: 'open-project' } },
    frame: frame(),
  },
  {
    name: 'pointing-at-a-note',
    about:
      'The pointer over a note: it lights as a tab, a second line where its words run on, with its forget and menu at the end.',
    state: {
      ...base(),
      folded: ['changes', 'files', 'where'],
      hover: {
        kind: 'note',
        at: '2026-09-03T09:00:00.000Z',
        text: 'refunds go through the ledger service, never the gateway',
      },
    },
    frame: frame(),
  },
  {
    name: 'a-note-read-whole',
    about:
      'A note clicked in the side opens on its own page: the headline it was given, what it is about, who said it when — and its words, to change, copy, forget or write a headline for from there.',
    state: {
      ...base(),
      folded: ['changes', 'files', 'where'],
      panel: notePanel(
        {
          at: '2026-09-03T09:00:00.000Z',
          summary: 'Refunds via the ledger',
          scope: 'checkout/refunds',
          by: 'orchestrator',
        },
        'refunds go through the ledger service, never the gateway',
      ),
    },
    frame: frame({ date: utcDate }),
  },
  {
    name: 'pointing-at-a-file',
    about: 'The pointer over a file in FILES: its row is shaded, so the click is plain.',
    state: { ...base(), hover: { kind: 'file', path: 'src/webhooks.ts' } },
    frame: frame(),
  },
  {
    name: 'two-terminals-split',
    about: 'Two terminals in the bottom panel, one below the other, the lower one typed into.',
    state: {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
        { id: 'checkout/terminals/2', project: 'checkout', name: 'server' },
      ]),
      bottom: 'checkout/terminals/1',
      keyboard: 'terminal',
      terminalSplit: { lane: 'checkout/terminals/2', direction: 'below', ratio: 0.5 },
      splitFocus: true,
      sizes: { stripHeight: 14 },
    },
    frame: frame({
      terminal: { screen: '~/src/checkout (main) $ pnpm test --watch\n ✓ 48 tests', find: null },
      splitTerminal: {
        screen: '~/src/checkout (main) $ pnpm dev\n  ready on http://localhost:3000',
        find: null,
      },
    }),
  },
  {
    name: 'terminals',
    about:
      'Terminals along the bottom: a tab each beside the orchestrator, the one in front typed ' +
      'into. Every tab carries its close and its menu, pointed at or not.',
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
        // Where the shell left its cursor, and how far back the lane reads:
        // the block you type at, and the bar that says where you are.
        view: { lines: 240, cursor: { back: 0, column: 24 } },
      },
    }),
  },
  {
    name: 'reading-back-a-terminal',
    about:
      'A terminal scrolled back through what it printed: the bar on the right says how far back, and the foot of it offers the newest line again.',
    state: {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
      ]),
      bottom: 'checkout/terminals/1',
      keyboard: 'terminal',
      terminalScroll: 120,
    },
    frame: frame({
      terminal: {
        screen: [
          ' ✓ src/ledger.test.ts (4 tests) 12ms',
          ' ✓ src/refunds.test.ts (9 tests) 31ms',
          ' ✓ src/webhooks.test.ts (12 tests) 48ms',
          ' ✗ charges once when the webhook retries',
          '   AssertionError: expected 2 charges to be 1',
        ].join('\n'),
        view: { lines: 240, cursor: { back: 0, column: 24 } },
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
    name: 'a-scrolled-sidebar',
    about:
      'The sidebar read part-way down its list: the bar on its right is one solid thumb over a quiet track — as long as the share of the list in view, as far down as you have read, and the same cell every row of the way, so it reads as one object rather than a box per row.',
    state: { ...toggleSection(base(), 'notes'), scroll: 8 },
    frame: frame(),
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
    name: 'typing-to-tade',
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
          fromThinker(t, { type: 'tool', id: '1', tool: 'tade_status', input: {} }, 1),
        (t: Transcript) =>
          fromThinker(t, { type: 'tool_done', id: '1', ok: true, text: '2 agents, 1 waiting' }, 2),
        (t: Transcript) =>
          fromThinker(
            t,
            {
              type: 'tool',
              id: '2',
              tool: 'tade_terminal_run',
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
              tool: 'tade_terminal_open',
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
      attached: ['/var/folders/T/tade-clipboard-1.png'],
    },
    frame: frame({ screen: '' }),
  },
  {
    name: 'pointing-at-a-terminal-tab',
    about:
      "A terminal's tab under the pointer: the tab lights, and the close and menu that were " +
      'already beside it stay as they were, so no tab moves as the pointer crosses the row.',
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
    name: 'pointing-at-a-terminal-tabs-close',
    about:
      "The pointer on a terminal tab's own close: the close is lit in the colour of what it " +
      'does and the tab is still lit behind it, because a tab and its buttons are one thing to ' +
      'point at.',
    state: {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
        { id: 'checkout/terminals/2', project: 'checkout', name: 'server' },
      ]),
      hover: { kind: 'action', name: 'close-terminal:checkout/terminals/2' },
    },
    frame: frame(),
  },
  {
    name: 'keys',
    about: 'The keys Tade keeps, talking first.',
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
    name: 'what-each-project-is-doing',
    about:
      'Four projects, and each tab says what is happening in its own: checkout has an agent working ' +
      'and one waiting on you, search has an agent idle at its prompt with nobody having said it ' +
      'is done, infra has queued work held and two more waiting their turn, and docs is finished — ' +
      'which is the whole of "is everything I asked for done in there?", answered without going there. ' +
      'The figures at the right are everybody’s, and say so.',
    state: focusTask(inFourProjects(), 'checkout/refunds'),
    frame: frame({ width: 160, height: 34 }),
  },
  {
    name: 'projects-in-a-narrow-window',
    about:
      'The same four projects with no room for any of it: each tab keeps the one mark that matters ' +
      'most in it, and the total at the right goes, because a figure nobody can place is worse than ' +
      'no figure at all.',
    state: focusTask(inFourProjects(), 'checkout/refunds'),
    frame: frame({ width: 100, height: 28 }),
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
  {
    name: 'buttons-that-want-you',
    about:
      'The bottom row with something to say: an extension that needs setting up, counted in a badge beside a button drawn exactly like Settings, and the sound turned off, so the button offers to bring it back in the green half of the stop-and-go pair — black letters on a bright ground, a shade lighter under the pointer. The one screen where a coloured button is pointed at, which is how a hover nobody could see was found.',
    state: { ...base(), hover: { kind: 'action', name: 'mute' } },
    frame: frame({ muted: true, extensionsNeedYou: 1 }),
  },
]
