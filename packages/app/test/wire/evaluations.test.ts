import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// The Evaluations panel, through the whole window: typed open from the line,
// folded from the journal the workbench wrote — read whole with the journal's
// own reader, not the window's newest five hundred lines — and moved between
// its tabs with the keys the Spend page answers.

describe('the window, and the Evaluations panel', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })

  it('opens from /evals and scores the work the journal says was done', async () => {
    for (const [task, harness, model] of [
      ['app/refunds', 'claude-code', 'claude-opus-5'],
      ['app/ledger', 'pi', 'kimi-k2'],
    ] as const) {
      await client.log.append({ type: 'task_created', task, detail: { workspace: 'worktree' } })
      await client.log.append({
        type: 'run_started',
        task,
        run: `${task}/agent`,
        detail: { harness, model },
      })
    }
    await client.log.append({
      type: 'task_done',
      task: 'app/refunds',
      detail: { by: 'rule', rule: 'merged' },
    })
    terminal.rows = 40
    terminal.columns = 130
    await start()

    const line = find('Ask Tade anything')
    click(line.col, line.row)
    await until('the line open', () =>
      screenOf(terminal.written).some((row) => row.includes('enter sends')),
    )
    for (const char of '/evals') terminal.press(char)
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes('/evals')),
    )
    terminal.press('\r')
    await until('the panel', () => terminal.written.includes('Evaluations'))
    await until('a row per harness, once the journal is read', () => {
      const screen = screenOf(terminal.written)
      return (
        screen.some((row) => /claude-code\s+1\s+1\/1\s+1\/1/.test(row)) &&
        screen.some((row) => /\bpi\s+1\s+0\/1\s+0\/1/.test(row))
      )
    })

    // tab moves to the next grouping, as it does on the Spend page.
    terminal.press('\t')
    await until('by model', () => screenOf(terminal.written).some((row) => /kimi-k2\s+1/.test(row)))
    expect(screenOf(terminal.written).some((row) => row.includes('MODEL'))).toBe(true)
  })
})
