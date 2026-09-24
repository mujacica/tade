import { THINKING_LEVELS } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import type { ThinkerEvent } from '../../src/transcript.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

/**
 * What the person actually said, out of the message the orchestrator is handed:
 * the window puts where they are standing above their words, under a heading,
 * and every test here is about the words.
 */
const theirWords = (message: string | undefined): string =>
  (message ?? '').split('What they said:\n').at(-1) ?? ''

// Where a key goes and what it does there: the line you type on, what is
// selected on it, the two keys that stop things, and what you said before.

describe('the window, taking a keystroke', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })

  it('takes a keystroke and opens the dictation line', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    // ctrl+space, as a terminal without the Kitty protocol sends it.
    terminal.press('\x00')
    await until('the dictation line', () => terminal.written.includes('◉'))
  })

  it('holds a line addressed to Tade rather than typing it at the agent', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    for (const char of 'tade par') terminal.press(char)
    await until('the held line', () => terminal.written.includes('◌'))
  })

  it('moves between agents on tab', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    terminal.press('\t')
    // The marker has to land somewhere; which task is the model's business.
    await until('a redraw with the focus marker', () => terminal.written.includes('▌'))
  })

  it('selects the whole line with ctrl+a, and one backspace takes it', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00') // opens the line you type into
    for (const char of 'why is refunds slow') terminal.press(char)
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes('why is refunds slow')),
    )

    terminal.press('\x01') // ctrl+a: all of it
    terminal.press('\x7f') // backspace: the selection, not the last character
    await until('the line to be empty again', () =>
      screenOf(terminal.written).every((row) => !row.includes('why is refunds')),
    )
    // Emptied, not closed: the keyboard is still on the orchestrator's line.
    expect(screenOf(terminal.written).some((row) => row.includes('enter sends'))).toBe(true)
  })

  it('replaces what is selected with what you type next', async () => {
    const asked: string[] = []
    await start({
      thinker: {
        ask: async (text: string) => {
          asked.push(text)
          return 'ok'
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    for (const char of 'why is refunds slow') terminal.press(char)
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes('why is refunds slow')),
    )

    terminal.press('\x01') // ctrl+a
    for (const char of 'and search') terminal.press(char)
    terminal.press('\r')
    await until('the question', () => asked.length === 1)
    expect(theirWords(asked[0])).toBe('and search')
  })

  it('keeps the keyboard on the orchestrator after sending, until you leave it', async () => {
    const asked: string[] = []
    await start({
      thinker: {
        ask: async (text: string) => {
          asked.push(text)
          return 'ok'
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))

    terminal.press('\x00') // opens the line you type into
    for (const char of 'why is refunds slow') terminal.press(char)
    terminal.press('\r')
    await until('the first question', () => asked.length === 1)

    // Nothing reopens the line: sending emptied it, it did not close it, so
    // the next sentence goes to the orchestrator and not to the agent in front.
    for (const char of 'and what about search') terminal.press(char)
    terminal.press('\r')
    await until('the second question', () => asked.length === 2)
    expect(asked.map(theirWords)).toEqual(['why is refunds slow', 'and what about search'])

    // Escape is the way out, and then the keyboard is the agent's again.
    terminal.written = ''
    terminal.press('\x1b')
    await until('the line to close', () =>
      screenOf(terminal.written).some((row) => row.includes('Ask Tade anything')),
    )
    for (const char of 'typed at the agent') terminal.press(char)
    terminal.press('\r')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(asked).toHaveLength(2)
  })

  it('leaves the caret where it was when focus goes to an agent and comes back', async () => {
    const asked: string[] = []
    await start({
      thinker: {
        ask: async (text: string) => {
          asked.push(text)
          return 'ok'
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))

    terminal.press('\x00') // opens the line you type into
    for (const char of 'why refunds slow') terminal.press(char)
    // Left, back to in front of "refunds": where the missing word goes.
    for (let i = 0; i < 'refunds slow'.length; i++) terminal.press('\x1b[D')
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes('why refunds slow')),
    )

    // Away and back. The line is not drawn meanwhile and is not emptied
    // either: the words, the caret and what is selected on them are the
    // orchestrator's, not the focus's.
    terminal.press('\t')
    await until('the line to close', () =>
      screenOf(terminal.written).every((row) => !row.includes('why refunds slow')),
    )
    terminal.press('\x1b[Z') // shift+tab, back to the orchestrator
    await until('the line, back as it was', () =>
      screenOf(terminal.written).some((row) => row.includes('why refunds slow')),
    )

    // Typed where the caret was left, not at the end of the line.
    for (const char of 'is ') terminal.press(char)
    terminal.press('\r')
    await until('the question', () => asked.length === 1)
    expect(asked.map(theirWords)).toEqual(['why is refunds slow'])
  })

  it('stops the orchestrator on escape, and leaves what you typed alone', async () => {
    const stops: number[] = []
    const listeners: Array<(event: ThinkerEvent) => void> = []
    await start({
      thinker: {
        onEvent: (listener) => {
          listeners.push(listener)
          return () => {}
        },
        offers: {
          harness: 'pi',
          interrupt: { shown: true, support: 'live', note: null },
          levels: THINKING_LEVELS,
        },
        interrupt: async () => {
          stops.push(1)
          for (const listener of listeners) listener({ type: 'idle' })
        },
        // Never answers: this is the turn you get tired of waiting for.
        ask: () => new Promise<string>(() => {}),
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    for (const char of 'why is refunds slow') terminal.press(char)
    terminal.press('\r')
    await until('it to be thinking', () =>
      screenOf(terminal.written).some((row) => row.includes('thinking')),
    )

    // The next sentence, half written, while it is still working.
    for (const char of 'and also search') terminal.press(char)
    await until('the half-written line', () =>
      screenOf(terminal.written).some((row) => row.includes('and also search')),
    )

    terminal.press('\x1b')
    await until('the turn to be stopped', () => stops.length === 1)
    await until('it to stop saying it is thinking', () =>
      screenOf(terminal.written).every((row) => !row.includes('thinking')),
    )

    // The whole point: the half-written message is still there, still being
    // typed, and the next character lands on the end of it.
    terminal.written = ''
    terminal.press('!')
    await until('the line to have kept what you typed', () =>
      screenOf(terminal.written).some((row) => row.includes('and also search!')),
    )
  })

  it('says so rather than swallowing escape, where its harness cannot be stopped', async () => {
    await start({
      thinker: {
        offers: {
          harness: 'codex',
          interrupt: { shown: false, support: 'none', note: 'runs a turn to the end' },
          levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
        ask: () => new Promise<string>(() => {}),
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    for (const char of 'why is refunds slow') terminal.press(char)
    terminal.press('\r')
    await until('it to be thinking', () =>
      screenOf(terminal.written).some((row) => row.includes('thinking')),
    )
    terminal.written = ''
    terminal.press('\x1b')
    await until('the reason', () =>
      screenOf(terminal.written).some((row) => row.includes('runs a turn to the end')),
    )
  })

  it('throws away what you typed on ctrl+c, and keeps the line open', async () => {
    const asked: string[] = []
    await start({
      thinker: {
        ask: async (text: string) => {
          asked.push(text)
          return 'ok'
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    for (const char of 'why is refunds slow') terminal.press(char)
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes('why is refunds slow')),
    )

    terminal.written = ''
    terminal.press('\x03') // ctrl+c: the line, not Tade
    await until('the line to be empty', () =>
      screenOf(terminal.written).every((row) => !row.includes('why is refunds slow')),
    )
    // Emptied, not closed, and Tade is still open: the next sentence goes to
    // the orchestrator without reopening anything.
    for (const char of 'and search') terminal.press(char)
    terminal.press('\r')
    await until('the question', () => asked.length === 1)
    expect(theirWords(asked[0])).toBe('and search')
  })

  it('brings back what you said with up, and finds it with ctrl+r, in the next window too', async () => {
    const asked: string[] = []
    const thinker = {
      ask: async (text: string) => {
        asked.push(text)
        return 'ok'
      },
    }
    const first = await start({ thinker })
    await until('the first frame', () => terminal.written.includes('refunds'))
    for (const line of ['why is refunds slow', 'what changed in search']) {
      terminal.press('\x00')
      for (const char of line) terminal.press(char)
      terminal.press('\r')
    }
    await until('both to be asked', () => asked.length === 2)
    await until(
      'both journaled',
      async () => (await client.events({ types: ['said'] })).length === 2,
    )
    // The line as pi's editor draws it: the words, then the cursor after them.
    const onLine = (text: string) => () =>
      screenOf(terminal.written).some((row) => row.trimEnd() === ` ${text}`)

    // Up twice is the one before last; down comes back.
    terminal.press('\x00')
    terminal.press('\x1b[A')
    terminal.press('\x1b[A')
    await until('the older line back', onLine('why is refunds slow'))
    terminal.press('\x1b[B')
    await until('the newer line back', onLine('what changed in search'))
    terminal.press('\x1b')

    // A new window finds it in the journal: ctrl+r, a few letters, enter.
    await first.stop()
    terminal.written = ''
    await start({ thinker })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    terminal.press('\x12')
    for (const char of 'refunds') terminal.press(char)
    await until('the match', () =>
      screenOf(terminal.written).some(
        (row) => row.includes('search: refunds▏') && row.includes('why is refunds slow'),
      ),
    )
    terminal.press('\r')
    await until('it sent again', () => asked.length === 3)
    expect(theirWords(asked[2])).toBe('why is refunds slow')
  })

  it('types to the orchestrator when no agent has focus', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Tab past every pane to the orchestrator, which is one of the things you
    // can focus precisely so that there is always somewhere to type.
    terminal.press('\t')
    terminal.press('\t')
    terminal.written = ''
    terminal.press('h')
    terminal.press('i')
    await until('the typed line', () => terminal.written.includes('hi'))
  })

  it('offers its commands when you type a slash', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\t')
    terminal.press('\t')
    terminal.written = ''
    terminal.press('/')
    await until('the command list', () => terminal.written.includes('/new'))
    expect(terminal.written).toContain('/settings')
  })

  it('puts the caret where you click in what you have typed', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Clicking the line opens it; then it takes what you type.
    const line = find('Ask Tade anything')
    click(line.col, line.row)
    await until('the line open', () =>
      screenOf(terminal.written).some((row) => row.includes('enter sends')),
    )
    for (const char of 'abcdef') terminal.press(char)
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes('abcdef')),
    )
    // A click in the middle of it, and then a letter: it lands where the click was.
    const typed = find('abcdef')
    click(typed.col + 2, typed.row)
    terminal.press('X')
    await until('the caret moved', () =>
      screenOf(terminal.written).some((row) => row.includes('abXcdef')),
    )
  }, 30_000)
})
