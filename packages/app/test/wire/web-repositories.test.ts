import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type GitSnapshot, mirrorDir, type Task, type Workspace } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { repositoriesFrom } from '../../src/wire/web-repositories.ts'

// This machine's half of another machine's mirror of its work
// (`wire/web-repositories.ts`): out of status's last look, each open project's
// root, what names its repository — never the URL, which may hold a
// credential — its base, each task's own branch, and its own mirror of the
// project, made ready for another machine to push its branches into.

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
    const answer = await repositoriesFrom(() => world, repo.home)()
    const mirror = mirrorDir(repo.home, 'app')
    expect(answer).toEqual([
      {
        mirror,
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
    // Made ready, bare, in this home: never inside the checkout.
    expect(existsSync(join(mirror, 'HEAD'))).toBe(true)
    expect(mirror.startsWith(repo.home)).toBe(true)
  })

  it('says why a mirror could not be made ready, once for each reason, and answers it once it can be', async () => {
    const repo = mkrepo()
    const root = join(repo.home, 'not-yet-a-checkout')
    mkdirSync(root)
    const world = { projects: [{ name: 'app', root, tasks: [] }] } as unknown as Workspace
    const said: string[] = []
    const repositories = repositoriesFrom(
      () => world,
      repo.home,
      (message) => said.push(message),
    )
    const first = await repositories()
    const again = await repositories()
    expect(first[0]).not.toHaveProperty('mirror')
    expect(again[0]).not.toHaveProperty('mirror')
    expect(said).toHaveLength(1)
    expect(said[0]).toContain(`app's mirror could not be made ready`)
    expect(said[0]).toContain(`${root} is not a checkout git can read`)
    // Asked again rather than remembered as none: once git can read it, the mirror is there.
    repo.git('init', '--quiet', root)
    expect((await repositories())[0]?.mirror).toBe(mirrorDir(repo.home, 'app'))
    expect(said).toHaveLength(1)
  })

  it('answers nothing before status has looked, rather than a world with nothing in it', async () => {
    expect(await repositoriesFrom(() => null, '/nowhere')()).toEqual([])
  })
})
