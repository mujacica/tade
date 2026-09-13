import { rmSync } from 'node:fs'
import { silentClip } from '@wilco/voice-core/conformance'
import { describe, expect, it } from 'vitest'
import {
  FfmpegRecorder,
  makeRecorder,
  makeTranscriber,
  OpenAiTranscriber,
  ScriptedTranscriber,
  WhisperCppTranscriber,
} from '../src/index.ts'

// No network and no audio hardware anywhere in here: the HTTP engine takes an
// injected `fetch`, and everything else is asked what it would do rather than
// made to do it.

describe('the OpenAI-compatible engine', () => {
  const ok = (text: string) => async (): Promise<Response> =>
    new Response(JSON.stringify({ text }), { status: 200 })

  it('sends the audio and hands back what was said', async () => {
    // Collected rather than assigned: a closure assignment is not something
    // the typechecker can follow, and it narrows the variable to `never`.
    const sent: FormData[] = []
    const transcriber = new OpenAiTranscriber({
      apiKey: 'k',
      fetch: async (_url, init) => {
        sent.push((init?.body ?? new FormData()) as FormData)
        return new Response(JSON.stringify({ text: '  park the stripe one  ' }), { status: 200 })
      },
    })
    const clip = silentClip()
    try {
      const transcript = await transcriber.transcribe(clip, { vocabulary: ['checkout/refunds'] })
      expect(transcript.text).toBe('park the stripe one')
      expect(transcript.by).toBe('openai')
      const form = sent[0]
      expect(form?.get('model')).toBe('gpt-4o-mini-transcribe')
      // Task names are the words a general model gets wrong.
      expect(form?.get('prompt')).toBe('checkout/refunds')
      expect(form?.get('file')).toBeInstanceOf(File)
    } finally {
      rmSync(clip.path, { force: true })
    }
  })

  it('says it cannot run when there is no key, rather than failing later', async () => {
    const transcriber = new OpenAiTranscriber({ env: {} })
    expect(await transcriber.available()).toEqual({
      ok: false,
      reason: 'OPENAI_API_KEY is not set',
    })
  })

  it('takes the key from the environment', async () => {
    const transcriber = new OpenAiTranscriber({ env: { OPENAI_API_KEY: 'k' } })
    expect(await transcriber.available()).toEqual({ ok: true })
  })

  it('reports a refusal from the other end', async () => {
    const transcriber = new OpenAiTranscriber({
      apiKey: 'k',
      fetch: async () => new Response('nope', { status: 429 }),
    })
    const clip = silentClip()
    try {
      await expect(transcriber.transcribe(clip)).rejects.toThrow(/429/)
    } finally {
      rmSync(clip.path, { force: true })
    }
  })

  it('points at Groq when asked to', async () => {
    let url = ''
    const transcriber = makeTranscriber({ driver: 'groq' })
    expect(transcriber.id).toBe('groq')
    const groq = new OpenAiTranscriber({
      preset: 'groq',
      apiKey: 'k',
      fetch: async (target) => {
        url = String(target)
        return (await ok('hi')()) as Response
      },
    })
    const clip = silentClip()
    try {
      await groq.transcribe(clip)
      expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    } finally {
      rmSync(clip.path, { force: true })
    }
  })
})

describe('the local engine', () => {
  it('explains what is missing instead of just failing', async () => {
    const transcriber = new WhisperCppTranscriber({ binary: '/nonexistent/whisper' })
    const availability = await transcriber.available()
    expect(availability.ok).toBe(false)
    if (!availability.ok) expect(availability.reason).toMatch(/not installed/)
  })

  it('looks for its model where Wilco keeps them', async () => {
    const transcriber = new WhisperCppTranscriber({
      binary: process.execPath,
      model: '/nonexistent/model.bin',
    })
    const availability = await transcriber.available()
    expect(availability.ok).toBe(false)
    if (!availability.ok) expect(availability.reason).toMatch(/no model at/)
  })
})

describe('the recorder', () => {
  it('says so where there is no way to record', async () => {
    const recorder = new FfmpegRecorder({ platform: 'win32' })
    const availability = await recorder.available()
    expect(availability.ok).toBe(false)
    if (!availability.ok) expect(availability.reason).toMatch(/win32/)
  })

  it('refuses to start rather than pretending to record', async () => {
    const recorder = new FfmpegRecorder({ binary: '/nonexistent/ffmpeg' })
    await expect(recorder.start()).rejects.toThrow(/unavailable/)
  })
})

describe('the registry', () => {
  it('is how a name in a config becomes something that listens', () => {
    expect(makeTranscriber({ driver: 'whisper-cpp' })).toBeInstanceOf(WhisperCppTranscriber)
    expect(makeTranscriber({ driver: 'scripted' })).toBeInstanceOf(ScriptedTranscriber)
    expect(makeRecorder({ driver: 'ffmpeg' })).toBeInstanceOf(FfmpegRecorder)
  })

  it('defaults to the local one, so nothing is sent anywhere unasked', () => {
    expect(makeTranscriber().id).toBe('whisper-cpp')
    expect(makeTranscriber().capabilities.local).toBe(true)
  })

  it('names what it does not know', () => {
    expect(() => makeTranscriber({ driver: 'nope' })).toThrow(/unknown transcriber: nope/)
    expect(() => makeRecorder({ driver: 'nope' })).toThrow(/unknown recorder: nope/)
  })
})

describe('the scripted pair', () => {
  it('hears what it was told to hear, and remembers what it was offered', async () => {
    const transcriber = new ScriptedTranscriber(['first', 'second'])
    const clip = silentClip()
    try {
      expect((await transcriber.transcribe(clip, { vocabulary: ['a/b'] })).text).toBe('first')
      expect((await transcriber.transcribe(clip)).text).toBe('second')
      // The last line repeats, so a test never runs out of speech.
      expect((await transcriber.transcribe(clip)).text).toBe('second')
      expect(transcriber.heard).toHaveLength(3)
      expect(transcriber.offered).toEqual([['a/b']])
    } finally {
      rmSync(clip.path, { force: true })
    }
  })
})
