import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { DISK_MOST } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { AgentPane } from '../../src/model.ts'
import { type DiskLive, diskOf, NOT_IN_TREE } from '../../src/wire/web-disk.ts'

// This machine's half of `/api/disk`: a file, a change or the branches in one
// of its projects, read for another machine standing in it — in the tree the
// side was drawn from, and nowhere else — and what the panels there write,
// written here, in that tree alone. Real git, real links on a real disk.

function machine(
  over: { worktree?: string; panes?: readonly AgentPane[]; branch?: () => string } = {},
) {
  const repo = mkrepo()
  repo.commit('the handler', { 'src/webhooks.ts': 'export const one = 1\n' })
  const refreshed: string[] = []
  const live: DiskLive = {
    worktreeOf: (task) => (task === 'tade/fix' ? (over.worktree ?? null) : null),
    baseOf: () => null,
    factsOf: (task) => (task === 'tade/fix' && over.branch ? { branch: over.branch() } : null),
    refresh: async () => {
      refreshed.push('looked')
    },
  }
  const named: string[] = []
  const disk = diskOf({
    config: () => ConfigSchema.parse({ projects: { tade: { root: repo.root } } }),
    panes: () => over.panes ?? [],
    live: () => live,
    nameTask: async (req) => {
      named.push(req.title)
      return `tade/${req.title}`
    },
  })
  return { repo, disk, refreshed, named }
}

/** The ask a file there is saved with: its words, and what it was when it was read. */
function saving(root: string, path: string, text: string) {
  const was = statSync(join(root, path))
  return {
    project: 'tade',
    agent: null,
    what: 'save' as const,
    path,
    text,
    was: { size: was.size, mtimeMs: was.mtimeMs },
  }
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

describe('what another machine’s panels write on this machine’s disk', () => {
  it('saves a file over the file as it was read, and answers it read again with what git says now', async () => {
    const { repo, disk, refreshed } = machine()
    const read = await disk(saving(repo.root, 'src/webhooks.ts', 'export const one = 3\n'))
    expect(readFileSync(join(repo.root, 'src/webhooks.ts'), 'utf8')).toBe('export const one = 3\n')
    expect(read).toMatchObject({ what: 'file', relative: 'src/webhooks.ts', error: null })
    expect(read?.what === 'file' ? read.diff : null).toContain('+export const one = 3')
    expect(read?.what === 'file' ? read.mtimeMs : 0).toBe(
      statSync(join(repo.root, 'src/webhooks.ts')).mtimeMs,
    )
    expect(refreshed).toEqual(['looked'])
  })

  it('refuses a save over a file that moved since it was read, and leaves what moved it', async () => {
    const { repo, disk } = machine()
    const ask = saving(repo.root, 'src/webhooks.ts', 'from there\n')
    writeFileSync(join(repo.root, 'src/webhooks.ts'), 'an agent here\n')
    // The same size and a moved time is still a file that moved.
    const later = new Date(ask.was.mtimeMs + 5_000)
    utimesSync(join(repo.root, 'src/webhooks.ts'), later, later)
    expect(await disk(ask)).toEqual({
      what: 'wrote',
      ok: false,
      said: 'It changed on disk since you opened it. Close it and open it again.',
    })
    expect(readFileSync(join(repo.root, 'src/webhooks.ts'), 'utf8')).toBe('an agent here\n')
  })

  it('writes nothing outside the tree, through a link out or a walk up', async () => {
    const { repo, disk } = machine()
    const outside = tmp('tade-outside-')
    writeFileSync(join(outside, 'secret'), 'not yours\n')
    symlinkSync(join(outside, 'secret'), join(repo.root, 'out'))
    const was = statSync(join(outside, 'secret'))
    for (const path of ['out', join(outside, 'secret'), '../tade-home/x']) {
      const read = await disk({
        project: 'tade',
        agent: null,
        what: 'save',
        path,
        text: 'written\n',
        was: { size: was.size, mtimeMs: was.mtimeMs },
      })
      expect(read, path).toEqual({ what: 'wrote', ok: false, said: NOT_IN_TREE })
    }
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('not yours\n')
  })

  it('refuses a save of a file only the start of which was ever sent', async () => {
    const { repo, disk } = machine()
    const ask = saving(repo.root, 'src/webhooks.ts', 'cut\n')
    const read = await disk({ ...ask, was: { ...ask.was, size: DISK_MOST.file + 1 } })
    expect(read).toMatchObject({ what: 'wrote', ok: false })
    expect(readFileSync(join(repo.root, 'src/webhooks.ts'), 'utf8')).toBe('export const one = 1\n')
  })

  it('discards a file’s changes, and a file never committed, and reads a path as a path', async () => {
    const { repo, disk } = machine()
    writeFileSync(join(repo.root, 'src/webhooks.ts'), 'changed\n')
    writeFileSync(join(repo.root, 'new.txt'), 'never committed\n')
    writeFileSync(join(repo.root, 'kept.txt'), 'never committed either\n')
    const ask = { project: 'tade', agent: null, what: 'discard' as const }
    expect(await disk({ ...ask, path: 'src/webhooks.ts' })).toEqual({
      what: 'wrote',
      ok: true,
      said: 'discarded src/webhooks.ts',
    })
    expect(readFileSync(join(repo.root, 'src/webhooks.ts'), 'utf8')).toBe('export const one = 1\n')
    expect(await disk({ ...ask, path: 'new.txt' })).toMatchObject({ ok: true })
    expect(existsSync(join(repo.root, 'new.txt'))).toBe(false)
    // A glob is a file called that, not every file it would match.
    expect(await disk({ ...ask, path: '*.txt' })).toMatchObject({ ok: false })
    expect(existsSync(join(repo.root, 'kept.txt'))).toBe(true)
    expect(await disk({ ...ask, path: '../tade-home/x' })).toEqual({
      what: 'wrote',
      ok: false,
      said: NOT_IN_TREE,
    })
  })

  it('switches the checkout to a branch and makes one, and says git’s reason where it will not', async () => {
    const { repo, disk } = machine()
    repo.git('branch', 'tade/other')
    const ask = { project: 'tade', agent: null, what: 'switch' as const }
    expect(await disk({ ...ask, name: 'tade/other', create: false })).toEqual({
      what: 'wrote',
      ok: true,
      said: 'on tade/other',
    })
    expect(repo.git('branch', '--show-current').trim()).toBe('tade/other')
    expect(await disk({ ...ask, name: 'tade/made', create: true })).toMatchObject({ ok: true })
    expect(repo.git('branch', '--show-current').trim()).toBe('tade/made')
    const refused = await disk({ ...ask, name: 'nowhere', create: false })
    expect(refused).toMatchObject({ what: 'wrote', ok: false })
    expect(refused?.what === 'wrote' ? refused.said : '').toMatch(/nowhere/)
  })

  it('renames the agent’s branch from the one the screen there showed, and not from another', async () => {
    const worktree = join(tmp('tade-worktree-'), 'fix')
    const { repo, disk } = machine({
      worktree,
      panes: [{ task: 'tade/fix', project: 'tade' } as AgentPane],
      branch: () => runBranch(),
    })
    repo.git('worktree', 'add', '-q', '-b', 'tade/fix', worktree)
    const runBranch = () => repo.git('-C', worktree, 'branch', '--show-current').trim()
    const ask = { project: 'tade', agent: 'tade/fix', what: 'rename' as const }
    expect(await disk({ ...ask, name: 'doorbell', from: 'tade/elsewhere' })).toEqual({
      what: 'wrote',
      ok: false,
      said: 'It is on tade/fix now.',
    })
    expect(await disk({ ...ask, name: 'doorbell', from: 'tade/fix' })).toEqual({
      what: 'wrote',
      ok: true,
      said: 'renamed to tade/doorbell',
    })
    expect(runBranch()).toBe('tade/doorbell')
    // An agent's worktree is not switched or pulled from there, as it is not from here.
    expect(
      await disk({
        project: 'tade',
        agent: 'tade/fix',
        what: 'switch',
        name: 'main',
        create: false,
      }),
    ).toMatchObject({ ok: false })
    expect(await disk({ project: 'tade', agent: 'tade/fix', what: 'pull' })).toMatchObject({
      ok: false,
    })
  })

  it('names the branch of an agent that has none yet, as naming it here does', async () => {
    const worktree = tmp('tade-worktree-')
    const { disk, named } = machine({
      worktree,
      panes: [{ task: 'tade/fix', project: 'tade' } as AgentPane],
      branch: () => '',
    })
    expect(
      await disk({
        project: 'tade',
        agent: 'tade/fix',
        what: 'rename',
        name: 'doorbell',
        from: '',
      }),
    ).toEqual({ what: 'wrote', ok: true, said: 'on tade/doorbell' })
    expect(named).toEqual(['doorbell'])
  })

  it('writes nothing for an agent that is not here, rather than to the checkout it would fall back to', async () => {
    const { repo, disk, refreshed } = machine()
    repo.git('branch', 'tade/other')
    expect(
      await disk({
        project: 'tade',
        agent: 'tade/gone',
        what: 'switch',
        name: 'tade/other',
        create: false,
      }),
    ).toEqual({
      what: 'wrote',
      ok: false,
      said: 'tade/gone is not open here, so nothing of it is changed',
    })
    expect(repo.git('branch', '--show-current').trim()).toBe('main')
    expect(refreshed).toEqual([])
  })
})
