import type { PlanSource } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// Moving the strip's plan bar between the sign-ins, through the whole window.
//
// What each account has left is drawn from what its harness already holds, so
// nothing here waits on anybody: the test replaces what the workbench reads out
// of the adapters, because a real one has heard nothing until an agent has run.

describe('the window, and which plan the strip shows', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })

  /** Two accounts across two harnesses that can say, and one that cannot. */
  const plans = (now: number): PlanSource[] => [
    {
      harness: 'claude-code',
      account: null,
      can: 'while-working',
      pays: 'plan',
      why: 'reports it as one of its agents replies',
      said: { at: now, windows: [{ label: '5h', used: 41, resetsAt: now + 3_600_000 }] },
    },
    {
      harness: 'codex',
      account: 'work',
      can: 'while-working',
      pays: 'plan',
      why: 'says it as each turn ends',
      said: { at: now, windows: [{ label: '5h', used: 93, resetsAt: now + 3_600_000 }] },
    },
    {
      harness: 'pi',
      account: null,
      can: 'none',
      pays: 'per-token',
      why: 'prices every turn instead',
      said: null,
    },
  ]

  it('starts on the tightest and moves to the next sign-in when its name is pressed', async () => {
    terminal.columns = 150
    client.planUsage = () => plans(Date.now())
    await start()
    // The one about to stop somebody working, named because it is not the only
    // one with something to say.
    await until('the tightest plan in the strip', () =>
      screenOf(terminal.written).some((row) => row.includes('codex @work ⇄')),
    )
    expect(screenOf(terminal.written).at(-1)).toContain('93%')

    const name = find('codex @work ⇄')
    terminal.written = ''
    click(name.col, name.row)
    await until('the other sign-in', () =>
      screenOf(terminal.written).some((row) => row.includes('claude-code ⇄')),
    )
    expect(screenOf(terminal.written).at(-1)).toContain('41%')

    // And round again: the one that cannot say is never stopped on.
    const back = find('claude-code ⇄')
    terminal.written = ''
    click(back.col, back.row)
    await until('back to the tightest', () =>
      screenOf(terminal.written).some((row) => row.includes('codex @work ⇄')),
    )
  })
})
