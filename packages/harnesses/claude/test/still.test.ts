import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STILL_MS, stillWaiting } from '../src/still.ts'

// Claude Code gives up on a call that says nothing for 1800s, and a
// `checks_run` or a `tade_done` with leftovers took longer than that on a
// loaded machine. A call still waiting has to say so, on its own token, well
// inside that, and say what it is waiting on.

type Progress = {
  method: string
  params: { progressToken: unknown; progress: number; message: string }
}

describe('a call still waiting on Tade', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says so on its own token, well inside the thirty minutes Claude Code waits for a word', () => {
    expect(STILL_MS).toBeLessThan((30 * 60_000) / 10)
    const said: Progress[] = []
    let on = 'Tade is still running checks_run'
    const stop = stillWaiting(
      7,
      () => on,
      (message) => said.push(message as Progress),
    )
    vi.advanceTimersByTime(STILL_MS)
    on = 'nothing is finished yet: Tade is still making what you left into parked work (3 items)'
    vi.advanceTimersByTime(STILL_MS)
    expect(said).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken: 7,
          progress: 1,
          message: 'Tade is still running checks_run: 1 min so far',
        },
      },
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken: 7,
          progress: 2,
          message:
            'nothing is finished yet: Tade is still making what you left into parked work (3 items): 2 min so far',
        },
      },
    ])
    stop()
    vi.advanceTimersByTime(STILL_MS * 5)
    expect(said).toHaveLength(2)
  })

  it('counts up for as long as it waits, so every word is news to the client', () => {
    const said: Progress[] = []
    const stop = stillWaiting(
      't',
      () => 'waiting',
      (message) => said.push(message as Progress),
    )
    vi.advanceTimersByTime(STILL_MS * 40)
    stop()
    expect(said).toHaveLength(40)
    expect(said.map((one) => one.params.progress)).toEqual(said.map((_, n) => n + 1))
    expect(said.at(-1)?.params.message).toBe('waiting: 40 min so far')
  })

  it('says nothing for a call that came with no token to say it on', () => {
    const said: unknown[] = []
    const stop = stillWaiting(
      undefined,
      () => 'waiting',
      (message) => said.push(message),
    )
    vi.advanceTimersByTime(STILL_MS * 3)
    stop()
    expect(said).toEqual([])
  })
})
