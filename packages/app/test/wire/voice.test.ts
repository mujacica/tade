import { ScriptedRecorder, ScriptedTranscriber } from '@tade/voice-stt'
import { Speaker } from '@tade/voice-tts'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { ThinkerEvent } from '../../src/transcript.ts'
import { type FakeTerminal, until, windowUnderTest } from './harness.ts'

// Push to talk, what the engine is told to expect, and mute — which is now,
// mid-sentence, or it is not mute.

describe('the window, listening', () => {
  let terminal: FakeTerminal
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
  })

  it('records what you say, and acts on it', async () => {
    const transcriber = new ScriptedTranscriber(['where are we'])
    const recorder = new ScriptedRecorder()
    await start({ transcriber, recorder })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''

    // ctrl+space, as a terminal without key releases sends it: press to start,
    // press again to stop.
    terminal.press('\x00')
    await until('recording to start', () => recorder.started.length === 1)
    terminal.press('\x00')
    await until('what was said to reach the engine', () => transcriber.heard.length === 1)
    // And it lands in the orchestrator strip, exactly as typing it would.
    await until('the utterance on screen', () => terminal.written.includes('where are we'))
  })

  it('tells the engine the task names, which are the words it would get wrong', async () => {
    const transcriber = new ScriptedTranscriber([''])
    const recorder = new ScriptedRecorder()
    await start({ transcriber, recorder })
    await until('the first frame', () => terminal.written.includes('refunds'))

    terminal.press('\x00')
    await until('recording to start', () => recorder.started.length === 1)
    terminal.press('\x00')
    await until('the engine to be asked', () => transcriber.offered.length === 1)
    expect(transcriber.offered[0]).toContain('app/refunds')
    expect(transcriber.offered[0]).toContain('app')
  })

  it('falls back to a typed line when there is nothing to listen with', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    terminal.press('\x00')
    // No recorder configured, so ctrl+space opens the line you can type into.
    await until('the dictation line', () => terminal.written.includes('◉'))
  })

  it('goes quiet the moment you mute it, mid-sentence', async () => {
    const started: string[] = []
    const finished: string[] = []
    let cut = 0
    const speaker = await Speaker.create({
      soundDir: tmp('tade-app-sound-'),
      platform: 'darwin',
      run: (command, signal) =>
        new Promise<void>((resolve) => {
          if (command.command !== 'say') return resolve()
          const text = command.args.at(-1) ?? ''
          started.push(text)
          // Saying a sentence out loud takes seconds; mute must not wait.
          const done = setTimeout(() => {
            finished.push(text)
            resolve()
          }, 2_000)
          signal?.addEventListener('abort', () => {
            cut += 1
            clearTimeout(done)
            resolve()
          })
        }),
    })
    const listeners: Array<(event: ThinkerEvent) => void> = []
    const answer = 'The first sentence. The second sentence. The third sentence.'
    await start({
      speaker,
      thinker: {
        onEvent: (listener) => {
          listeners.push(listener)
          return () => {}
        },
        ask: async () => {
          for (const listener of listeners) listener({ type: 'delta', text: `${answer} ` })
          for (const listener of listeners) listener({ type: 'message', text: answer })
          return answer
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    for (const char of 'why is refunds slow') terminal.press(char)
    terminal.press('\r')
    await until('it to start talking', () => started.length === 1)

    // ctrl+m, as a terminal sends it.
    terminal.press('\x1b[109;5u')
    await until('the sentence to be cut off', () => cut === 1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Nothing finished, and the two sentences queued behind it never start.
    expect(finished).toEqual([])
    expect(started).toEqual(['The first sentence.'])
  })
})
