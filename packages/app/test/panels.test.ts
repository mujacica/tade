import type { TadeEvent } from '@tade/core'
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
  type FilePanel,
  fileMenuItems,
  filePanel,
  findPanel,
  harnessMenuItems,
  laneMenuItems,
  type Panel,
  panelClick,
  panelKey,
  perMillion,
  priceCells,
  priceSaid,
  promptPanel,
  type SetupFieldView,
  savedFile,
  scrollFile,
  searchPanel,
  setupControls,
  spendPanel,
  terminalMenuItems,
  thinkingMenuItems,
  watchControl,
} from '../src/panels.ts'
import type { SearchEntry } from '../src/search.ts'
import { spendView } from '../src/spend.ts'

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

  it('includes agent spend in the rows', () => {
    const view = spendView(
      [
        {
          seq: 1,
          ts: new Date().toISOString(),
          type: 'usage',
          urgency: 'routine',
          task: 'search/pagination',
          lane: null,
          run: 'search/pagination/agent',
          detail: { model: 'anthropic/claude-sonnet-5', tokens: 1500, usd: 0.351 },
        },
      ],
      {
        window: 'today',
        by: 'agent',
        now: Date.now(),
        openedAt: Date.now() - 3_600_000,
        projects: ['checkout', 'search'],
        budgets: {},
      },
    )
    expect(view.rows).toHaveLength(1)
    expect(view.rows[0]).toMatchObject({
      label: 'search/pagination',
      kind: 'task',
      tokens: 1500,
      usd: 0.351,
    })
  })

  describe('what it says about runtime', () => {
    const now = Date.parse('2026-09-13T14:00:00.000Z')
    const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
    const run = (type: 'run_started' | 'run_exited', task: string, minutes: number): TadeEvent =>
      ({
        seq: 1,
        ts: at(minutes),
        type,
        urgency: 'notable',
        task,
        lane: `${task}/agent`,
        run: `${task}/agent`,
        detail: type === 'run_started' ? { model: 'anthropic/claude-sonnet-5' } : {},
      }) as TadeEvent
    const view = (by: 'agent' | 'project' | 'model', runs: TadeEvent[]) =>
      spendView([spent], {
        // Measured from when the window opened, which no timezone moves.
        window: 'window',
        by,
        now,
        openedAt: now - 3_600_000,
        projects: ['search'],
        budgets: {},
        runs,
      })
    const spent = {
      seq: 1,
      ts: at(30),
      type: 'usage',
      urgency: 'routine',
      task: 'search/pagination',
      lane: null,
      run: 'search/pagination/agent',
      detail: { model: 'anthropic/claude-sonnet-5', tokens: 1500, usd: 0.351 },
    } as TadeEvent

    it('puts the time of each agent on its row, and the lot in the total', () => {
      const seen = view('agent', [
        run('run_started', 'search/pagination', 45),
        run('run_exited', 'search/pagination', 15),
        run('run_started', 'checkout/refunds', 20),
      ])
      expect(seen.runtime.ms).toBe(50 * 60_000)
      expect(seen.rows.find((r) => r.label === 'search/pagination')?.runtime).toMatchObject({
        ms: 30 * 60_000,
        running: false,
      })
      // An agent that ran and reported no money still gets a row.
      expect(seen.rows.find((r) => r.label === 'checkout/refunds')?.runtime).toMatchObject({
        ms: 20 * 60_000,
        running: true,
      })
    })

    it('gives the orchestrator no runtime: it has no run of its own', () => {
      const seen = view('agent', [run('run_started', 'search/pagination', 10)])
      const usage = {
        ...spent,
        task: null,
        detail: { ...spent.detail, by: 'orchestrator' },
      } as TadeEvent
      const withOrchestrator = spendView([spent, usage], {
        window: 'window',
        by: 'agent',
        now,
        openedAt: now - 3_600_000,
        projects: ['search'],
        budgets: {},
        runs: [run('run_started', 'search/pagination', 10)],
      })
      expect(seen.rows[0]?.runtime).not.toBeNull()
      expect(withOrchestrator.rows.find((r) => r.kind === 'orchestrator')?.runtime).toBeNull()
    })

    it('adds it up by project and by model too', () => {
      const runs = [
        run('run_started', 'search/pagination', 45),
        run('run_exited', 'search/pagination', 15),
      ]
      expect(view('project', runs).rows.find((r) => r.label === 'search')?.runtime?.ms).toBe(
        30 * 60_000,
      )
      expect(
        view('model', runs).rows.find((r) => r.label === 'anthropic/claude-sonnet-5')?.runtime?.ms,
      ).toBe(30 * 60_000)
    })

    it('has run for no time when no runs were read', () => {
      expect(view('agent', []).runtime).toMatchObject({ ms: 0, runs: 0, running: false })
    })
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

describe('finding in a file, and going to a line', () => {
  const text = ['const event = 1', '', 'if (event) return', 'const other = 2', 'done(event)']
  const inputs = { text, lines: text.length, body: 3, columns: 60 }
  const type = (panel: Panel, word: string) => {
    let out = panel
    for (const char of word) out = panelKey(out, char, char, inputs).panel as Panel
    return out as FilePanel
  }

  it('opens the find bar on ctrl+f and walks the matches, wrapping', () => {
    let panel = panelKey(filePanel('/r/a.ts'), 'ctrl+f', '\x06', inputs).panel as FilePanel
    expect(panel.asking).toEqual({ kind: 'find', query: '', index: 0 })
    panel = type(panel, 'event')
    // Typing lands on the first match and marks its line, counting from 1.
    expect(panel).toMatchObject({ line: 1, asking: { query: 'event', index: 0 } })
    panel = panelKey(panel, 'enter', '\r', inputs).panel as FilePanel
    expect(panel).toMatchObject({ line: 3, asking: { index: 1 } })
    panel = panelKey(panel, 'enter', '\r', inputs).panel as FilePanel
    expect(panel).toMatchObject({ line: 5, asking: { index: 2 }, scroll: 3 })
    // Round the end, and back the other way with the bar's own arrows.
    panel = panelKey(panel, 'enter', '\r', inputs).panel as FilePanel
    expect(panel).toMatchObject({ line: 1, asking: { index: 0 } })
    panel = panelClick(panel, 'match-previous', inputs).panel as FilePanel
    expect(panel).toMatchObject({ line: 5, asking: { index: 2 } })
  })

  it('shuts the bar on escape, and leaves the file open', () => {
    const panel = panelKey(filePanel('/r/a.ts'), 'ctrl+f', '\x06', inputs).panel as FilePanel
    const shut = panelKey(panel, 'escape', '\x1b', inputs).panel as FilePanel
    expect(shut.asking).toBeNull()
    expect(panelKey(shut, 'escape', '\x1b', inputs).panel).toBeNull()
  })

  it('goes to the line typed, and no further than the file goes', () => {
    let panel = panelKey(filePanel('/r/a.ts'), 'ctrl+g', '\x07', inputs).panel as FilePanel
    panel = type(panel, '4')
    expect(panel.asking).toEqual({ kind: 'goto', digits: '4' })
    panel = panelKey(panel, 'enter', '\r', inputs).panel as FilePanel
    expect(panel).toMatchObject({ line: 4, scroll: 2 })
    panel = type(panelKey(panel, 'ctrl+g', '\x07', inputs).panel as FilePanel, '900')
    panel = panelKey(panel, 'enter', '\r', inputs).panel as FilePanel
    expect(panel.line).toBe(5)
  })

  it('reads the source: neither of them has a formatted line to land on', () => {
    const markdown = filePanel('/r/README.md', null, true)
    expect(markdown.formatted).toBe(true)
    expect(panelKey(markdown, 'ctrl+f', '\x06', inputs).panel).toMatchObject({ formatted: false })
    expect(panelKey(markdown, 'ctrl+g', '\x07', inputs).panel).toMatchObject({ formatted: false })
  })
})

describe('typing into a file', () => {
  const text = ['const a = 1', 'const b = 2', 'done()']
  const inputs = { text, lines: text.length, body: 3, columns: 60 }
  const clicked = (panel: Panel, line: number, cell: number) =>
    panelClick(panel, `caret:${line}:${cell}`, inputs).panel as FilePanel

  it('puts the caret where the click landed, and types there', () => {
    let panel = clicked(filePanel('/r/a.ts'), 1, 7)
    expect(panel.edit).toMatchObject({ row: 1, column: 7, dirty: false })
    panel = panelKey(panel, undefined, 'X', inputs).panel as FilePanel
    expect(panel.edit?.lines[1]).toBe('const bX = 2')
    expect(panel.edit?.dirty).toBe(true)
    // Reading keys are typed now: the file is what has the keyboard.
    panel = panelKey(panel, 'e', 'e', inputs).panel as FilePanel
    expect(panel.edit?.lines[1]).toBe('const bXe = 2')
  })

  it('saves on ctrl+s, and only when there is something to save', () => {
    const put = clicked(filePanel('/r/a.ts'), 0, 0)
    expect(panelKey(put, 'ctrl+s', '\x13', inputs)).toMatchObject({ submit: false })
    const typed = panelKey(put, undefined, 'x', inputs).panel as FilePanel
    expect(panelKey(typed, 'ctrl+s', '\x13', inputs)).toMatchObject({
      submit: true,
      choice: 'save',
    })
    expect(panelClick(typed, 'save', inputs)).toMatchObject({ submit: true, choice: 'save' })
  })

  it('asks once before throwing away what was typed, and never silently', () => {
    const typed = panelKey(clicked(filePanel('/r/a.ts'), 0, 0), undefined, 'x', inputs)
      .panel as FilePanel
    const asked = panelKey(typed, 'escape', '\x1b', inputs).panel as FilePanel
    expect(asked.said).toMatch(/ctrl\+s/)
    expect(asked.warned).toBe(true)
    expect(panelKey(asked, 'escape', '\x1b', inputs).panel).toBeNull()
    // The same for the two ways out that are clicks.
    expect(panelClick(typed, 'close', inputs).panel).toMatchObject({ warned: true })
    expect(panelClick(typed, 'editor', inputs)).toMatchObject({ submit: false })
    // Nothing typed, nothing to ask about.
    const put = clicked(filePanel('/r/a.ts'), 0, 0)
    expect(panelKey(put, 'escape', '\x1b', inputs).panel).toBeNull()
  })

  it('takes a paste as the lines it is', () => {
    const put = clicked(filePanel('/r/a.ts'), 0, 11)
    const pasted = panelKey(put, undefined, '\x1b[200~ // one\n// two\x1b[201~', inputs)
      .panel as FilePanel
    expect(pasted.edit?.lines).toEqual(['const a = 1 // one', '// two', 'const b = 2', 'done()'])
  })

  it('is scrolled by the wheel without the caret moving', () => {
    const typed = clicked(filePanel('/r/a.ts'), 0, 0)
    const wheeled = scrollFile(typed, 2, 3)
    expect(wheeled.scroll).toBe(2)
    expect(wheeled.edit).toMatchObject({ row: 0, column: 0 })
    expect(scrollFile(wheeled, 9, 3).scroll).toBe(2)
    expect(scrollFile(wheeled, -9, 3).scroll).toBe(0)
  })

  it('keeps the caret in view as it moves', () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const wide = { text: many, lines: many.length, body: 5, columns: 60 }
    let panel = panelClick(filePanel('/r/a.ts'), 'caret:0:0', wide).panel as FilePanel
    for (let i = 0; i < 6; i++) panel = panelKey(panel, 'down', '', wide).panel as FilePanel
    expect(panel.edit?.row).toBe(6)
    expect(panel.scroll).toBe(4)
  })

  it('saved, comes from the file again', () => {
    const typed = panelKey(clicked(filePanel('/r/a.ts'), 0, 5), undefined, '!', inputs)
      .panel as FilePanel
    const saved = savedFile(typed, ['const!a = 1', 'const b = 2', 'done()'], 'Saved a.ts.')
    expect(saved.edit).toMatchObject({ dirty: false, row: 0, column: 6 })
    expect(saved.edit?.from).toEqual([0, 1, 2])
    expect(saved.said).toBe('Saved a.ts.')
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
      'split-beside',
      'split-below',
      'close',
    ])
    // Split, it offers to go back to one instead.
    expect(terminalMenuItems(true).map((item) => item.id)).toEqual([
      'run',
      'find',
      'rename',
      'clear',
      'unsplit',
      'close',
    ])
    // Every level, least to most, the one it is at marked.
    expect(thinkingMenuItems('high').map((item) => item.label.trim())).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      '● high',
      'xhigh',
      'max',
    ])
    // A harness not runnable yet is offered, and said to be not yet.
    const harnesses = harnessMenuItems(
      [
        { id: 'pi', title: 'pi', about: 'pi', ready: true },
        { id: 'codex', title: 'Codex', about: 'not supported yet', ready: false },
      ],
      'pi',
    )
    expect(harnesses).toMatchObject([
      { id: 'pi', label: '● pi', note: 'now' },
      { id: 'codex', off: 'not supported yet' },
    ])
    expect(laneMenuItems(false).map((item) => item.id)).toEqual([
      'rename',
      'split-beside',
      'split-below',
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
      watches: [],
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
      // Offered while it still needs setting up: turned on, it waits, and says why.
      watches: [
        {
          id: 'new-errors',
          title: 'New Sentry errors',
          means: 'Starts an agent on each new issue.',
          every: '1h',
          project: 'shop',
          on: null,
        },
        {
          id: 'regressions',
          title: 'Regressions',
          means: 'Starts an agent on each issue that came back.',
          every: '1h',
          project: 'shop',
          on: 'regressions',
        },
      ],
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
      'watch:sentry:new-errors',
      'watching:regressions',
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

  it('offers a watch only where there is a project to watch', () => {
    const watch = views[1]!.watches[0]!
    expect(watchControl('sentry', watch)).toBe('watch:sentry:new-errors')
    expect(watchControl('sentry', { ...watch, project: null })).toBeNull()
    expect(watchControl('sentry', { ...watch, project: null, on: 'new-sentry-errors' })).toBe(
      'watching:new-sentry-errors',
    )
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

describe('the Reload panel', () => {
  it('toggles between cancel and reload with tab, and submits on enter', () => {
    const panel: { kind: 'reload'; field: 'cancel' | 'reload'; busy: false } = {
      kind: 'reload',
      field: 'cancel',
      busy: false,
    }
    const toggled = panelKey(panel, 'tab', '').panel as typeof panel
    expect(toggled.field).toBe('reload')
    expect(panelKey(toggled, 'tab', '').panel).toMatchObject({ field: 'cancel' })
    expect(panelKey(panel, 'escape', '').panel).toBeNull()
    expect(panelKey(toggled, 'enter', '')).toMatchObject({ submit: true, choice: 'reload' })
    expect(panelKey(panel, 'enter', '')).toMatchObject({ submit: false })
  })

  it('submits or closes by click', () => {
    const panel: { kind: 'reload'; field: 'cancel' | 'reload'; busy: false } = {
      kind: 'reload',
      field: 'cancel',
      busy: false,
    }
    expect(panelClick(panel, 'cancel', {})).toMatchObject({ submit: false, panel: null })
    expect(panelClick(panel, 'reload', {})).toMatchObject({ submit: true, choice: 'reload' })
  })
})

describe('what a model costs', () => {
  it('is said per million tokens the way a person reads a price', () => {
    expect([5, 0.95, 12.5, 0.016, 150, 0].map(perMillion)).toEqual([
      '$5',
      '$0.95',
      '$12.50',
      '$0.016',
      '$150',
      '$0',
    ])
  })

  it('is in, out and read back from the cache — or free, or whatever a router picks', () => {
    const model = (id: string, input: number, output: number, cacheRead: number) => ({
      id,
      provider: 'openrouter',
      name: id,
      price: { input, output, cacheRead, cacheWrite: 0 },
    })
    expect(priceCells(model('openrouter/moonshotai/kimi-k2.6', 0.95, 4, 0.16))).toEqual([
      '$0.95',
      '$4',
      '$0.16',
    ])
    expect(priceSaid(model('openrouter/moonshotai/kimi-k2.6', 0.95, 4, 0.16))).toBe(
      '$0.95 in · $4 out · $0.16 cached',
    )
    expect(priceCells(model('openrouter/google/gemma-4-31b-it:free', 0, 0, 0))[0]).toBe('free')
    expect(priceCells(model('openrouter/openrouter/free', 0, 0, 0))[0]).toBe('free')
    expect(priceCells(model('openrouter/auto', 0, 0, 0))[0]).toBe('varies')
    // Not in the catalog: nothing is said rather than a guess.
    expect(priceSaid({ id: 'x/y', provider: 'x', name: 'y' })).toBeNull()
  })
})
