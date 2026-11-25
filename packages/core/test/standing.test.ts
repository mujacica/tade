import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import { AWAY_REQUEST_SAID, ORCHESTRATOR_SAID, standingWarnings } from '../src/standing.ts'

// Which of the journal's warnings still stand, as the journal's lines say,
// in the order the window writes them.
function journal(...lines: (Pick<TadeEvent, 'type'> & { message?: string })[]): TadeEvent[] {
  return lines.map(({ type, message }, at) => ({
    seq: at + 1,
    ts: '2026-11-25T09:00:00.000Z',
    type,
    urgency: 'routine',
    task: null,
    lane: null,
    run: null,
    detail: message === undefined ? {} : { message },
  }))
}

const said = (events: TadeEvent[]) => standingWarnings(events).map((event) => event.detail.message)

const unplaced = `${ORCHESTRATOR_SAID}claude-code cannot run "unknown/unknown"`
const aborted = `${AWAY_REQUEST_SAID}Error: aborted`

describe('a start of the orchestrator inside one window supersedes what an earlier start said of it', () => {
  it('drops what the start before said once it is started again, as a model chosen or an account moved does', () => {
    const events = journal(
      { type: 'tade_opened' },
      { type: 'orchestrator_started' },
      { type: 'warning', message: unplaced },
      // opus chosen: started again in the same window, and it placed it
      { type: 'orchestrator_started' },
    )
    expect(said(events)).toEqual([])
  })

  it('keeps what the start now running said, and what is not the orchestrator’s', () => {
    const compaction = 'the journal is over its ceiling with nothing left to drop'
    const events = journal(
      { type: 'tade_opened' },
      { type: 'orchestrator_started' },
      { type: 'warning', message: unplaced },
      { type: 'warning', message: aborted },
      { type: 'warning', message: compaction },
      { type: 'orchestrator_started' },
      { type: 'warning', message: unplaced },
    )
    // The away view's line is the window's, which a start of the orchestrator does not supersede.
    expect(said(events)).toEqual([unplaced, compaction, aborted])
    expect(standingWarnings(events)[0]?.seq).toBe(7)
  })

  it('keeps every orchestrator line where no start of it is in the journal, as before', () => {
    const events = journal({ type: 'warning', message: unplaced })
    expect(said(events)).toEqual([unplaced])
  })
})
