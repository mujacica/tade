import { type ParsedDiff, parseDiff } from '../../../src/diff.ts'
import { offsetOf } from '../../../src/input.ts'
import { initialState, toggleSection, withProjects } from '../../../src/model.ts'
import { inlineRows } from '../../../src/panels/file/inline.ts'
import { filePanel } from '../../../src/panels/file/state.ts'
import { branchPanel, diffPanel } from '../../../src/panels/small/state.ts'
import {
  type Edited,
  editFrom,
  formattedLines,
  sourceLines,
  textLines,
  typeIn,
  type ViewedFile,
} from '../../../src/viewer.ts'
import { base, frame, type Scenario } from './fixtures.ts'

// The files: the tree down the side, what git marks, a diff, and the viewer —
// reading, finding, editing and selecting in one.

const webhooksFile: ViewedFile = {
  path: '/Users/me/src/checkout/src/webhooks.ts',
  size: 1_184,
  binary: false,
  truncated: false,
  language: 'typescript',
  mtimeMs: 1_700_000_000_000,
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
  mtimeMs: 1_700_000_000_000,
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

function viewing(file: ViewedFile, width?: number, diff?: ParsedDiff, edit?: Edited) {
  const text = textLines(file)
  return {
    file,
    source: sourceLines(file, false),
    text,
    formatted: width ? formattedLines(file, width, false) : null,
    // The rows git's answer makes of it, worked out the way the window works
    // them out: from where each line the panel holds came from in the file.
    inline: diff
      ? inlineRows(diff, edit?.from ?? null, edit ? edit.lines.length : text.length)
      : null,
  }
}

/**
 * What `git diff` says about `webhooks.ts` as the fixture has it: the one call
 * replaced by four lines, which is a removal and four additions in the middle
 * of a file whose other eleven lines nobody touched.
 */
const webhooksDiff = parseDiff(
  [
    'diff --git a/src/webhooks.ts b/src/webhooks.ts',
    '--- a/src/webhooks.ts',
    '+++ b/src/webhooks.ts',
    '@@ -5,7 +5,10 @@ export async function handle(body: string, sig: string): Promise<void> {',
    ' export async function handle(body: string, sig: string): Promise<void> {',
    '   const key = process.env.STRIPE_WEBHOOK_SECRET',
    "   if (!key) throw new Error('no webhook secret')",
    '-  const event = stripe.webhooks.constructEvent(body, sig, key)',
    '+  const cryptoProvider = Stripe.createSubtleCryptoProvider()',
    '+  const event = await stripe.webhooks.constructEventAsync(',
    '+    body, sig, key, undefined, cryptoProvider,',
    '+  )',
    "   if (event.type === 'charge.refunded') {",
    '     await refund(event)',
    '   }',
  ].join('\n'),
)

/** A word typed onto the line above the change, with the diff still drawn in. */
const typedIntoChange = typeIn(editFrom(textLines(webhooksFile), 6, 51), ' // always')

export const FILE_SCREENS: Scenario[] = [
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
    name: 'reading-a-file',
    about: 'A file opened from FILES or search: coloured, numbered, at the line asked for.',
    state: {
      ...base(),
      panel: filePanel('/Users/me/src/checkout/src/webhooks.ts', 9),
    },
    frame: frame({ panel: { homeDir: '/Users/me', viewing: viewing(webhooksFile) } }),
  },
  {
    name: 'finding-in-a-file',
    about: 'ctrl+f in a file: every match lit, the one you are on amber, its line marked.',
    state: {
      ...base(),
      panel: {
        ...filePanel('/Users/me/src/checkout/src/webhooks.ts'),
        asking: { kind: 'find', query: 'event', index: 1 },
        line: 9,
      },
    },
    frame: frame({ panel: { homeDir: '/Users/me', viewing: viewing(webhooksFile) } }),
  },
  {
    name: 'editing-a-file',
    about: 'Clicked into and typed in: the block where typing lands, and a Save that says so.',
    state: {
      ...base(),
      panel: {
        ...filePanel('/Users/me/src/checkout/src/webhooks.ts'),
        edit: typeIn(editFrom(textLines(webhooksFile), 5, 47), '_V2'),
      },
    },
    frame: frame({ panel: { homeDir: '/Users/me', viewing: viewing(webhooksFile) } }),
  },
  {
    name: 'a-change-in-the-editor',
    about:
      'A changed file clicked in CHANGES: the editor it opens in, with git’s answer drawn into it.',
    state: {
      ...base(),
      panel: filePanel('/Users/me/src/checkout/src/webhooks.ts', null, false, true),
    },
    frame: frame({
      panel: {
        homeDir: '/Users/me',
        diff: webhooksDiff,
        viewing: viewing(webhooksFile, undefined, webhooksDiff),
      },
    }),
  },
  {
    name: 'editing-a-change-in-place',
    about: 'Typed into a changed file with the diff still on it: the new line is an addition too.',
    state: {
      ...base(),
      panel: {
        ...filePanel('/Users/me/src/checkout/src/webhooks.ts', null, false, true),
        edit: typedIntoChange,
      },
    },
    frame: frame({
      panel: {
        homeDir: '/Users/me',
        diff: webhooksDiff,
        viewing: viewing(webhooksFile, undefined, webhooksDiff, typedIntoChange),
      },
    }),
  },
  {
    name: 'selecting-in-a-file',
    about: 'Dragged over three lines of it: the selection through the break at the end of each.',
    state: {
      ...base(),
      panel: {
        ...filePanel('/Users/me/src/checkout/src/webhooks.ts'),
        edit: editFrom(textLines(webhooksFile), 10, 3),
        // From partway along the call on line 9 to partway into line 11.
        anchor: offsetOf(textLines(webhooksFile), { line: 8, col: 20 }),
      },
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
]
