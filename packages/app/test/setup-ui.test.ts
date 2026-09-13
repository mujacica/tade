import type { Terminal } from '@earendil-works/pi-tui'
import type { Step } from '@wilco/core'
import { ECHO_CHILD, until } from '@wilco/drivers-core/conformance'
import { PtyDriver } from '@wilco/drivers-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { initialSetup, renderSetup, runSetupUi } from '../src/setup-ui.ts'

// The first minute, drawn rather than printed.
//
// What matters here is that Wilco keeps the keyboard: the old wizard handed
// the terminal to pi while a readline was still reading it, and the two ate
// each other's keystrokes.

const steps: Step[] = [
  { id: 'project', title: 'A project to work on', done: true, detail: '', required: true },
  {
    id: 'model',
    title: 'A model to think with',
    done: false,
    detail: 'nothing set',
    required: true,
  },
  { id: 'voice', title: 'Speech, if you want it', done: false, detail: 'no mic', required: false },
]

class FakeTerminal implements Terminal {
  columns = 80
  rows = 24
  kittyProtocolActive = false
  written = ''
  private onInput: ((data: string) => void) | null = null

  start(onInput: (data: string) => void): void {
    this.onInput = onInput
  }
  press(data: string): void {
    this.onInput?.(data)
  }
  write(data: string): void {
    this.written += data
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

describe('the setup screen', () => {
  const frame = { width: 70, height: 20 }

  it('marks what is done, what is needed and what is optional', () => {
    const rows = renderSetup(initialSetup(steps), frame).join('\n')
    expect(rows).toContain('✓ A project to work on')
    expect(rows).toContain('· A model to think with')
    // Optional is marked differently, or "speech is not set up" reads as a
    // failure on a machine that works perfectly well.
    expect(rows).toContain('○ Speech, if you want it')
  })

  it('shows the question and what has been typed at it', () => {
    const state = {
      ...initialSetup(steps),
      prompt: { question: 'repository path', fallback: '/src/app', confirm: false },
      typed: '/src/other',
    }
    const rows = renderSetup(state, frame).join('\n')
    expect(rows).toContain('repository path [/src/app]: /src/other')
  })

  it('shows which way a yes/no question falls if you just press enter', () => {
    const yes = { question: 'keep agents running?', fallback: 'y', confirm: true }
    expect(renderSetup({ ...initialSetup(steps), prompt: yes }, frame).join('\n')).toContain(
      '[Y/n]',
    )
    const no = { ...yes, fallback: 'n' }
    expect(renderSetup({ ...initialSetup(steps), prompt: no }, frame).join('\n')).toContain('[y/N]')
  })

  it('tails an embedded terminal, because the newest line is the one to answer', () => {
    const screen = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const rows = renderSetup(
      { ...initialSetup(steps), running: { title: 'pi', screen } },
      { width: 70, height: 16 },
    ).join('\n')
    expect(rows).toContain('line 59')
    expect(rows).not.toContain('line 0\n')
    expect(rows).toContain('ctrl+]')
  })

  it('never draws more rows than the terminal has', () => {
    const state = { ...initialSetup(steps), said: Array.from({ length: 50 }, (_, i) => `n${i}`) }
    for (const height of [6, 12, 40]) {
      expect(renderSetup(state, { width: 70, height }).length).toBeLessThanOrEqual(height)
    }
  })
})

describe('answering it', () => {
  let driver: PtyDriver | null = null
  afterEach(async () => {
    await driver?.shutdown().catch(() => {})
    driver = null
  })

  it('takes a typed answer, and an empty one means the suggestion', async () => {
    const terminal = new FakeTerminal()
    const answers: string[] = []
    await runSetupUi({ steps, terminal }, async (ui) => {
      const typed = ui.ask('repository path', '/src/app')
      await until(() => terminal.written.includes('repository path'))
      for (const char of '/src/other') terminal.press(char)
      terminal.press('\r')
      answers.push(await typed)

      const suggested = ui.ask('call it what?', 'app')
      await until(() => terminal.written.includes('call it what?'))
      terminal.press('\r')
      answers.push(await suggested)
    })
    expect(answers).toEqual(['/src/other', 'app'])
  })

  it('treats enter on a yes/no question as the suggestion', async () => {
    const terminal = new FakeTerminal()
    const said: boolean[] = []
    await runSetupUi({ steps, terminal }, async (ui) => {
      const keep = ui.confirm('keep agents running?', true)
      await until(() => terminal.written.includes('keep agents running?'))
      terminal.press('\r')
      said.push(await keep)

      const speech = ui.confirm('set up speech?', false)
      await until(() => terminal.written.includes('set up speech?'))
      terminal.press('\r')
      said.push(await speech)
    })
    expect(said).toEqual([true, false])
  })

  it('sends every keystroke to the program it is running, and nothing else', async () => {
    const terminal = new FakeTerminal()
    driver = new PtyDriver({ scrollback: 200 })
    let code: number | null = null
    await runSetupUi({ steps, terminal, driver }, async (ui) => {
      const running = ui.run('echo', process.execPath, [ECHO_CHILD])
      await until(() => terminal.written.includes('ready'))

      // This is the thing the old wizard got wrong: with two readers of stdin,
      // half of what you typed went to the wrong one.
      for (const char of 'hello\r') terminal.press(char)
      await until(() => terminal.written.includes('got:hello'))

      for (const char of 'exit\r') terminal.press(char)
      code = await running
    })
    expect(code).toBe(0)
  }, 30_000)

  it('puts the terminal back however it ends', async () => {
    const terminal = new FakeTerminal()
    await expect(
      runSetupUi({ steps, terminal }, async () => {
        throw new Error('a step went wrong')
      }),
    ).rejects.toThrow('a step went wrong')
    // Leaving somebody in the alternate screen because setup failed would be a
    // worse first minute than the one this replaced.
    expect(terminal.written).toContain('\x1b[?1049l')
  })
})
