import { describe, expect, it } from 'vitest'
import { panelClick, panelKey, spendPanel } from '../src/panels.ts'

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
