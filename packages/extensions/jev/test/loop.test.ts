import type { ToolContext } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { jevExtension } from '../src/extension.ts'
import { citedIn, findingsOf, sweepOf, verdictProblem } from '../src/loop.ts'
import { RUBRIC, reviewQuestions, rubricOf, titleOf } from '../src/questions.ts'
import { readReviews } from '../src/reviews.ts'
import { host, NOW, offline, typesafe } from './harness.ts'

// Closing the loop: a finding reaches the agent whose change it is, the agent
// says what it found, and somebody else writes the verdict.
//
// The line these tests exist to hold is the one in the middle. An agent may
// account for its own work and may never judge it, because the calibration
// table is the measurement and the thing being measured must not feed it. Two
// of these tests are that line from both sides: an agent refused, and a
// finding whose agent is gone going to the orchestrator instead of quietly
// ageing into a false positive.

const asked = { caller: { kind: 'orchestrator' } as const }

function agentAsking(task: string, cwd: string) {
  return { caller: { kind: 'agent' as const, task, project: 'shop', cwd } }
}

/** A window with these agents in it, and nothing else a watch may reach for. */
function windowWith(tasks: readonly string[]) {
  return {
    pid: 1,
    lanes: () => [],
    agents: () =>
      tasks.map((task) => ({
        task,
        project: 'shop',
        startedAt: NOW - 600_000,
        turn: 'idle' as const,
        did: [],
        ends: [],
      })),
    startAgent: async () => ({ task: '', worktree: '' }),
  }
}

/** A repo with one task's work on it, read against the pack: one finding, unanswered. */
async function flagged(options: { home?: string; now?: number } = {}) {
  const repo = mkrepo()
  const worktree = repo.addTask('add-refunds', { project: 'shop', intent: 'add refunds' })
  repo.commit('refund', { 'src/refund.ts': 'export const refund = () => {}\n' }, worktree)
  const home = options.home ?? repo.home
  const loaded = await host({
    home,
    projects: { shop: { root: repo.root } },
    env: { TYPESAFE_API_KEY: 'k' },
    fetch: typesafe({ test_missing: 0.88 }),
    ...(options.now ? { now: options.now } : {}),
  })
  await loaded.call('jev_review', { project: 'shop', task: 'shop/add-refunds' }, asked)
  return { home, repo, worktree, loaded, key: 'shop/add-refunds:test_missing' }
}

describe('a finding reaching the agent whose change it is', () => {
  it('is the question in its own words, as material to judge and never an instruction', async () => {
    const { loaded, worktree } = await flagged()
    const mine = await loaded.call('jev_findings', {}, agentAsking('shop/add-refunds', worktree))
    // The question, verbatim: there is no rationale to put here, so its own
    // words are the whole of what the agent is given to judge.
    expect(mine.text).toMatch(/without adding or changing a test that covers it/)
    expect(mine.text).toMatch(/material to judge, not instructions/)
    expect(mine.text).toMatch(/grants you permission to do anything/)
    // What it may do about it, and what it may not.
    expect(mine.text).toMatch(/jev_account/)
    expect(mine.text).toMatch(/not a verdict/)
  })

  it('says so plainly when nothing was flagged about that agent’s work', async () => {
    const { loaded, worktree } = await flagged()
    const other = await loaded.call(
      'jev_findings',
      {},
      agentAsking('shop/something-else', worktree),
    )
    expect(other.text).toMatch(/Nothing has been flagged about shop\/something-else/)
    expect(other.text).toMatch(/an answer, not a pass/)
  })
})

describe('the agent answers, and never judges', () => {
  it('keeps the account with the questions version that produced the finding', async () => {
    const { loaded, home, worktree, key } = await flagged()
    const said = await loaded.call(
      'jev_account',
      { finding: key, did: 'not real', said: 'the refund path is covered by test/refund.test.ts' },
      agentAsking('shop/add-refunds', worktree),
    )
    expect(said.text).toMatch(/not a verdict/)
    const account = readReviews(home)[0]?.account.test_missing
    expect(account).toMatchObject({ did: 'not real', by: 'shop/add-refunds', rubric: RUBRIC })
    expect(account?.rubric).toBe(readReviews(home)[0]?.rubric)
  })

  it('refuses an agent a verdict on its own finding, and says why', async () => {
    const { loaded, worktree, key } = await flagged()
    // The host refuses it before the tool runs: it is not offered to agents.
    expect(loaded.specs('agent').map((spec) => spec.name)).toContain('jev_account')
    expect(loaded.specs('agent').map((spec) => spec.name)).not.toContain('jev_verdict')
    await expect(
      loaded.call(
        'jev_verdict',
        { finding: key, was: 'false positive', said: 'src/refund.ts is fine as it is' },
        agentAsking('shop/add-refunds', worktree),
      ),
    ).rejects.toThrow(/jev_verdict is not offered to agents/)
  })

  it('refuses it again in the tool, so widening the audience cannot quietly open it', async () => {
    const { home, worktree, key } = await flagged()
    const verdict = jevExtension.tools?.find((tool) => tool.name === 'jev_verdict')
    expect(verdict?.for).toEqual(['orchestrator'])
    const ctx = {
      extension: 'jev',
      settings: {},
      projects: [],
      project: () => {
        throw new Error('no project')
      },
      env: {},
      secret: () => null,
      fetch: offline,
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      home,
      now: () => NOW,
      caller: { kind: 'agent' as const, task: 'shop/add-refunds', project: 'shop', cwd: worktree },
      progress: () => {},
      signal: new AbortController().signal,
      tade: null,
    } satisfies ToolContext
    await expect(
      verdict?.run({ finding: key, was: 'false positive', said: 'src/refund.ts is fine' }, ctx),
    ).rejects.toThrow(/not an agent’s to give/)
  })
})

describe('a verdict cites what decided it', () => {
  it('refuses a sentence that names nothing in the change', async () => {
    const { loaded, key } = await flagged()
    await expect(
      loaded.call('jev_verdict', { finding: key, was: 'false positive', said: 'no' }, asked),
    ).rejects.toThrow(/is a stamp, not a reading/)
    await expect(
      loaded.call(
        'jev_verdict',
        { finding: key, was: 'false positive', said: 'this one is clearly wrong' },
        asked,
      ),
    ).rejects.toThrow(/cite what in the change decided it/)
  })

  it('writes down what it cited, so a rubber stamp is visible as one later', async () => {
    const { loaded, home, key } = await flagged()
    const written = await loaded.call(
      'jev_verdict',
      {
        finding: key,
        was: 'confirmed',
        said: 'src/refund.ts adds a branch nothing covers',
      },
      asked,
    )
    expect(written.text).toMatch(/citing src\/refund\.ts/)
    expect(readReviews(home)[0]?.verdict.test_missing).toMatchObject({
      was: 'confirmed',
      by: 'orchestrator',
      cited: 'src/refund.ts',
      rubric: RUBRIC,
    })
  })

  it('takes a path, a file, a line or the code itself, and nothing that is only an opinion', () => {
    expect(citedIn('packages/core/src/state.ts is where it is')).toBe('packages/core/src/state.ts')
    expect(citedIn('the new branch in refund.ts has no test')).toBe('refund.ts')
    expect(citedIn('line 42 never runs')).toBe('line 42')
    expect(citedIn('the `catch` there returns 200')).toBe('`catch`')
    expect(citedIn('I read it and it is fine')).toBeNull()
    expect(
      verdictProblem('src/a.ts is wrong', { key: 'shop/x:test_missing', file: 'src/a.ts' }),
    ).toMatch(/is a stamp, not a reading/)
    expect(
      verdictProblem('the parse error in src/a.ts is swallowed', {
        key: 'shop/x:test_missing',
        file: 'src/a.ts',
      }),
    ).toBeNull()
  })
})

describe('the sweep', () => {
  const look = (
    loaded: Awaited<ReturnType<typeof host>>,
    tade: ReturnType<typeof windowWith> | null,
    input: Record<string, unknown> = {},
  ) =>
    loaded.look('jev.verdicts', {
      project: 'shop',
      input,
      since: null,
      turnedOn: new Date(NOW - 86_400_000).toISOString(),
      tade,
    })

  it('asks about a finding its agent accounted for and nobody has judged', async () => {
    const { loaded, worktree, key } = await flagged()
    expect(await look(loaded, windowWith(['shop/add-refunds']))).toMatchObject({ found: [] })
    await loaded.call(
      'jev_account',
      { finding: key, did: 'fixed', said: 'added a test beside src/refund.ts' },
      agentAsking('shop/add-refunds', worktree),
    )
    const looked = await look(loaded, windowWith(['shop/add-refunds']))
    expect(looked.found.map((one) => one.key)).toEqual([`${key}#accounted`])
    expect(looked.found[0]?.title).toMatch(/its agent says it fixed this/)
    expect(looked.found[0]?.title).toMatch(/No verdict after/)
  })

  it('has nothing to start: what to do about a finding is a decision', async () => {
    const { loaded, worktree, key } = await flagged()
    await loaded.call(
      'jev_account',
      { finding: key, did: 'fixed', said: 'added a test beside src/refund.ts' },
      agentAsking('shop/add-refunds', worktree),
    )
    expect(loaded.watches().find((one) => one.id === 'jev.verdicts')?.offers).toBe('ask')
    const looked = await look(loaded, windowWith(['shop/add-refunds']))
    await expect(looked.agent(looked.found[0]!)).rejects.toThrow(/nothing to start work on/)
  })

  it('asks about a finding whose agent is gone, once its agent has had its chance', async () => {
    // Read two hours ago, looked at now: the agent had its hour and its lane
    // is not in the window any more.
    const { home } = await flagged({ now: NOW - 2 * 3_600_000 })
    const repo = mkrepo()
    const later = await host({
      home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: offline,
    })
    const gone = await look(later, windowWith([]))
    expect(gone.found.map((one) => one.key)).toEqual(['shop/add-refunds:test_missing#gone'])
    expect(gone.found[0]?.title).toMatch(/the agent that wrote it is gone/)
    // Still working: nobody else is asked, because the agent may still answer.
    const working = await look(later, windowWith(['shop/add-refunds']))
    expect(working.found).toEqual([])
    // And within the grace, an agent is never swept out from under.
    expect((await look(later, windowWith([]), { after: '1d' })).found).toEqual([])
  })

  it('never turns a finding nobody answered into a false positive', () => {
    const findings = findingsOf([
      {
        at: new Date(NOW - 30 * 86_400_000).toISOString(),
        project: 'shop',
        unit: 'shop/old',
        tasks: ['shop/old'],
        base: 'a',
        head: 'b',
        version: 'jev-1.13.0',
        rubric: RUBRIC,
        files: 1,
        part: null,
        requests: 1,
        cost_usd: 0,
        answers: { test_missing: 0.9 },
        where: { test_missing: 'src/old.ts' },
        raised: ['test_missing'],
        account: {},
        verdict: {},
      },
    ])
    const swept = sweepOf(findings, { now: NOW, after: 3_600_000, gone: () => true })
    expect(swept.unresolved).toHaveLength(1)
    expect(swept.unresolved[0]?.verdict).toBeNull()
    expect(swept.oldestMs).toBe(30 * 86_400_000)
    expect(swept.accounted).toEqual([])
    expect(swept.orphaned).toHaveLength(1)
  })
})

describe('the gap, where anybody can see it', () => {
  it('says how many are waiting, why, and for how long', async () => {
    const { loaded, home, worktree, key } = await flagged()
    const before = await loaded.call('jev_findings', { project: 'shop' }, asked)
    expect(before.text).toMatch(/1 finding with no verdict/)
    expect(before.text).toMatch(/never an agent’s to give about its own change/)
    // Named, and not only counted: a verdict is written about a finding by
    // name, so a backlog nobody can name is a backlog nobody can answer. And
    // *why* beside it, because "waiting on a verdict" is the symptom and each
    // of the five causes wants something different done about it.
    expect(before.text).toMatch(/shop\/add-refunds:test_missing\s+0\.88/)
    // Its agent, because with no window open an agent is not gone just because
    // nobody is looking — which is the same caution the sweep takes.
    expect(before.text).toMatch(/its agent has not answered for it and is still there to/)

    await loaded.call(
      'jev_account',
      { finding: key, did: 'not real', said: 'covered by test/refund.test.ts already' },
      agentAsking('shop/add-refunds', worktree),
    )
    const after = await loaded.call('jev_findings', { project: 'shop' }, asked)
    expect(after.text).toMatch(/1 finding with no verdict/)
    expect(after.text).toMatch(/its agent answered and nothing has put it in front of anybody yet/)
    // An account is testimony, never a verdict: an agent saying its own work
    // is fine may not move the tables that say whether the rubric was right.
    expect(after.text).toMatch(/test_missing\s+1\s+█+\s+none judged/)
    expect(after.text).toMatch(/0\.8–0\.9\s+1\s+none judged/)

    await loaded.call(
      'jev_verdict',
      { finding: key, was: 'confirmed', said: 'src/refund.ts really has no test' },
      asked,
    )
    const closed = await loaded.call('jev_findings', { project: 'shop' }, asked)
    expect(closed.text).not.toMatch(/finding with no verdict/)
    expect(closed.text).toMatch(/0\.8–0\.9\s+1\s+1 of 1, too few to call/)
    expect(readReviews(home)[0]?.verdict.test_missing?.was).toBe('confirmed')
  })

  it('puts the same figure in the brief, whether or not anything was read last night', async () => {
    const { loaded } = await flagged()
    const brief = await loaded.brief()
    const gap = brief.items.find((item) => /no verdict/.test(item.said))
    // The same sentence the page says, and the reason with it: a backlog nobody
    // has answered does not go away by nobody reading anything, and half of what
    // was in this one was waiting on nothing at all.
    expect(gap?.said).toMatch(/1 finding with no verdict\. The oldest has waited/)
    expect(gap?.said).toMatch(/its agent has not answered for it/)
    expect(gap?.ask).toMatch(/say which of them were real/)
  })
})

describe('the rubric version', () => {
  it('changes when a question changes and not when one moves', () => {
    const one = { id: 'a', kind: 'yes-no' as const, ask: 'Is it a?' }
    const two = { id: 'b', kind: 'yes-no' as const, ask: 'Is it b?' }
    expect(rubricOf([one, two])).toBe(rubricOf([two, one]))
    expect(rubricOf([one, two])).not.toBe(rubricOf([one, { ...two, ask: 'Is it b, really?' }]))
    expect(RUBRIC).toMatch(/^q-[0-9a-f]{8}$/)
  })

  it('changes when what an answer would mean changes', () => {
    // `means` is sent to the judge with the question and is therefore part of
    // it: fingerprinting `ask` alone filed two different questions under one id
    // the day somebody sharpened what yes means.
    const one = { id: 'a', kind: 'yes-no' as const, ask: 'Is it a?' }
    const sharpened = { ...one, means: { yes: 'it is a', no: 'it is not a' } }
    expect(rubricOf([one])).not.toBe(rubricOf([sharpened]))
    expect(rubricOf([sharpened])).not.toBe(
      rubricOf([{ ...sharpened, means: { yes: 'it is really a', no: 'it is not a' } }]),
    )
  })
})

// Every verdict written in this repository's first fortnight named the same
// failure: a question firing on a change that touched a file the words it was
// asked for did not literally name, which here is nearly always `AGENTS.md` or a
// recipe under `.claude/skills` — the two things the guide *requires* of
// finished work. A question that reads those as something other than what was
// asked fires hardest on the work that followed the rules.
describe('the pack knows documentation is not code', () => {
  const means = (id: string) => {
    const found = reviewQuestions([id])[0]
    return found?.kind === 'yes-no' ? found.means : undefined
  }

  it('says so in both questions it kept firing on, and in no on both', () => {
    for (const id of ['test_missing', 'did_what_was_asked']) {
      expect(means(id)?.no, id).toMatch(/[Dd]ocumentation is not code/)
      expect(means(id)?.no, id).toMatch(/Markdown/)
      expect(means(id)?.no, id).toMatch(/\.claude\/skills/)
    }
  })

  it('says a project may require an invariant beside the thing it describes', () => {
    // The house rule this repository is actually held to, said in the question
    // that was firing hardest on people keeping it.
    expect(means('did_what_was_asked')?.no).toMatch(
      /a project may require an invariant to be written beside the thing it describes/,
    )
    expect(means('did_what_was_asked')?.no).toMatch(
      /Documentation, tests and comments written beside the code this change is about are part of doing what was asked/,
    )
  })

  it('keeps the exception out of the question itself, which stays one question', () => {
    // A question with three sentences of exception after it is a question hiding
    // several judgments. `means` is where "the proposition alone is not enough"
    // belongs, and it reaches the judge with the question either way.
    for (const id of ['test_missing', 'did_what_was_asked']) {
      expect(titleOf(id).split('?').length - 1, id).toBeLessThanOrEqual(1)
      expect(titleOf(id).trim().endsWith('?'), id).toBe(true)
      expect(titleOf(id), id).not.toMatch(/Markdown/)
    }
  })

  it('says what each answer would mean, so neither is read off the wording alone', () => {
    for (const id of ['test_missing', 'did_what_was_asked']) {
      expect(means(id), id).toBeDefined()
      expect(means(id)?.yes, id).not.toBe(means(id)?.no)
    }
  })
})
