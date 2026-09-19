import type { Terminal } from '@earendil-works/pi-tui'
import { ECHO_CHILD, until } from '@tade/drivers-core/conformance'
import { PtyDriver } from '@tade/drivers-pty'
import { afterEach, describe, expect, it } from 'vitest'
import {
  drawScreen,
  initialScreen,
  PLAIN,
  paletteFor,
  renderScreen,
  runScreen,
  ScreenCancelled,
  type Ui,
} from '../src/screen.ts'

// The first minute, drawn rather than printed.
//
// What matters here is that Tade keeps the keyboard: the old wizard handed
// the terminal to pi while a readline was still reading it, and the two ate
// each other's keystrokes.

/** What a caller keeps above the question: setup puts its checklist here. */
const context = [
  '✓ A project to work on',
  '· A model to think with — nothing set',
  '○ Speech, if you want it — no mic',
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

  it('colours the marks, and reads the same without colour', () => {
    const state = initialScreen('Setting up', context)
    const coloured = renderScreen(state, { ...frame, palette: paletteFor({ TERM: 'xterm' }) })
    // A done step is green: xterm 256-colour 114, as the window draws it.
    expect(coloured.join('\n')).toContain('38;5;114m')

    // Colour is decoration. Everything has to say the same thing without it,
    // because pipes, CI logs and plenty of terminals will never show it.
    // Built rather than written as a literal: the linter is right that an
    // escape character in a regular expression is usually a mistake.
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
    const strip = (rows: string[]) => rows.join('\n').replace(ansi, '')
    expect(strip(coloured)).toBe(strip(renderScreen(state, frame)))
  })

  it('shows no colour where somebody has asked for none', () => {
    for (const env of [{ NO_COLOR: '1', TERM: 'xterm' }, { TERM: 'dumb' }, {}]) {
      expect(paletteFor(env)).toBe(PLAIN)
    }
    // And never into a pipe, where escape codes are worse than plain text.
    expect(paletteFor({ TERM: 'xterm' }, false)).toBe(PLAIN)
  })

  it('keeps the banner, the standing context and the keys all on screen', () => {
    const rows = renderScreen(initialScreen('Setting up', context), frame).join('\n')
    expect(rows).toContain('Setting up')
    expect(rows).toContain('✓ A project to work on')
    // The way out is always visible. A TUI with no stated way to leave it is
    // one people close by killing the terminal.
    expect(rows).toContain('ctrl+c quit')
  })

  it('drops the banner rather than the question on a small terminal', () => {
    const small = renderScreen(initialScreen('Setting up', context), {
      width: 40,
      height: 14,
    }).join('\n')
    expect(small).toContain('  T A D E   Setting up')
    expect(small).not.toContain('██')
    expect(small).toContain('✓ A project to work on')
  })

  it('shows a menu with the cursor on one of them', () => {
    const state = {
      ...initialScreen('Setting up', context),
      menu: { question: 'which?', options: ['log in', 'use an API key'], index: 1, filter: '' },
    }
    const rows = renderScreen(state, frame).join('\n')
    expect(rows).toContain('◉ use an API key')
    expect(rows).toContain('○ log in')
    expect(rows).toContain('↑↓ choose')
  })

  it('shows the question and what has been typed at it', () => {
    const state = {
      ...initialScreen('Setting up', context),
      prompt: { question: 'repository path', fallback: '/src/app', confirm: false },
      typed: '/src/other',
    }
    const rows = renderScreen(state, frame).join('\n')
    expect(rows).toContain('repository path [/src/app]: /src/other')
  })

  it('shows which way a yes/no question falls if you just press enter', () => {
    const yes = { question: 'keep agents running?', fallback: 'y', confirm: true }
    expect(
      renderScreen({ ...initialScreen('Setting up', context), prompt: yes }, frame).join('\n'),
    ).toContain('[Y/n]')
    const no = { ...yes, fallback: 'n' }
    expect(
      renderScreen({ ...initialScreen('Setting up', context), prompt: no }, frame).join('\n'),
    ).toContain('[y/N]')
  })

  it('tails an embedded terminal, because the newest line is the one to answer', () => {
    const screen = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const rows = renderScreen(
      { ...initialScreen('Setting up', context), running: { title: 'pi', screen } },
      { width: 70, height: 16 },
    ).join('\n')
    expect(rows).toContain('line 59')
    expect(rows).not.toContain('line 0\n')
    expect(rows).toContain('ctrl+]')
  })

  it('never draws more rows than the terminal has', () => {
    const state = {
      ...initialScreen('Setting up', context),
      said: Array.from({ length: 50 }, (_, i) => `n${i}`),
    }
    for (const height of [6, 12, 40]) {
      expect(renderScreen(state, { width: 70, height }).length).toBeLessThanOrEqual(height)
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
    await runScreen({ title: 'Setting up', terminal }, async (ui: Ui) => {
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

  it('takes a pasted key without ever drawing it', async () => {
    const terminal = new FakeTerminal()
    const key = 'tsk_secret_0123456789'
    let answered = ''
    await runScreen({ title: 'Setting up', terminal }, async (ui: Ui) => {
      const typed = ui.secret('paste your key')
      await until(() => terminal.written.includes('paste your key'))
      for (const char of key) terminal.press(char)
      await until(() => terminal.written.includes('•••'))
      terminal.press('\r')
      answered = await typed
    })
    expect(answered).toBe(key)
    // The flow got the key; the screen never had a character of it on it.
    expect(terminal.written).not.toContain(key)
    expect(terminal.written).not.toContain('tsk_')
  })

  it('treats enter on a yes/no question as the suggestion', async () => {
    const terminal = new FakeTerminal()
    const said: boolean[] = []
    await runScreen({ title: 'Setting up', terminal }, async (ui: Ui) => {
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
    await runScreen({ title: 'Setting up', terminal, driver }, async (ui: Ui) => {
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
      runScreen({ title: 'Setting up', terminal }, async () => {
        throw new Error('a step went wrong')
      }),
    ).rejects.toThrow('a step went wrong')
    // Leaving somebody in the alternate screen because setup failed would be a
    // worse first minute than the one this replaced.
    expect(terminal.written).toContain('\x1b[?1049l')
  })

  it('chooses from a menu with the arrows', async () => {
    const terminal = new FakeTerminal()
    let picked = -1
    await runScreen({ title: 'Setting up', terminal }, async (ui: Ui) => {
      const choosing = ui.choose('which?', ['log in', 'use an API key'])
      await until(() => terminal.written.includes('which?'))
      terminal.press('\x1b[B')
      terminal.press('\r')
      picked = await choosing
    })
    expect(picked).toBe(1)
  })

  it('takes a click on an option as the answer', async () => {
    const terminal = new FakeTerminal()
    terminal.columns = 110
    terminal.rows = 32
    let picked = -1
    await runScreen({ title: 'Setting up', terminal }, async (ui: Ui) => {
      const choosing = ui.choose('which provider?', ['Anthropic — Claude', 'OpenAI — GPT'])
      await until(() => terminal.written.includes('which provider?'))
      // Find OpenAI on the screen as drawn, and click it as a terminal would.
      const drawn = drawScreen(
        {
          ...initialScreen('Setting up'),
          menu: {
            question: 'which provider?',
            options: ['Anthropic — Claude', 'OpenAI — GPT'],
            index: 0,
            filter: '',
          },
        },
        { width: 110, height: 32 },
      )
      const hit = drawn.hits.find((h) => h.target.kind === 'control' && h.target.id === 'option:1')
      if (!hit) throw new Error('no OpenAI option on screen')
      terminal.press(`\x1b[<0;${hit.from + 3};${hit.row + 1}M`)
      terminal.press(`\x1b[<0;${hit.from + 3};${hit.row + 1}m`)
      picked = await choosing
    })
    expect(picked).toBe(1)
  })

  it('narrows a long list by typing, and answers with the right one', async () => {
    const terminal = new FakeTerminal()
    const models = ['anthropic/claude-opus-5', 'openai/gpt-5', 'google/gemini-3', 'ollama/qwen']
    let picked = -1
    await runScreen({ title: 'Setting up', terminal }, async (ui: Ui) => {
      const choosing = ui.choose('model?', models)
      await until(() => terminal.written.includes('model?'))
      // Words in any order: people type "opus 5" and mean claude-opus-5.
      for (const char of 'opus 5') terminal.press(char)
      await until(() => terminal.written.includes('opus 5'))
      terminal.press('\r')
      picked = await choosing
    })
    // The index into the list as given, not into what was left after filtering.
    expect(models[picked]).toBe('anthropic/claude-opus-5')
  })

  it('refuses to answer with something that does not match', async () => {
    const terminal = new FakeTerminal()
    let settled = false
    const screen = runScreen({ title: 'Setting up', terminal }, async (ui: Ui) => {
      const choosing = ui.choose('model?', ['anthropic/claude-opus-5', 'openai/gpt-5'])
      await until(() => terminal.written.includes('model?'))
      for (const char of 'zzz') terminal.press(char)
      await until(() => terminal.written.includes('nothing matches that'))
      // Enter on nothing picks nothing, rather than the first thing in a list
      // you can no longer see.
      terminal.press('\r')
      await new Promise((r) => setTimeout(r, 50))
      settled = true
      for (const char of '\x7f\x7f\x7fgpt') terminal.press(char)
      terminal.press('\r')
      await choosing
    })
    await screen
    expect(settled).toBe(true)
  })

  it('stops on ctrl+c and puts the terminal back', async () => {
    const terminal = new FakeTerminal()
    const stopped = runScreen({ title: 'Setting up', terminal }, async (ui: Ui) => {
      await ui.ask('repository path', '/src/app')
      throw new Error('it should never get here')
    })
    await until(() => terminal.written.includes('repository path'))
    // The listener consumes every key, so without this ctrl+c does nothing at
    // all and the only way out is killing the terminal.
    terminal.press('\x03')
    await expect(stopped).rejects.toThrow(ScreenCancelled)
    expect(terminal.written).toContain('\x1b[?1049l')
  })

  it('stops on ctrl+c while a program is running inside it', async () => {
    const terminal = new FakeTerminal()
    driver = new PtyDriver({ scrollback: 200 })
    const stopped = runScreen({ title: 'Setting up', terminal, driver }, async (ui: Ui) => {
      await ui.run('echo', process.execPath, [ECHO_CHILD])
    })
    await until(() => terminal.written.includes('ready'))
    terminal.press('\x03')
    await expect(stopped).rejects.toThrow(ScreenCancelled)
  }, 30_000)

  it('waits to be told an explanation has been read', async () => {
    const terminal = new FakeTerminal()
    let went = false
    await runScreen({ title: 'Tade', terminal }, async (ui: Ui) => {
      const paused = ui.pause('  that branch already exists')
      await until(() => terminal.written.includes('that branch already exists'))
      // A screen that closes on its way out takes the reason with it, and the
      // window behind is about to redraw over where it was.
      expect(terminal.written).toContain('press enter')
      terminal.press('\r')
      await paused
      went = true
    })
    expect(went).toBe(true)
  })
})
