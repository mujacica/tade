import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, taskDir } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import { EventLog } from '../src/events.ts'
import {
  branchSlug,
  createTask,
  nameTask,
  removeTask,
  setTitle,
  worktreesAgain,
} from '../src/tasks.ts'

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

  it("refuses a document that would not be in the task's documents folder", async () => {
    const { repo, worktreeRoot } = setup()
    // The document is kept in Tade's home, so a name that climbs out of its
    // folder is a write somewhere nobody asked for.
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
    ).rejects.toThrow(/climbs out of the task's documents folder/)
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

describe('worktreesAgain', () => {
  /**
   * A home as a restore leaves it, beside the project it was backed up from:
   * the task's file and the journal, and no worktree — its folder is not in a
   * backup. `clone` is the checkout cloned again from the remote.
   */
  async function restored(push: boolean) {
    const repo = mkrepo({ remote: true })
    const task = await createTask({
      home: repo.home,
      project: 'checkout',
      root: repo.root,
      slug: 'refunds',
      intent: INTENT,
      worktreeRoot: join(repo.home, 'worktrees'),
    })
    const head = repo.commit('the work', { 'refund.ts': 'once\n' }, task.worktree)
    if (push) runGit(task.worktree, 'push', '-q', 'origin', 'tade/refunds')
    const clone = join(tmp('tade-clone-'), 'repo')
    runGit(repo.root, 'clone', '-q', repo.remote!, clone)
    rmSync(join(repo.home, 'worktrees'), { recursive: true, force: true })
    const log = await EventLog.open({ path: join(repo.home, 'events.jsonl'), indexPath: null })
    const config = (root: string) => ConfigSchema.parse({ projects: { checkout: { root } } })
    return { repo, task, head, clone, log, config }
  }

  it('makes a restored task’s worktree again from its pushed branch, tracking it', async () => {
    const { repo, task, head, clone, log, config } = await restored(true)
    const made = await worktreesAgain({ home: repo.home, config: config(clone), log })
    expect(made).toEqual(['checkout/refunds'])
    expect(runGit(task.worktree, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(runGit(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('tade/refunds')
    expect(runGit(task.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe(
      'origin/tade/refunds',
    )
    // And once it is there, opening again leaves it be.
    expect(await worktreesAgain({ home: repo.home, config: config(clone), log })).toEqual([])
    expect(await log.read({ types: ['warning'] })).toEqual([])
    await log.close()
  })

  it('makes it from the branch the task was named, where it was', async () => {
    const { repo, task, clone, log, config } = await restored(false)
    runGit(repo.root, 'worktree', 'prune')
    runGit(repo.root, 'branch', '-m', 'tade/refunds', 'tade/refund-retries')
    runGit(repo.root, 'push', '-q', 'origin', 'tade/refund-retries')
    runGit(clone, 'fetch', '-q', 'origin')
    await log.append({
      type: 'task_named',
      task: task.id,
      detail: { branch: 'tade/refund-retries', title: 'Refund retries' },
    })
    const made = await worktreesAgain({ home: repo.home, config: config(clone), log })
    expect(made).toEqual(['checkout/refunds'])
    expect(runGit(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'tade/refund-retries',
    )
    await log.close()
  })

  it('makes nothing of a branch that was never pushed, or one still in the checkout', async () => {
    const { repo, task, clone, log, config } = await restored(false)
    expect(await worktreesAgain({ home: repo.home, config: config(clone), log })).toEqual([])
    // Here, the worktree was taken away by hand and its branch kept: meant.
    runGit(repo.root, 'worktree', 'prune')
    runGit(repo.root, 'push', '-q', 'origin', 'tade/refunds')
    runGit(repo.root, 'fetch', '-q', 'origin')
    expect(await worktreesAgain({ home: repo.home, config: config(repo.root), log })).toEqual([])
    expect(existsSync(task.worktree)).toBe(false)
    expect(await log.read({ types: ['warning'] })).toEqual([])
    await log.close()
  })

  it('makes nothing from a branch that is not Tade’s, whatever a restored journal says', async () => {
    const { repo, task, clone, log, config } = await restored(true)
    runGit(repo.root, 'push', '-q', 'origin', 'main:feature')
    runGit(clone, 'fetch', '-q', 'origin')
    await log.append({ type: 'task_named', task: task.id, detail: { branch: 'feature' } })
    expect(await worktreesAgain({ home: repo.home, config: config(clone), log })).toEqual([])
    expect(existsSync(task.worktree)).toBe(false)
    await log.close()
  })

  it('says why, where the branch is on more than one remote', async () => {
    const { repo, task, clone, log, config } = await restored(true)
    runGit(clone, 'remote', 'add', 'fork', repo.remote!)
    runGit(clone, 'fetch', '-q', 'fork')
    expect(await worktreesAgain({ home: repo.home, config: config(clone), log })).toEqual([])
    expect(existsSync(task.worktree)).toBe(false)
    const [warning] = await log.read({ types: ['warning'] })
    expect(warning?.task).toBe('checkout/refunds')
    expect(String(warning?.detail.message)).toContain('more than one remote')
    await log.close()
  })
})
