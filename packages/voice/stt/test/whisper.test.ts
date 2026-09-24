import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { silentClip } from '@tade/voice-core/conformance'
import { describe, expect, it } from 'vitest'
import { defaultModelPath, WhisperCppTranscriber } from '../src/whisper.ts'

// The default engine, which is a model on your own machine — and so the one
// part of speech-in that a test must never actually run: `test/no-gui.ts`
// refuses the binary outright, because four hundred milliseconds of silence
// still costs a runner a minute of CPU.
//
// What is faked is the run. Everything here — the arguments it builds, the
// file it reads back, what it makes of whisper's own noise annotations — is
// the real engine.

/** A transcriber whose model is faked, with what it asked for in reach. */
function whisper(
  writes: string | null,
  opts: { language?: string; threads?: number } = {},
): { transcriber: WhisperCppTranscriber; runs: string[][] } {
  const runs: string[][] = []
  const transcriber = new WhisperCppTranscriber({
    // Real paths, so `available()` finds a binary and a model without either
    // whisper.cpp or a 150MB download being on the machine.
    binary: process.execPath,
    model: process.execPath,
    ...opts,
    run: async (_binary, args) => {
      runs.push(args)
      // whisper writes its text beside the clip rather than to stdout, which
      // carries the model's own progress chatter.
      const at = args.indexOf('--output-file')
      if (writes !== null) writeFileSync(`${args[at + 1]}.txt`, writes)
      return undefined
    },
  })
  return { transcriber, runs }
}

/** A clip, and the promise to clean it up: the caller owns it. */
async function withClip<T>(what: (clip: ReturnType<typeof silentClip>) => Promise<T>): Promise<T> {
  const clip = silentClip()
  try {
    return await what(clip)
  } finally {
    rmSync(clip.path, { force: true })
  }
}

describe('the local engine', () => {
  it('explains what is missing instead of just failing', async () => {
    const transcriber = new WhisperCppTranscriber({ binary: '/nonexistent/whisper' })
    const availability = await transcriber.available()
    expect(availability.ok).toBe(false)
    if (!availability.ok) expect(availability.reason).toMatch(/not installed/)
  })

  it('looks for its model where Tade keeps them', async () => {
    const transcriber = new WhisperCppTranscriber({
      binary: process.execPath,
      model: '/nonexistent/model.bin',
    })
    const availability = await transcriber.available()
    expect(availability.ok).toBe(false)
    if (!availability.ok) expect(availability.reason).toMatch(/no model at/)
  })

  it('keeps its model under the Tade home, wherever that is', () => {
    expect(defaultModelPath({ TADE_HOME: '/tmp/home' })).toBe('/tmp/home/models/ggml-base.en.bin')
  })

  it('refuses before running anything when it cannot run', async () => {
    const transcriber = new WhisperCppTranscriber({ binary: '/nonexistent/whisper' })
    await withClip(async (clip) => {
      await expect(transcriber.transcribe(clip)).rejects.toThrow(/unavailable/)
    })
  })

  it('says nothing local was sent anywhere', () => {
    expect(new WhisperCppTranscriber().capabilities.local).toBe(true)
  })
})

describe('what it asks the model for', () => {
  it('names the model, the clip, and where to write the text', async () => {
    const { transcriber, runs } = whisper('park the stripe one')
    await withClip(async (clip) => {
      const transcript = await transcriber.transcribe(clip)
      expect(transcript.text).toBe('park the stripe one')
      expect(transcript.by).toBe('whisper-cpp')
      expect(transcript.confidence).toBeNull()

      const args = runs[0] ?? []
      expect(args).toEqual(expect.arrayContaining(['-m', process.execPath, '-f', clip.path]))
      // No timestamps and no progress chatter: the words are all that is wanted.
      expect(args).toEqual(expect.arrayContaining(['--no-timestamps', '--no-prints']))
    })
  })

  it('offers the task names, which are the words a general model gets wrong', async () => {
    const { transcriber, runs } = whisper('park the refunds one')
    await withClip(async (clip) => {
      await transcriber.transcribe(clip, { vocabulary: ['app/refunds', 'checkout'] })
      const args = runs[0] ?? []
      expect(args[args.indexOf('--prompt') + 1]).toBe('app/refunds, checkout')
    })
  })

  it('asks for no prompt at all where there is nothing to offer', async () => {
    const { transcriber, runs } = whisper('hello')
    await withClip(async (clip) => {
      await transcriber.transcribe(clip, { vocabulary: [] })
      expect(runs[0]).not.toContain('--prompt')
    })
  })

  it('takes the language from the call over the one it was built with', async () => {
    const { transcriber, runs } = whisper('bonjour', { language: 'en' })
    await withClip(async (clip) => {
      await transcriber.transcribe(clip, { language: 'fr' })
      const args = runs[0] ?? []
      expect(args[args.indexOf('--language') + 1]).toBe('fr')
    })
  })

  it('passes the thread count only when one was chosen', async () => {
    const { transcriber, runs } = whisper('hi', { threads: 4 })
    await withClip(async (clip) => {
      await transcriber.transcribe(clip)
      expect((runs[0] ?? [])[(runs[0] ?? []).indexOf('--threads') + 1]).toBe('4')
    })

    const bare = whisper('hi')
    await withClip(async (clip) => {
      await bare.transcriber.transcribe(clip)
      expect(bare.runs[0]).not.toContain('--threads')
    })
  })

  it('gives up before running the model when the caller already has', async () => {
    const { transcriber, runs } = whisper('never said')
    const controller = new AbortController()
    controller.abort()
    await withClip(async (clip) => {
      await expect(transcriber.transcribe(clip, { signal: controller.signal })).rejects.toThrow()
      // A model that was never started is a minute nobody spent.
      expect(runs).toEqual([])
    })
  })
})

describe('what it makes of what the model wrote', () => {
  it('strips the noise annotations, so silence is nothing said', async () => {
    // whisper writes these for silence, and they are not words anybody spoke.
    for (const written of ['[BLANK_AUDIO]', '(silence)', '[ Silence ]', '(no speech)']) {
      const { transcriber } = whisper(written)
      await withClip(async (clip) => {
        expect((await transcriber.transcribe(clip)).text).toBe('')
      })
    }
  })

  it('keeps the words around an annotation, rather than dropping the line', async () => {
    const { transcriber } = whisper('[MUSIC] park the stripe one [BLANK_AUDIO]')
    await withClip(async (clip) => {
      expect((await transcriber.transcribe(clip)).text).toBe('park the stripe one')
    })
  })

  it('reads a transcript over several lines as one utterance', async () => {
    const { transcriber } = whisper('  park the stripe one\n  and show me refunds  \n')
    await withClip(async (clip) => {
      expect((await transcriber.transcribe(clip)).text).toBe(
        'park the stripe one and show me refunds',
      )
    })
  })

  it('hears nothing where the model wrote no file, rather than failing', async () => {
    const { transcriber } = whisper(null)
    await withClip(async (clip) => {
      expect((await transcriber.transcribe(clip)).text).toBe('')
    })
  })

  it('takes its scratch file away afterwards, however it went', async () => {
    const { transcriber, runs } = whisper('park it')
    await withClip(async (clip) => {
      await transcriber.transcribe(clip)
      const at = (runs[0] ?? []).indexOf('--output-file')
      expect(existsSync(`${(runs[0] ?? [])[at + 1]}.txt`)).toBe(false)
    })
  })

  it('takes it away even when the model failed halfway', async () => {
    let wrote = ''
    const transcriber = new WhisperCppTranscriber({
      binary: process.execPath,
      model: process.execPath,
      run: async (_binary, args) => {
        wrote = `${args[args.indexOf('--output-file') + 1]}.txt`
        writeFileSync(wrote, 'half a sentence')
        throw new Error('whisper: out of memory')
      },
    })
    await withClip(async (clip) => {
      await expect(transcriber.transcribe(clip)).rejects.toThrow(/out of memory/)
      expect(existsSync(wrote)).toBe(false)
    })
  })

  it('leaves the clip alone: the caller owns it and deletes it', async () => {
    const { transcriber } = whisper('park it')
    await withClip(async (clip) => {
      const before = readFileSync(clip.path)
      await transcriber.transcribe(clip)
      expect(readFileSync(clip.path)).toEqual(before)
    })
  })
})
