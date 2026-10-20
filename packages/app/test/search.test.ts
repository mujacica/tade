import type { Document } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { ABOUT_ASKED, askedAbout, isSentence, shortlist, worthAsking } from '../src/meant.ts'
import {
  completed,
  documentEntries,
  type FoundDocument,
  fuzzy,
  GROUPS,
  looksLikePath,
  openId,
  type PathLook,
  parseOpenId,
  parseQuery,
  pathTyped,
  type SearchEntry,
  searchFile,
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
].map((path) => searchFile(root, path))
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

  it('keeps the best of a long list exactly as sorting all of it would have', () => {
    // Two worktrees holding the same files, so every name ties with itself:
    // what is held while scanning must come out as the whole list sorted and
    // cut, the first worktree's copy first.
    const names = ['webhooks.ts', 'web-hooks.ts', 'hooks.ts', 'webhook.test.ts', 'README.md']
    const paths = ['api', 'web', 'hooks', 'lib'].flatMap((dir) =>
      names.flatMap((name) => [`src/${dir}/${name}`, `${dir}/${name}`]),
    )
    const all = [root, agent].flatMap((place) => paths.map((path) => searchFile(place, path)))
    const sorted = all
      .map((file) => ({ file, found: fuzzy('WebHk', file.path) }))
      .filter((one) => one.found !== null)
      .sort(
        (a, b) =>
          (b.found?.score ?? 0) - (a.found?.score ?? 0) || a.file.path.localeCompare(b.file.path),
      )
    expect(sorted.length).toBeGreaterThan(12)
    const found = searchResults('WebHk', { entries: [], files: all, matches: [] })
    expect(found.map((entry) => `${entry.detail} ${entry.label}`)).toEqual(
      sorted.slice(0, 12).map((one) => `${one.file.root.label} ${one.file.path}`),
    )
    expect(found.map((entry) => entry.hits)).toEqual(
      sorted.slice(0, 12).map((one) => one.found?.hits),
    )
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

describe('a sentence, when the letters find nothing', () => {
  // The window's own list, in the order it keeps it: what needs you, what the
  // extensions can do, the agents, then everything else.
  const list: SearchEntry[] = [
    { id: 'task:checkout/refunds', kind: 'agent', label: 'refunds', mark: '○' },
    { id: 'stop:checkout/refunds', kind: 'action', label: 'Stop refunds', mark: '■' },
    {
      id: 'changes:checkout/refunds',
      kind: 'action',
      label: 'Show the changes in refunds',
      mark: '±',
    },
    { id: 'run:new-agent', kind: 'action', label: 'New agent', mark: '›' },
    { id: 'run:spend', kind: 'action', label: 'Spend', mark: '›' },
    { id: 'setting:voice', kind: 'setting', label: 'Voice › Talk key', mark: '◇' },
  ]

  it('knows a sentence from the start of a name', () => {
    expect(isSentence('refund')).toBe(false)
    expect(isSentence('st')).toBe(false)
    // Two words and long enough to be meant as words.
    expect(isSentence('stop whoever is on the refunds thing')).toBe(true)
    // Looking inside files is looking for text, not asking a question.
    expect(isSentence('#stop whoever is on refunds')).toBe(false)
  })

  it('is worth asking about unless the whole of it came back', () => {
    const said = 'stop whoever is on the refunds thing'
    expect(worthAsking(said, [])).toBe(true)
    // A line inside somebody's code is not an answer to what they asked for.
    expect(worthAsking(said, [{ id: 'x', kind: 'match', label: 'a.ts:2', mark: '≡' }])).toBe(true)
    expect(worthAsking('stop', [])).toBe(false)
  })

  it('still asks when the letters found something weak', () => {
    // What a sentence matches is never a name and is always letters scattered
    // down some long label. One of these was enough to silence the question
    // for good, and it is not an answer to anything.
    const said = 'what the run'
    const weak = searchResults(said, {
      entries: [
        {
          id: 'setting:telemetry',
          kind: 'setting',
          label: 'Telemetry › What the brief counts',
          mark: '◇',
        },
      ],
      files: [],
      matches: [],
    })
    expect(weak).toHaveLength(1)
    expect(worthAsking(said, weak)).toBe(true)
  })

  it('does not ask when what came back is the whole of what was typed', () => {
    const said = 'Show the changes in refunds'
    const found = searchResults(said, { entries: list, files: [], matches: [] })
    expect(found.map((entry) => entry.id)).toEqual(['changes:checkout/refunds'])
    expect(worthAsking(said, found)).toBe(false)
  })

  it('puts a handful of what there is to do, not everything', () => {
    const picked = shortlist('stop whoever is on the refunds thing', list, 4)
    expect(picked).toHaveLength(4)
    // What its own words found comes first: "stop" and "refunds" are in the
    // list even though the whole sentence matches none of it.
    expect(picked.slice(0, 2).map((entry) => entry.id)).toContain('stop:checkout/refunds')
    expect(
      searchResults('stop whoever is on the refunds thing', { entries: list, files, matches: [] }),
    ).toEqual([])
  })

  it('picks out what is happening, where no name says it', () => {
    // The whole of what this is for: `coverage` is in nobody's name here, and
    // in exactly one thing that is going on.
    const working: SearchEntry[] = [
      {
        id: 'task:tade/flaky-suite',
        kind: 'agent',
        label: 'flaky-suite',
        detail: 'in tade',
        mark: '●',
        about: 'working · 2 commits, tests green\nasked for: raise test coverage in packages/core',
      },
      ...list,
    ]
    const picked = shortlist('agent working on test coverage', working, 3)
    expect(picked.map((entry) => entry.id)).toContain('task:tade/flaky-suite')
  })

  it('tops up from what there is to do when no word matches anything', () => {
    const picked = shortlist('make the thing go please', list, 3)
    expect(picked).toHaveLength(3)
    // The window's own order, which starts with what needs you.
    expect(picked[0]?.id).toBe('task:checkout/refunds')
  })

  it('shows what came back as its own group, above the rest and never matched again', () => {
    const said = 'stop whoever is on the refunds thing'
    const meant = [list[1] as SearchEntry]
    const found = searchResults(said, { entries: list, files, matches: [], meant })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: 'stop:checkout/refunds', kind: 'meant', hits: [] })
    // It is the same entry: choosing it does what choosing it always did.
    expect(GROUPS.find((group) => group.kind === 'meant')?.title).toBe('MIGHT MEAN')
  })

  it('never shows the same thing twice when the letters did match it', () => {
    const found = searchResults('stop', {
      entries: list,
      files,
      matches: [],
      meant: [list[1] as SearchEntry],
    })
    expect(found.filter((entry) => entry.id === 'stop:checkout/refunds')).toHaveLength(1)
  })
})

describe('what is happening, as something the letters can find', () => {
  const working: SearchEntry[] = [
    {
      id: 'task:tade/flaky-suite',
      kind: 'agent',
      label: 'flaky-suite',
      detail: 'in tade',
      mark: '●',
      about: 'working · 2 commits, tests green\nasked for: raise test coverage in packages/core',
    },
    {
      id: 'task:tade/coverage-report',
      kind: 'agent',
      label: 'coverage-report',
      detail: 'in tade',
      mark: '○',
    },
  ]

  it('finds a thing by what is going on with it, and says which line said so', () => {
    const found = searchResults('raise test coverage', {
      entries: working,
      files: [],
      matches: [],
    })
    expect(found.map((entry) => entry.id)).toEqual(['task:tade/flaky-suite'])
    // Nothing in the name matched, so nothing in it is lit; the line that did
    // is under it, which is what says why the row is there at all.
    expect(found[0]?.hits).toEqual([])
    expect(found[0]?.preview).toBe('asked for: raise test coverage in packages/core')
  })

  it('never puts what is happening above what is named', () => {
    const found = searchResults('coverage', { entries: working, files: [], matches: [] })
    expect(found.map((entry) => entry.id)).toEqual([
      'task:tade/coverage-report',
      'task:tade/flaky-suite',
    ])
  })

  it('matches it whole, never as letters wandering through a paragraph', () => {
    // Every letter of `rtc` is in that paragraph, in order, and means nothing.
    expect(searchResults('rtc', { entries: working, files: [], matches: [] })).toEqual([])
  })

  it('carries as much of it as one ask is worth, saying where it was cut', () => {
    expect(askedAbout(undefined)).toBeUndefined()
    expect(askedAbout('  ')).toBeUndefined()
    expect(askedAbout('working\nasked for: x')).toBe('working asked for: x')
    const long = askedAbout('a'.repeat(ABOUT_ASKED + 50)) ?? ''
    expect(long).toHaveLength(ABOUT_ASKED + 1)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('a path somebody named outright', () => {
  // Not under any of the roots above: the point of this is a file search has
  // never heard of, which is where everything an agent writes about its own
  // work lives.
  const HOME = '/Users/sam'
  const RESEARCH = `${HOME}/.tade/projects/tade/tasks/remote-cloud-multiplayer-research/research.md`
  const sources = { entries, files, matches: [], home: HOME }

  /** The one row a path makes, with a look at it that has or has not answered. */
  const rowFor = (raw: string, look?: { path: string; is: PathLook }) =>
    searchResults(raw, { ...sources, ...(look ? { look } : {}) }).filter(
      (entry) => entry.kind === 'path',
    )

  it('is read off an absolute path, and opened where it is', () => {
    const [row] = rowFor(RESEARCH)
    expect(row?.label).toBe('research.md')
    expect(parseOpenId(row?.id ?? '')).toEqual({ path: RESEARCH, line: null, column: null })
    // Above everything else, because it is the one thing they asked for
    // outright: a path pasted in must never be a row below an approval.
    expect(GROUPS[0]).toEqual({ kind: 'path', title: 'THIS PATH' })
  })

  it('expands ~ against the home it is handed, and says the folder as it was typed', () => {
    const [row] = rowFor(
      '~/.tade/projects/tade/tasks/remote-cloud-multiplayer-research/research.md',
    )
    expect(parseOpenId(row?.id ?? '')?.path).toBe(RESEARCH)
    // And tab tidies it into the path it actually means.
    expect(row?.complete).toBe(RESEARCH)
  })

  it('leaves a ~ path alone where nobody said where home is', () => {
    expect(pathTyped('~/notes.md', null)).toBeNull()
    expect(pathTyped('~/notes.md', '')).toBeNull()
    // An absolute one needs nobody's help.
    expect(pathTyped('/notes.md', null)?.path).toBe('/notes.md')
    // A home with a trailing slash, and the one that is nothing but one.
    expect(pathTyped('~/notes.md', `${HOME}/`)?.path).toBe(`${HOME}/notes.md`)
    expect(pathTyped('~/notes.md', '/')?.path).toBe('/notes.md')
    expect(pathTyped('~', '/')?.path).toBe('/')
  })

  it('takes a pasted path with spaces in it, quoted or escaped', () => {
    const quoted = rowFor(`'${HOME}/My Documents/a note.md'`)[0]
    expect(parseOpenId(quoted?.id ?? '')?.path).toBe(`${HOME}/My Documents/a note.md`)
    const escaped = rowFor(`${HOME}/My\\ Documents/a note.md`)[0]
    expect(parseOpenId(escaped?.id ?? '')?.path).toBe(`${HOME}/My Documents/a note.md`)
    expect(escaped?.label).toBe('a note.md')
  })

  it('says the end of the folder, short enough to leave room for the answer', () => {
    // Whole segments from the end, saying it was cut. Drawn in full, this
    // folder is sixty characters and the row drops `not there` off its right
    // edge — which is the one thing on it nobody could have known.
    expect(rowFor(RESEARCH)[0]?.detail).toBe('…/remote-cloud-multiplayer-research')
    expect(rowFor('~/.tade/x/research.md')[0]?.detail).toBe('~/.tade/x')
    // What they typed, not what it resolved to: that is the half they recognise.
    expect(rowFor(`${HOME}/notes.md`)[0]?.detail).toBe(HOME)
    expect(rowFor('~/notes.md')[0]?.detail).toBe('~')
    expect(rowFor('/notes.md')[0]?.detail).toBe('/')
    const row = rowFor(RESEARCH, { path: RESEARCH, is: 'missing' })[0]
    expect(`${row?.label}  ${row?.detail}  ${row?.note}`.length).toBeLessThan(66)
  })

  it('goes to a line at the end of it', () => {
    const [row] = rowFor(`${RESEARCH}:120`)
    expect(parseOpenId(row?.id ?? '')).toEqual({ path: RESEARCH, line: 120, column: null })
    expect(row?.note).toBe('line 120')
  })

  it('says what a look at it found, and nothing until one has', () => {
    const says = (is: PathLook) => rowFor(RESEARCH, { path: RESEARCH, is })[0]
    expect(rowFor(RESEARCH)[0]?.note).toBeUndefined()
    expect(says('file')?.note).toBeUndefined()
    expect(says('folder')).toMatchObject({ note: 'folder', mark: '▸', tone: 'hint' })
    expect(says('missing')).toMatchObject({ note: 'not there', tone: 'bad' })
    expect(says('unreadable')).toMatchObject({ note: 'cannot read', tone: 'bad' })
    // A look that could not say is its own answer, never "nothing is there".
    expect(says('unknown')).toMatchObject({ note: 'cannot tell', tone: 'hint' })
    expect(rowFor(`${RESEARCH}:120`, { path: RESEARCH, is: 'missing' })[0]?.note).toBe(
      'line 120 · not there',
    )
  })

  it('ignores a look that was about some other path', () => {
    expect(rowFor(RESEARCH, { path: '/somewhere/else.md', is: 'missing' })[0]?.note).toBeUndefined()
  })

  it('is never a sentence, and never carries anything about itself', () => {
    const said = `${HOME}/My Documents/the refunds double charge/notes.md`
    expect(looksLikePath(said)).toBe(true)
    // Three words and a space apiece: the one thing that keeps a pasted path
    // out of everything that reads a sentence.
    expect(isSentence(said)).toBe(false)
    expect(worthAsking(said, [])).toBe(false)
    expect(rowFor(said)[0]?.about).toBeUndefined()
  })

  it('leaves ordinary search alone', () => {
    expect(looksLikePath('readme')).toBe(false)
    expect(looksLikePath('src/webhooks.ts')).toBe(false)
    // Narrowed to text, a leading slash is text to look for inside files.
    expect(looksLikePath('#/api/v1')).toBe(false)
    expect(rowFor('#/api/v1')).toEqual([])
    expect(rowFor('webhooks')).toEqual([])
    // And what search always found, it still finds.
    expect(
      searchResults('webhooks', sources)
        .map((entry) => entry.label)
        .slice(0, 1),
    ).toEqual(['src/webhooks.ts'])
    expect(searchResults('', sources).map((entry) => entry.kind)).toEqual([
      'agent',
      'action',
      'setting',
    ])
  })
})

describe('the documents tasks produced', () => {
  const DIR = '/Users/sam/.tade/projects/vrolta/documents'
  const found = (within: string): FoundDocument => ({
    project: 'vrolta',
    path: `${DIR}/${within}`,
    within,
  })
  const record = (task: string, within: string, over: Partial<Document> = {}): Document => ({
    task,
    path: `${DIR}/${within}`,
    state: 'written',
    summary: '',
    at: '2026-10-01T10:00:00.000Z',
    asked: '',
    finished: true,
    removedAt: null,
    missing: false,
    bytes: 120,
    followed: [],
    reused: false,
    triaged: null,
    deleted: null,
    ...over,
  })
  const NOW = Date.parse('2026-10-20T10:00:00.000Z')
  const ROLEPLAY = 'research-roleplay-economy-and-systems/ROLEPLAY-SYSTEMS.md'
  const PLAN = 'p3-09-closed-test-brief/PLAN.md'
  const NOTES = 'research-roleplay-economy-and-systems/notes/sources.md'
  const rows = documentEntries(
    [found(ROLEPLAY), found(PLAN), found(NOTES)],
    [
      record('vrolta/research-roleplay-economy-and-systems', ROLEPLAY, {
        triaged: {
          by: 'person',
          decided: 'keep it',
          at: '2026-10-02T10:00:00.000Z',
          approved: false,
        },
      }),
      record('vrolta/p3-09-closed-test-brief', PLAN, { at: '2026-09-01T10:00:00.000Z' }),
    ],
    NOW,
  )
  const results = (raw: string) =>
    searchResults(raw, { entries: [...entries, ...rows], files, matches: [] }).filter(
      (entry) => entry.kind === 'document',
    )

  it('is named by its file, said to be its task’s and its project’s, and opened where it is', () => {
    const [row] = results('ROLEPLAY-SYSTEMS.md')
    expect(row?.label).toBe('ROLEPLAY-SYSTEMS.md')
    expect(row?.detail).toBe('research-roleplay-economy-and-s… · vrolta')
    expect(parseOpenId(row?.id ?? '')).toEqual({
      path: `${DIR}/${ROLEPLAY}`,
      line: null,
      column: null,
    })
  })

  it('says whether it waits for a decision, and puts the waiting ones first', () => {
    expect(rows.map((one) => [one.label, one.note ?? null])).toEqual([
      ['PLAN.md', 'waiting on you'],
      ['ROLEPLAY-SYSTEMS.md', 'decided'],
      // A file beside the one handed over is nobody's question.
      ['notes/sources.md', null],
    ])
    expect(rows[0]?.tone).toBe('waiting')
    const approved = documentEntries(
      [found(PLAN)],
      [
        record('vrolta/p3-09-closed-test-brief', PLAN, {
          triaged: { by: 'person', decided: 'go', at: '2026-10-02T10:00:00.000Z', approved: true },
        }),
      ],
      NOW,
    )
    expect(approved[0]?.note).toBe('approved')
  })

  it('is found by part of its file name, and by its task’s name', () => {
    // First, and lit: the letters are in its own name. Its sibling comes after,
    // on its task's name, which spells them too.
    const [first] = results('roleplay-sys')
    expect(first?.label).toBe('ROLEPLAY-SYSTEMS.md')
    expect(first?.hits?.length).toBeGreaterThan(0)
    // The task's name: both files it wrote, and the letters lit on neither,
    // because the label is not what they were found in.
    const byTask = results('roleplay-economy')
    expect(byTask.map((one) => one.label)).toEqual(['ROLEPLAY-SYSTEMS.md', 'notes/sources.md'])
    expect(byTask.every((one) => one.hits?.length === 0)).toBe(true)
  })

  it('ranks a match on the file above the same match on a task', () => {
    const both = documentEntries(
      [found('plan-review/OTHER.md'), found('research/plan.md')],
      [],
      NOW,
    )
    const ranked = searchResults('plan', { entries: both, files: [], matches: [] })
    expect(ranked.map((one) => one.label)).toEqual(['plan.md', 'OTHER.md'])
  })

  it('takes its task from the folder it is in where the journal has no record, even one whose task is gone', () => {
    const [row] = documentEntries([found('gone-task/brief.md')], [], NOW)
    expect(row?.detail).toBe('gone-task · vrolta')
    expect(row?.note).toBeUndefined()
    const [loose] = documentEntries([found('README.md')], [], NOW)
    expect(loose?.detail).toBe('vrolta')
  })

  it('is not listed before anything is typed, and is under its own heading', () => {
    expect(results('')).toEqual([])
    expect(GROUPS.find((group) => group.kind === 'document')?.title).toBe('DOCUMENTS')
  })
})
