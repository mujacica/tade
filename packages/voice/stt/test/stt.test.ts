import { rmSync } from 'node:fs'
import { silentClip } from '@tade/voice-core/conformance'
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

  it('sends the key as a bearer header, and nowhere else', async () => {
    // A credential travels in the one header and is never in the body, the
    // URL, or anything that gets logged.
    // Collected rather than assigned, as above: a closure assignment is not
    // something the typechecker can follow.
    const urls: string[] = []
    const headers: Array<Record<string, string>> = []
    const bodies: FormData[] = []
    const transcriber = new OpenAiTranscriber({
      apiKey: 'sk-secret',
      fetch: async (url, init) => {
        urls.push(String(url))
        headers.push((init?.headers ?? {}) as Record<string, string>)
        bodies.push((init?.body ?? new FormData()) as FormData)
        return new Response(JSON.stringify({ text: 'hi' }), { status: 200 })
      },
    })
    const clip = silentClip()
    try {
      await transcriber.transcribe(clip, { vocabulary: ['app/refunds'] })
      expect(headers[0]?.authorization).toBe('Bearer sk-secret')
      expect(urls[0]).not.toContain('sk-secret')
      for (const [, value] of bodies[0]?.entries() ?? []) {
        if (typeof value === 'string') expect(value).not.toContain('sk-secret')
      }
    } finally {
      rmSync(clip.path, { force: true })
    }
  })

  it('takes the language from the call over the one it was built with', async () => {
    const sent: FormData[] = []
    const transcriber = new OpenAiTranscriber({
      apiKey: 'k',
      language: 'en',
      fetch: async (_url, init) => {
        sent.push((init?.body ?? new FormData()) as FormData)
        return new Response(JSON.stringify({ text: 'bonjour' }), { status: 200 })
      },
    })
    const clip = silentClip()
    try {
      await transcriber.transcribe(clip, { language: 'fr' })
      expect(sent[0]?.get('language')).toBe('fr')
    } finally {
      rmSync(clip.path, { force: true })
    }
  })

  it('gives up before sending anything when the caller already has', async () => {
    let asked = 0
    const transcriber = new OpenAiTranscriber({
      apiKey: 'k',
      fetch: async () => {
        asked += 1
        return new Response('{}', { status: 200 })
      },
    })
    const controller = new AbortController()
    controller.abort()
    const clip = silentClip()
    try {
      await expect(transcriber.transcribe(clip, { signal: controller.signal })).rejects.toThrow()
      expect(asked).toBe(0)
    } finally {
      rmSync(clip.path, { force: true })
    }
  })

  it('hears nothing where the endpoint answered with nothing', async () => {
    const transcriber = new OpenAiTranscriber({
      apiKey: 'k',
      fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
    })
    const clip = silentClip()
    try {
      // Silence is nothing said, not an undefined read out as a word.
      expect((await transcriber.transcribe(clip)).text).toBe('')
    } finally {
      rmSync(clip.path, { force: true })
    }
  })

  it('reads the key from the variable its preset names', async () => {
    expect(await new OpenAiTranscriber({ preset: 'groq', env: {} }).available()).toEqual({
      ok: false,
      reason: 'GROQ_API_KEY is not set',
    })
    expect(
      await new OpenAiTranscriber({ preset: 'groq', env: { GROQ_API_KEY: 'k' } }).available(),
    ).toEqual({ ok: true })
  })

  it('never reaches the network to answer whether it can run', async () => {
    // Asked on every push-to-talk, so it may only ever read the environment.
    let asked = 0
    const transcriber = new OpenAiTranscriber({
      env: { OPENAI_API_KEY: 'k' },
      fetch: async () => {
        asked += 1
        return new Response('{}', { status: 200 })
      },
    })
    await transcriber.available()
    expect(asked).toBe(0)
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

// The local engine has a file of its own: `whisper.test.ts`.

// The recorder has a file of its own: `recorder.test.ts`.

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
