import type { PlanSource, TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { textOf } from '../src/input.ts'
import {
  extensionSetupPanel,
  extensionViewPanel,
  type SetupFieldView,
  setupControls,
} from '../src/panels/extensions/setup.ts'
import {
  chosenEntry,
  type ExtensionView,
  extensionControls,
  extensionEntries,
  extensionsPanel,
  HARNESS,
  listStart,
  toolSummary,
  WRITTEN,
  watchControl,
} from '../src/panels/extensions/state.ts'
import {
  type FilePanel,
  filePanel,
  fileSelection,
  savedFile,
  scrollFile,
} from '../src/panels/file/state.ts'
import {
  accountMenuItems,
  agentOffers,
  branchMenuItems,
  changeMenuItems,
  fileMenuItems,
  harnessMenuItems,
  laneMenuItems,
  menuItems,
  terminalMenuItems,
  thinkingMenuItems,
} from '../src/panels/menu/state.ts'
import { perMillion, priceCells, priceSaid } from '../src/panels/models/state.ts'
import { searchPanel } from '../src/panels/search/state.ts'
import { accountActions, settingsPanel } from '../src/panels/settings/state.ts'
import {
  branchChoices,
  branchPanel,
  closeDonePanel,
  findPanel,
  noteFacts,
  noteHeadlinePanel,
  notePanel,
  promptPanel,
} from '../src/panels/small/state.ts'
import { spendPanel } from '../src/panels/spend/state.ts'
import { type Panel, panelClick, panelDismiss, panelKey } from '../src/panels.ts'
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

  describe('what it says about a subscription', () => {
    const now = Date.parse('2026-09-13T14:00:00.000Z')
    const HOUR = 3_600_000
    const view = (plan: PlanSource[]) =>
      spendView([], {
        window: 'today',
        by: 'agent',
        now,
        openedAt: now - HOUR,
        projects: ['search'],
        budgets: {},
        plan,
      })

    it('reads a plan as shares of windows and how long until each comes back', () => {
      const [row] = view([
        {
          harness: 'claude-code',
          account: null,
          can: 'while-working',
          why: 'says it while an agent replies',
          said: {
            at: now - 4 * 60_000,
            windows: [
              { label: '5h', used: 78, resetsAt: now + 2 * HOUR },
              { label: '7d', used: 21, resetsAt: now + 40 * HOUR },
            ],
          },
        },
      ]).plan
      expect(row?.label).toBe('claude-code')
      expect(row?.cannotTell).toBeNull()
      expect(row?.windows).toEqual([
        { label: '5h', used: 78, resetsIn: 2 * HOUR },
        { label: '7d', used: 21, resetsIn: 40 * HOUR },
      ])
      expect(row?.saidAgo).toBe(4 * 60_000)
    })

    it('gives a harness that cannot say its own sentence, and no figures', () => {
      const [row] = view([
        {
          harness: 'pi',
          account: null,
          can: 'none',
          why: 'is never told what a plan has left: it prices every turn instead',
          said: null,
        },
      ]).plan
      expect(row?.windows).toEqual([])
      expect(row?.saidAgo).toBeNull()
      expect(row?.cannotTell).toBe(
        'is never told what a plan has left: it prices every turn instead',
      )
    })

    it('names the account beside the harness, so two of one are told apart', () => {
      const rows = view([
        { harness: 'codex', account: 'work', can: 'none', why: 'nothing yet', said: null },
        { harness: 'codex', account: null, can: 'none', why: 'nothing yet', said: null },
      ]).plan
      expect(rows.map((row) => row.label)).toEqual(['codex @work', 'codex'])
    })

    it('has nothing to say when no harness was read', () => {
      expect(
        spendView([], {
          window: 'today',
          by: 'agent',
          now,
          openedAt: now - HOUR,
          projects: ['search'],
          budgets: {},
        }).plan,
      ).toEqual([])
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
      // Under the model's own name: `anthropic/claude-sonnet-5` is how the
      // route reached it, and the row is the model rather than the route.
      expect(view('model', runs).rows.find((r) => r.label === 'claude-sonnet-5')?.runtime?.ms).toBe(
        30 * 60_000,
      )
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
    // And for the third: a click on the window behind it, which is a miss far
    // more often than it is a decision.
    expect(panelDismiss(typed).panel).toMatchObject({ warned: true })
    expect(panelDismiss(panelDismiss(typed).panel as FilePanel).panel).toBeNull()
    // Nothing typed, nothing to ask about.
    const put = clicked(filePanel('/r/a.ts'), 0, 0)
    expect(panelKey(put, 'escape', '\x1b', inputs).panel).toBeNull()
    expect(panelDismiss(put).panel).toBeNull()
    expect(panelDismiss(searchPanel('refunds')).panel).toBeNull()
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

  it('is copied only where there is something to copy', () => {
    const put = clicked(filePanel('/r/a.ts'), 0, 0)
    expect(panelKey(put, 'ctrl+shift+c', '', inputs)).toMatchObject({ submit: false })
    const some = panelKey(put, 'shift+right', '', inputs).panel as FilePanel
    // However the terminal ordered the modifiers: the ones that speak the
    // Kitty protocol report this one as `shift+ctrl+c`.
    for (const key of ['ctrl+shift+c', 'shift+ctrl+c', 'super+c']) {
      expect(panelKey(some, key, '', inputs)).toMatchObject({
        submit: true,
        choice: 'copy-selection',
      })
    }
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

describe('selecting in a file', () => {
  const text = ['const a = 1', 'const b = 2', '', 'done()']
  const inputs = { text, lines: text.length, body: 4, columns: 60 }
  const at = (panel: Panel, line: number, cell: number, how = 'put') =>
    panelClick(panel, `caret:${line}:${cell}:${how}`, inputs).panel as FilePanel
  const press = (panel: Panel, key: string) => panelKey(panel, key, '', inputs).panel as FilePanel
  const chosen = (panel: FilePanel) => {
    const span = fileSelection(panel)
    return span ? textOf(panel.edit?.lines ?? [], span) : null
  }

  it('reaches further with shift and an arrow, over as many lines as it is held for', () => {
    let panel = at(filePanel('/r/a.ts'), 0, 6)
    expect(chosen(panel)).toBeNull()
    panel = press(panel, 'shift+down')
    expect(chosen(panel)).toBe('a = 1\nconst ')
    panel = press(panel, 'shift+down')
    expect(chosen(panel)).toBe('a = 1\nconst b = 2\n')
    panel = press(panel, 'shift+end')
    expect(chosen(panel)).toBe('a = 1\nconst b = 2\n')
    expect(panel.edit).toMatchObject({ row: 2, column: 0 })
  })

  it('reads the same when it ends above where it began', () => {
    const down = press(at(filePanel('/r/a.ts'), 0, 6), 'shift+down')
    const up = press(at(filePanel('/r/a.ts'), 1, 6), 'shift+up')
    expect(chosen(up)).toBe('a = 1\nconst ')
    expect(chosen(up)).toBe(chosen(down))
    // The caret is at the end it was sent towards, either way.
    expect(up.edit).toMatchObject({ row: 0, column: 6 })
    expect(down.edit).toMatchObject({ row: 1, column: 6 })
  })

  it('crosses a word with shift and ctrl, and a page with shift and a page key', () => {
    const word = press(at(filePanel('/r/a.ts'), 0, 0), 'shift+ctrl+right')
    expect(chosen(word)).toBe('const')
    const page = press(at(filePanel('/r/a.ts'), 0, 0), 'shift+pageDown')
    expect(page.edit?.row).toBe(3)
    expect(chosen(page)).toBe('const a = 1\nconst b = 2\n\n')
  })

  it('takes everything on ctrl+a, and lets go on a move without shift', () => {
    const all = press(at(filePanel('/r/a.ts'), 0, 0), 'ctrl+a')
    expect(chosen(all)).toBe(text.join('\n'))
    // Plain left collapses to the near end of it rather than stepping on.
    const near = press(all, 'left')
    expect(chosen(near)).toBeNull()
    expect(near.edit).toMatchObject({ row: 0, column: 0 })
    expect(chosen(press(press(all, 'shift+left'), 'down'))).toBeNull()
  })

  it('is what a second and a third press take, and shift reaches on from it', () => {
    const word = at(filePanel('/r/a.ts'), 0, 6, 'word')
    expect(chosen(word)).toBe('a')
    const line = at(filePanel('/r/a.ts'), 1, 3, 'line')
    expect(chosen(line)).toBe('const b = 2')
    // Shift after a double click reaches on from where the word started.
    const on = press(press(word, 'shift+down'), 'shift+end')
    expect(chosen(on)).toBe('a = 1\nconst b = 2')
  })

  it('is dragged over the lines the pointer crossed, and shift+click reaches there', () => {
    let panel = at(filePanel('/r/a.ts'), 0, 6)
    panel = at(panel, 1, 5, 'drag')
    expect(chosen(panel)).toBe('a = 1\nconst')
    panel = at(panel, 3, 4, 'drag')
    expect(chosen(panel)).toBe('a = 1\nconst b = 2\n\ndone')
    // Back above where it started: the same two ends, the other way round.
    panel = at(panel, 0, 0, 'drag')
    expect(chosen(panel)).toBe('const ')
    expect(chosen(at(at(filePanel('/r/a.ts'), 0, 6), 3, 4, 'extend'))).toBe(
      'a = 1\nconst b = 2\n\ndone',
    )
  })

  it('is what typing replaces, and what backspace and delete take', () => {
    const start = at(at(filePanel('/r/a.ts'), 0, 6), 1, 5, 'drag')
    const typed = panelKey(start, undefined, 'X', inputs).panel as FilePanel
    expect(typed.edit?.lines).toEqual(['const X b = 2', '', 'done()'])
    expect(typed.anchor).toBeNull()
    for (const key of ['backspace', 'delete']) {
      const gone = press(start, key)
      expect(gone.edit?.lines).toEqual(['const  b = 2', '', 'done()'])
      expect(gone.edit).toMatchObject({ row: 0, column: 6 })
      expect(gone.anchor).toBeNull()
    }
    // A paste replaces it the same way, lines and all.
    const pasted = panelKey(start, undefined, '\x1b[200~one\ntwo\x1b[201~', inputs)
      .panel as FilePanel
    expect(pasted.edit?.lines).toEqual(['const one', 'two b = 2', '', 'done()'])
  })

  it('is let go of when the caret is sent somewhere else', () => {
    const some = press(at(filePanel('/r/a.ts'), 0, 6), 'shift+down')
    expect(chosen(some)).not.toBeNull()
    let bar = panelKey(some, 'ctrl+g', '\x07', inputs).panel as Panel
    bar = panelKey(bar, '4', '4', inputs).panel as Panel
    const went = panelKey(bar, 'enter', '\r', inputs).panel as FilePanel
    expect(went.edit).toMatchObject({ row: 3, column: 0 })
    expect(chosen(went)).toBeNull()
  })

  it('counts tabs and wide characters as the cells they are drawn in', () => {
    const wide = ['\tこんにちは x', 'done()']
    const cells = { text: wide, lines: wide.length, body: 4, columns: 60 }
    // The tab is two cells, then five wide characters at two each.
    const put = panelClick(filePanel('/r/a.ts'), 'caret:0:2:put', cells).panel as FilePanel
    const to = panelClick(put, 'caret:0:12:drag', cells).panel as FilePanel
    const span = fileSelection(to)
    expect(span && textOf(to.edit?.lines ?? [], span)).toBe('こんにちは')
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

  it('opens on its own page: its words, what it is about, and who said it when', () => {
    const panel = notePanel(
      {
        at: '2026-09-03T09:00:00.000Z',
        summary: 'Refunds via the ledger',
        scope: 'checkout/refunds',
        by: 'orchestrator',
      },
      'refunds go through the ledger service',
    )
    // The words are the field, so reading it and changing it are one page.
    expect(panel).toMatchObject({
      purpose: 'edit-note',
      title: 'Note',
      text: 'refunds go through the ledger service',
    })
    expect(noteFacts(panel.note!, 'Thu 3 Sep 09:00')).toEqual({
      about: 'About checkout/refunds',
      said: 'Said by the orchestrator · Thu 3 Sep 09:00',
    })
  })

  it('says a note is about everything where it is, and that you said it yourself', () => {
    const facts = noteFacts(
      { at: '2026-09-04T09:00:00.000Z', summary: null, scope: null, by: 'voice' },
      'Fri 4 Sep 09:00',
    )
    expect(facts.about).toBe('About everything')
    expect(facts.said).toBe('Said by you · Fri 4 Sep 09:00')
    // A note from before anybody recorded where one came from claims nothing.
    expect(noteFacts({ at: 'x', summary: null, scope: null, by: 'unknown' }, 'then').said).toBe(
      'Said by somebody · then',
    )
  })

  it('is given the headline it is read by from its own page, and nowhere else', () => {
    const known = {
      at: '2026-09-01T09:00:00.000Z',
      summary: null,
      scope: 'checkout',
      by: 'window',
    }
    const page = notePanel(known, 'the staging key rotates on the 1st')
    expect(panelClick(page, 'headline')).toMatchObject({ submit: true, choice: 'headline' })

    const asking = noteHeadlinePanel(known, 'the staging key rotates on the 1st')
    expect(asking).toMatchObject({ purpose: 'note-headline', text: '' })
    // It names the note it is about, so saving it changes that one and no other.
    expect(asking.target).toBe('2026-09-01T09:00:00.000Z\u0000the staging key rotates on the 1st')
    // A headline that says nothing is not a headline.
    expect(panelKey(asking, 'enter', '\r')).toMatchObject({
      submit: false,
      panel: { error: 'Write the headline first.' },
    })
  })

  it('copies and forgets from its own page, as its menu does', () => {
    const panel = notePanel(
      { at: '2026-09-03T09:00:00.000Z', summary: null, scope: 'checkout', by: 'window' },
      'we pin major versions',
    )
    expect(panelClick(panel, 'copy')).toMatchObject({ submit: true, choice: 'copy' })
    expect(panelClick(panel, 'forget')).toMatchObject({ submit: true, choice: 'forget' })
    // Nothing else grows those buttons: a branch name is not a note.
    expect(panelClick(promptPanel('new-branch', 'New branch', 'NAME'), 'forget')).toMatchObject({
      submit: false,
    })
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
    // Only the levels its harness can be told, least to most.
    expect(
      thinkingMenuItems('high', ['low', 'high', 'max']).map((item) => item.label.trim()),
    ).toEqual(['low', '● high', 'max'])
    // A harness not runnable yet is offered, and said to be not yet.
    const harnesses = harnessMenuItems(
      [
        { id: 'pi', title: 'pi', about: 'pi', ready: true },
        { id: 'later', title: 'Later', about: 'not supported yet', ready: false },
      ],
      'pi',
    )
    expect(harnesses).toMatchObject([
      { id: 'pi', label: '● pi', note: 'now' },
      { id: 'later', off: 'not supported yet' },
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
      description: 'Finds what a project depends on that is out of date.',
      workflow: ['Looking before you touch anything.'],
      source: 'built-in',
      state: 'ready',
      problem: null,
      tools: [
        { name: 'deps_check', summary: "Check a project's dependencies", for: ['orchestrator'] },
      ],
      actions: [{ id: 'check', title: 'Check dependencies' }],
      options: [],
      unknownSettings: [],
      configurable: true,
      folder: null,
      watches: [],
    },
    {
      name: 'sentry',
      title: 'Sentry',
      description: 'Reads the errors your projects send to Sentry.',
      workflow: ['Turning an error into work.'],
      source: 'built-in',
      state: 'needs setup',
      problem: 'which organization?',
      tools: [],
      actions: [{ id: 'new', title: 'New issues' }],
      options: [
        { key: 'token', label: 'API key', value: '', have: '$SENTRY_AUTH_TOKEN', secret: true },
      ],
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
  const written = [{ name: 'notes', why: 'x', path: '/p/notes.ts', on: false }]
  const harness = [{ name: 'plan-mode', where: '~/.pi/agent/extensions' }]
  const inputs = { extensions: views, written, harnessExtensions: harness }

  it('lists every extension, then what Tade wrote and what the harness loads itself', () => {
    expect(extensionEntries(views, written, harness).map((entry) => entry.id)).toEqual([
      'deps',
      'sentry',
      WRITTEN,
      HARNESS,
    ])
    // What wants somebody is marked, so a list of twelve says where to look.
    expect(extensionEntries(views, written, harness).map((entry) => entry.wants)).toEqual([
      false,
      true,
      false,
      false,
    ])
  })

  it('narrows the list by anything the page would say, not only the name', () => {
    const matching = (search: string) =>
      extensionEntries(views, written, harness, search).map((entry) => entry.id)
    expect(matching('sentry')).toEqual(['sentry'])
    // The word is in a tool's name, and in nothing else.
    expect(matching('deps_check')).toEqual(['deps'])
    // And in what it is for, which is how somebody who forgot the name finds it.
    expect(matching('error into work')).toEqual(['sentry'])
    expect(matching('every word must match sentry')).toEqual([])
  })

  it('has only the controls of the one you are on, in the order the keyboard walks them', () => {
    expect(extensionControls('sentry', views, written)).toEqual([
      'setup:sentry',
      'toggle:sentry',
      'watch:sentry:new-errors',
      'watching:regressions',
    ])
    // Turning it off is last: enter into the right-hand side lands on the
    // first control, and that must never be the switch.
    expect(extensionControls('deps', views, written)).toEqual([
      'setup:deps',
      'action:deps:check',
      'toggle:deps',
    ])
    expect(extensionControls(WRITTEN, views, written)).toEqual(['read:notes', 'toggle:notes'])
    // Tade only lists what pi loads: there is nothing here to press.
    expect(extensionControls(HARNESS, views, written)).toEqual([])
  })

  it('walks the list with the arrows and the right-hand side with tab, and presses with enter', () => {
    let panel = extensionsPanel('deps')
    panel = panelKey(panel, 'down', '', inputs).panel as typeof panel
    expect(panel.chosen).toBe('sentry')
    panel = panelKey(panel, 'tab', '\t', inputs).panel as typeof panel
    expect(panel.focus).toBe('body')
    expect(panelKey(panel, 'enter', '\r', inputs)).toMatchObject({
      submit: true,
      choice: 'setup:sentry',
    })
    // And back out of it to the list, which is where the arrows work again.
    expect((panelKey(panel, 'left', '', inputs).panel as typeof panel).focus).toBe('list')
  })

  it('types into the search, and shows the first thing that matches', () => {
    let panel = extensionsPanel('deps')
    panel = panelClick(panel, 'search', inputs).panel as typeof panel
    expect(panel.focus).toBe('search')
    for (const letter of 'sent')
      panel = panelKey(panel, undefined, letter, inputs).panel as typeof panel
    expect(panel.search).toBe('sent')
    // What was chosen is not in the list any more, so the first match is.
    expect(panel.chosen).toBeNull()
    expect(chosenEntry(panel, extensionEntries(views, written, harness, panel.search))?.id).toBe(
      'sentry',
    )
    // Escape in the field clears it rather than closing the panel.
    panel = panelKey(panel, 'escape', '', inputs).panel as typeof panel
    expect(panel).toMatchObject({ search: '', focus: 'list' })
    expect(panelKey(panel, 'escape', '', inputs).panel).toBeNull()
  })

  it('brings the list back to what the keyboard chose, and leaves where you scrolled it alone', () => {
    // Somebody scrolled the list away from what is chosen: it stays where
    // they put it, because they are reading it.
    expect(listStart(4, 12, 5, 0)).toBe(0)
    expect(listStart(4, 12, 5, 6)).toBe(4)
    expect(listStart(0, 12, 5, 9)).toBe(5)
    // Never past the end, and never before the start.
    expect(listStart(99, 12, 5, 11)).toBe(7)
    expect(listStart(-3, 12, 5, 0)).toBe(0)
    // Nothing to scroll is nothing scrolled.
    expect(listStart(4, 3, 5, 0)).toBe(0)

    // Walking down past the last row in view brings the list with it.
    let panel = { ...extensionsPanel('deps'), listScroll: 0 }
    panel = panelKey(panel, 'down', '', { ...inputs, listRoom: 1 }).panel as typeof panel
    expect(panel).toMatchObject({ chosen: 'sentry', listScroll: 1 })
    panel = panelKey(panel, 'up', '', { ...inputs, listRoom: 1 }).panel as typeof panel
    expect(panel).toMatchObject({ chosen: 'deps', listScroll: 0 })
  })

  it('scrolls the right-hand side as far as it has, and stops following the buttons', () => {
    let panel = { ...extensionsPanel('sentry'), focus: 'body' as const }
    panel = panelKey(panel, 'down', '', { ...inputs, scrollable: 4 }).panel as typeof panel
    expect(panel).toMatchObject({ scroll: 1, following: false })
    panel = panelKey(panel, 'end', '', { ...inputs, scrollable: 4 }).panel as typeof panel
    expect(panel.scroll).toBe(4)
    // Never past what there is to read.
    panel = panelKey(panel, 'pageDown', '', { ...inputs, scrollable: 4 }).panel as typeof panel
    expect(panel.scroll).toBe(4)
    // Tab is for the buttons, and puts the page back to wherever they are.
    panel = panelKey(panel, 'tab', '\t', { ...inputs, scrollable: 4 }).panel as typeof panel
    expect(panel.following).toBe(true)
  })

  it('clicks a name in the list, and a control on the right', () => {
    const picked = panelClick(extensionsPanel('deps'), 'pick:sentry', inputs).panel as {
      chosen: string
    }
    expect(picked.chosen).toBe('sentry')
    expect(panelClick(extensionsPanel(WRITTEN), 'toggle:notes', inputs)).toMatchObject({
      submit: true,
      choice: 'toggle:notes',
    })
    // A control of an extension you are not on is not there to be pressed.
    expect(panelClick(extensionsPanel('deps'), 'toggle:notes', inputs)).toMatchObject({
      submit: false,
    })
  })

  it('says what a tool does in a line, from what its model is told', () => {
    expect(
      toolSummary(
        'Grep that reads: give it a question in plain words and it says which lines answer it. Use it over text.',
      ),
    ).toBe('Grep that reads')
    expect(toolSummary('Judge anything against questions you write')).toBe(
      'Judge anything against questions you write',
    )
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

describe('closing every agent that has finished', () => {
  const panel = closeDonePanel(['app/shipped', 'app/reviewed'])

  it('starts on the answer that loses nothing, and asks before it closes any', () => {
    expect(panel.tasks).toEqual(['app/shipped', 'app/reviewed'])
    expect(panel.field).toBe('keep')
    // Enter where it starts keeps them; escape is the same answer.
    expect(panelKey(panel, 'enter', '')).toMatchObject({ submit: false, panel: null })
    expect(panelKey(panel, 'escape', '').panel).toBeNull()
  })

  it('closes them once you have said so, by key or by click', () => {
    const chosen = panelKey(panel, 'tab', '').panel as typeof panel
    expect(chosen.field).toBe('remove')
    expect(panelKey(chosen, 'enter', '')).toMatchObject({ submit: true })
    expect(panelClick(panel, 'keep', {})).toMatchObject({ submit: false, panel: null })
    const pressed = panelClick(panel, 'remove', {})
    expect(pressed.submit).toBe(true)
    // Busy while it runs, so the question cannot be answered twice.
    expect(pressed.panel).toMatchObject({ kind: 'close-done', busy: true })
    expect(panelKey(pressed.panel as typeof panel, 'enter', '')).toMatchObject({ submit: false })
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

describe("an agent's menu, as its harness offers it", () => {
  const running = { lane: 'app/t/agent', state: 'working' }
  const caps = (model: 'live' | 'restart' | 'none') => ({
    model,
    thinking: 'live' as const,
    rename: 'live' as const,
    thinkingLevels: ['low' as const, 'high' as const],
    why: { model: 'Claude Code takes a model only when it starts' },
  })
  const modelItem = (offers: ReturnType<typeof agentOffers> | null) =>
    menuItems(running, 0, offers).find((item) => item.id === 'model')

  it('keeps an item its harness cannot do, off, saying where', () => {
    expect(modelItem(agentOffers('claude-code', caps('none') as never))).toMatchObject({
      off: 'not in claude-code',
    })
  })

  it('says in a word that changing it starts the agent again', () => {
    expect(modelItem(agentOffers('claude-code', caps('restart') as never))).toMatchObject({
      note: 'restarts it',
    })
    expect(modelItem(agentOffers('pi', caps('live') as never))?.off).toBeUndefined()
    expect(modelItem(null)?.off).toBeUndefined()
  })
})

describe('the Accounts page', () => {
  const account = (over: Record<string, unknown>) => ({
    harness: 'claude-code',
    name: null,
    kind: 'subscription' as const,
    canAdd: true,
    why: null,
    status: { signedIn: true, who: 'you@example.com', plan: 'max', problem: null },
    limits: null,
    agents: 0,
    forNewAgents: true,
    canSignIn: true,
    ...over,
  })
  const accounts = [
    account({}),
    account({
      name: 'work',
      forNewAgents: false,
      status: { signedIn: false, who: null, plan: null, problem: 'not signed in yet' },
    }),
    account({ harness: 'pi', canAdd: false, why: 'keeps one set of sign-ins' }),
  ]

  it('offers what can be done to each account, then to its harness, in the order drawn', () => {
    expect(accountActions(accounts).map((action) => action.id)).toEqual([
      'account:sign-in:claude-code:',
      'account:sign-out:claude-code:',
      'account:sign-in:claude-code:work',
      'account:use:claude-code:work',
      'account:remove:claude-code:work',
      'account:add:claude-code:',
      'account:add-key:claude-code:',
      // pi has one account: signing in to it is all there is.
      'account:sign-in:pi:',
    ])
  })

  it('asks twice before taking an account away', () => {
    const inputs = { accountActions: accountActions(accounts) }
    const panel = { ...settingsPanel('accounts'), row: 4 }
    const once = panelKey(panel, 'enter', '\r', inputs)
    expect(once.submit).toBeFalsy()
    expect(once.panel).toMatchObject({ confirm: 'account:remove:claude-code:work' })
    const twice = panelKey(once.panel as typeof panel, 'enter', '\r', inputs)
    expect(twice).toMatchObject({ submit: true, choice: 'account:remove:claude-code:work' })
    // Anything else is done at once.
    const use = panelClick(panel, 'account:use:claude-code:work', inputs)
    expect(use).toMatchObject({ submit: true, choice: 'account:use:claude-code:work' })
  })

  it('moves an agent only to an account of its harness that is signed in', () => {
    const items = accountMenuItems(accounts, 'claude-code', '')
    expect(items.map((item) => [item.id, item.off ?? item.note ?? ''])).toEqual([
      ['', 'now'],
      ['work', 'not signed in'],
    ])
  })
})
