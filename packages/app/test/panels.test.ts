import { describe, expect, it } from 'vitest'
import { filePanel, panelClick, panelKey, searchPanel, spendPanel } from '../src/panels.ts'
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
