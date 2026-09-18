import { readFileSync } from 'node:fs'
import { stringEnv } from '@tade/core'
import {
  type AudioClip,
  type Availability,
  type TranscribeOptions,
  type Transcriber,
  type TranscriberCapabilities,
  TranscriberUnavailableError,
  type Transcript,
} from '@tade/voice-core'

// Any OpenAI-compatible `/audio/transcriptions` endpoint. One implementation
// covers OpenAI, Groq, and anything self-hosted that copies the shape, because
// the only difference is a base URL and a model name.

export interface OpenAiOptions {
  baseUrl?: string
  model?: string
  /** Read from the environment when not given, so keys stay out of config. */
  apiKey?: string
  apiKeyEnv?: string
  language?: string
  env?: NodeJS.ProcessEnv
  /** Injectable, so tests never touch the network. */
  fetch?: typeof globalThis.fetch
}

/** Known endpoints, so a config only has to name one. */
export const PRESETS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-transcribe',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    apiKeyEnv: 'GROQ_API_KEY',
  },
} as const

export type PresetName = keyof typeof PRESETS

export class OpenAiTranscriber implements Transcriber {
  readonly id: string
  readonly capabilities: TranscriberCapabilities = {
    local: false,
    // The batch endpoint. Streaming is a different API and a different port.
    streaming: false,
    // `prompt` biases the decode toward words it is told to expect.
    vocabulary: true,
  }

  private readonly opts: Required<Pick<OpenAiOptions, 'baseUrl' | 'model' | 'apiKeyEnv'>> &
    OpenAiOptions
  private readonly env: Record<string, string>

  constructor(opts: OpenAiOptions & { preset?: PresetName } = {}) {
    const preset = PRESETS[opts.preset ?? 'openai']
    this.id = opts.preset ?? 'openai'
    this.opts = {
      ...opts,
      baseUrl: opts.baseUrl ?? preset.baseUrl,
      model: opts.model ?? preset.model,
      apiKeyEnv: opts.apiKeyEnv ?? preset.apiKeyEnv,
    }
    this.env = stringEnv(opts.env ?? process.env)
  }

  private key(): string | null {
    return this.opts.apiKey ?? this.env[this.opts.apiKeyEnv] ?? null
  }

  async available(): Promise<Availability> {
    // Deliberately no network call: this is asked on every push-to-talk, and
    // the test suite makes none at all.
    return this.key() ? { ok: true } : { ok: false, reason: `${this.opts.apiKeyEnv} is not set` }
  }

  async transcribe(clip: AudioClip, opts: TranscribeOptions = {}): Promise<Transcript> {
    const key = this.key()
    if (!key) {
      throw new TranscriberUnavailableError(this.id, `${this.opts.apiKeyEnv} is not set`)
    }
    opts.signal?.throwIfAborted()

    const form = new FormData()
    // The endpoint infers the format from the filename, so it has to have one.
    form.append('file', new File([readFileSync(clip.path)], 'speech.wav', { type: 'audio/wav' }))
    form.append('model', this.opts.model)
    form.append('response_format', 'json')
    const language = opts.language ?? this.opts.language
    if (language) form.append('language', language)
    if (opts.vocabulary?.length) form.append('prompt', opts.vocabulary.join(', '))

    const send = this.opts.fetch ?? globalThis.fetch
    const response = await send(`${this.opts.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`${this.id} transcription failed: ${response.status} ${detail.slice(0, 200)}`)
    }
    const body = (await response.json()) as { text?: string }
    return { text: (body.text ?? '').trim(), confidence: null, by: this.id }
  }
}
