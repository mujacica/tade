import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '@tade/status'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  completedQuery,
  nameFrom,
  type OpenRow,
  openProjectPanel,
} from '../src/panels/project/state.ts'
import { panelClick, panelKey } from '../src/panels.ts'
import {
  ago,
  branchOf,
  browsing,
  expand,
  initialise,
  isPath,
  listFolders,
  makeFolder,
  neverInitialise,
  noteRecent,
  readRecents,
  recentProjects,
  whatIsAt,
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

describe('somewhere too wide to make a repository of', () => {
  // Fabricated paths and a fabricated home: the rule is pure so that testing
  // it never needs the machine the suite is running on to have a `~` worth
  // risking.
  const home = '/Users/someone'

  it('refuses a whole home and the top of a disk', () => {
    for (const path of [home, `${home}/`, '/', '']) {
      expect(neverInitialise(path, home), path).toBe(true)
    }
  })

  it('allows anywhere inside either, which is where repositories live', () => {
    for (const path of [`${home}/src/pay`, `${home}/pay`, '/srv/pay', '/opt'])
      expect(neverInitialise(path, home), path).toBe(false)
  })

  it('is about this home, not the word home', () => {
    expect(neverInitialise('/home/other', home)).toBe(false)
    expect(neverInitialise('/Users/someone-else', home)).toBe(false)
  })
})

describe('a folder that is not there yet', () => {
  it('tells a folder from something in the way from nothing at all', () => {
    const root = tmp('tade-there-')
    mkdirSync(join(root, 'payroll'))
    writeFileSync(join(root, 'notes.txt'), 'not a folder')
    expect(whatIsAt(join(root, 'payroll'))).toBe('folder')
    expect(whatIsAt(join(root, 'notes.txt'))).toBe('something')
    expect(whatIsAt(join(root, 'nowhere'))).toBe('nothing')
  })

  it('is made, git inited and ready for an agent to branch from', async () => {
    const root = tmp('tade-make-')
    const path = join(root, 'deep', 'refunds-api')
    makeFolder(path)
    await initialise(path)
    expect(whatIsAt(path)).toBe('folder')
    expect(await branchOf(path)).toBe('main')
    expect(nameFrom(path)).toBe('refunds-api')
  })

  it('leaves what is already there exactly as it was', () => {
    const root = tmp('tade-keep-')
    const path = join(root, 'payroll')
    mkdirSync(path)
    writeFileSync(join(path, 'README.md'), '# payroll\n')
    makeFolder(path)
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# payroll\n')
  })

  it('expands what was typed the way the list does', () => {
    const root = tmp('tade-expand-')
    expect(expand(`${root}/refunds-api`, '/')).toBe(join(root, 'refunds-api'))
    expect(browsing(`${root}/refunds-api`, '/').dir).toBe(root)
  })
})

describe('finishing a path with tab', () => {
  const folders = (...names: string[]): OpenRow[] =>
    names.map((name) => ({ kind: 'folder', name, path: `/src/${name}`, git: false }))
  const at = (query: string) => ({ ...openProjectPanel('/src'), query })

  it('adds what every folder that could be meant shares', () => {
    expect(completedQuery(at('~/src/p'), folders('payments', 'payroll'))).toBe('~/src/pay')
    expect(completedQuery(at('~/src/payr'), folders('payments', 'payroll'))).toBe('~/src/payroll')
    expect(completedQuery(at('~/src/payr'), folders('payroll'))).toBe('~/src/payroll')
    expect(completedQuery(at('~/src/'), folders('payments'))).toBe('~/src/payments')
    // Everything they share is already typed: there is nothing to add, so tab
    // is free to be the key that moves between the fields.
    expect(completedQuery(at('~/src/pay'), folders('payments', 'payroll'))).toBeNull()
  })

  it('finishes in the disk’s own spelling, not the one that was typed', () => {
    // `~/src/Pay` + the rest of `payments` would be `~/src/Payments`, which on
    // a case-sensitive disk opens nothing at all.
    expect(completedQuery(at('~/src/Pay'), folders('payments'))).toBe('~/src/payments')
  })

  it('has nothing to say about a name being matched against the list', () => {
    expect(completedQuery(at('pay'), folders('payments'))).toBeNull()
    expect(completedQuery(at('~/src/payroll'), folders('payroll'))).toBeNull()
    expect(completedQuery(at('~/src/zz'), folders('payments'))).toBeNull()
  })
})

describe('the Open project keys', () => {
  const rows: OpenRow[] = [
    { kind: 'recent', name: 'tade', path: '/me/tade', git: true },
    { kind: 'here', name: 'src', path: '/src', git: false },
    { kind: 'folder', name: 'payments', path: '/src/payments', git: true },
  ]
  const at = (over: Partial<ReturnType<typeof openProjectPanel>> = {}) => ({
    ...openProjectPanel('/src'),
    ...over,
  })

  it('never wraps round the ends, because the wheel used to press these keys', () => {
    expect(panelKey(at({ index: 2 }), 'down', '', { rows }).panel).toMatchObject({ index: 2 })
    expect(panelKey(at({ index: 0 }), 'up', '', { rows }).panel).toMatchObject({ index: 0 })
    // From nothing chosen, either end is a sensible place to start.
    expect(panelKey(at(), 'down', '', { rows }).panel).toMatchObject({ index: 0 })
    expect(panelKey(at(), 'up', '', { rows }).panel).toMatchObject({ index: 2 })
  })

  it('goes to either end', () => {
    expect(panelKey(at({ index: 2 }), 'home', '', { rows }).panel).toMatchObject({ index: 0 })
    expect(panelKey(at({ index: 0 }), 'end', '', { rows }).panel).toMatchObject({ index: 2 })
  })

  it('still looks around from the tick box, which used to swallow every key', () => {
    const panel = at({ index: 1, field: 'init' })
    expect(panelKey(panel, 'down', '', { rows }).panel).toMatchObject({ index: 2, field: 'init' })
    expect(panelKey(panel, 'space', ' ', { rows }).panel).toMatchObject({ init: false })
  })

  it('clears a field with ctrl+u, as the settings fields do', () => {
    expect(panelKey(at({ query: '~/src/pay' }), 'ctrl+u', '', { rows }).panel).toMatchObject({
      query: '',
    })
    expect(
      panelKey(at({ index: 2, field: 'name', name: 'payments' }), 'ctrl+u', '', { rows }).panel,
    ).toMatchObject({ name: '' })
  })

  it('takes a pasted path whole, markers and trailing newline and all', () => {
    const pasted = panelKey(at(), undefined, '\x1b[200~/Users/me/src/pay\n\x1b[201~', { rows })
    expect(pasted.panel).toMatchObject({ query: '/Users/me/src/pay' })
  })

  it('completes the path on tab, and moves between the fields once it cannot', () => {
    const completed = panelKey(at({ query: '~/src/pay' }), 'tab', '\t', {
      rows: [{ kind: 'folder', name: 'payments', path: '/src/payments', git: false }],
    })
    expect(completed.panel).toMatchObject({ query: '~/src/payments', field: 'query' })
    expect(panelKey(at({ index: 0 }), 'tab', '\t', { rows }).panel).toMatchObject({ field: 'name' })
  })

  it('offers a folder that is not there as a row like any other', () => {
    const fresh: OpenRow[] = [
      { kind: 'new', name: 'refunds-api', path: '/src/refunds-api', git: false },
    ]
    const chosen = panelKey(at({ query: '~/src/refunds-api' }), 'down', '', { rows: fresh }).panel
    expect(chosen).toMatchObject({ index: 0 })
    const outcome = chosen ? panelKey(chosen, 'enter', '\r', { rows: fresh }) : null
    expect(outcome?.submit).toBe(true)
    // There is nothing in it to commit, so it never asks about committing it:
    // tab goes straight past the tick box.
    expect(chosen ? panelKey(chosen, 'tab', '\t', { rows: fresh }).panel : null).toMatchObject({
      field: 'name',
    })
  })

  it('has nothing to go into where a folder is not there yet', () => {
    const fresh: OpenRow[] = [
      { kind: 'new', name: 'refunds-api', path: '/src/refunds-api', git: false },
    ]
    expect(panelKey(at({ index: 0 }), 'right', '', { rows: fresh }).panel).toMatchObject({
      dir: '/src',
    })
    expect(panelClick(at({ index: 0 }), 'into:0', { rows: fresh }).panel).toMatchObject({
      dir: '/src',
    })
  })
})
