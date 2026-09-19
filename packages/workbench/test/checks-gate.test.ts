import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { checksAt, checksGate, pushOrCommit } from '../src/checks.ts'

// The rule about pushing without a green run, and what it can honestly do.

const MANIFEST = [
  'checks:',
  '  - id: format',
  '    title: Formatting',
  '    run: pnpm exec biome ci .',
  '  - id: tests',
  '    title: Tests',
  '    run: pnpm exec vitest run',
  '    alone: true',
].join('\n')

const COMMIT = 'a1b2c3d4e5f6'

function worktreeWith(runs: { check: string; state: string; tail?: string }[] = []): string {
  const root = tmp('tade-gate-')
  mkdirSync(join(root, '.tade'), { recursive: true })
  writeFileSync(join(root, '.tade', 'checks.yaml'), MANIFEST)
  if (runs.length > 0) {
    writeFileSync(
      join(root, '.tade', 'checks.jsonl'),
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

const config = (over: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    approvals: { mode: 'policy' },
    projects: { shop: { root: '/src/shop' } },
    ...over,
  })

function gate(_worktree: string, over: Record<string, unknown> = {}, events: TadeEvent[] = []) {
  return checksGate({
    config: config(over),
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
})

describe('how a project stands', () => {
  it('reads the plan, the runs and the rollup without running anything', async () => {
    const worktree = worktreeWith([{ check: 'format', state: 'passed' }])
    const stood = await checksAt({
      config: config(),
      project: 'shop',
      worktree,
      commit: COMMIT,
    })
    expect(stood.plan.map((check) => check.id)).toEqual(['format', 'tests'])
    expect(stood.rollup).toMatchObject({ state: 'unknown', missing: ['tests'] })
    expect(stood.at.map((run) => run.check)).toEqual(['format'])
    expect(stood.rule.before).toBe('push')
  })
})
