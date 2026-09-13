import { describe, expect, it } from 'vitest'
import {
  completed,
  fuzzy,
  openId,
  parseOpenId,
  parseQuery,
  type SearchEntry,
  searchResults,
} from '../src/search.ts'

// What search finds, from made-up sources: no disk, no git.

const root = { path: '/src/checkout', label: 'checkout', task: null }
const agent = {
  path: '/wt/checkout-refunds',
  label: 'checkout › refunds',
  task: 'checkout/refunds',
}
const files = [
  'src/webhooks.ts',
  'src/payments/stripe/web/hook-handlers.ts',
  'test/webhooks.test.ts',
  'README.md',
].map((path) => ({ root, path }))
const entries: SearchEntry[] = [
  { id: 'task:checkout/refunds', kind: 'agent', label: 'refunds', mark: '○', complete: '@refunds' },
  { id: 'run:new-agent', kind: 'action', label: 'New agent', mark: '›', complete: '>New agent' },
  { id: 'setting:voice', kind: 'setting', label: 'Voice › Talk key', mark: '◇' },
]

describe('a query', () => {
  it('reads a scope from its first character and a line from its end', () => {
    expect(parseQuery('@ref')).toMatchObject({ scope: 'agents', text: 'ref' })
    expect(parseQuery('#refund twice')).toMatchObject({ scope: 'text', text: 'refund twice' })
    expect(parseQuery('>new')).toMatchObject({ scope: 'actions', text: 'new' })
    expect(parseQuery('hooks.ts:42:7')).toMatchObject({ text: 'hooks.ts', line: 42, column: 7 })
    // Inside files a colon and digits are just text to look for.
    expect(parseQuery('#port:8080')).toMatchObject({ text: 'port:8080', line: null })
  })
})

describe('fuzzy matching', () => {
  it('matches letters in order, and not out of order', () => {
    expect(fuzzy('wbh', 'src/webhooks.ts')?.hits).toEqual([4, 6, 7])
    expect(fuzzy('hbw', 'src/webhooks.ts')).toBeNull()
  })

  it('ranks a file named for the query over one that merely spells it along its path', () => {
    const named = fuzzy('webhooks', 'src/webhooks.ts')?.score ?? 0
    const spelled = fuzzy('webhooks', 'src/payments/stripe/web/hook-handlers.ts')?.score ?? 0
    expect(named).toBeGreaterThan(spelled)
  })
})

describe('results', () => {
  const sources = { entries, files, matches: [] }

  it('groups them, files by name, best first', () => {
    const found = searchResults('webhooks', sources)
    expect(found.map((entry) => entry.label).slice(0, 2)).toEqual([
      'src/webhooks.ts',
      'test/webhooks.test.ts',
    ])
    expect(found.every((entry) => entry.kind === 'file')).toBe(true)
  })

  it('opens a file at the line asked for', () => {
    const [first] = searchResults('webhooks.ts:42', sources)
    expect(first?.note).toBe('line 42')
    expect(parseOpenId(first?.id ?? '')).toEqual({
      path: '/src/checkout/src/webhooks.ts',
      line: 42,
      column: null,
    })
  })

  it('shows what needs you and what you can do before anything is typed, and no files', () => {
    const found = searchResults('', sources)
    expect(found.map((entry) => entry.kind)).toEqual(['agent', 'action', 'setting'])
  })

  it('narrows to a scope', () => {
    expect(searchResults('@', sources).map((entry) => entry.kind)).toEqual(['agent'])
    expect(searchResults('>voice', sources).map((entry) => entry.label)).toEqual([
      'Voice › Talk key',
    ])
  })

  it('shows lines found inside files, with the file and the line', () => {
    const found = searchResults('#refund', {
      ...sources,
      matches: [{ root: agent, path: 'src/ledger.ts', line: 12, text: '  refund(charge)' }],
    })
    expect(found).toEqual([
      expect.objectContaining({
        kind: 'match',
        label: 'src/ledger.ts:12',
        detail: 'checkout › refunds',
        preview: 'refund(charge)',
        id: openId('/wt/checkout-refunds/src/ledger.ts', 12, null),
      }),
    ])
  })
})

describe('tab', () => {
  it('completes to the chosen result, keeping the scope and the line', () => {
    const file: SearchEntry = {
      id: 'x',
      kind: 'file',
      label: 'src/app.ts',
      mark: '□',
      complete: 'src/app.ts',
    }
    expect(completed('app:42', file)).toBe('src/app.ts:42')
    expect(completed('@ref', entries[0])).toBe('@refunds')
    expect(completed('anything', undefined)).toBe('anything')
  })
})

describe('lines in terminals', () => {
  it('are found newest first, with which terminal printed them', () => {
    const found = searchResults('#error', {
      entries: [],
      files: [],
      matches: [],
      terminals: [
        {
          id: 'app/terminals/1',
          name: 'tests',
          project: 'app',
          text: 'Error: first\nfine\nTypeError: second',
        },
      ],
    })
    expect(found.map((entry) => [entry.kind, entry.label, entry.preview])).toEqual([
      ['terminal', 'tests', 'TypeError: second'],
      ['terminal', 'tests', 'Error: first'],
    ])
    // The id says which match, counting back from the newest, for the find box to open on.
    expect(found[1]?.id.split('\0')).toEqual(['terminal', 'app/terminals/1', 'error', '1'])
  })
})
