import { noRuntime } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import { initialState, type TaskSnapshot, withProjects, withTasks } from '../src/model.ts'
import { renderApp } from '../src/view.ts'

// What the strip says today cost.
//
// One slot, drawn whatever else the strip gives up, and three different claims
// about the same day: a figure is what somebody was charged, `—` is effort no
// dollar here covers, and a nought is a day where nothing ran and nothing was
// counted. No two of them may collapse into one — a harness that has reported
// nothing is silence and not a nought, and silence drawn as `$0.00` reads as
// free — and the slot may never be left empty, which is what `today ▾` with
// nothing in front of it was: a figure that looks as though it failed to load.

/** The same row without its colour, so a figure can be looked for in it. */
const plain = (row: string) =>
  row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

const tasks: TaskSnapshot[] = [
  { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
]

/**
 * The bottom row of the window, which is where the figure is.
 *
 * Eighty columns unless said, which is narrow enough that everything shedable
 * has been shed — so what is left is what this slot keeps whatever happens.
 */
const strip = (spend: Frame['spend'], width = 80): string => {
  const state = withTasks(withProjects(initialState(), ['checkout']), tasks)
  const rows = renderApp(state, { width, height: 24, screen: '', spend })
  return plain(rows[rows.length - 1] ?? '')
}

/** A day whose agents ran, so the day is never mistaken for an idle one. */
const ran = { ...noRuntime(), ms: 80 * 60_000, runs: 2, running: true }

describe('what today cost, in the strip', () => {
  it('draws the figure where money was reported, even with no tokens against it', () => {
    const footer = strip({ tokens: 0, usd: 0.351, hasCost: true, byTask: {} })
    expect(footer).toContain('$0.35 today ▾')
  })

  it('says the money cannot be told where nothing was priced, rather than leaving the slot empty', () => {
    const footer = strip({
      tokens: 1_900_000,
      usd: 0,
      hasCost: false,
      byTask: {},
      runtime: ran,
    })
    expect(footer).toContain('— today ▾')
    // Never a nought, which reads as free where a plan pays a flat fee.
    expect(footer).not.toContain('$0.00')
    expect(footer).not.toContain('nothing spent')
  })

  it('does not call a harness that has reported nothing a day that cost nothing', () => {
    // Agents ran and not one of them said what they cost.
    const footer = strip({ tokens: 0, usd: 0, hasCost: false, byTask: {}, runtime: ran })
    expect(footer).toContain('— today ▾')
    expect(footer).not.toContain('nothing spent')
  })

  it('calls a day nothing ran in and nothing was counted for a nought', () => {
    const footer = strip({ tokens: 0, usd: 0, hasCost: false, byTask: {}, runtime: noRuntime() })
    expect(footer).toContain('nothing spent today ▾')
  })

  it('claims no nought before it has read what ran', () => {
    const footer = strip({ tokens: 0, usd: 0, hasCost: false, byTask: {} })
    expect(footer).toContain('— today ▾')
    expect(footer).not.toContain('nothing spent')
  })

  it('draws what a plan’s day would have cost at list price, marked as that', () => {
    // A day a subscription paid for: no bill, and not nothing either. `—` where
    // that figure exists is the hole people leave Tade to run `ccusage` for, and
    // this slot is the one the strip never gives up.
    const footer = strip({
      tokens: 1_900_000,
      usd: 0,
      hasCost: false,
      usdOnPlan: 11.4,
      onPlan: 'listed',
      byTask: {},
      runtime: ran,
    })
    expect(footer).toContain('≈$11.40 at list today ▾')
    // Marked and worded, so it can never be read as a bill: nobody is charged a
    // plan per turn. And never a nought, which reads as free.
    expect(footer).not.toContain('$11.40 today')
    expect(footer).not.toContain('$0.00')
  })

  it('draws it as a floor where some of a plan’s turns had no rate', () => {
    const footer = strip({
      tokens: 1_900_000,
      usd: 0,
      hasCost: false,
      usdOnPlan: 11.4,
      onPlan: 'partly',
      byTask: {},
      runtime: ran,
    })
    expect(footer).toContain('≥≈$11.40 at list today ▾')
  })

  it('keeps the bill in that slot where there is one, and the estimate beside it', () => {
    // Both in one day — an orchestrator on an API key and agents on a plan — is
    // the ordinary case, and the two are never added: the money keeps the slot
    // that never sheds, and the estimate is its own figure with its own word —
    // one the strip gives up where there is no room, because the money beside it
    // is the figure worth keeping and this one is a click away on the page.
    const footer = strip(
      {
        tokens: 1_900_000,
        usd: 9.64,
        hasCost: true,
        usdOnPlan: 11.4,
        onPlan: 'listed',
        byTask: {},
        runtime: ran,
      },
      150,
    )
    expect(footer).toContain('$9.64 today ▾')
    expect(footer).toContain('≈$11.40 at list')
    // And nowhere on the row is there a figure that added the two.
    expect(footer).not.toContain('21.04')
    // Narrow, the bill stays and the estimate goes — never the other way round.
    const narrow = strip({
      tokens: 1_900_000,
      usd: 9.64,
      hasCost: true,
      usdOnPlan: 11.4,
      onPlan: 'listed',
      byTask: {},
      runtime: ran,
    })
    expect(narrow).toContain('$9.64 today ▾')
    expect(narrow).not.toContain('at list')
  })
})
