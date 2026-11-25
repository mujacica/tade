import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { AgentPane } from '../../src/model.ts'
import { type DiskLive, diskOf, NOT_IN_TREE } from '../../src/wire/web-disk.ts'

// This machine's half of `/api/disk`: a file, a change or the branches in one
// of its projects, read for another machine standing in it — in the tree the
// side was drawn from, and nowhere else. Real git, real links on a real disk.

function machine(over: { worktree?: string; panes?: readonly AgentPane[] } = {}) {
  const repo = mkrepo()
  repo.commit('the handler', { 'src/webhooks.ts': 'export const one = 1\n' })
  const live: DiskLive = {
    worktreeOf: (task) => (task === 'tade/fix' ? (over.worktree ?? null) : null),
    baseOf: () => null,
  }
  const disk = diskOf({
    config: () => ConfigSchema.parse({ projects: { tade: { root: repo.root } } }),
    panes: () => over.panes ?? [],
    live: () => live,
  })
  return { repo, disk }
}

describe('what is on this machine’s disk, read for another machine', () => {
  it('reads a file in the project’s checkout, with what git says changed in it', async () => {
    const { repo, disk } = machine()
    writeFileSync(join(repo.root, 'src/webhooks.ts'), 'export const one = 2\n')
    const read = await disk({
      project: 'tade',
      agent: null,
      what: 'file',
      path: 'src/webhooks.ts',
      diff: true,
    })
    expect(read).toMatchObject({
      what: 'file',
      relative: 'src/webhooks.ts',
      text: 'export const one = 2\n',
      error: null,
    })
    expect(read?.what === 'file' ? read.diff : null).toContain('+export const one = 2')
  })

  it('says a file a change deleted is gone, with what git says of it, rather than that it never was', async () => {
    const { repo, disk } = machine()
    rmSync(join(repo.root, 'src/webhooks.ts'))
    const read = await disk({
      project: 'tade',
      agent: null,
      what: 'file',
      path: 'src/webhooks.ts',
      diff: true,
    })
    expect(read).toMatchObject({ what: 'file', error: 'It is not there any more.' })
    expect(read?.what === 'file' ? read.diff : null).toContain('-export const one = 1')
  })

  it('reads nothing outside the tree: a walk up, a path anywhere else and a link out read alike', async () => {
    const { repo, disk } = machine()
    const outside = tmp('tade-outside-')
    writeFileSync(join(outside, 'secret'), 'not yours\n')
    symlinkSync(join(outside, 'secret'), join(repo.root, 'out'))
    symlinkSync(outside, join(repo.root, 'away'))
    for (const path of [
      '../tade-home/x',
      join(outside, 'secret'),
      'out',
      'away/secret',
      '/etc/hosts',
      'src/../../secret',
    ]) {
      const read = await disk({ project: 'tade', agent: null, what: 'file', path })
      expect(read, path).toMatchObject({ what: 'file', text: '', error: NOT_IN_TREE, diff: null })
    }
  })

  it('reads in the worktree of the agent in front where it is this project’s, and not where it is not', async () => {
    const worktree = tmp('tade-worktree-')
    mkdirSync(join(worktree, 'src'))
    writeFileSync(join(worktree, 'src/webhooks.ts'), 'in the worktree\n')
    const pane = { task: 'tade/fix', project: 'tade' } as AgentPane
    const { disk } = machine({ worktree, panes: [pane] })
    const ask = { project: 'tade', what: 'file' as const, path: 'src/webhooks.ts' }
    expect(await disk({ ...ask, agent: 'tade/fix' })).toMatchObject({ text: 'in the worktree\n' })
    // An agent the asking screen names that is not this project's is no agent here.
    expect(await disk({ ...ask, agent: 'other/fix' })).toMatchObject({
      text: 'export const one = 1\n',
    })
  })

  it('lists the checkout’s branches, the one it is on marked', async () => {
    const { repo, disk } = machine()
    repo.git('branch', 'tade/other')
    const read = await disk({ project: 'tade', agent: null, what: 'branches' })
    expect(read?.what === 'branches' ? read.branches.map((one) => one.name).sort() : []).toEqual([
      'main',
      'tade/other',
    ])
    expect(read?.what === 'branches' ? read.branches.find((one) => one.current)?.name : '').toBe(
      'main',
    )
  })

  it('answers nothing for a project that is not open here', async () => {
    const { disk } = machine()
    expect(await disk({ project: 'other', agent: null, what: 'branches' })).toBeNull()
  })
})
