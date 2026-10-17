import { stripVTControlCharacters } from 'node:util'
import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  evaluationsClick,
  evaluationsKey,
  evaluationsPanel,
} from '../src/panels/evaluations/state.ts'
import { rateCell } from '../src/panels/evaluations/view.ts'
import { draw } from '../src/view.ts'
import { evals } from './screens/scenarios/evaluations.ts'
import { base, frame } from './screens/scenarios/fixtures.ts'

// The Evaluations panel in the window: its keys, and its drawing in the room
// there is. What the cards say is core's fold, tested there.

const screen = (panel = evaluationsPanel(), width = 120, height = 34, view = evals) =>
  draw({ ...base(), panel }, frame({ width, height, evaluations: view })).rows.map((row) =>
    stripVTControlCharacters(row),
  )

describe('the Evaluations panel', () => {
  it('tabs through the groupings, the judge and the replays, and ← → through the ranges', () => {
    const panel = evaluationsPanel()
    expect(panel).toMatchObject({ tab: 'harness', window: 'all' })
    const next = evaluationsKey(panel, 'tab').panel
    expect(next).toMatchObject({ tab: 'model', scroll: 0 })
    expect(evaluationsKey(panel, 'shift+tab').panel).toMatchObject({ tab: 'replays' })
    expect(evaluationsKey(panel, 'left').panel).toMatchObject({ window: 'month' })
    expect(evaluationsKey(panel, 'right').panel).toMatchObject({ window: 'today' })
    // A line up the table, which the window moves it by (`panelMoved`).
    expect(evaluationsKey({ ...panel, scroll: 3 }, 'up')).toMatchObject({ scroll: -1 })
    expect(evaluationsKey(panel, 'escape').panel).toBeNull()
  })

  it('answers a press on a tab or a range, and nothing it does not have', () => {
    const panel = evaluationsPanel()
    expect(evaluationsClick(panel, 'tab:persona').panel).toMatchObject({ tab: 'persona' })
    expect(evaluationsClick(panel, 'window:week').panel).toMatchObject({ window: 'week' })
    expect(evaluationsClick(panel, 'tab:colour').panel).toEqual(panel)
    expect(evaluationsClick(panel, 'close').panel).toBeNull()
  })

  it('says the counts before a rate, and a rate only from five', () => {
    expect(rateCell(0, 0)).toBe('—')
    expect(rateCell(3, 4)).toBe('3/4')
    expect(rateCell(3, 5)).toBe('3/5 60%')
  })

  it('draws a row per harness and the whole of it under them', () => {
    const rows = screen()
    const line = (name: string) => rows.find((row) => row.includes(`│ ${name} `)) ?? ''
    expect(line('claude-code')).toMatch(/claude-code\s+6\s+6\/6 100%\s+6\/6 100%/)
    // Nothing recorded is said as that, never as a harness called unknown.
    expect(line('not recorded')).toMatch(/not recorded\s+1\s+0\/1/)
    expect(line('all')).toMatch(/all\s+11\s+8\/11 73%/)
  })

  it('draws billed money and a plan’s list price over their own denominators', () => {
    const rows = screen()
    // Six landed on a plan, none billed: list price only.
    expect(rows.find((row) => row.includes('│ claude-code '))).toContain('≈$2.00')
    // Across every harness: the billed two at their own price, beside the plan's six.
    const all = rows.find((row) => row.includes('│ all ')) ?? ''
    expect(all).toContain('$0.48 ≈$2.00')
  })

  it('says a judge nobody runs as that, and a journal not yet read as looking', () => {
    const judged = screen(evaluationsPanel('judge'), 120, 34, {
      ...evals,
      evaluations: { ...evals.evaluations, calibration: null },
    })
    expect(judged.some((row) => row.includes('No judge reads anything here.'))).toBe(true)
    const before = draw(
      { ...base(), panel: evaluationsPanel() },
      frame({ width: 120, height: 34, evaluations: null }),
    ).rows.map((row) => stripVTControlCharacters(row))
    expect(before.some((row) => /│ …\s/.test(row))).toBe(true)
    expect(before.some((row) => row.includes('0/'))).toBe(false)
  })

  it('draws the judge’s precision per question with its worth, and only bands that fired', () => {
    const rows = screen(evaluationsPanel('judge'))
    expect(rows.find((row) => row.includes('did_what_was_asked'))).toMatch(
      /0 of 5 · 0%\s+firing and wrong/,
    )
    expect(rows.find((row) => row.includes('secret_committed'))).toContain('too few to call')
    expect(rows.some((row) => row.includes('0.9–1.0'))).toBe(true)
    expect(rows.some((row) => row.includes('0.1–0.2'))).toBe(false)
  })

  it('gives up whole columns rather than the name, and keeps the window its size', () => {
    const narrow = screen(evaluationsPanel(), 60, 24)
    expect(narrow.some((row) => row.includes('claude-code'))).toBe(true)
    expect(narrow.some((row) => row.includes('TOKENS'))).toBe(false)
    for (const tab of ['harness', 'model', 'persona', 'template', 'judge', 'replays'] as const) {
      for (const width of [40, 60, 80, 120, 200]) {
        for (const height of [10, 24, 50]) {
          const drawn = draw(
            { ...base(), panel: evaluationsPanel(tab) },
            frame({ width, height, evaluations: evals }),
          )
          expect(drawn.rows.length, `${tab} ${width}x${height}`).toBe(height)
          for (const row of drawn.rows) {
            expect(visibleWidth(row), `${tab} ${width}x${height}`).toBe(width)
          }
        }
      }
    }
  })
})
