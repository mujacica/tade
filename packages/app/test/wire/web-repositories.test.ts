import type { GitSnapshot, Task, Workspace } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { repositoriesFrom } from '../../src/wire/web-repositories.ts'

// This machine's half of another machine's mirror of its work
// (`wire/web-repositories.ts`): out of status's last look, each open project's
// root, what names its repository — never the URL, which may hold a
// credential — its base, and each task's own branch.

const HEAD = 'b'.repeat(40)

function git(over: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    branch: 'tade/fix',
    head: HEAD,
    headSubject: 'fix',
    headTime: 0,
    dirty: [],
    xy: {},
    ahead: 2,
    behind: 0,
    baseRef: 'main',
    mergedIntoBase: false,
    upstreamGone: false,
    pr: null,
    ...over,
  }
}

function task(id: string, over: Partial<Task>): Task {
  return {
    id,
    workspace: 'worktree',
    state: 'working',
    git: git(),
    agents: [],
    lanes: [],
    ...over,
  } as Task
}

describe('where this machine’s work is, for another machine', () => {
  it('answers each project’s root, its repository by name, its base and its tasks’ own branches', async () => {
    const repo = mkrepo()
    repo.git('remote', 'add', 'origin', 'https://someone:secret@github.com/Acme/App.git')
    const world = {
      projects: [
        {
          name: 'app',
          root: repo.root,
          tasks: [
            task('app/fix', {}),
            task('app/done', { state: 'review', git: git({ branch: 'tade/done', ahead: 0 }) }),
            task('app/landed', { git: git({ branch: 'tade/landed', mergedIntoBase: true }) }),
            task('app/shared', { workspace: 'checkout', git: git({ branch: 'main' }) }),
            task('app/none', { git: null }),
          ],
        },
      ],
    } as unknown as Workspace
    const answer = await repositoriesFrom(() => world)()
    expect(answer).toEqual([
      {
        project: 'app',
        root: repo.root,
        repository: 'github.com/acme/app',
        base: 'main',
        branches: [
          { task: 'app/fix', branch: 'tade/fix', base: 'main', head: HEAD, live: true },
          { task: 'app/done', branch: 'tade/done', base: 'main', head: HEAD, live: false },
        ],
      },
    ])
    expect(JSON.stringify(answer)).not.toContain('secret')
  })

  it('answers nothing before status has looked, rather than a world with nothing in it', async () => {
    expect(await repositoriesFrom(() => null)()).toEqual([])
  })
})
