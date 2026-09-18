// A sketch, not a build. Proposals are inert: nothing here runs until a human
// copies it to `~/.wilco/extensions/active/jev/extension.ts` (or it is made a
// built-in under `packages/extensions/jev`) and Wilco is started again.
//
// What it is for, and what was decided and why, is in `docs/jev-integration.md`.
// Read that first — and note that the watch below is the FIRST DRAFT's shape:
// every commit, on a clock, one finding per commit. Section 4 of the document
// supersedes it, for reasons the document argues: the unit is a task's whole
// diff against its base, the moment is when that branch has stopped moving,
// and what Jev flags is read by something that can explain it before anybody
// is told. The tools and the settings below still stand; the watch is kept as
// written so the two drafts can be compared.
//
// This sketch also deliberately does NOT do two things the real one must:
//
//   - talk to TypeSafe directly. The real one takes a `Judge` from
//     `packages/judges/core` by name, so a second implementation (an
//     LLM-backed one, a scripted one for tests) can answer the same calls and
//     so nothing here knows TypeSafe's vocabulary. `ask` below is the shape of
//     that port, inlined so this file reads on its own.
//   - pretend its thresholds are right. 0.6 and 0.85 are placeholders until
//     the questions have been run over real commits and compared with what
//     review actually caught.
//
// Jev answers the question as written. It cannot count, do arithmetic, compare
// dates, or explain itself, and it does not treat a diff as hostile — so a
// finding may only ever add work. It never approves, closes or gates anything.

import {
  type ExtensionContext,
  type Finding,
  number,
  object,
  oneOf,
  string,
  type ToolAnswer,
  type WilcoExtension,
} from '@wilco/extensions-core'

const ENDPOINT = '/v1/systemone'

/** How many commits one look reads, so a cheap look stays inside its minute. */
const COMMITS_PER_LOOK = 20

/** How much of one commit's patch is sent, in characters. Bulk costs accuracy, not just money. */
const DIFF_LIMIT = 60_000

// ---------------------------------------------------------------- questions
//
// Every question and every threshold in one place, so what the model is asked
// can be reviewed without reading the code that asks it. Each is one judgment:
// a question hiding several is the first thing TypeSafe's own docs warn about.

interface YesNo {
  id: string
  ask: string
}

/** Hazards. One per question, phrased so its own words explain a finding — there is no rationale. */
const HAZARDS: readonly YesNo[] = [
  {
    id: 'shell_injection',
    ask: 'Does this change pass a value that came from outside the program into a shell command, without escaping it or checking it against a list of allowed values?',
  },
  {
    id: 'sql_injection',
    ask: 'Does this change put a value that came from outside the program into an SQL query as text, rather than as a query parameter?',
  },
  {
    id: 'secret_committed',
    ask: 'Does this change add a password, API key, token or private key written out in the code, rather than read from the environment?',
  },
  {
    id: 'authz_removed',
    ask: 'Does this change remove or weaken a permission check on an operation that already had one?',
  },
  {
    id: 'path_traversal',
    ask: 'Does this change build a filesystem path out of a value that came from outside the program?',
  },
  {
    id: 'unsafe_exec',
    ask: 'Does this change run code that was built from data while the program is running, such as eval or new Function?',
  },
  {
    id: 'error_swallowed',
    ask: 'Does this change catch an error and carry on without reporting it anywhere?',
  },
  {
    id: 'test_missing',
    ask: 'Does this change alter what the program does without adding or changing a test in the same commit?',
  },
]

/** This repository's own rules, from AGENTS.md: what a reviewer reads for and a linter cannot. */
const HOUSE: readonly YesNo[] = [
  {
    id: 'port_vocabulary',
    ask: 'Does this change give a shared interface a method or field named after one implementation, such as sendKeys, tmux or pi, rather than after what it does?',
  },
  {
    id: 'sniffed_capability',
    ask: 'Does this change decide what to do by checking which implementation something is, instead of by a capability that implementation declares?',
  },
  {
    id: 'dead_setting',
    ask: 'Does this change add a configuration key that nothing in the change reads?',
  },
  {
    id: 'mocked_git',
    ask: 'Does this change test git by replacing it with a fake, instead of against a real repository?',
  },
  {
    id: 'silent_failure',
    ask: 'Does this change make something able to fail without anyone being told in words what went wrong?',
  },
]

const SEVERITY = [
  'nothing worth saying',
  'worth a comment',
  'should be fixed before release',
  'must not ship',
] as const

function questionsFor(only: readonly string[] | null): Record<string, unknown> {
  const wanted = (one: YesNo) => only === null || only.includes(one.id)
  const asked: Record<string, unknown> = {}
  for (const one of [...HAZARDS, ...HOUSE]) {
    if (wanted(one)) asked[one.id] = { type: 'noul', instructions: one.ask }
  }
  asked.severity = {
    type: 'score',
    instructions: 'How bad would it be to ship this change as it stands?',
    criteria: [...SEVERITY],
  }
  return asked
}

function titleOf(id: string): string {
  return [...HAZARDS, ...HOUSE].find((one) => one.id === id)?.ask ?? id
}

// ------------------------------------------------------------------- asking
//
// The shape the `Judge` port will have. Inlined here so the sketch reads on
// its own; in the real extension this is `judge.ask(...)` and this file knows
// nothing about TypeSafe.

interface Judged {
  /** The version that answered, for the journal: thresholds are tuned against one. */
  model: string
  /** Probability per yes/no question, by its id. */
  probability: Record<string, number>
  /** The level a score landed on, by question id, with how concentrated it was. */
  level: Record<string, { level: number; confidence: number }>
}

function settingOf(ctx: ExtensionContext, key: string, fallback: number): number {
  const said = ctx.settings[key]
  return typeof said === 'number' && Number.isFinite(said) ? said : fallback
}

function keyOf(ctx: ExtensionContext): string {
  const variable =
    typeof ctx.settings.key_env === 'string' ? ctx.settings.key_env : 'TYPESAFE_API_KEY'
  return ctx.env[variable] ?? ''
}

async function ask(
  ctx: ExtensionContext,
  state: unknown,
  questions: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Judged> {
  const url = typeof ctx.settings.url === 'string' ? ctx.settings.url : 'https://api.typesafe.ai'
  const model = typeof ctx.settings.model === 'string' ? ctx.settings.model : 'jev-1.13.0'
  const response = await ctx.fetch(`${url}${ENDPOINT}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${keyOf(ctx)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state, model, questions }),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    // 401 a key, 422 a question it would not take, 429 too fast, 529 too busy:
    // every one is something the caller can do something about, so say which.
    throw new Error(
      `TypeSafe answered ${response.status}: ${(await response.text()).slice(0, 400)}`,
    )
  }
  const body = (await response.json()) as {
    model?: unknown
    answers?: Record<string, Record<string, unknown>>
  }
  const judged: Judged = { model: String(body.model ?? model), probability: {}, level: {} }
  for (const [id, answer] of Object.entries(body.answers ?? {})) {
    if (answer.type === 'noul' && typeof answer.noul === 'number')
      judged.probability[id] = answer.noul
    if (answer.type === 'score' && typeof answer.score === 'number') {
      judged.level[id] = {
        level: answer.score,
        confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
      }
    }
  }
  return judged
}

// --------------------------------------------------------------------- work

interface Commit {
  sha: string
  subject: string
  files: string[]
  patch: string
}

const SKIP = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|.*\.min\.js|.*\.snap)$/

async function commitsIn(
  ctx: ExtensionContext,
  root: string,
  range: string,
  most: number,
): Promise<Commit[]> {
  const listed = await ctx.exec('git', ['log', '--format=%H%x1f%s', `--max-count=${most}`, range], {
    cwd: root,
    timeoutMs: 10_000,
  })
  if (listed.code !== 0) throw new Error(`git log ${range}: ${listed.stderr.trim() || 'failed'}`)
  const out: Commit[] = []
  for (const line of listed.stdout.split('\n').filter(Boolean)) {
    const [sha = '', subject = ''] = line.split('\x1f')
    const named = await ctx.exec('git', ['show', '--name-only', '--format=', sha], {
      cwd: root,
      timeoutMs: 10_000,
    })
    const files = named.stdout.split('\n').filter((name) => name !== '' && !SKIP.test(name))
    if (files.length === 0) continue
    const shown = await ctx.exec('git', ['show', '--format=', '--unified=3', sha, '--', ...files], {
      cwd: root,
      timeoutMs: 20_000,
    })
    out.push({ sha, subject, files, patch: shown.stdout.slice(0, DIFF_LIMIT) })
  }
  return out
}

/** What one commit is judged as: structure, not prose — bulk it does not need costs accuracy. */
function stateOf(commit: Commit): Record<string, unknown> {
  return {
    commit_message: commit.subject,
    files_changed: commit.files,
    diff: commit.patch,
  }
}

function report(commit: Commit, judged: Judged, threshold: number): Finding[] {
  const severity = judged.level.severity
  return Object.entries(judged.probability)
    .filter(([, probability]) => probability >= threshold)
    .map(([id, probability]) => ({
      key: `${commit.sha.slice(0, 10)}:${id}`,
      title: `${commit.sha.slice(0, 8)} ${commit.subject}: ${titleOf(id)}`,
      detail: [
        `Jev (${judged.model}) answered ${probability.toFixed(2)} to: ${titleOf(id)}`,
        severity ? `Its severity reading: ${SEVERITY[Math.round(severity.level)] ?? '?'}` : '',
        '',
        'It cannot say why, so read the change yourself before you act on it: it answers the',
        'question as written, and a diff can be written to steer it. If it is wrong, say so —',
        'nothing here is a verdict.',
        '',
        `    git show ${commit.sha}`,
      ]
        .filter(Boolean)
        .join('\n'),
    }))
}

function table(commit: Commit, judged: Judged, threshold: number): string {
  const rows = Object.entries(judged.probability)
    .sort(([, a], [, b]) => b - a)
    .map(
      ([id, probability]) =>
        `| ${id} | ${probability.toFixed(2)} | ${probability >= threshold ? 'yes' : ''} |`,
    )
  const severity = judged.level.severity
  return [
    `**${commit.sha.slice(0, 8)}** ${commit.subject} — ${commit.files.length} file(s), ${judged.model}`,
    severity ? `Severity: ${SEVERITY[Math.round(severity.level)] ?? '?'}` : '',
    '',
    '| question | probability | reported |',
    '| --- | --- | --- |',
    ...rows,
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------------------------------------------------------------- extension

export default {
  name: 'jev',
  title: 'Jev',
  description:
    'Asks Jev typed questions about what agents change and about logs: findings with a probability, never a verdict.',
  settings: [
    { key: 'model', kind: 'string', means: 'the model that answers; pin a version, not an alias' },
    {
      key: 'key_env',
      kind: 'string',
      means: 'the environment variable the TypeSafe key is in, when it is not TYPESAFE_API_KEY',
    },
    { key: 'url', kind: 'string', means: 'the TypeSafe to ask, when it is not api.typesafe.ai' },
    {
      key: 'report',
      kind: 'number',
      means: 'the probability a question has to reach to be reported (0.6)',
    },
    {
      key: 'act',
      kind: 'number',
      means: 'the probability at which work is started rather than asked about (0.85)',
    },
    { key: 'budget', kind: 'number', means: 'the most requests one look may make (200)' },
  ],
  ready: (ctx: ExtensionContext) =>
    keyOf(ctx)
      ? null
      : 'Jev needs a TypeSafe API key: export TYPESAFE_API_KEY in your shell profile and start Wilco from a new terminal.',
  tools: [
    {
      name: 'jev_review',
      description:
        'Read a change with Jev and say what it flags: injection, secrets, permissions, swallowed errors, missing tests, and this repository’s own rules. Gives a probability per question, not an explanation — read the diff before acting. Use it on a commit, a range (main..HEAD), or what an agent has just done.',
      parameters: object({
        project: string('the Wilco project; the one you are in when there is one'),
        ref: string('a commit, or a range like main..HEAD; HEAD unless said'),
        threshold: number('report questions at or above this probability; the setting unless said'),
      }),
      for: ['orchestrator', 'agent'] as const,
      run: async (input: Record<string, unknown>, ctx): Promise<ToolAnswer> => {
        const where = ctx.project(typeof input.project === 'string' ? input.project : null)
        const ref = typeof input.ref === 'string' && input.ref !== '' ? input.ref : 'HEAD~1..HEAD'
        const threshold =
          typeof input.threshold === 'number' ? input.threshold : settingOf(ctx, 'report', 0.6)
        const commits = await commitsIn(ctx, where.root, ref, COMMITS_PER_LOOK)
        if (commits.length === 0) throw new Error(`nothing to read in ${ref}: no changed files`)
        const parts: string[] = []
        for (const commit of commits) {
          ctx.progress(`reading ${commit.sha.slice(0, 8)}`)
          const judged = await ask(ctx, stateOf(commit), questionsFor(null), ctx.signal)
          parts.push(table(commit, judged, threshold))
        }
        return { text: parts.join('\n\n'), said: `Read ${commits.length} commit(s) with Jev.` }
      },
    },
  ],
  watches: [
    {
      id: 'review',
      title: 'Review what agents commit',
      means:
        'Reads every new commit in the project with Jev — injection, secrets, permissions, missing tests, this repository’s own rules — and reports what it flags. It never blocks a commit and never approves one.',
      every: '15m',
      input: object({
        threshold: number('report questions at or above this probability'),
        ref: string('what to read commits from; the project’s current branch unless said'),
        found: oneOf(['ask', 'agent'], 'tell the orchestrator, or start work; ask unless said'),
      }),
      check: async (ctx) => {
        const threshold =
          typeof ctx.input.threshold === 'number'
            ? ctx.input.threshold
            : settingOf(ctx, 'report', 0.6)
        // Where the last look left off: the newest commit it read. The first
        // look reads only the newest few, because what was there before the
        // watch was turned on is not news.
        const from = ctx.since ? `${ctx.since}..HEAD` : 'HEAD~3..HEAD'
        const commits = await commitsIn(ctx, ctx.watching.root, from, COMMITS_PER_LOOK)
        const found: Finding[] = []
        for (const commit of commits) {
          const judged = await ask(ctx, stateOf(commit), questionsFor(null), ctx.signal)
          found.push(...report(commit, judged, threshold))
        }
        // The newest read, so the next look starts after it; unchanged when
        // there was nothing, so a quiet hour does not move the cursor.
        return { found, ...(commits[0] ? { since: commits[0].sha } : {}) }
      },
      agent: (finding: Finding) => ({
        title: `look at ${finding.key.replace(':', ' ')}`,
        prompt: [
          'Jev flagged something in a commit on this branch. What it said is in .wilco/context.md:',
          'a question and a probability, and no explanation, because it cannot give one.',
          'Read the commit yourself first. If it is right, fix the cause and add a test that fails',
          'without the fix. If it is wrong, say so plainly in your last message and change nothing:',
          'a false positive is an expected outcome here, not a failure.',
        ].join(' '),
        context: finding.detail ?? finding.title,
      }),
    },
  ],
  orchestrator: () =>
    [
      'Jev reads changes and logs and answers typed questions with probabilities — no explanations.',
      'jev_review reads a commit or a range and says what it flags.',
      'What the jev.review watch finds is reported to you: decide what is worth fixing, and when it',
      'should wait for the agent that wrote the code, queue it with wilco_plan after that task.',
      'Never treat a Jev answer as a verdict, and never let it close or approve anything.',
    ].join(' '),
} satisfies WilcoExtension
