import { stripTerminalSequences } from '@earendil-works/pi-tui'
import type { TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { drawPanel, type PanelContext } from '../src/panels/context.ts'
import { spendPanel } from '../src/panels/spend/state.ts'
import { panelClick, panelKey } from '../src/panels.ts'
import { COLOUR } from '../src/skin.ts'
import { SPEND_WINDOWS, type SpendWindow, sinceOf, spendView } from '../src/spend.ts'

// How far back the Spend page is looking.
//
// Today and seven days were the whole of it, which made "what has this cost us
// since we started?" a question nobody could ask here: the journal has every
// event of it and the page offered no way to read them. Five ranges now, out to
// the journal itself — which is nought, because the events are append-only and
// every one of them is still there.
//
// One list (`SPEND_WINDOWS`) and one piece of arithmetic (`sinceOf`), read by
// this page and by every extension's page, so there is one idea of a day in
// Tade and nothing downstream can invent a second.

const NOW = Date.parse('2026-09-13T12:00:00.000Z')
const DAY = 86_400_000

let seq = 0
const usage = (at: string, over: Record<string, unknown> = {}): TadeEvent =>
  ({
    seq: ++seq,
    ts: at,
    type: 'usage',
    urgency: 'routine',
    task: 'checkout/refunds',
    lane: null,
    run: `r${seq}`,
    detail: {
      model: 'claude-opus-5',
      harness: 'pi',
      tokens: 1000,
      usd: 1,
      priced: 'exact',
      ...over,
    },
  }) as TadeEvent

/** What each range is asked over, apart from the range itself. */
const ASKED = {
  by: 'agent' as const,
  now: NOW,
  openedAt: NOW - 3_600_000,
  projects: ['checkout'],
  budgets: {},
}

/** What the Spend panel reads of the window, and nothing else. */
const context = (spend: PanelContext['spend'], over: Partial<PanelContext> = {}): PanelContext =>
  ({
    width: 96,
    height: 40,
    skin: COLOUR,
    pointer: { hover: null, pressed: null },
    spend,
    panes: [],
    project: 'checkout',
    ...over,
  }) as PanelContext

describe('how far back the page can look', () => {
  it('measures each range from a midnight, and the longest from nothing', () => {
    // A whole day at a time, the way somebody asking for a week means it: `7
    // days` is this one and the six before it, not the last 168 hours. And the
    // longest range is the journal itself — nought, so nothing in it is cut off
    // by a number somebody picked.
    const opened = NOW - 3_600_000
    const midnight = sinceOf('today', NOW, opened)
    expect(sinceOf('window', NOW, opened)).toBe(opened)
    expect(sinceOf('week', NOW, opened)).toBe(midnight - 6 * DAY)
    expect(sinceOf('month', NOW, opened)).toBe(midnight - 29 * DAY)
    expect(sinceOf('all', NOW, opened)).toBe(0)
  })

  it('reads the whole journal when it is asked to, and today when it is not', () => {
    // Ten months old, so it is in the journal and in no shorter range.
    const lastYear = usage('2025-11-02T09:00:00.000Z', { usd: 3 })
    const today = usage('2026-09-13T11:00:00.000Z', { usd: 2 })
    const over = (window: SpendWindow) => spendView([lastYear, today], { ...ASKED, window }).usd
    expect(over('today')).toBe(2)
    expect(over('week')).toBe(2)
    expect(over('month')).toBe(2)
    expect(over('all')).toBe(5)
  })

  it('says which range found nothing, rather than that something did', () => {
    // With five of them, `Nothing in this window.` is the answer to whichever
    // range the reader happens to think they are on — and one of them is
    // called This window.
    const empty = (window: SpendWindow) =>
      drawPanel({ ...spendPanel(), window }, context(spendView([], { ...ASKED, window })))
        .panel.rows.map((row) => stripTerminalSequences(row))
        .join('\n')
    expect(empty('today')).toContain('Nothing today.')
    expect(empty('window')).toContain('Nothing since Tade opened.')
    expect(empty('month')).toContain('Nothing in 30 days.')
    expect(empty('all')).toContain('Nothing in the journal.')
  })
})

describe('reaching a range', () => {
  it('steps along them with the arrows, and wraps', () => {
    expect(panelKey(spendPanel(), 'right', '').panel).toMatchObject({ window: 'window' })
    // Backwards off Today is the far end of the list, which is the whole
    // journal: the ranges wrap, so the longest one is one key from the
    // shortest whichever way somebody goes looking for it.
    expect(panelKey(spendPanel(), 'left', '').panel).toMatchObject({ window: 'all' })
  })

  it('reaches every one of them by name', () => {
    // Each is a control on the page, and a range nothing can select is one the
    // page only claims to have.
    for (const window of SPEND_WINDOWS) {
      expect(panelClick(spendPanel(), `window:${window.id}`).panel).toMatchObject({
        window: window.id,
      })
    }
  })

  it('draws every one of them, and says which it is on', () => {
    const drawn = drawPanel(
      { ...spendPanel(), window: 'month' },
      context(spendView([], { ...ASKED, window: 'month' })),
    ).panel.rows.map((row) => stripTerminalSequences(row))
    for (const window of SPEND_WINDOWS) {
      expect(drawn.join('\n'), window.id).toContain(window.label)
    }
    // And it wraps under its own word rather than running off the edge, which
    // is what five of them stopped fitting beside the figures for.
    expect(drawn.some((row) => row.includes('for ') && row.includes('Today'))).toBe(true)
  })
})
