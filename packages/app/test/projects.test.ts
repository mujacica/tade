import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '@tade/status'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { nameFrom, openProjectPanel, panelClick, panelKey } from '../src/panels.ts'
import {
  ago,
  branchOf,
  browsing,
  initialise,
  isPath,
  listFolders,
  noteRecent,
  readRecents,
  recentProjects,
} from '../src/projects.ts'

// Finding a project to open, against a real disk and real git.

describe('recent projects', () => {
  it('lists every configured project, the ones used most recently first', () => {
    const home = tmp('tade-recent-')
    noteRecent(home, 'search', '~/src/search', 1_000)
    noteRecent(home, 'checkout', '~/src/checkout', 2_000)
    const list = recentProjects(readRecents(home), {
      checkout: { root: '~/src/checkout' },
      search: { root: '~/src/search' },
      infra: { root: '~/src/infra' },
    })
    expect(list.map((entry) => entry.name)).toEqual(['checkout', 'search', 'infra'])
  })

  it('forgets a project the config no longer has', () => {
    const home = tmp('tade-recent-')
    noteRecent(home, 'gone', '~/src/gone', 5_000)
    expect(recentProjects(readRecents(home), {}).length).toBe(0)
  })

  it('says when, the way people do', () => {
    const now = 10 * 86_400_000
    expect(ago(now - 2 * 3_600_000, now)).toBe('2h ago')
    expect(ago(now - 30 * 3_600_000, now)).toBe('yesterday')
    expect(ago(0, now)).toBe('never opened')
  })
})

describe('browsing folders', () => {
  it('knows a path from a name', () => {
    expect(isPath('~/src')).toBe(true)
    expect(isPath('./app')).toBe(true)
    expect(isPath('checkout')).toBe(false)
  })

  it('lists the folders under what is typed, and which are repositories', async () => {
    const root = tmp('tade-browse-')
    const repo = mkrepo()
    mkdirSync(join(root, 'payroll'))
    mkdirSync(join(root, 'payments'))
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, 'notes.txt'), 'not a folder')
    // A repository among them, as it would be on a real machine.
    await git(root, ['clone', '--quiet', repo.root, join(root, 'pay-api')])

    const { dir, prefix } = browsing(`${root}/pay`, '/')
    const folders = listFolders(dir, prefix)
    expect(folders.map((folder) => folder.name)).toEqual(['pay-api', 'payments', 'payroll'])
    expect(folders.find((folder) => folder.name === 'pay-api')?.git).not.toBeNull()
    expect(folders.find((folder) => folder.name === 'payroll')?.git).toBeNull()
    expect(listFolders(root, '').some((folder) => folder.name === '.hidden')).toBe(false)
    expect(await branchOf(join(root, 'pay-api'))).toBe('main')
  })
})

describe('a folder without git', () => {
  it('becomes a repository with its files in a first commit that is Tade’s', async () => {
    const root = tmp('tade-init-')
    writeFileSync(join(root, 'README.md'), '# payroll\n')
    await initialise(root)
    const log = await git(root, ['log', '--format=%an|%s'])
    expect(log.stdout.trim()).toBe('Tade|First commit, so agents have something to branch from')
    const files = await git(root, ['ls-files'])
    expect(files.stdout).toContain('README.md')
    expect(await branchOf(root)).toBe('main')
  })

  it('is named from its folder, as a project name has to be', () => {
    expect(nameFrom('/Users/me/src/My Payroll App')).toBe('my-payroll-app')
  })
})

describe('the Open project panel', () => {
  const rows = [
    { kind: 'here' as const, name: 'src', path: '/src', git: false },
    { kind: 'folder' as const, name: 'payments', path: '/src/payments', git: true },
    { kind: 'folder' as const, name: 'payroll', path: '/src/payroll', git: false },
    { kind: 'recent' as const, name: 'tade', path: '/me/tade', git: true },
  ]
  const at = (dir: string) => openProjectPanel(dir)

  it('starts in a folder with nothing chosen, so enter opens nothing by accident', () => {
    const panel = at('/src')
    expect(panel.index).toBe(-1)
    expect(panelKey(panel, 'enter', '\r', { rows }).submit).toBe(false)
    expect(panelKey(panel, 'down', '', { rows }).panel).toMatchObject({ index: 0 })
  })

  it('goes into a folder with the right arrow, and up with the left', () => {
    const into = panelKey({ ...at('/src'), index: 2 }, 'right', '', { rows }).panel
    expect(into).toMatchObject({ dir: '/src/payroll', index: -1, back: ['/src'] })
    const up = panelKey(at('/src/payroll'), 'left', '', { rows }).panel
    expect(up).toMatchObject({ dir: '/src' })
  })

  it('goes into a folder when you click it a second time', () => {
    const chosen = panelClick(at('/src'), 'row:1', { rows }).panel
    expect(chosen).toMatchObject({ dir: '/src', index: 1 })
    const into = chosen ? panelClick(chosen, 'row:1', { rows }).panel : null
    expect(into).toMatchObject({ dir: '/src/payments' })
  })

  it('goes back and forward through the folders you looked in', () => {
    let panel = panelClick(at('/me'), 'go:/src', { rows }).panel
    panel = panel ? panelClick(panel, 'into:2', { rows }).panel : null
    expect(panel).toMatchObject({ dir: '/src/payroll', back: ['/me', '/src'] })
    panel = panel ? panelClick(panel, 'back', { rows }).panel : null
    expect(panel).toMatchObject({ dir: '/src', forward: ['/src/payroll'] })
    panel = panel ? panelClick(panel, 'forward', { rows }).panel : null
    expect(panel).toMatchObject({ dir: '/src/payroll', forward: [] })
  })

  it('opens the chosen row on enter', () => {
    const outcome = panelKey({ ...at('/src'), index: 3 }, 'enter', '\r', { rows })
    expect(outcome.submit).toBe(true)
    expect(outcome.choice).toBe('open')
  })

  it('narrows as you type, and backspace on nothing goes up a folder', () => {
    const typed = panelKey(at('/src'), undefined, 'pay', { rows }).panel
    expect(typed).toMatchObject({ query: 'pay', dir: '/src' })
    expect(panelKey(at('/src/pay'), 'backspace', '', { rows }).panel).toMatchObject({ dir: '/src' })
  })
})
