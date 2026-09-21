import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, until, windowUnderTest } from './harness.ts'

// It starts, draws what it found, stops, and reloads. Nothing here is about
// one subject: this is `App` itself — the lifecycle, and the bar along the
// bottom that says what is true while it runs.

describe('the window, booted', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })

  it('boots and draws the tasks it found', async () => {
    await start()
    await until('the tasks to be drawn', () => terminal.written.includes('refunds'))
    expect(terminal.written).toContain('search')
    expect(terminal.written).toContain('app')
  })

  it('always shows the orchestrator', async () => {
    await start()
    // It cannot be closed: it is how you see what Tade heard.
    await until('the orchestrator strip', () => terminal.written.includes('orchestrator'))
  })

  it('stops cleanly, and stopping twice is safe', async () => {
    const started = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await started.stop()
    await started.stop()
    // Whoever is waiting on the window is released, or this never resolves.
    await started.wait()
  })

  it('reloads when the reload key is pressed and nothing is running', async () => {
    let reloaded = false
    await start({
      reloadWindow: async () => {
        reloaded = true
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x1b[114;6u')
    await until('reload to be called', () => reloaded)
  })

  it('warns before reloading when lanes cannot survive', async () => {
    await client.openTerminal({ project: 'app' })
    let reloaded = false
    await start({
      reloadWindow: async () => {
        reloaded = true
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    terminal.press('\x1b[114;6u')
    await until('the reload panel', () => terminal.written.includes('Reload Tade?'))
    expect(reloaded).toBe(false)
    // Dismiss the panel so the test ends cleanly.
    terminal.written = ''
    terminal.press('\x1b')
    await until('the panel to close', () => !terminal.written.includes('Reload Tade?'))
  })

  it('opens the Spend panel from the status bar', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('today'))
    const status = find('today')
    terminal.written = ''
    click(status.col + 1, status.row)
    await until('the spend panel', () => terminal.written.includes('BUDGETS'))
  })

  it('shows agent spend in the status bar', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('today'))
    terminal.written = ''
    await client.log.append({
      type: 'usage',
      task: 'app/refunds',
      detail: { model: 'anthropic/claude-sonnet-5', tokens: 1500, usd: 0.351 },
    })
    await until('agent spend in status bar', () => terminal.written.includes('$0.35'))
  })
})
