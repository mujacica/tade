import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CheckLog, coverageOf, writeRun } from '@tade/checks-core'
import { ConfigSchema, type TadeEvent, taskDir } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { CI_WORKFLOW, ciWorkflow } from '../../../test/fixtures/workflow.ts'
import { checksAt, checksGate, pushOrCommit } from '../src/checks.ts'

// The rule about pushing without a green run, and what it can honestly do.

const WORKFLOW = ciWorkflow([
  { id: 'format', run: 'pnpm exec biome ci .' },
  { id: 'tests', run: 'pnpm exec vitest run' },
])

const COMMIT = 'a1b2c3d4e5f6'

function worktreeWith(runs: { check: string; state: string; tail?: string }[] = []): string {
  const root = tmp('tade-gate-')
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(root, CI_WORKFLOW), WORKFLOW)
  if (runs.length > 0) {
    // `gate` hands the worktree in as Tade's home, so what ran here is under
    // it rather than in it — and the test holds no path of its own.
    mkdirSync(recordsOf(root), { recursive: true })
    writeFileSync(
      join(recordsOf(root), 'checks.jsonl'),
      `${runs
        .map((run) =>
          JSON.stringify({
            id: `${COMMIT}:${run.check}:here:1`,
            check: run.check,
            commit: COMMIT,
            state: run.state,
            where: { kind: 'here', runner: 'local', host: 'mbp' },
            required: true,
            startedAt: '2026-09-19T05:00:00.000Z',
            finishedAt: '2026-09-19T05:01:00.000Z',
            code: run.state === 'passed' ? 0 : 1,
            summary: null,
            by: 'shop/refunds',
            tail: run.tail ?? '',
          }),
        )
        .join('\n')}\n`,
    )
  }
  return root
}

/** Where a run in this worktree is written down, with the worktree as the home. */
const recordsOf = (root: string) => taskDir(root, 'shop/refunds')

const green = (check: string, commit: string): CheckLog => ({
  id: `${commit.slice(0, 7)}:${check}:here:1`,
  check,
  commit,
  state: 'passed',
  where: { kind: 'here', runner: 'local', host: 'mbp' },
  required: true,
  startedAt: '2026-09-19T05:00:00.000Z',
  finishedAt: '2026-09-19T05:01:00.000Z',
  code: 0,
  summary: null,
  by: 'shop/refunds',
  tail: '',
})

const config = (over: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    approvals: { mode: 'policy' },
    projects: { shop: { root: '/src/shop' } },
    ...over,
  })

function gate(worktree: string, over: Record<string, unknown> = {}, events: TadeEvent[] = []) {
  return checksGate({
    config: config(over),
    // Where a run in this worktree is written down. These tests hold the
    // records beside the worktree, which is what `recordsDir` would give a
    // project whose checkout it is.
    tadeHome: worktree,
    events: async () => events,
    head: async () => COMMIT,
    now: () => Date.parse('2026-09-19T09:00:00Z'),
  })
}

const push = (worktree: string) => ({
  task: 'shop/refunds',
  project: 'shop',
  worktree,
  tool: 'bash',
  input: { command: 'git push origin HEAD' },
})

describe('what a call is', () => {
  it('reads a push and a commit out of the command, and nothing out of the rest', () => {
    expect(pushOrCommit('bash', { command: 'git push origin HEAD' })).toBe('push')
    expect(pushOrCommit('bash', { command: 'git add -p && git commit -m x' })).toBe('commit')
    expect(pushOrCommit('bash', { command: 'pnpm test' })).toBeNull()
    expect(pushOrCommit('write', { path: 'src/a.ts' })).toBeNull()
  })
})

describe('the checks gate', () => {
  it('lets a push through when every required check passed at this commit', async () => {
    const worktree = worktreeWith([
      { check: 'format', state: 'passed' },
      { check: 'tests', state: 'passed' },
    ])
    expect(await gate(worktree)(push(worktree))).toEqual({ allow: true })
  })

  it('refuses one with a red check, and hands back what it said', async () => {
    const worktree = worktreeWith([
      { check: 'format', state: 'passed' },
      { check: 'tests', state: 'failed', tail: '8 failed  packages/app/test/view.test.ts' },
    ])
    const answer = await gate(worktree)(push(worktree))
    expect(answer.allow).toBe(false)
    if (answer.allow) return
    expect(answer.reason).toContain('tests failed at this commit')
    expect(answer.reason).toContain('8 failed')
    expect(answer.reason).toContain('checks_run')
    expect(answer.reason).toContain('checks_override')
  })

  it('refuses one whose checks were never run — absent is not fine', async () => {
    const worktree = worktreeWith([{ check: 'format', state: 'passed' }])
    const answer = await gate(worktree)(push(worktree))
    expect(answer.allow).toBe(false)
    if (!answer.allow) expect(answer.reason).toContain('tests has not run at this commit')
  })

  it('says so and lets it through when the rule is to tell rather than hold', async () => {
    const worktree = worktreeWith([{ check: 'format', state: 'failed' }])
    const answer = await gate(worktree, { checks: { on_red: 'tell' } })(push(worktree))
    expect(answer).toMatchObject({ allow: true })
    if (answer.allow) expect(answer.note).toContain('format failed')
  })

  it('does not hold a commit unless the rule says to', async () => {
    const worktree = worktreeWith([{ check: 'tests', state: 'failed' }])
    const commit = { ...push(worktree), input: { command: 'git commit -m "wip"' } }
    expect(await gate(worktree)(commit)).toEqual({ allow: true })
    const answer = await gate(worktree, { checks: { before: 'commit and push' } })(commit)
    expect(answer.allow).toBe(false)
  })

  it('does nothing at all where the project turned the rule off', async () => {
    const worktree = worktreeWith([{ check: 'tests', state: 'failed' }])
    const off = { projects: { shop: { root: '/src/shop', checks: { before: 'off' } } } }
    expect(await gate(worktree, off)(push(worktree))).toEqual({ allow: true })
  })

  it('lets a push through when somebody overruled the rule, and says what they said', async () => {
    const worktree = worktreeWith([{ check: 'tests', state: 'failed' }])
    const written: TadeEvent[] = [
      {
        seq: 1,
        ts: '2026-09-19T08:30:00Z',
        type: 'tool_call',
        urgency: 'routine',
        task: 'shop/refunds',
        lane: null,
        run: null,
        detail: {
          tool: 'checks_override',
          caller: 'agent',
          input: { scope: 'next push', reason: 'the flaky PTY timeout from yesterday' },
        },
      },
    ]
    const answer = await gate(worktree, {}, written)(push(worktree))
    expect(answer).toMatchObject({ allow: true })
    if (answer.allow) expect(answer.note).toContain('flaky PTY timeout')
  })

  it('has no opinion about a project with nothing to check', async () => {
    const empty = tmp('tade-gate-')
    expect(await gate(empty)(push(empty))).toEqual({ allow: true })
  })

  // The gate reads what is recorded for the commit in hand, and an agent's
  // commit is made a second after the run that checked it.
  it('lets the push through after a commit of exactly what the run read', async () => {
    const repo = mkrepo()
    repo.commit('start', { [CI_WORKFLOW]: WORKFLOW, 'a.txt': 'a\n' })
    repo.write({ 'a.txt': 'a, edited\n' })
    const before = repo.head()
    const covered = await coverageOf(repo.root, before)
    for (const check of ['format', 'tests']) {
      await writeRun(recordsOf(repo.root), { ...green(check, before), covered })
    }
    repo.git('add', 'a.txt')
    repo.git('commit', '-q', '-m', 'the work')

    const ask = checksGate({
      config: config(),
      tadeHome: repo.root,
      events: async () => [],
      head: async () => repo.head(),
      now: () => Date.parse('2026-09-19T09:00:00Z'),
    })
    expect(await ask(push(repo.root))).toEqual({ allow: true })
  })

  it('refuses it when the commit holds work the run never read', async () => {
    const repo = mkrepo()
    repo.commit('start', { [CI_WORKFLOW]: WORKFLOW, 'a.txt': 'a\n', 'b.txt': 'b\n' })
    repo.write({ 'a.txt': 'a, edited\n' })
    const before = repo.head()
    const covered = await coverageOf(repo.root, before)
    for (const check of ['format', 'tests']) {
      await writeRun(recordsOf(repo.root), { ...green(check, before), covered })
    }
    // Somebody else's file goes in with mine.
    repo.write({ 'b.txt': 'theirs\n' })
    repo.git('add', 'a.txt', 'b.txt')
    repo.git('commit', '-q', '-m', 'mine and theirs')

    const ask = checksGate({
      config: config(),
      tadeHome: repo.root,
      events: async () => [],
      head: async () => repo.head(),
      now: () => Date.parse('2026-09-19T09:00:00Z'),
    })
    const answer = await ask(push(repo.root))
    expect(answer.allow).toBe(false)
    if (!answer.allow) expect(answer.reason).toContain('have not run at this commit')
  })
})

describe('how a project stands', () => {
  it('reads the plan, the runs and the rollup without running anything', async () => {
    const worktree = worktreeWith([{ check: 'format', state: 'passed' }])
    const stood = await checksAt({
      config: config(),
      project: 'shop',
      worktree,
      tadeHome: worktree,
      task: 'shop/refunds',
      commit: COMMIT,
    })
    expect(stood.plan.map((check) => check.id)).toEqual(['format', 'tests'])
    expect(stood.rollup).toMatchObject({ state: 'unknown', missing: ['tests'] })
    expect(stood.at.map((run) => run.check)).toEqual(['format'])
    expect(stood.rule.before).toBe('push')
  })
})
