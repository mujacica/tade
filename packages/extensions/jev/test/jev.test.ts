import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extensionConformance } from '@tade/extensions-core/conformance'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { circlingIn } from '../src/circles.ts'
import { jevExtension } from '../src/extension.ts'
import { shorten } from '../src/loop.ts'
import { findingsReport } from '../src/page.ts'
import { RUBRIC, reviewQuestions } from '../src/questions.ts'
import { statusLine } from '../src/report.ts'
import { readReviews } from '../src/reviews.ts'
import { host, NOW, offline, typesafe } from './harness.ts'

// Jev, answered here the way TypeSafe answers, or by a table. Nothing reaches
// the network: what is under test is what Tade asks, what it makes of the
// answer, and — the half that matters most — that with no key none of it runs
// and nothing else changes.

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
    const loaded = await host({ home, env: {} })
    expect(loaded.list()[0]).toMatchObject({ state: 'needs setup' })
    // Pasted into the field, which writes it as the setting it is.
    await loaded.reconfigure({ jev: { key: 'tsk_0123456789' } })
    expect(loaded.list()[0]).toMatchObject({ state: 'ready', problem: null })
    const setup = loaded.setupOf('jev')
    expect(setup?.guide[0]).toContain('in use from config.yaml')
    // The guide says where it is; the field it is typed into says what it is,
    // because a key you cannot read is a key you cannot check.
    expect(setup?.guide.join(' ')).not.toContain('tsk_0123456789')
    expect(setup?.fields[0]).toMatchObject({
      key: 'key',
      kind: 'secret',
      value: 'tsk_0123456789',
    })

    // And a variable in the shell is what is used, whatever was pasted.
    const exported = await host({
      home,
      settings: { key: 'tsk_0123456789' },
      env: { TYPESAFE_API_KEY: 'from-the-shell' },
    })
    expect(exported.setupOf('jev')?.guide[0]).toContain('in use from $TYPESAFE_API_KEY')
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
      home: repo.home,
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
    const home = repo.home
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
      home: repo.home,
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
      home: repo.home,
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
    const home = repo.home
    const loaded = await host({
      home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ authz_removed: 0.88 }),
      // The real clock, as in the test below, and read at each look rather
      // than captured once: the fixture commits again part way through, and
      // git's own timestamps are whole seconds. A frozen clock is a watch
      // looking at work from its own future, which settles nothing — pinned,
      // this passed on the day it was written and went red the next morning.
      now: Date.now,
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
      home: repo.home,
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
    const home = repo.home
    const loaded = await host({
      home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.77 }),
    })
    await loaded.call('jev_review', { project: 'shop', task: 'shop/add-refunds' }, asked)
    const before = await loaded.call('jev_findings', { project: 'shop' }, asked)
    // `jev_findings` is every tab and no window: a tool call has no tabs to
    // press, and the orchestrator is usually asking about findings older than
    // today.
    expect(before.text).toMatch(/## Read ever/)
    expect(before.text).toMatch(/1 change · 1 flagged/)
    expect(before.text).toMatch(/test_missing\s+1\s+█+\s+none judged/)

    await loaded.call(
      'jev_verdict',
      {
        finding: 'shop/add-refunds:test_missing',
        was: 'confirmed',
        said: 'src/refund.ts adds a refund path with no test at all',
      },
      asked,
    )
    const after = await loaded.call('jev_findings', { project: 'shop' }, asked)
    expect(after.text).toMatch(/test_missing\s+1\s+█+\s+1 of 1, too few to call/)
    expect(after.text).toMatch(/## By probability/)
    await expect(
      loaded.call(
        'jev_verdict',
        {
          finding: 'shop/nothing:test_missing',
          was: 'confirmed',
          said: 'src/nothing.ts has no test',
        },
        asked,
      ),
    ).rejects.toThrow(/nothing was read/)
  })

  it('keeps what it is asked to keep, and answers with nothing when nothing was read', () => {
    const record = { reviews: [], looks: [], findings: [], finished: new Set<string>(), now: NOW }
    expect(findingsReport(record)).toMatch(/Nothing read ever/)
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
    agents: () => [],
    startAgent: async () => ({ task: '', worktree: '' }),
  }

  it('keeps nothing in the status bar until something has been read, then costs a moment', async () => {
    const repo = mkrepo()
    const worktree = repo.addTask('add-refunds', { project: 'shop', intent: 'add refunds' })
    repo.commit('refund', { 'src/refund.ts': 'export const refund = () => {}\n' }, worktree)
    const home = repo.home
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
    expect(view.markdown).toMatch(/1 change · 1 flagged/)
    // The page says what it offers, so the window draws the tabs and the window
    // row from the extension's own answer rather than from anything sniffed.
    expect(view.tabs.map((tab) => tab.id)).toEqual([
      'overview',
      'findings',
      'questions',
      'calibration',
      'looks',
    ])
    expect(view.windowed).toBe(true)
    // And a tab it was never offered is answered as its first, so a page whose
    // tabs were renamed never comes back empty.
    const overview = await loaded.view('jev', tade, { tab: 'nonesuch', since: 0, window: 'today' })
    expect(overview.markdown).toBe(view.markdown)
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
      rubric: RUBRIC,
      files: 12,
      part: null,
      requests: 3,
      cost_usd: 0.0011,
      answers: { test_missing: 0.7, shell_injection: 0.1 },
      where: { test_missing: 'src/thing.ts' },
      raised: ['test_missing'],
      account: {},
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

describe('reading a command an agent is held at', () => {
  const asking = {
    project: 'checkout',
    task: 'checkout/refunds',
    worktree: '/work/wt/checkout-refunds',
    tool: 'bash',
    command: 'terraform destroy -auto-approve',
    input: { command: 'terraform destroy -auto-approve' },
    decided: { tier: 'soft' as const, rule: 'command', reason: 'runs a command' },
    signal: new AbortController().signal,
  }

  it('raises what it takes to allow one, in Tade’s own words and never the number', async () => {
    const seen: unknown[] = []
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ reaches_shared: 0.94, more_than_it_looks: 0.7 }, seen),
    })
    const read = await loaded.caution(asking)

    expect(read.problems).toEqual([])
    expect(read.caution).toEqual({
      tier: 'hard',
      // Written in questions.ts, in advance, by somebody: what a person hears
      // is never a sentence a model wrote about a command it was shown.
      reason: 'changes something other people share',
      version: 'jev-1.13.0',
      by: 'jev',
    })
    // It is asked about the command, and told where the agent is allowed to
    // be working — "outside it" is a question about this call, not about paths.
    const [body] = seen as { state: string }[]
    expect(JSON.parse(body?.state ?? '{}')).toMatchObject({
      command: 'terraform destroy -auto-approve',
      agent_works_in: '/work/wt/checkout-refunds',
      // What the rules already decided, so it is asked about what no rule names.
      tade_already_decided: 'soft: runs a command',
    })
  })

  it('says nothing about a command that reads as ordinary', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      // Everything well under `act`: a run of the tests is a run of the tests.
      fetch: typesafe({}),
    })
    expect(await loaded.caution({ ...asking, command: 'pnpm test' })).toMatchObject({
      caution: null,
    })
  })

  it('takes the strictest of what fired, not the first one asked', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ more_than_it_looks: 0.99, wipes_uncommitted: 0.9 }),
    })
    expect((await loaded.caution(asking)).caution).toMatchObject({
      tier: 'hard',
      reason: 'throws away work that is not committed',
    })
  })

  it('reads nothing when it is turned off, and nothing from a project nobody named', async () => {
    const off = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      settings: { commands: false },
      // Nothing may reach the network: a setting that is read after the ask
      // would have cost money before anybody noticed.
      fetch: offline,
    })
    expect(await off.caution(asking)).toEqual({ caution: null, problems: [] })

    const elsewhere = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      settings: { projects: ['billing'] },
      fetch: offline,
    })
    expect(await elsewhere.caution(asking)).toEqual({ caution: null, problems: [] })
  })

  it('reads the same command from the same agent once, not at every retry', async () => {
    const seen: unknown[] = []
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ reaches_shared: 0.94 }, seen),
    })
    const first = await loaded.caution(asking)
    // An agent that is refused runs the same line again, and again after that.
    const again = await loaded.caution(asking)

    expect(again).toEqual(first)
    expect(seen).toHaveLength(1)
    // A different command is a different question.
    await loaded.caution({ ...asking, command: 'pnpm test' })
    expect(seen).toHaveLength(2)
  })

  it('with no key, reads nothing and holds nothing up', async () => {
    const loaded = await host({ home: tmp('tade-jev-'), env: {}, fetch: offline })
    expect(await loaded.caution(asking)).toEqual({ caution: null, problems: [] })
  })
})

describe('a sentence typed into search', () => {
  const choices = [
    { id: 'stop:checkout/refunds', label: 'Stop refunds', detail: 'in checkout' },
    { id: 'run:new-agent', label: 'New agent' },
    { id: 'run:spend', label: 'Spend' },
  ]
  const said = 'stop whoever is on the refunds thing'

  /** A TypeSafe that puts the weight where a test says, over the options asked. */
  function picks(weights: Record<string, number>, seen?: unknown[]): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        questions: Record<string, { criteria?: Record<string, string> }>
      }
      seen?.push(body)
      const options = Object.keys(body.questions.meant?.criteria ?? {})
      const probabilities = Object.fromEntries(
        options.map((option) => [option, weights[option] ?? 0.01]),
      )
      return Response.json({
        model: 'jev-1.13.0',
        usage: { input_tokens: 200 },
        answers: {
          meant: {
            type: 'choice',
            choice: options.reduce((best, one) =>
              (probabilities[one] ?? 0) > (probabilities[best] ?? 0) ? one : best,
            ),
            probabilities,
            confidence: 0.9,
          },
        },
      })
    }) as typeof fetch
  }

  it('answers with what was put in front of it, best first, and nothing else', async () => {
    const seen: unknown[] = []
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: picks({ c1: 0.88, c2: 0.65 }, seen),
    })
    const answer = await loaded.meant({ said, choices, signal: new AbortController().signal })

    // Two plausible readings of one sentence is the answer to "did you mean".
    expect(answer).toEqual({ ids: ['stop:checkout/refunds', 'run:new-agent'], problems: [] })
    // It is asked about what they typed, with one option per thing they can
    // already see and one for none of them.
    const [body] = seen as { questions: { meant: { criteria: Record<string, string> } } }[]
    const options = Object.keys(body?.questions.meant.criteria ?? {})
    expect(options).toEqual(['c1', 'c2', 'c3', 'none'])
  })

  it('is asked with what is happening about each thing, where the window offered it', async () => {
    const seen: unknown[] = []
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: picks({ c1: 0.9 }, seen),
    })
    await loaded.meant({
      said: 'the agent on test coverage',
      choices: [
        {
          id: 'task:tade/flaky-suite',
          label: 'flaky-suite',
          detail: 'in tade',
          about: 'working · 2 commits, tests green asked for: raise test coverage',
        },
        { id: 'run:new-agent', label: 'New agent' },
      ],
      signal: new AbortController().signal,
    })
    const [body] = seen as { questions: { meant: { criteria: Record<string, string> } } }[]
    const options = body?.questions.meant.criteria ?? {}
    // Which is the whole of what makes the sentence answerable: nothing here
    // is called `coverage`, and one of them is doing it.
    expect(options.c1).toBe(
      'flaky-suite — in tade · working · 2 commits, tests green asked for: raise test coverage',
    )
    // And a choice that came with none is offered exactly as it always was.
    expect(options.c2).toBe('New agent')
  })

  it('says nothing where none of them was meant', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: picks({ none: 0.93, c1: 0.4 }),
    })
    expect(await loaded.meant({ said, choices, signal: new AbortController().signal })).toEqual({
      ids: [],
      problems: [],
    })
  })

  it('stops at none, so what it believes less than "none of these" is not offered', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: picks({ c1: 0.8, none: 0.7, c2: 0.65 }),
    })
    expect(
      (await loaded.meant({ said, choices, signal: new AbortController().signal })).ids,
    ).toEqual(['stop:checkout/refunds'])
  })

  it('asks nobody when it is turned off, or when there is no key', async () => {
    const off = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      settings: { search: false },
      fetch: offline,
    })
    expect(await off.meant({ said, choices, signal: new AbortController().signal })).toEqual({
      ids: [],
      problems: [],
    })
    const none = await host({ home: tmp('tade-jev-'), env: {}, fetch: offline })
    expect(await none.meant({ said, choices, signal: new AbortController().signal })).toEqual({
      ids: [],
      problems: [],
    })
  })
})

describe('what an agent has been doing, counted', () => {
  const did = (tool: string, about: string, ok: boolean | null = true, at = NOW) => ({
    at,
    tool,
    about,
    ok,
  })
  const ended = (status: 'ok' | 'error' | 'aborted') => ({ at: NOW, status })

  it('says nothing about an agent that is getting on with it', () => {
    const working = [
      did('read', 'src/charge.ts'),
      did('edit', 'src/charge.ts'),
      did('bash', 'pnpm test'),
      did('bash', 'git commit -m fix'),
    ]
    expect(circlingIn(working, [ended('ok')], 3, 3)).toBeNull()
  })

  it('does not call running the tests five times a loop when they keep passing', () => {
    // A repeat where nothing ever fails is a method, not a loop — and nobody
    // is asked about it, which is what keeps looking every ten minutes free.
    const method = Array.from({ length: 5 }, () => did('bash', 'pnpm test'))
    expect(circlingIn(method, [], 3, 3)).toBeNull()
  })

  it('finds the same failing call coming round, and what else it did', () => {
    const stuck = [
      did('bash', 'pnpm test', false),
      did('edit', 'src/charge.ts'),
      did('bash', 'pnpm test', false),
      did('edit', 'src/charge.ts'),
      did('bash', 'pnpm test', false),
    ]
    const round = circlingIn(stuck, [], 3, 3)
    expect(round).toMatchObject({ signature: 'bash pnpm test', times: 3, failed: 3 })
    // Everything it did, oldest first, the same thing counted rather than
    // listed again: a judge cannot count, so nothing is left for it to.
    expect(round?.steps).toEqual([
      { tool: 'bash', about: 'pnpm test', times: 3, failed: 3 },
      { tool: 'edit', about: 'src/charge.ts', times: 2, failed: 0 },
    ])
  })

  it('finds an agent that cannot get through a turn at all', () => {
    const round = circlingIn(
      [did('bash', 'pnpm build')],
      [ended('ok'), ended('error'), ended('error'), ended('error')],
      3,
      3,
    )
    expect(round).toMatchObject({ badTurns: 3, signature: 'bash pnpm build' })
  })
})

describe('watching for an agent going in circles', () => {
  const stuck = {
    task: 'checkout/refunds',
    project: 'checkout',
    startedAt: NOW - 40 * 60_000,
    turn: 'running' as const,
    did: Array.from({ length: 4 }, () => ({
      at: NOW,
      tool: 'bash',
      about: 'pnpm migrate --env staging',
      ok: false,
    })),
    ends: [],
  }
  const window = {
    pid: 1,
    lanes: () => [],
    agents: () => [stuck],
    startAgent: async () => ({ task: '', worktree: '' }),
  }
  const look = (loaded: Awaited<ReturnType<typeof host>>, tade: typeof window | null = window) =>
    loaded.look('jev.circles', {
      project: 'checkout',
      input: {},
      since: null,
      turnedOn: new Date(NOW - 3_600_000).toISOString(),
      tade,
    })

  it('says which agent, what it keeps trying, and that nothing was done about it', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      projects: { checkout: { root: tmp('tade-jev-repo-') } },
      fetch: typesafe({ in_circles: 0.91, needs_a_person: 0.2 }),
    })
    const looked = await look(loaded)

    expect(looked.found).toHaveLength(1)
    expect(looked.found[0]?.title).toBe(
      'checkout/refunds: it looks like it is trying the same thing that already failed',
    )
    // Known by the agent and what it is going round on, so being stuck on the
    // same thing is said once and on something else later is news again.
    expect(looked.found[0]?.key).toMatch(/^checkout\/refunds:bash pnpm migrate/)
    expect(looked.found[0]?.detail).toMatch(/4 times, 4 of them failing/)
    expect(looked.found[0]?.detail).toMatch(/stopping or steering it is yours/)
  })

  it('has nothing to start work on, and says so rather than starting something', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      projects: { checkout: { root: tmp('tade-jev-repo-') } },
      fetch: typesafe({ in_circles: 0.91 }),
    })
    expect(loaded.watches().find((one) => one.id === 'jev.circles')?.offers).toBe('ask')
    const looked = await look(loaded)
    await expect(looked.agent(looked.found[0] as never)).rejects.toThrow(/told to the orchestrator/)
  })

  it('says nothing where a repeat is how a job gets finished', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      projects: { checkout: { root: tmp('tade-jev-repo-') } },
      // The one answer that takes a finding away again.
      fetch: typesafe({ in_circles: 0.9, nearly_there: 0.88 }),
    })
    expect((await look(loaded)).found).toEqual([])
  })

  it('asks nobody about an agent that is getting on with it', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      projects: { checkout: { root: tmp('tade-jev-repo-') } },
      fetch: offline,
    })
    const working = { ...stuck, did: [{ at: NOW, tool: 'bash', about: 'pnpm test', ok: true }] }
    const looked = await loaded.look('jev.circles', {
      project: 'checkout',
      input: {},
      since: null,
      turnedOn: new Date(NOW - 3_600_000).toISOString(),
      tade: { ...window, agents: () => [working] },
    })
    expect(looked.found).toEqual([])
  })

  it('cannot look without a window, and says why rather than finding nothing', async () => {
    const loaded = await host({
      home: tmp('tade-jev-'),
      env: { TYPESAFE_API_KEY: 'k' },
      projects: { checkout: { root: tmp('tade-jev-repo-') } },
      fetch: offline,
    })
    await expect(look(loaded, null)).rejects.toThrow(/open window/)
  })
})
