import { describe, expect, it } from 'vitest'
import {
  branchChoices,
  branchMenuItems,
  branchPanel,
  changeMenuItems,
  type ExtensionView,
  extensionControls,
  extensionSetupPanel,
  extensionsPanel,
  extensionViewPanel,
  fileMenuItems,
  filePanel,
  findPanel,
  panelClick,
  panelKey,
  promptPanel,
  type SetupFieldView,
  searchPanel,
  setupControls,
  spendPanel,
  terminalMenuItems,
} from '../src/panels.ts'
import type { SearchEntry } from '../src/search.ts'

// What a key or a click does to a panel, without a terminal.

describe('the Spend panel', () => {
  it('opens on today, by agent', () => {
    expect(spendPanel()).toMatchObject({ window: 'today', by: 'agent' })
  })

  it('moves through the time windows with the arrows and the groupings with tab', () => {
    const later = panelKey(spendPanel(), 'right', '').panel
    expect(later).toMatchObject({ window: 'window' })
    expect(panelKey(spendPanel(), 'left', '').panel).toMatchObject({ window: 'week' })
    expect(panelKey(spendPanel(), 'tab', '').panel).toMatchObject({ by: 'project' })
  })

  it('changes by click on its tabs, and closes on escape', () => {
    expect(panelClick(spendPanel(), 'by:model').panel).toMatchObject({ by: 'model' })
    expect(panelClick(spendPanel(), 'window:week').panel).toMatchObject({ window: 'week' })
    expect(panelKey(spendPanel(), 'escape', '').panel).toBeNull()
  })
})

describe('the Search panel', () => {
  const entries: SearchEntry[] = [
    {
      id: 'open\0/r/src/app.ts\0\0',
      kind: 'file',
      label: 'src/app.ts',
      mark: '□',
      complete: 'src/app.ts',
    },
    {
      id: 'task:checkout/refunds',
      kind: 'agent',
      label: 'refunds',
      mark: '○',
      complete: '@refunds',
    },
  ]

  it('types, moves, and opens the chosen result', () => {
    let panel = panelKey(searchPanel(), undefined, 'app', { entries }).panel
    expect(panel).toMatchObject({ query: 'app', index: 0 })
    panel = panel ? panelKey(panel, 'down', '', { entries }).panel : null
    const outcome = panel ? panelKey(panel, 'enter', '\r', { entries }) : null
    expect(outcome).toMatchObject({ submit: true, choice: 'task:checkout/refunds' })
  })

  it('completes with tab', () => {
    const panel = panelKey(searchPanel('app:3'), 'tab', '\t', { entries }).panel
    expect(panel).toMatchObject({ query: 'src/app.ts:3' })
  })

  it('narrows with a scope chip, keeping the words', () => {
    const panel = panelClick(searchPanel('#ref'), 'scope:@', { entries }).panel
    expect(panel).toMatchObject({ query: '@ref' })
  })
})

describe('the file viewer', () => {
  it('opens at a line with some of what comes before it in view', () => {
    expect(filePanel('/r/a.ts', 40)).toMatchObject({ line: 40, scroll: 34, formatted: false })
    // Markdown reads formatted, unless a line was asked for.
    expect(filePanel('/r/README.md', null, true).formatted).toBe(true)
    expect(filePanel('/r/README.md', 3, true).formatted).toBe(false)
  })

  it('scrolls within the file, and not past it', () => {
    const at = filePanel('/r/a.ts')
    expect(panelKey(at, 'up', '', { lines: 50 }).panel).toMatchObject({ scroll: 0 })
    expect(panelKey(at, 'pageDown', '', { lines: 50 }).panel).toMatchObject({ scroll: 20 })
    expect(panelKey(at, 'end', '', { lines: 50 }).panel).toMatchObject({ scroll: 49 })
  })

  it('goes to the editor on e, enter or its button', () => {
    const at = filePanel('/r/a.ts')
    expect(panelKey(at, 'e', 'e')).toMatchObject({ submit: true, choice: 'editor' })
    expect(panelClick(at, 'editor')).toMatchObject({ submit: true, choice: 'editor' })
    expect(panelKey(at, 'escape', '\x1b').panel).toBeNull()
  })
})

describe('menus beside the agents', () => {
  it('offer a file what can be done with it, and say why not', () => {
    const items = fileMenuItems({
      folder: false,
      open: false,
      changed: false,
      agent: false,
      platform: 'darwin',
    })
    expect(items.map((item) => item.id)).toEqual([
      'open',
      'editor',
      'changes',
      'ask',
      'copy-path',
      'copy-relative',
      'reveal',
    ])
    expect(items.find((item) => item.id === 'changes')?.off).toBe('unchanged')
    expect(items.find((item) => item.id === 'reveal')?.label).toBe('Reveal in Finder')
  })

  it('offer a folder a search inside it', () => {
    const items = fileMenuItems({
      folder: true,
      open: true,
      changed: false,
      agent: true,
      platform: 'linux',
    })
    expect(items[0]?.label).toBe('Collapse')
    expect(items.some((item) => item.id === 'search')).toBe(true)
  })

  it('only discard what is not committed', () => {
    expect(
      changeMenuItems({ uncommitted: false, agent: true }).find((i) => i.id === 'discard')?.off,
    ).toBe('committed')
  })

  it("switch the project, but rename an agent's branch rather than switch it out from under it", () => {
    expect(branchMenuItems({ agent: false, name: 'main' }).map((i) => i.id)).toContain('switch')
    const agent = branchMenuItems({ agent: true, name: '' })
    expect(agent.map((i) => i.id)).not.toContain('switch')
    expect(agent[0]?.label).toBe('Name the branch now…')
  })
})

describe('a note', () => {
  it('is typed word for word, turned to everything with tab, and saved on enter', () => {
    let panel = panelKey(
      promptPanel('note', 'New note', 'NOTE'),
      undefined,
      'Staging Key rotates',
    ).panel
    expect(panel).toMatchObject({ text: 'Staging Key rotates' })
    panel = panel ? panelKey(panel, 'tab', '\t').panel : null
    expect(panel).toMatchObject({ everywhere: true })
    const saved = panel ? panelKey(panel, 'enter', '\r') : null
    expect(saved).toMatchObject({ submit: true, choice: 'save', panel: { busy: true } })
  })

  it('refuses to save nothing', () => {
    const outcome = panelKey(promptPanel('note', 'New note', 'NOTE'), 'enter', '\r')
    expect(outcome.submit).toBe(false)
    expect(outcome.panel).toMatchObject({ error: 'Write the note first.' })
  })

  it('turns a space in a branch name into a dash', () => {
    const panel = panelKey(
      promptPanel('new-branch', 'New branch', 'NAME'),
      undefined,
      'fix refunds',
    ).panel
    expect(panel).toMatchObject({ text: 'fix-refunds' })
  })
})

describe('switching branch', () => {
  const rows = [
    { name: 'main', current: true, when: 'now' },
    { name: 'fix/refunds', current: false, when: 'yesterday' },
  ]

  it('narrows, and offers to create a name nobody has', () => {
    expect(branchChoices(rows, 'fix').map((c) => [c.name, c.create])).toEqual([
      ['fix', true],
      ['fix/refunds', false],
    ])
    expect(branchChoices(rows, 'main').map((c) => c.create)).toEqual([false])
  })

  it('switches to the chosen branch on enter', () => {
    const panel = { ...branchPanel(), query: 'refunds', index: 1 }
    expect(panelKey(panel, 'enter', '\r', { branches: rows })).toMatchObject({
      submit: true,
      choice: 'switch:fix/refunds',
    })
  })
})

describe('finding in a terminal', () => {
  it('narrows as you type, goes older with enter or up and newer with down, wrapping', () => {
    let panel = panelKey(findPanel('app/terminals/1'), undefined, 'Error', { found: 3 }).panel
    expect(panel).toMatchObject({ query: 'Error', index: 0 })
    panel = panel ? panelKey(panel, 'enter', '\r', { found: 3 }).panel : null
    panel = panel ? panelKey(panel, 'up', '', { found: 3 }).panel : null
    expect(panel).toMatchObject({ index: 2 })
    panel = panel ? panelKey(panel, 'up', '', { found: 3 }).panel : null
    expect(panel).toMatchObject({ index: 0 })
    panel = panel ? panelKey(panel, 'down', '', { found: 3 }).panel : null
    expect(panel).toMatchObject({ index: 2 })
    expect(panel ? panelKey(panel, 'escape', '\x1b').panel : 'open').toBeNull()
  })

  it('offers a terminal what can be done with it, closing last', () => {
    expect(terminalMenuItems().map((item) => item.id)).toEqual([
      'run',
      'find',
      'rename',
      'clear',
      'close',
    ])
  })
})

describe('the Extensions panel', () => {
  const views: ExtensionView[] = [
    {
      name: 'deps',
      title: 'Dependencies',
      description: '',
      source: 'built-in',
      state: 'ready',
      problem: null,
      tools: [],
      actions: [{ id: 'check', title: 'Check dependencies' }],
      unknownSettings: [],
      configurable: true,
      folder: null,
    },
    {
      name: 'sentry',
      title: 'Sentry',
      description: '',
      source: 'built-in',
      state: 'needs setup',
      problem: 'which organization?',
      tools: [],
      actions: [{ id: 'new', title: 'New issues' }],
      unknownSettings: [],
      configurable: true,
      folder: null,
    },
  ]
  const proposals = [{ name: 'notes', kind: 'tool' as const, why: 'x', path: '/p/notes.ts' }]

  it('moves through turning on and off, setting up, actions and proposals, and presses with enter', () => {
    expect(extensionControls(views, proposals)).toEqual([
      'toggle:deps',
      'setup:deps',
      'action:deps:check',
      'toggle:sentry',
      'setup:sentry',
      'read:notes',
      'approve:notes',
      'reject:notes',
    ])
    let panel = extensionsPanel()
    for (let i = 0; i < 4; i++)
      panel = panelKey(panel, 'tab', '\t', { extensions: views, proposals }).panel as typeof panel
    expect(panelKey(panel, 'enter', '\r', { extensions: views, proposals })).toMatchObject({
      submit: true,
      choice: 'setup:sentry',
    })
    expect(
      panelClick(extensionsPanel(), 'approve:notes', { extensions: views, proposals }),
    ).toMatchObject({
      submit: true,
      choice: 'approve:notes',
    })
  })
})

describe("an extension's view", () => {
  it('scrolls as far as it has lines, and closes', () => {
    let panel = extensionViewPanel('resources')
    panel = panelKey(panel, 'pageDown', '', { lines: 14 }).panel as typeof panel
    expect(panel.scroll).toBe(10)
    panel = panelKey(panel, 'pageDown', '', { lines: 14 }).panel as typeof panel
    expect(panel.scroll).toBe(13)
    panel = panelKey(panel, 'home', '', { lines: 14 }).panel as typeof panel
    expect(panel.scroll).toBe(0)
    expect(panelKey(panel, 'escape', '', {}).panel).toBeNull()
    expect(panelClick(panel, 'close', {}).panel).toBeNull()
  })
})

describe('setting an extension up', () => {
  const fields: SetupFieldView[] = [
    {
      key: 'org',
      label: 'Organization',
      help: '',
      placeholder: '',
      kind: 'text',
      choices: ['acme', 'globex'],
    },
    { key: 'brief', label: 'In the brief', help: '', placeholder: '', kind: 'flag', choices: [] },
  ]

  it('types into a field, picks what it offers, turns a flag round, and saves', () => {
    let panel = extensionSetupPanel('sentry', [
      { key: 'org', value: '' },
      { key: 'brief', value: '' },
    ])
    expect(setupControls(fields)).toEqual([
      'field:org',
      'pick:org:acme',
      'pick:org:globex',
      'field:brief',
      'save',
      'cancel',
    ])
    for (const char of 'ac')
      panel = panelKey(panel, undefined, char, { setupFields: fields }).panel as typeof panel
    expect(panel.values.org).toBe('ac')
    panel = panelClick(panel, 'pick:org:globex', { setupFields: fields }).panel as typeof panel
    expect(panel.values.org).toBe('globex')
    panel = panelClick(panel, 'field:brief', { setupFields: fields }).panel as typeof panel
    expect(panel.values.brief).toBe('on')
    panel = panelKey(panel, 'space', ' ', { setupFields: fields }).panel as typeof panel
    expect(panel.values.brief).toBe('off')
    expect(panelClick(panel, 'save', { setupFields: fields })).toMatchObject({
      submit: true,
      choice: 'save',
    })
  })
})
