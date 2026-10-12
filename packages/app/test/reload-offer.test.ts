import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { drawPanel } from '../src/panels/context.ts'
import type { ReloadPanel } from '../src/panels/small/state.ts'
import { panelKey } from '../src/panels.ts'
import { context, plainRows } from './settings-panel.ts'

// The reload, offered because Tade itself was updated in this window.
//
// What is held here is that it says what Tade moved to, and says what
// reloading costs in the driver's own terms — the agents that would stop where
// lanes do not survive, the shells that close under pty where no agent runs,
// and that work carries on where they do — and that an enter meant for
// something else never reloads, because the offer arrives on its own.

const offer = (survives: boolean): ReloadPanel => ({
  kind: 'reload',
  field: 'cancel',
  busy: false,
  updated: { to: '1a2b3c4', survives },
})

const shown = (panel: ReloadPanel, running: number) =>
  plainRows(drawPanel(panel, context({ running })).panel)

describe('the reload offered after Tade moved', () => {
  it('says what Tade moved to, and that the window runs the old one until it reloads', () => {
    // As one run of words: the box's own sides out, the wrapped lines rejoined.
    const rows = shown(offer(true), 2)
      .map((row) => row.replace(/│/g, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
    expect(rows).toContain('Reload into the new Tade?')
    expect(rows).toContain('Tade was updated to 1a2b3c4.')
    expect(rows).toContain('runs the one it opened on until it reloads')
  })

  it('says agents keep working where the driver’s lanes survive, and asks plainly', () => {
    const rows = shown(offer(true), 2).join('\n')
    expect(rows).toContain('Agents keep working')
    expect(rows).not.toContain('running inside this window')
    expect(rows).toContain('Later')
    expect(rows).toMatch(/Reload(?! anyway)/)
  })

  it('names the agents that would stop where they do not, and says anyway', () => {
    const rows = shown(offer(false), 2).join('\n')
    expect(rows).toContain('2 agents are running inside this window.')
    expect(rows).toContain('Reload anyway')
  })

  it('says only the shells close under pty where no agent is running', () => {
    const rows = shown(offer(false), 0).join('\n')
    expect(rows).toContain('Terminals close under pty')
    expect(rows).not.toContain('Reload anyway')
  })

  it('keeps every row the panel’s width', () => {
    for (const [survives, running] of [
      [true, 0],
      [false, 3],
      [false, 0],
    ] as const) {
      const rows = drawPanel(offer(survives), context({ running })).panel.rows
      const width = visibleWidth(rows[0] ?? '')
      for (const row of rows) expect(visibleWidth(row)).toBe(width)
    }
  })

  it('opens on Later, so an enter meant for something else closes it', () => {
    expect(panelKey(offer(false), 'enter', '')).toMatchObject({ panel: null })
  })
})
