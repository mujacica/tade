import { ExtensionHost } from '@tade/extensions-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { githubReplay, type ReplayOptions } from '../../../../test/fixtures/forge/github.ts'
import { runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { checkoutPlan } from '../src/checkout.ts'
import { reviewExtension } from '../src/extension.ts'
import { forget } from '../src/forge.ts'
import { NOW, project, reallyExec, worktree } from './repo.ts'

// Checking out a review, against a real git.
//
// **The repositories are real and so is the fetch** — the one thing this is
// about is which branch a checkout ends up on, and a scripted git would only
// ever answer what this file already believes. `origin` is read as
// `git@github.com:acme/api.git`, which is what makes the GitHub forge serve it,
// and rewritten by git's own `insteadOf` to the bare repository next door, so
// the fetch is a real fetch and nothing reaches the network. What the review
// *is* comes from the replay: PR #412, opened from `shop/refunds-retry`.
//
// What every test here is really asserting is one thing: the branch is the
// review's own. A local `pr-412` is the failure, and it is the thing that
// actually happened — which is why `branch --list 'pr-*'` is asked about at all.

const env = { GITHUB_TOKEN: 'ghp_pretend', PATH: '/usr/bin' }

/** The branch PR #412 was opened from, as the replay's own fixture has it. */
const BRANCH = 'shop/refunds-retry'

function load(options: ReplayOptions & { root: string }) {
  const replay = githubReplay(options)
  return ExtensionHost.load({
    builtin: [reviewExtension],
    config: { extensions: { review: {} }, projects: { api: { root: options.root } } },
    home: tmp('tade-checkout-home-'),
    env,
    fetch: replay.fetch,
    exec: async (command: string, args: readonly string[]) =>
      command === 'gh' ? replay.exec(command, args) : reallyExec(command, args),
    now: () => NOW,
  })
}

/**
 * A project whose remote really has the review's branch on it, and which has
 * never fetched it — which is every "check out that PR" there has ever been.
 */
function withTheBranch(options: { fork?: boolean } = {}) {
  const { repo } = project()
  const bare = repo.remote ?? ''
  repo.git('config', `url.${bare}.insteadOf`, 'git@github.com:acme/api.git')
  repo.git('checkout', '-q', '-b', BRANCH)
  const head = repo.commit('a teapot service')
  repo.git('push', '-q', 'origin', BRANCH)
  repo.git('checkout', '-q', 'main')
  repo.git('branch', '-D', BRANCH)
  // Nothing here has ever heard of the branch: the remote-tracking ref the push
  // left behind goes, so landing on the right commit is evidence of a fetch.
  repo.git('update-ref', '-d', `refs/remotes/origin/${BRANCH}`)
  if (options.fork) {
    // A review opened from somebody else's repository: `origin` has the head
    // under the ref GitHub publishes for it, and no branch of that name at all.
    runGit(bare, 'update-ref', 'refs/pull/412/head', head)
    runGit(bare, 'update-ref', '-d', `refs/heads/${BRANCH}`)
  }
  return { repo, head, bare }
}

const on = (root: string) => runGit(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
const at = (root: string) => runGit(root, 'rev-parse', 'HEAD').trim()
const tracks = (root: string, branch: string) =>
  runGit(root, 'for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`).trim()
const invented = (root: string) => runGit(root, 'branch', '--list', 'pr-*').trim()

const checkout = (host: ExtensionHost, input: Record<string, unknown> = {}) =>
  host.call(
    'review_checkout',
    { review: 'acme/api#412', ...input },
    {
      caller: { kind: 'orchestrator' },
    },
  )

beforeEach(() => forget())

describe('checking out a review', () => {
  it('lands on the branch the review was opened from, tracking it', async () => {
    const { repo, head } = withTheBranch()
    const answer = await checkout(await load({ root: repo.root }))
    expect(on(repo.root)).toBe(BRANCH)
    expect(at(repo.root)).toBe(head)
    expect(tracks(repo.root, BRANCH)).toBe(`origin/${BRANCH}`)
    // The whole bug, as a line: a branch named after the number is on nobody
    // else's machine and nothing can push it back to the review.
    expect(invented(repo.root)).toBe('')
    expect(answer.text).toContain(BRANCH)
    expect(answer.text).toContain(`tracking \`origin/${BRANCH}\``)
    expect(answer.said).toContain(BRANCH)
    // The replay's head sha is not this repository's, which is a review that
    // has moved since it was polled — said, because it decides what was fetched.
    expect(answer.text).toContain('has moved since this was read')
  })

  it('switches to the branch it already has and fast-forwards it', async () => {
    const { repo, head } = withTheBranch()
    const older = runGit(repo.root, 'rev-parse', `${head}^`).trim()
    runGit(repo.root, 'branch', BRANCH, older)
    const answer = await checkout(await load({ root: repo.root }))
    expect(on(repo.root)).toBe(BRANCH)
    expect(at(repo.root)).toBe(head)
    expect(tracks(repo.root, BRANCH)).toBe(`origin/${BRANCH}`)
    expect(answer.text).not.toContain('diverged')
  })

  it('reports a branch that has diverged rather than throwing anybody’s work away', async () => {
    const { repo, head } = withTheBranch()
    const older = runGit(repo.root, 'rev-parse', `${head}^`).trim()
    repo.git('checkout', '-q', '-b', BRANCH, older)
    const mine = repo.commit('my own go at it')
    repo.git('checkout', '-q', 'main')
    const answer = await checkout(await load({ root: repo.root }))
    expect(on(repo.root)).toBe(BRANCH)
    // Still where it was: nothing reset, nothing merged, both counts said.
    expect(at(repo.root)).toBe(mine)
    expect(answer.text).toContain('It had diverged: 1 commit here')
    expect(answer.text).toContain('1 on the review')
  })

  it('says a branch that is ahead of the review, which fast-forwards without a word otherwise', async () => {
    const { repo, head } = withTheBranch()
    repo.git('checkout', '-q', '-b', BRANCH, head)
    const mine = repo.commit('not pushed yet')
    repo.git('checkout', '-q', 'main')
    const answer = await checkout(await load({ root: repo.root }))
    expect(at(repo.root)).toBe(mine)
    // Said, not called a divergence: a commit nobody has pushed yet is about to
    // become part of the review, and the ff that let it through says nothing.
    expect(answer.text).toContain('1 commit on it that the review does not')
    expect(answer.text).not.toContain('diverged')
  })

  it('says who else is working in the checkout it just moved', async () => {
    const { repo } = withTheBranch()
    const host = await load({ root: repo.root })
    const answer = await host.call(
      'review_checkout',
      { review: 'acme/api#412' },
      {
        caller: { kind: 'orchestrator' },
        tade: {
          pid: 1,
          lanes: () => [],
          agents: () => [
            {
              task: 'api/refunds-retry',
              project: 'api',
              startedAt: 0,
              turn: 'idle',
              did: [],
              ends: [],
            },
          ],
          startAgent: async () => ({ task: 'api/none', worktree: repo.root }),
        },
      },
    )
    expect(answer.text).toContain('1 agent is working in this checkout')
    expect(answer.text).toContain('api/refunds-retry')
  })

  it('refuses while there is uncommitted work, and moves nothing', async () => {
    const { repo } = withTheBranch()
    repo.write({ 'half-written.txt': 'not mine to move' })
    const host = await load({ root: repo.root })
    await expect(checkout(host)).rejects.toThrow(/uncommitted work/)
    expect(on(repo.root)).toBe('main')
  })

  it('fetches a fork’s head from the ref the forge publishes, and says it tracks nothing', async () => {
    const { repo, head } = withTheBranch({ fork: true })
    const answer = await checkout(await load({ root: repo.root }))
    // Still the review's own branch name — the fork changes where the commits
    // come from, never what the branch is called.
    expect(on(repo.root)).toBe(BRANCH)
    expect(at(repo.root)).toBe(head)
    expect(tracks(repo.root, BRANCH)).toBe('')
    expect(invented(repo.root)).toBe('')
    expect(answer.text).toContain('refs/pull/412/head')
    expect(answer.text).toContain('tracking nothing')
  })

  it('refuses in a task’s own worktree, because its branch is how Tade finds the task', async () => {
    const { repo } = withTheBranch()
    const task = worktree(repo, 'refunds-retry', { pushed: false })
    const host = await load({ root: repo.root })
    await expect(
      host.call(
        'review_checkout',
        { review: 'acme/api#412' },
        { caller: { kind: 'agent', task: 'api/refunds-retry', project: 'api', cwd: task.path } },
      ),
    ).rejects.toThrow(/own worktree/)
    expect(on(task.path)).toBe('tade/refunds-retry')
    expect(on(repo.root)).toBe('main')
  })
})

describe('what a checkout of a review is, before anything runs', () => {
  const review = { number: 151, branch: 'feat/teapot-service' }

  it('is the review’s own branch, tracking the remote, where the remote has it', () => {
    const plan = checkoutPlan(review, { hasBranch: true, headRef: 'refs/pull/151/head' })
    expect(plan).toEqual({
      branch: 'feat/teapot-service',
      fetch: {
        refspec: 'refs/heads/feat/teapot-service:refs/remotes/origin/feat/teapot-service',
        at: 'origin/feat/teapot-service',
      },
      tracks: 'origin/feat/teapot-service',
      why: null,
    })
  })

  it('is the same branch for a fork, from the published ref, tracking nothing with the reason', () => {
    const plan = checkoutPlan(review, { hasBranch: false, headRef: 'refs/pull/151/head' })
    expect(plan).toMatchObject({
      branch: 'feat/teapot-service',
      fetch: { refspec: 'refs/pull/151/head', at: 'FETCH_HEAD' },
      tracks: null,
    })
    expect('why' in plan ? plan.why : '').toContain('fork')
  })

  it('says there is nothing to check out rather than making a name up', () => {
    const plan = checkoutPlan(review, { hasBranch: false, headRef: null })
    expect(plan).toEqual({
      problem: expect.stringContaining('origin has no feat/teapot-service'),
    })
    // Never the number, in any of the three answers: that is the bug.
    for (const said of Object.values(plan)) expect(JSON.stringify(said)).not.toContain('pr-151')
  })
})
