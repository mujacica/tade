import { describe, expect, it } from 'vitest'
import { type Intent, parseUtterance, type Vocabulary } from '../src/intent.ts'

const vocabulary: Vocabulary = {
  tasks: ['checkout/stripe-v15', 'checkout/refunds', 'search/pagination', 'app/migration'],
  projects: ['checkout', 'search', 'app'],
}

const parse = (text: string) => parseUtterance(text, vocabulary)

interface Case {
  said: string
  want: Intent['kind']
  check?: (intent: Intent) => void
}

const cases: Case[] = [
  // --- status
  { said: 'where are we', want: 'status' },
  { said: 'Where are we?', want: 'status' },
  { said: 'status', want: 'status' },
  { said: "what's going on", want: 'status' },
  { said: 'how are things', want: 'status' },
  {
    said: 'what about checkout',
    want: 'status',
    check: (i) => expect(i).toMatchObject({ scope: 'checkout' }),
  },
  {
    said: "how's search",
    want: 'status',
    check: (i) => expect(i).toMatchObject({ scope: 'search/pagination' }),
  },

  // --- focus
  {
    said: 'show me pagination',
    want: 'focus',
    check: (i) => expect(i).toMatchObject({ task: 'search/pagination' }),
  },
  {
    said: 'pull up refunds',
    want: 'focus',
    check: (i) => expect(i).toMatchObject({ task: 'checkout/refunds' }),
  },
  { said: 'open stripe-v15', want: 'focus' },

  // --- steering
  {
    said: 'tell refunds to also update the docs',
    want: 'steer',
    check: (i) =>
      expect(i).toMatchObject({ task: 'checkout/refunds', message: 'to also update the docs' }),
  },
  { said: 'ask pagination what it is waiting for', want: 'steer' },

  // --- starting work
  {
    said: 'start the refund flow double-charges in checkout',
    want: 'start',
    check: (i) => expect(i).toMatchObject({ project: 'checkout' }),
  },
  {
    said: 'start fixing the webhook signature in search',
    want: 'start',
    // Stored the way it was said, not the way it was normalised.
    check: (i) =>
      expect((i as { intent: string }).intent).toContain('fixing the webhook signature'),
  },

  // --- parking
  {
    said: 'park migration',
    want: 'park',
    check: (i) => expect(i).toMatchObject({ task: 'app/migration' }),
  },
  { said: 'bark migration', want: 'park' }, // misheard "park"
  { said: 'set aside migration', want: 'park' },
  { said: 'resume migration', want: 'resume' },
  { said: 'pick migration back up', want: 'resume' },

  // --- approvals
  { said: 'yes', want: 'approve' },
  { said: 'go ahead', want: 'approve' },
  { said: 'do it', want: 'approve' },
  { said: 'approve', want: 'approve' },
  { said: 'no', want: 'deny' },
  { said: 'deny', want: 'deny' },
  { said: 'the neigh', want: 'deny' }, // misheard "deny"
  { said: "don't", want: 'deny' },
  {
    said: 'confirm force push',
    want: 'confirm',
    check: (i) => expect(i).toMatchObject({ phrase: 'force push' }),
  },

  // --- memory
  {
    said: 'remember we pin major versions',
    want: 'remember',
    check: (i) => expect(i).toMatchObject({ text: 'we pin major versions' }),
  },
  {
    said: 'remember that I hate force pushes',
    want: 'remember',
    check: (i) => expect(i).toMatchObject({ text: 'I hate force pushes' }),
  },

  // --- the other ways people say the same things
  { said: 'where are we at', want: 'status' },
  { said: 'how are we doing', want: 'status' },
  { said: 'STATUS', want: 'status' },
  { said: '  where are we  ', want: 'status' },
  { said: 'how is migration', want: 'status' },
  { said: 'status of checkout', want: 'status' },
  { said: 'status for search', want: 'status' },
  { said: 'what about app', want: 'status' },
  { said: 'open migration', want: 'focus' },
  { said: 'bring up pagination', want: 'focus' },
  { said: 'ask refunds to add a test', want: 'steer' },
  { said: 'kick off a redesign in search', want: 'start' },
  { said: 'begin the cleanup in app', want: 'start' },
  { said: 'pause migration', want: 'park' },
  { said: 'set aside refunds', want: 'park' },
  { said: 'unpark migration', want: 'resume' },
  { said: 'resume pagination', want: 'resume' },
  { said: 'pick up pagination', want: 'resume' },
  { said: 'pick refunds back up', want: 'resume' },
  { said: 'keep in mind we deploy on fridays', want: 'remember' },
  { said: 'note the webhook retries twice', want: 'remember' },
  { said: 'important: never deploy on fridays', want: 'remember' },
  { said: "don't forget the staging key rotates", want: 'remember' },
  { said: 'make a note that refunds go through the ledger', want: 'remember' },
  { said: 'write down we pin major versions', want: 'remember' },
  { said: 'note to self check the webhook retries', want: 'remember' },
  { said: 'for the record, main is protected', want: 'remember' },

  // --- terminals
  { said: 'open a terminal', want: 'terminal' },
  { said: 'show me the tests terminal', want: 'terminal' },
  { said: 'close terminal 2', want: 'terminal' },
  { said: 'rename the tests terminal to Unit Tests', want: 'terminal' },
  { said: 'run npm test in the tests terminal', want: 'terminal' },
  { said: 'search for TypeError in the terminal', want: 'terminal' },
  // Without the word, an instruction is for an agent or the orchestrator, never a shell.
  { said: 'run the tests', want: 'free' },

  // --- near-misses
  // A known mishearing is corrected ("bark" → "park", above); one that is not
  // falls through rather than being bent into the nearest command.
  { said: 'parked migration', want: 'free' },
  { said: 'sparking migration', want: 'free' },

  // --- anything else falls through
  { said: 'what did the migration task actually change last week', want: 'free' },
  { said: 'park something nobody has heard of', want: 'free' },
  { said: 'show me nonsense', want: 'free' },
  { said: 'start something in a project that does not exist', want: 'free' },
  { said: 'tell nobody anything', want: 'free' },
  { said: '', want: 'free' },
  { said: 'yes but only the first one', want: 'free' },
  { said: 'i was thinking about denying that', want: 'free' },
]

describe('parseUtterance', () => {
  it.each(cases)('"$said" → $want', (c) => {
    const intent = parse(c.said)
    expect(intent.kind).toBe(c.want)
    c.check?.(intent)
  })

  it('resolves a misheard project name', () => {
    expect(parse('what about check out')).toMatchObject({ kind: 'status', scope: 'checkout' })
  })

  it('refuses to guess between two tasks of the same project', () => {
    // checkout owns two tasks, so the bare project name stays a project.
    expect(parse('what about checkout')).toMatchObject({ scope: 'checkout' })
    expect(parse('park checkout')).toMatchObject({ kind: 'park', task: 'checkout' })
  })

  it('is pure and leaves its inputs alone', () => {
    const frozen = structuredClone(vocabulary)
    expect(parse('where are we')).toEqual(parse('where are we'))
    expect(vocabulary).toEqual(frozen)
  })
})

describe('approval safety', () => {
  // This property is the reason the grammar exists. Deleting it should require
  // an argument in review, not a shrug.
  it('no ordinary sentence can reach a destructive confirmation', () => {
    const utterances = [
      ...cases.map((c) => c.said),
      'yes go ahead and force push',
      'sure, do whatever you need',
      'push it',
      'confirm',
      'i confirm',
      'please confirm that for me',
      'yes confirm',
      'approve the force push',
      'do it, force push to main',
    ]
    for (const said of utterances) {
      const intent = parse(said)
      if (intent.kind !== 'confirm') continue
      // The only way through is the exact shape "confirm <phrase>".
      expect(said.toLowerCase().trim().startsWith('confirm ')).toBe(true)
    }
  })

  it('no generated sentence reaches a confirmation without being one', () => {
    // Generated rather than listed, because a fixed corpus only ever proves
    // the sentences somebody thought of. Deterministic, so a failure can be
    // reproduced rather than re-rolled.
    const words = [
      'yes',
      'no',
      'ok',
      'sure',
      'please',
      'confirm',
      'force',
      'push',
      'delete',
      'rm',
      '-rf',
      'the',
      'it',
      'that',
      'do',
      'go',
      'ahead',
      'approve',
      'deny',
      'wilco',
      'park',
      'start',
      'checkout',
      'refunds',
      'main',
      'branch',
      'now',
      'all',
      'everything',
      'drop',
      'database',
      'reset',
      'hard',
      'migration',
      'and',
      'to',
      'on',
      'with',
      'just',
      'really',
    ]
    let seed = 20_260_913
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed
    }
    for (let i = 0; i < 20_000; i++) {
      const said = Array.from(
        { length: 1 + (next() % 6) },
        () => words[next() % words.length],
      ).join(' ')
      if (parse(said).kind !== 'confirm') continue
      // The only way through is the exact shape, with something after it.
      expect(said.startsWith('confirm ')).toBe(true)
      expect(said.length).toBeGreaterThan('confirm '.length)
    }
  })

  it('a bare yes never confirms anything destructive', () => {
    for (const said of ['yes', 'yeah', 'go ahead', 'do it', 'approve']) {
      expect(parse(said).kind).toBe('approve')
    }
  })

  it('"confirm" alone is not a confirmation', () => {
    expect(parse('confirm').kind).toBe('free')
  })

  it('keeps a note exactly as it was said', () => {
    // A note is the one thing nothing else can reconstruct, so it is stored
    // verbatim like an intent. Normalised text would file this away as
    // "i work from home on fridays".
    expect(parse('remember I work from home on Fridays')).toMatchObject({
      kind: 'remember',
      text: 'I work from home on Fridays',
    })
    // Punctuation survives too.
    expect(parse('note that the Stripe key rotates on the 1st.')).toMatchObject({
      text: 'the Stripe key rotates on the 1st.',
    })
  })
})

describe('asking for the settings', () => {
  it('understands the ways people ask', () => {
    for (const said of [
      'settings',
      'open settings',
      'show settings',
      'preferences',
      'config',
      'change configuration',
    ]) {
      expect(parseUtterance(said, vocabulary).kind).toBe('settings')
    }
  })

  it('does not swallow a sentence that merely mentions them', () => {
    // "tell refunds to read the config" is an instruction to an agent, not a
    // request to open a screen.
    expect(parseUtterance('tell refunds to read the config', vocabulary).kind).toBe('steer')
    expect(parseUtterance('what about config', vocabulary).kind).not.toBe('settings')
  })
})

describe('asking for the brief', () => {
  it('understands the ways people ask', () => {
    for (const said of [
      'brief me',
      'morning brief',
      'give me the brief',
      "what's the briefing",
      'catch me up',
      'what did I miss?',
    ]) {
      expect(parseUtterance(said, vocabulary).kind).toBe('brief')
    }
  })

  it('leaves a sentence that mentions one to the orchestrator', () => {
    expect(parseUtterance('write a brief for the refunds agent', vocabulary).kind).toBe('free')
  })
})

describe('a sentence about a terminal', () => {
  const vocabulary = { tasks: ['app/refunds'], projects: ['app'] }
  const parse = (said: string) => parseUtterance(said, vocabulary)

  it('keeps a command and a search exactly as said', () => {
    expect(parse('run PORT=3000 pnpm dev in terminal 2')).toEqual({
      kind: 'terminal',
      action: 'run',
      name: '2',
      command: 'PORT=3000 pnpm dev',
    })
    expect(parse('find TypeError in the tests terminal')).toMatchObject({
      action: 'search',
      name: 'tests',
      text: 'TypeError',
    })
  })

  it('names the one meant, or none for the one in front of you', () => {
    expect(parse('open a new terminal called Server')).toMatchObject({
      action: 'open',
      name: 'Server',
    })
    expect(parse('close the terminal')).toMatchObject({ action: 'close', name: null })
    expect(parse('rename terminal to logs')).toMatchObject({
      action: 'rename',
      name: null,
      to: 'logs',
    })
  })
})
