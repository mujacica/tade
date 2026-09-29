import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskDir } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import { branchSlug, createTask, nameTask, removeTask, setTitle } from '../src/tasks.ts'

const INTENT =
  "the refund flow double-charges when the webhook retries, I think it's not idempotent"

function setup() {
  const repo = mkrepo()
  return { repo, home: repo.home, worktreeRoot: tmp('tade-worktrees-') }
}

/** A task's own file, wherever the task works: always in Tade's home. */
const fileOf = (home: string, id: string) =>
  parse(readFileSync(join(taskDir(home, id), 'task.yaml'), 'utf8'))

describe('createTask', () => {
  it('creates a branch and worktree, and stores the intent verbatim', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await createTask({
      home: repo.home,
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

    // Nothing of Tade's is in the worktree at all: the file is in its home.
    expect(existsSync(join(task.worktree, '.tade'))).toBe(false)
    const file = fileOf(repo.home, task.id)
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

  it('keeps the document a task produces, so its agent and the journal both have it', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await createTask({
      home: repo.home,
      project: 'checkout',
      root: repo.root,
      slug: 'scope-audit',
      intent: 'work out where the token gets taken twice',
      worktreeRoot,
      produces: 'notes/scope-audit.md',
    })
    expect(fileOf(repo.home, task.id).produces).toBe('notes/scope-audit.md')
  })

  it('refuses a document that would not be in the repository at all', async () => {
    const { repo, worktreeRoot } = setup()
    // The whole reason a task names one is that somebody reads it later, which
    // means it has to be a file the agent commits like any other change.
    await expect(
      createTask({
        home: repo.home,
        project: 'checkout',
        root: repo.root,
        slug: 'scope-audit',
        intent: 'work out where the token gets taken twice',
        worktreeRoot,
        produces: '../audit.md',
      }),
    ).rejects.toThrow(/climbs out of the repository/)
    expect(existsSync(join(worktreeRoot, 'checkout-scope-audit'))).toBe(false)
  })

  it('refuses a name that would not make a valid task id', async () => {
    const { repo, worktreeRoot } = setup()
    for (const slug of ['Refunds', 'has space', '-leading', '']) {
      await expect(
        createTask({
          home: repo.home,
          project: 'checkout',
          root: repo.root,
          slug,
          intent: 'x',
          worktreeRoot,
        }),
      ).rejects.toThrow(/invalid task/)
    }
  })

  it('refuses to reuse an existing branch', async () => {
    const { repo, worktreeRoot } = setup()
    const options = {
      home: repo.home,
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
        home: tmp('tade-home-'),
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
      home: repo.home,
      project: 'checkout',
      root: repo.root,
      slug: 'refunds',
      intent: INTENT,
      worktreeRoot,
    })

  const remove = (
    repo: ReturnType<typeof mkrepo>,
    task: { id: string; worktree: string; branch: string },
    force?: boolean,
  ) =>
    removeTask({
      home: repo.home,
      root: repo.root,
      task: task.id,
      worktree: task.worktree,
      branch: task.branch,
      ...(force ? { force: true } : {}),
    })

  it('removes a clean, merged task and deletes its branch', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    repo.commit('fix refunds', { 'refunds.ts': 'ok' }, task.worktree)
    repo.git('merge', '-q', '--ff-only', task.branch)

    const result = await remove(repo, task)
    expect(result).toEqual({ removed: true, branchDeleted: true })
    expect(existsSync(task.worktree)).toBe(false)
    // The task's folder goes with it: nothing of it is left anywhere.
    expect(existsSync(taskDir(repo.home, task.id))).toBe(false)
  })

  it('refuses to throw away uncommitted work', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    writeFileSync(join(task.worktree, 'wip.ts'), 'half a thought')

    const result = await remove(repo, task)
    expect(result).toEqual({ removed: false, reason: expect.stringContaining('uncommitted') })
    expect(existsSync(task.worktree)).toBe(true)
  })

  it('refuses to throw away unmerged commits', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    repo.commit('work nobody has merged', { 'a.ts': '1' }, task.worktree)

    const result = await remove(repo, task)
    expect(result).toEqual({ removed: false, reason: expect.stringContaining('not merged') })
    expect(existsSync(task.worktree)).toBe(true)
  })

  it('removes an empty task that never did anything', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    const result = await remove(repo, task)
    expect(result.removed).toBe(true)
  })

  it('force removes dirty and unmerged work when told to', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    repo.commit('unmerged', { 'a.ts': '1' }, task.worktree)
    writeFileSync(join(task.worktree, 'wip.ts'), 'also dirty')

    const result = await remove(repo, task, true)
    expect(result).toEqual({ removed: true, branchDeleted: true })
    expect(existsSync(task.worktree)).toBe(false)
  })

  it('leaves a worktree Tade wrote nothing in, so nothing blocks teardown', async () => {
    const { repo, worktreeRoot } = setup()
    const task = await create(repo, worktreeRoot)
    // The task file is in Tade's home, so `git status` in the worktree is
    // empty and there is nothing to make an exception for.
    expect(existsSync(join(taskDir(repo.home, task.id), 'task.yaml'))).toBe(true)
    expect(runGit(task.worktree, 'status', '--porcelain').trim()).toBe('')
    expect((await remove(repo, task)).removed).toBe(true)
  })
})

describe('an agent that starts without a branch', () => {
  async function detached() {
    const { repo, worktreeRoot } = setup()
    const task = await createTask({
      home: repo.home,
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
    await setTitle(repo.home, task.id, 'Fix the double charge on refund retries!', false)
    const branch = await nameTask({
      home: repo.home,
      task: task.id,
      root: repo.root,
      worktree: task.worktree,
      title: 'Fix the double charge on refund retries!',
    })
    expect(branch).toBe('tade/fix-the-double-charge-on-refund-retries')
    expect(runGit(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch)
    expect(existsSync(join(task.worktree, 'refund.ts'))).toBe(true)
    // Its id does not change with its branch: lanes and the session are keyed by it.
    const file = fileOf(repo.home, task.id)
    expect(file).toMatchObject({
      id: 'checkout/agent-1',
      title: 'Fix the double charge on refund retries!',
    })
    // Asked again, it is already named.
    expect(
      await nameTask({
        home: repo.home,
        task: task.id,
        root: repo.root,
        worktree: task.worktree,
        title: 'other',
      }),
    ).toBe(branch)
  })

  it('never takes a branch somebody already has', async () => {
    const { repo, task } = await detached()
    runGit(repo.root, 'branch', 'tade/tidy-up')
    expect(
      await nameTask({
        home: repo.home,
        task: task.id,
        root: repo.root,
        worktree: task.worktree,
        title: 'tidy up',
      }),
    ).toBe('tade/tidy-up-2')
  })

  it('takes a better name when one comes, and keeps a name you gave it', async () => {
    const { repo, task } = await detached()
    const read = () => fileOf(repo.home, task.id).title
    await setTitle(repo.home, task.id, 'look at the logs', false)
    await setTitle(repo.home, task.id, 'Investigate failing log rotation', false)
    expect(read()).toBe('Investigate failing log rotation')
    await setTitle(repo.home, task.id, 'Refund retries', true)
    await setTitle(repo.home, task.id, 'something it guessed', false)
    expect(read()).toBe('Refund retries')
  })

  it('removes cleanly when it never did anything', async () => {
    const { repo, task } = await detached()
    const result = await removeTask({
      home: repo.home,
      root: repo.root,
      task: task.id,
      worktree: task.worktree,
      branch: '',
    })
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
