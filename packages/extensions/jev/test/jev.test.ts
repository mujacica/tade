import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Secrets } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { extensionConformance } from '@tade/extensions-core/conformance'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { jevExtension } from '../src/extension.ts'
import { reviewQuestions } from '../src/questions.ts'
import { findingsReport, statusLine } from '../src/report.ts'
import { shorten } from '../src/review.ts'
import { readReviews } from '../src/reviews.ts'

// Jev, answered here the way TypeSafe answers, or by a table. Nothing reaches
// the network: what is under test is what Tade asks, what it makes of the
// answer, and — the half that matters most — that with no key none of it runs
// and nothing else changes.

const NOW = Date.parse('2026-09-20T09:00:00Z')

/** A TypeSafe that answers exactly what a test tells it to, and 0.02 otherwise. */
function typesafe(answers: Record<string, number>, seen?: unknown[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      state: unknown
      questions: Record<string, { type: string; criteria?: unknown }>
    }
    seen?.push(body)
    return Response.json({
      model: 'jev-1.13.0',
      usage: { input_tokens: 500 },
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => {
          if (question.type === 'noul') return [id, { type: 'noul', noul: answers[id] ?? 0.02 }]
          if (question.type === 'choice') {
            const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
            return [
              id,
              {
                type: 'choice',
                choice: options[0],
                probabilities: Object.fromEntries(
                  options.map((one, at) => [one, at === 0 ? 0.9 : 0.1]),
                ),
                confidence: 0.8,
              },
            ]
          }
          const levels = (question.criteria ?? []) as string[]
          return [
            id,
            {
              type: 'score',
              score: answers[id] ?? 1,
              probabilities: Object.fromEntries(levels.map((level) => [level, 1 / levels.length])),
              confidence: 0.5,
            },
          ]
        }),
      ),
    })
  }) as typeof fetch
}

const offline: typeof fetch = async (input) => {
  throw new Error(`it reached the network: ${String(input)}`)
}

function host(options: {
  home: string
  projects?: Record<string, { root: string }>
  settings?: Record<string, unknown>
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  now?: number
  secrets?: Secrets
}) {
  return ExtensionHost.load({
    builtin: [jevExtension],
    config: {
      extensions: { jev: options.settings ?? {} },
      projects: options.projects ?? {},
    },
    home: options.home,
    env: options.env ?? {},
    fetch: options.fetch ?? offline,
    now: () => options.now ?? NOW,
    ...(options.secrets ? { secrets: options.secrets } : {}),
  })
}

const asked = { caller: { kind: 'orchestrator' } as const }

extensionConformance(() => jevExtension, { env: { TYPESAFE_API_KEY: 'k' } })

describe('with no key', () => {
  it('says what it needs, offers nothing, and touches nothing to find that out', async () => {
    const loaded = await host({ home: tmp('tade-jev-'), env: {} })
    const [jev] = loaded.list()
    expect(jev?.state).toBe('needs setup')
    expect(jev?.problem).toMatch(/TYPESAFE_API_KEY/)
    expect(loaded.specs('orchestrator').map((spec) => spec.name)).toEqual([])
    expect(loaded.specs('agent').map((spec) => spec.name)).toEqual([])
    expect(loaded.actions()).toEqual([])
    expect(loaded.orchestratorPrompt()).toMatch(/installed but not set up/)
    // The watch is still offered, with why it cannot look — a watch waits for
    // its extension and says so, rather than disappearing.
    expect(loaded.watches()[0]).toMatchObject({ id: 'jev.review', problem: /needs setting up/ })
    await expect(loaded.call('jev_findings', {}, asked)).rejects.toThrow(
      /needs setup|TYPESAFE_API_KEY/,
    )
  })

  it('reads the key from wherever the settings say it is', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      settings: { key_env: 'MY_TYPESAFE_KEY' },
      env: { MY_TYPESAFE_KEY: 'k' },
    })
    expect(loaded.list()[0]).toMatchObject({ state: 'ready', problem: null })
  })

  it('takes a key pasted into Tade, and still lets the shell win', async () => {
    const home = tmp('tade-jev-')
    const secrets = Secrets.open({ home, platform: 'linux' })
    const loaded = await host({ home, env: {}, secrets })
    expect(loaded.list()[0]).toMatchObject({ state: 'needs setup' })
    // Pasted — not into the config, which is never read for it.
    const saved = loaded.saveSecret('jev', 'key', 'tsk_0123456789')
    expect(saved.where).toContain('secrets.json')
    await loaded.reconfigure({ jev: {} })
    expect(loaded.list()[0]).toMatchObject({ state: 'ready', problem: null })
    const setup = loaded.setupOf('jev')
    expect(setup?.guide[0]).toContain('found in')
    expect(setup?.guide.join(' ')).not.toContain('tsk_0123456789')
    expect(setup?.fields[0]).toMatchObject({ key: 'key', kind: 'secret', value: '' })

    // And a variable in the shell is what is used, whatever was pasted.
    const exported = await host({
      home,
      env: { TYPESAFE_API_KEY: 'from-the-shell' },
      secrets,
    })
    expect(exported.setupOf('jev')?.guide[0]).toContain('found in $TYPESAFE_API_KEY')
  })

  it('is ready with a judge that asks nobody, which nothing chooses for you', async () => {
    const loaded = await host({ home: tmp('tade-jev-'), settings: { judge: 'scripted' }, env: {} })
    expect(loaded.list()[0]).toMatchObject({ state: 'ready' })
    const named = await host({ home: tmp('tade-jev-'), settings: { judge: 'nobody' }, env: {} })
    expect(named.list()[0]?.problem).toMatch(/no judge called nobody/)
  })
})

describe('asking about anything', () => {
  it('asks every question of one state and answers in a table', async () => {
    const seen: unknown[] = []
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ is_bug: 0.91 }, seen),
    })
    const answer = await loaded.call(
      'jev_ask',
      {
        state: { issue: 'the payout job retries forever on 429' },
        questions: [
          {
            id: 'is_bug',
            kind: 'yes-no',
            ask: 'Does this describe a bug that will keep happening?',
          },
          { id: 'area', kind: 'pick', ask: 'Which part?', options: ['payments', 'search'] },
        ],
      },
      asked,
    )
    expect(answer.text).toMatch(/\| is_bug \| 0\.91 \| worth acting on \|/)
    expect(answer.text).toMatch(/\| area \| payments \(0\.90, confidence 0\.80\) \|/)
    expect(answer.text).toMatch(/Answered by jev-1\.13\.0/)
    expect(seen).toHaveLength(1)
  })

  it('refuses a question it cannot ask, in words the caller can fix', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({}),
    })
    await expect(loaded.call('jev_ask', { state: 'x', questions: [] }, asked)).rejects.toThrow(
      /at least one question/,
    )
    await expect(
      loaded.call(
        'jev_ask',
        { state: 'x', questions: [{ id: 'one', kind: 'pick', ask: 'which?', options: ['only'] }] },
        asked,
      ),
    ).rejects.toThrow(/option/)
  })
})

describe('grepping by meaning', () => {
  it('keeps the lines that answer the question, likeliest first, and asks in batches', async () => {
    const home = tmp('tade-jev-')
    const loaded = await host({
      home,
      settings: { judge: 'scripted' },
      env: {},
    })
    // The scripted judge answers 0 for anything it was not told about, so
    // nothing is kept — which is itself an answer, and said as one.
    const nothing = await loaded.call(
      'jev_grep',
      { question: 'where did it give up?', source: 'text', text: 'one\ntwo\nthree' },
      asked,
    )
    expect(nothing.text).toMatch(/Nothing in what you gave it/)
  })

  it('asks one question per line and hands back the lines that answer it, likeliest first', async () => {
    const seen: unknown[] = []
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ line__1: 0.94, line__3: 0.71 }, seen),
    })
    const answer = await loaded.call(
      'jev_grep',
      {
        question: 'did it give up here?',
        source: 'text',
        text: [
          'starting',
          'giving up after 3 retries',
          'still going',
          'retry budget exhausted',
        ].join('\n'),
      },
      asked,
    )
    expect(answer.text).toMatch(/2 of 4 lines/)
    // Likeliest first, and the line itself — there is nothing else to show.
    expect(answer.text.indexOf('giving up')).toBeLessThan(answer.text.indexOf('retry budget'))
    // One request for the batch, with a question per line in it.
    expect(seen).toHaveLength(1)
    expect(Object.keys((seen[0] as { questions: object }).questions)).toEqual([
      'line__0',
      'line__1',
      'line__2',
      'line__3',
    ])
  })

  it('never reads a path outside a project, however it is asked', async () => {
    const repo = mkrepo()
    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      settings: { judge: 'scripted' },
    })
    await expect(
      loaded.call('jev_grep', { question: 'anything?', source: 'file', file: '/etc/hosts' }, asked),
    ).rejects.toThrow(/not inside a project/)
  })
})

describe('reading a change', () => {
  /** A repo with a task that has done something worth flagging. */
  function repoWithWork() {
    const repo = mkrepo()
    const worktree = repo.addTask('add-refunds', {
      project: 'shop',
      intent: 'add refunds to the payouts page',
    })
    repo.commit(
      'refund by id',
      {
        'src/refund.ts': ['export const refund = (id: string) =>', 'exec("refund " + id)'].join(
          ' ',
        ),
      },
      worktree,
    )
    return { repo, worktree }
  }

  it('reads a task’s whole diff, says what fired, and writes down every answer', async () => {
    const { repo } = repoWithWork()
    const home = tmp('tade-jev-')
    const loaded = await host({
      home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ shell_injection: 0.93, test_missing: 0.71, severity: 2 }),
    })
    const answer = await loaded.call(
      'jev_review',
      { project: 'shop', task: 'shop/add-refunds' },
      asked,
    )
    expect(answer.text).toMatch(/shop\/add-refunds/)
    expect(answer.text).toMatch(
      /\| shell_injection \| 0\.93 \| src\/refund\.ts \| worth acting on \|/,
    )
    expect(answer.text).toMatch(/should be fixed before release/)
    expect(answer.said).toBe('Read shop/add-refunds: 2 flagged.')

    const [review] = readReviews(home)
    expect(review).toMatchObject({
      unit: 'shop/add-refunds',
      tasks: ['shop/add-refunds'],
      version: 'jev-1.13.0',
      raised: ['shell_injection', 'test_missing'],
    })
    // Every answer, not only the ones that fired: a threshold changed later is
    // a question to re-ask, not an experiment to re-run.
    expect(Object.keys(review?.answers ?? {}).length).toBeGreaterThan(10)
    expect(review?.answers.sql_injection).toBe(0.02)
    expect(readFileSync(join(home, 'jev', 'reviews.jsonl'), 'utf8').split('\n').length).toBe(2)
  })

  it('says there is nothing to read rather than answering cheerfully about nothing', async () => {
    const repo = mkrepo()
    repo.addTask('nothing-yet', { project: 'shop' })
    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({}),
    })
    await expect(
      loaded.call('jev_review', { project: 'shop', task: 'shop/nothing-yet' }, asked),
    ).rejects.toThrow(/no branch|nothing to read/)
  })

  it('sends nothing from a project nobody said it could read', async () => {
    const repo = mkrepo()
    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      settings: { projects: ['other'] },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: offline,
    })
    await expect(
      loaded.call('jev_review', { project: 'shop', ref: 'HEAD~1..HEAD' }, asked),
    ).rejects.toThrow(/not one of the projects Jev may look at/)
  })

  it('reads a branch when it stops moving, once, and starts where it left off', async () => {
    const { repo, worktree } = repoWithWork()
    const home = tmp('tade-jev-')
    const loaded = await host({
      home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ authz_removed: 0.88 }),
    })
    const look = await loaded.look('jev.review', {
      project: 'shop',
      input: { settle: '0m' },
      since: null,
      turnedOn: new Date(NOW - 60_000).toISOString(),
    })
    expect(look.found.map((finding) => finding.key)).toEqual(['shop/add-refunds:authz_removed'])
    expect(look.found[0]?.detail).toMatch(/jev-1\.13\.0 answered 0\.88/)
    expect(look.found[0]?.detail).toMatch(/git diff/)
    // What it read, so the next look costs a `git worktree list` and nothing else.
    expect(JSON.parse(look.since ?? '{}')).toMatchObject({
      'shop/add-refunds': repo.head(worktree),
    })

    const again = await loaded.look('jev.review', {
      project: 'shop',
      input: { settle: '0m' },
      since: look.since,
      turnedOn: new Date(NOW - 60_000).toISOString(),
    })
    expect(again.found).toEqual([])

    repo.commit('one more', { 'src/more.ts': 'export const more = 1\n' }, worktree)
    const moved = await loaded.look('jev.review', {
      project: 'shop',
      input: { settle: '0m' },
      since: look.since,
      turnedOn: new Date(NOW - 60_000).toISOString(),
    })
    expect(moved.found.map((finding) => finding.key)).toEqual(['shop/add-refunds:authz_removed'])
    // What an agent on it is told never says "Jev says so": it says read it.
    const agent = await moved.agent(moved.found[0]!)
    expect(agent.prompt).toMatch(/Read the change yourself first/)
    expect(agent.prompt).toMatch(/false positive is an expected outcome/)
    // The question's own words, because there is no rationale to put here.
    expect(agent.context).toMatch(/weaken a permission check/i)
  })

  it('leaves a branch that is still moving alone', async () => {
    const { repo } = repoWithWork()
    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: offline,
      // The real clock: the commit was made a moment ago, which is exactly
      // the case a settle time exists for.
      now: Date.now(),
    })
    const look = await loaded.look('jev.review', {
      project: 'shop',
      input: { settle: '10m' },
      since: null,
      turnedOn: new Date(NOW - 60_000).toISOString(),
    })
    expect(look.found).toEqual([])
  })
})

describe('the record', () => {
  it('shows what was read, what fired, and that nobody has said whether it was right', async () => {
    const repo = mkrepo()
    const worktree = repo.addTask('add-refunds', { project: 'shop', intent: 'add refunds' })
    repo.commit('refund', { 'src/refund.ts': 'export const refund = () => {}\n' }, worktree)
    const home = tmp('tade-jev-')
    const loaded = await host({
      home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.77 }),
    })
    await loaded.call('jev_review', { project: 'shop', task: 'shop/add-refunds' }, asked)
    const before = await loaded.call('jev_findings', { project: 'shop' }, asked)
    expect(before.text).toMatch(/## This week/)
    expect(before.text).toMatch(/1 change read · 1 flagged/)
    expect(before.text).toMatch(/\| test_missing \| 1 \| 0 \| 0 \|/)

    await loaded.call(
      'jev_verdict',
      {
        finding: 'shop/add-refunds:test_missing',
        was: 'confirmed',
        said: 'the refund path has no test at all',
      },
      asked,
    )
    const after = await loaded.call('jev_findings', { project: 'shop' }, asked)
    expect(after.text).toMatch(/\| test_missing \| 1 \| 1 \| 0 \|/)
    expect(after.text).toMatch(/## Calibration/)
    await expect(
      loaded.call('jev_verdict', { finding: 'shop/nothing:test_missing', was: 'confirmed' }, asked),
    ).rejects.toThrow(/nothing was read/)
  })

  it('keeps what it is asked to keep, and answers with nothing when nothing was read', () => {
    const record = { reviews: [], looks: [], findings: [], finished: new Set<string>(), now: NOW }
    expect(findingsReport(record)).toMatch(/Nothing has been read yet/)
    expect(statusLine(record).text).toBe('0 read · 0 flagged')
  })
})

describe('advising, never deciding', () => {
  it('reads a request and says only what stood out', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ ambiguous_work: 0.81, underspecified: 0.12 }),
    })
    const answer = await loaded.call(
      'jev_read_request',
      { said: 'fix the retry thing and also get the docs off the front page' },
      asked,
    )
    expect(answer.text).toMatch(/ambiguous_work 0\.81/)
    expect(answer.text).not.toMatch(/underspecified 0\.12,/)
    expect(answer.text).toMatch(/you choose the route/)
  })

  it('reads a plan pair by pair, and says when a plan is too big to reason about', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ same_behaviour: 0.9 }),
    })
    const answer = await loaded.call(
      'jev_plan_check',
      {
        agents: [
          { name: 'port', prompt: 'add a method to the driver port', touches: ['drivers/core'] },
          { name: 'tmux', prompt: 'implement it in the tmux driver', touches: ['drivers/tmux'] },
        ],
      },
      asked,
    )
    expect(answer.text).toMatch(/port \+ tmux: same_behaviour 0\.90/)
    expect(answer.text).toMatch(/Nothing here refuses a plan/)

    const many = Array.from({ length: 7 }, (_, index) => ({
      name: `agent-${index}`,
      prompt: `do thing ${index}`,
    }))
    await expect(loaded.call('jev_plan_check', { agents: many }, asked)).rejects.toThrow(
      /more plan than anybody can reason about/,
    )
  })

  it('suggests an order, counting what can be counted rather than asking it', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ broken_now__1: 0.95 }),
    })
    const answer = await loaded.call(
      'jev_queue_order',
      {
        items: [
          { task: 'shop/docs', about: 'tidy the docs' },
          { task: 'shop/payouts', about: 'fix the payout retry loop' },
          { task: 'shop/after', about: 'follow the payout fix', after: ['shop/payouts'] },
        ],
      },
      asked,
    )
    const data = answer.data as { order: string[] }
    expect(data.order[0]).toBe('shop/payouts')
    expect(answer.text).toMatch(/1 waiting on it/)
    expect(answer.text).toMatch(/already ready/)
  })

  it('reads the queue against what has actually changed, and only ever later for it', async () => {
    const seen: unknown[] = []
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ runs_into_changes__0: 0.9 }, seen),
    })
    const answer = await loaded.call(
      'jev_queue_order',
      {
        items: [
          { task: 'shop/write-up', about: 'write up how charging works' },
          { task: 'shop/mail-notes', about: 'write up how mail works' },
        ],
        changed: ['src/charge.ts — shop/fix-charge, which is working'],
      },
      asked,
    )
    // The evidence reaches the judge as state, not as a decision.
    const state = JSON.parse(String((seen[0] as { state: unknown }).state)) as {
      changed: string[]
    }
    expect(state.changed).toEqual(['src/charge.ts — shop/fix-charge, which is working'])
    // And it can only push work later: the one the tree moved under is last.
    const data = answer.data as { order: string[] }
    expect(data.order).toEqual(['shop/mail-notes', 'shop/write-up'])
    expect(answer.text).toMatch(/runs into what has already changed/)
    expect(answer.text).toMatch(/never what may go at all/)
  })
})

describe('the rubric', () => {
  it('asks each thing once, literally, and refuses a question that is not in it', () => {
    const pack = reviewQuestions()
    const ids = pack.map((one) => one.id)
    expect(new Set(ids).size).toBe(ids.length)
    // One judgment per question: the hazards are yes-no, and how bad it would
    // be to ship is the one thing that has levels.
    expect(pack.filter((one) => one.kind === 'rate').map((one) => one.id)).toEqual(['severity'])
    for (const one of pack) expect(one.ask.trim().endsWith('?')).toBe(true)

    expect(reviewQuestions(['test_missing']).map((one) => one.id)).toEqual([
      'test_missing',
      'severity',
    ])
    expect(() => reviewQuestions(['no_such_question'])).toThrow(/is a question in the review pack/)
  })
})

describe('what the window shows', () => {
  const tade = {
    pid: process.pid,
    lanes: () => [],
    startAgent: async () => ({ task: '', worktree: '' }),
  }

  it('keeps nothing in the status bar until something has been read, then costs a moment', async () => {
    const repo = mkrepo()
    const worktree = repo.addTask('add-refunds', { project: 'shop', intent: 'add refunds' })
    repo.commit('refund', { 'src/refund.ts': 'export const refund = () => {}\n' }, worktree)
    const home = tmp('tade-jev-')
    const loaded = await host({
      home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.77 }),
    })
    expect(await loaded.statuses(tade)).toEqual([])

    await loaded.call('jev_review', { project: 'shop', task: 'shop/add-refunds' }, asked)
    const [item] = await loaded.statuses(tade)
    expect(item?.item.text).toMatch(/jev · 1 read · 1 flagged/)
    // It is asked on a timer whether anybody is looking or not, so the second
    // ask must not read the journal again.
    const started = performance.now()
    for (let n = 0; n < 20; n++) await loaded.statuses(tade)
    expect(performance.now() - started).toBeLessThan(200)

    const view = await loaded.view('jev', tade)
    expect(view.markdown).toMatch(/1 change read · 1 flagged/)
    const brief = await loaded.brief()
    expect(brief.items[0]?.said).toMatch(/Jev read 1 change and flagged 1/)
    expect(brief.items[0]?.ask).toMatch(/which .* are worth fixing/)
  })

  it('renders a large record quickly enough to draw on a timer', () => {
    const reviews = Array.from({ length: 500 }, (_, index) => ({
      at: new Date(NOW - index * 60_000).toISOString(),
      project: 'shop',
      unit: `shop/task-${index}`,
      tasks: [`shop/task-${index}`],
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      version: 'jev-1.13.0',
      files: 12,
      requests: 3,
      cost_usd: 0.0011,
      answers: { test_missing: 0.7, shell_injection: 0.1 },
      raised: ['test_missing'],
      verdict: {},
    }))
    const record = { reviews, looks: [], findings: [], finished: new Set<string>(), now: NOW }
    const started = performance.now()
    for (let n = 0; n < 20; n++) findingsReport(record)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('cuts a title at a word, so a title stays a title', () => {
    expect(shorten('a b c d e f', 5)).toBe('a b…')
    expect(shorten('short', 50)).toBe('short')
  })
})
