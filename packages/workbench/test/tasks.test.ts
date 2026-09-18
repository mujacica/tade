import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import { branchSlug, createTask, nameTask, removeTask, setTitle } from '../src/tasks.ts'

const INTENT =
  "the refund flow double-charges when the webhook retries, I think it's not idempotent"

function setup() {
  const repo = mkrepo()
  return { repo, worktreeRoot: tmp('tade-worktrees-') }
}

describe('createTask', () => {
  it('creates a branch and worktree, and stores the intent verbatim', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await createTask({
      project: 'checkout',
      root: repo.root,
      slug: 'refunds',
      intent: INTENT,
      worktreeRoot,
      now: new Date('2026-09-12T09:14:22Z'),
    })

    expect(task).toMatchObject({
      id: 'checkout/refunds',
      branch: 'tade/refunds',
      baseRef: 'main',
    })
    expect(existsSync(task.worktree)).toBe(true)
    expect(runGit(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('tade/refunds')

    const file = parse(readFileSync(join(task.worktree, '.tade', 'task.yaml'), 'utf8'))
    expect(file).toMatchObject({
      id: 'checkout/refunds',
      project: 'checkout',
      intent_spoken: INTENT,
      created: '2026-09-12T09:14:22.000Z',
      parked: false,
    })
    // The base commit is recorded so a later fast-forward merge is detectable.
    expect(file.base).toBe(repo.head())
  })

  it('refuses a name that would not make a valid task id', async () => {
    const { repo, worktreeRoot } = setup()
    for (const slug of ['Refunds', 'has space', '-leading', '']) {
      await expect(
        createTask({ project: 'checkout', root: repo.root, slug, intent: 'x', worktreeRoot }),
      ).rejects.toThrow(/invalid task/)
    }
  })

  it('refuses to reuse an existing branch', async () => {
    const { repo, worktreeRoot } = setup()
    const options = {
      project: 'checkout',
      root: repo.root,
      slug: 'refunds',
      intent: 'x',
      worktreeRoot,
    }
    await createTask(options)
    await expect(createTask(options)).rejects.toThrow(/branch already exists/)
  })

  it('reports a repository with no base branch instead of guessing', async () => {
    const base = tmp('tade-empty-')
    runGit(base, 'init', '-q', '-b', 'trunk', '.')
    await expect(
      createTask({
        project: 'p',
        root: base,
        slug: 't',
        intent: 'x',
        worktreeRoot: tmp('tade-wt-'),
      }),
    ).rejects.toThrow(/no base branch/)
  })
})

describe('removeTask', () => {
  const create = (repo: ReturnType<typeof mkrepo>, worktreeRoot: string) =>
    createTask({
      project: 'checkout',
      root: repo.root,
      slug: 'refunds',
      intent: INTENT,
      worktreeRoot,
    })

  it('removes a clean, merged task and deletes its branch', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    repo.commit('fix refunds', { 'refunds.ts': 'ok' }, task.worktree)
    repo.git('merge', '-q', '--ff-only', task.branch)

    const result = await removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
    })
    expect(result).toEqual({ removed: true, branchDeleted: true })
    expect(existsSync(task.worktree)).toBe(false)
  })

  it('refuses to throw away uncommitted work', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    writeFileSync(join(task.worktree, 'wip.ts'), 'half a thought')

    const result = await removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
    })
    expect(result).toEqual({ removed: false, reason: expect.stringContaining('uncommitted') })
    expect(existsSync(task.worktree)).toBe(true)
  })

  it('refuses to throw away unmerged commits', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    repo.commit('work nobody has merged', { 'a.ts': '1' }, task.worktree)

    const result = await removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
    })
    expect(result).toEqual({ removed: false, reason: expect.stringContaining('not merged') })
    expect(existsSync(task.worktree)).toBe(true)
  })

  it('removes an empty task that never did anything', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    const result = await removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
    })
    expect(result.removed).toBe(true)
  })

  it('force removes dirty and unmerged work when told to', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    repo.commit('unmerged', { 'a.ts': '1' }, task.worktree)
    writeFileSync(join(task.worktree, 'wip.ts'), 'also dirty')

    const result = await removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
      force: true,
    })
    expect(result).toEqual({ removed: true, branchDeleted: true })
    expect(existsSync(task.worktree)).toBe(false)
  })

  it('the .tade directory itself never counts as uncommitted work', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    // task.yaml is written but never committed; that must not block teardown.
    expect(existsSync(join(task.worktree, '.tade', 'task.yaml'))).toBe(true)
    expect(
      (await removeTask({ root: repo.root, worktree: task.worktree, branch: task.branch })).removed,
    ).toBe(true)
  })
})

describe('an agent that starts without a branch', () => {
  async function detached() {
    const { repo, worktreeRoot } = setup()
    const task = await createTask({
      project: 'checkout',
      root: repo.root,
      slug: 'agent-1',
      intent: '',
      worktreeRoot,
      detached: true,
    })
    return { repo, task }
  }

  it('gets a worktree and no branch, so looking around leaves nothing behind', async () => {
    const { repo, task } = await detached()
    expect(task).toMatchObject({ id: 'checkout/agent-1', branch: '' })
    expect(runGit(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD')
    expect(runGit(repo.root, 'branch', '--list', 'tade/*').trim()).toBe('')
  })

  it('is named for its work when it has some, keeping what it changed', async () => {
    const { repo, task } = await detached()
    writeFileSync(join(task.worktree, 'refund.ts'), 'export const once = true\n')
    await setTitle(task.worktree, 'Fix the double charge on refund retries!', false)
    const branch = await nameTask({
      root: repo.root,
      worktree: task.worktree,
      title: 'Fix the double charge on refund retries!',
    })
    expect(branch).toBe('tade/fix-the-double-charge-on-refund-retries')
    expect(runGit(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch)
    expect(existsSync(join(task.worktree, 'refund.ts'))).toBe(true)
    // Its id does not change with its branch: lanes and the session are keyed by it.
    const file = parse(readFileSync(join(task.worktree, '.tade', 'task.yaml'), 'utf8'))
    expect(file).toMatchObject({
      id: 'checkout/agent-1',
      title: 'Fix the double charge on refund retries!',
    })
    // Asked again, it is already named.
    expect(await nameTask({ root: repo.root, worktree: task.worktree, title: 'other' })).toBe(
      branch,
    )
  })

  it('never takes a branch somebody already has', async () => {
    const { repo, task } = await detached()
    runGit(repo.root, 'branch', 'tade/tidy-up')
    expect(await nameTask({ root: repo.root, worktree: task.worktree, title: 'tidy up' })).toBe(
      'tade/tidy-up-2',
    )
  })

  it('takes a better name when one comes, and keeps a name you gave it', async () => {
    const { task } = await detached()
    const read = () => parse(readFileSync(join(task.worktree, '.tade', 'task.yaml'), 'utf8')).title
    await setTitle(task.worktree, 'look at the logs', false)
    await setTitle(task.worktree, 'Investigate failing log rotation', false)
    expect(read()).toBe('Investigate failing log rotation')
    await setTitle(task.worktree, 'Refund retries', true)
    await setTitle(task.worktree, 'something it guessed', false)
    expect(read()).toBe('Refund retries')
  })

  it('removes cleanly when it never did anything', async () => {
    const { repo, task } = await detached()
    const result = await removeTask({ root: repo.root, worktree: task.worktree, branch: '' })
    expect(result).toEqual({ removed: true, branchDeleted: false })
    expect(existsSync(task.worktree)).toBe(false)
  })

  it('makes short branch names from long titles', () => {
    expect(branchSlug('Fix: the double-charge when Stripe retries the webhook')).toBe(
      'fix-the-double-charge-when-stripe',
    )
    expect(branchSlug('!!!')).toBe('work')
  })
})
