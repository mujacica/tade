import { searchPanel } from '../../../src/panels/search/state.ts'
import { type SearchEntry, searchResults } from '../../../src/search.ts'
import { base, checkout, frame, type Scenario } from './fixtures.ts'

// Search: letters matched against what Tade already has, and the shortlist
// somebody is asked to read when they match nothing.

const stripeTree = {
  path: '/Users/me/.tade/worktrees/checkout-stripe-v15',
  label: 'checkout › stripe-v15',
  task: 'checkout/stripe-v15',
}

/** What search shows for a query, from the same function the window uses. */
function searched(query: string, meant?: readonly SearchEntry[]): SearchEntry[] {
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
    { id: 'stop:checkout/stripe-v15', kind: 'action', label: 'Stop stripe-v15', mark: '■' },
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
    // A whole sentence is grepped for like anything else and found nowhere,
    // which is the other half of why anybody was asked about it.
    matches: meant
      ? []
      : [
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
    ...(meant ? { meant } : {}),
  })
}

/** The two of those a judge said the sentence below might have meant. */
function mightMean(): SearchEntry[] {
  const all = searched('')
  return ['stop:checkout/stripe-v15', 'task:checkout/stripe-v15'].flatMap((id) => {
    const found = all.find((entry) => entry.id === id)
    return found ? [found] : []
  })
}

/** What somebody typed that no letter of matches anything Tade has. */
const A_SENTENCE = 'stop whoever is doing the stripe upgrade'

export const SEARCH_SCREENS: Scenario[] = [
  {
    name: 'searching',
    about:
      'ctrl+k: agents, files in every worktree and lines inside them, grouped, with what matched lit.',
    state: { ...base(), panel: { ...searchPanel('webhook'), index: 1 } },
    frame: frame({ panel: { entries: searched('webhook'), searching: false } }),
  },
  {
    name: 'asking-in-search',
    about:
      'A sentence rather than a name: its letters match nothing, so what is already in the list is put to a judge — which of these did they mean — and comes back as MIGHT MEAN, above the ordinary results and never instead of them.',
    state: { ...base(), panel: { ...searchPanel(A_SENTENCE), index: 0 } },
    frame: frame({
      panel: { entries: searched(A_SENTENCE, mightMean()), searching: false },
    }),
  },
  {
    name: 'searching-to-a-line',
    about: 'A file and a line: tab completes the name, enter opens it there.',
    state: { ...base(), panel: searchPanel('hooks.ts:42') },
    frame: frame({ panel: { entries: searched('hooks.ts:42'), searching: false } }),
  },
]
