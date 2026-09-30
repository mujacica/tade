import type { CheckRun } from '@tade/checks-core'
import { makeScriptedForge } from '@tade/forge-scripted'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { onRemote, standingEverywhere, standingOn, whatRan } from '../src/commit.ts'
import { FRESH, project, RED, ran, reallyExec, worktree } from './repo.ts'

// What CI can say about a commit sitting in a checkout here, and every honest
// reason it cannot.
//
// `commit.ts` is the one place that asks a forge about a commit, and the whole
// of why it exists is that **a commit that is not on the remote is not a
// failure**: it is CI that has not run yet. So git is asked first, here as
// there, against real repositories — the watch built on this is
// `branch.test.ts`, and the fixtures both use are `repo.ts`.

describe('whether a commit is red yet', () => {
  /** What the scripted forge says about a commit, put through the rule. */
  const asked = async (commit: string, runs: Record<string, CheckRun[]>) =>
    whatRan(await makeScriptedForge({ commits: runs }).checksOn('acme/api', commit))

  it('says nothing has run while CI has not reached the push, rather than saying it is fine', async () => {
    // Every push looks like this for a minute. "No failures" and "nothing has
    // run" are the same empty list to anybody reading a boolean, which is why
    // each answer here is its own word.
    expect(await asked(FRESH, {})).toEqual({ kind: 'nothing ran' })
  })

  it('waits while anything is still going, so a retry is never raced', async () => {
    expect(
      await asked(RED, {
        [`acme/api@${RED}`]: [
          ran(RED, 'tests', 'failed'),
          // The one that decides: a workflow still running may yet turn this
          // commit green, and an agent started now is an agent started on a
          // failure that was about to be re-run.
          ran(RED, 'types', 'running'),
        ],
      }),
    ).toEqual({ kind: 'running' })
  })

  it('says which checks failed once everything has settled', async () => {
    const red = await asked(RED, {
      [`acme/api@${RED}`]: [
        ran(RED, 'format', 'passed'),
        ran(RED, 'types', 'skipped'),
        ran(RED, 'tests', 'failed'),
      ],
    })
    expect(red.kind).toBe('red')
    expect(red.kind === 'red' && red.runs.map((one) => one.check)).toEqual(['tests'])
  })

  it('reads a green commit as passed, which is not the same answer as nothing to look at', async () => {
    expect(await asked(RED, { [`acme/api@${RED}`]: [ran(RED, 'tests', 'passed')] })).toEqual({
      kind: 'passed',
    })
  })
})

describe('whether a commit is on the remote', () => {
  const ctx = { exec: reallyExec, extension: 'review' } as unknown as Parameters<typeof onRemote>[0]
  const standing = (repo: { git(...args: string[]): string }, branch = 'main') => ({
    branch,
    commit: repo.git('rev-parse', 'HEAD').trim(),
    subject: 'retry refunds once',
  })

  it('is yes for a commit that was really pushed', async () => {
    const { repo } = project()
    expect(await onRemote(ctx, repo.root, standing(repo))).toEqual({
      on: true,
      branchThere: true,
      problem: null,
    })
  })

  it('is no for a commit that is only here, and says the branch is on origin', async () => {
    // The whole bug: `main` three commits ahead of `origin/main` is not a
    // failure, and nothing on the other end has ever heard of this sha.
    const { repo } = project()
    repo.commit('not pushed yet')
    expect(await onRemote(ctx, repo.root, standing(repo))).toEqual({
      on: false,
      branchThere: true,
      problem: null,
    })
  })

  it('tells a branch that is not on origin at all from one that is merely ahead', async () => {
    const { repo } = project({ branch: 'shop/refunds-retry', pushed: false })
    expect(await onRemote(ctx, repo.root, standing(repo, 'shop/refunds-retry'))).toEqual({
      on: false,
      branchThere: false,
      problem: null,
    })
  })

  it('keeps git’s own refusal rather than reading it as not pushed', async () => {
    // A probe that could not look is not a probe that found nothing: a sha no
    // repository here has is a question git answers with an error, and calling
    // that "not pushed yet" would be the same lie one scale down.
    const { repo } = project()
    const asked = await onRemote(ctx, repo.root, { ...standing(repo), commit: 'f'.repeat(40) })
    expect(asked.on).toBe(false)
    expect(asked.problem).toMatch(/bad object|unknown revision|not a valid/i)
  })
})

describe('the branch a project is on', () => {
  // Real repositories, because this is the one thing the watch asks git, and a
  // scripted git could only ever say back what this file already believes.
  const ctx = { exec: reallyExec, extension: 'review' } as unknown as Parameters<
    typeof standingOn
  >[0]

  it('is read off a real checkout, with the commit and its subject', async () => {
    const { repo, commit } = project({ subject: 'retry refunds once' })
    expect(await standingOn(ctx, repo.root)).toEqual({
      branch: 'main',
      commit,
      subject: 'retry refunds once',
    })
  })

  it('is nobody’s branch in a really detached checkout, and nothing is watched there', async () => {
    // What git actually answers here is `HEAD`, which is the assumption the
    // watch rests on and the one a fake would have granted for free.
    const { repo } = project()
    repo.git('checkout', '-q', '--detach')
    expect(await standingOn(ctx, repo.root)).toBeNull()
  })

  it('is nothing at all where git knows of no repository', async () => {
    expect(await standingOn(ctx, tmp('tade-not-a-repo-'))).toBeNull()
  })

  it('reads a branch whose name has slashes in it as its whole name', async () => {
    const { repo } = project({ branch: 'shop/refunds-retry' })
    expect((await standingOn(ctx, repo.root))?.branch).toBe('shop/refunds-retry')
  })

  it('reads every branch the repository has checked out, the project’s own first', async () => {
    const { repo } = project()
    const main = repo.git('rev-parse', 'HEAD').trim()
    const own = worktree(repo, 'refunds-retry')
    const ctx = { exec: reallyExec, extension: 'review' } as unknown as Parameters<
      typeof standingEverywhere
    >[0]
    const everywhere = await standingEverywhere(ctx, repo.root)
    expect(everywhere).toEqual([
      { branch: 'main', commit: main, subject: 'retry refunds once' },
      { branch: own.branch, commit: own.commit, subject: 'retry refunds twice' },
    ])
  })
})
