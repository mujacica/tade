import type { Recorder, Transcriber } from '@wilco/voice-core'
import { OpenAiTranscriber } from './openai.ts'
import { FfmpegRecorder } from './recorder.ts'
import { ScriptedRecorder, ScriptedTranscriber } from './scripted.ts'
import { WhisperCppTranscriber } from './whisper.ts'

export { type OpenAiOptions, OpenAiTranscriber, PRESETS, type PresetName } from './openai.ts'
export { type FfmpegOptions, FfmpegRecorder } from './recorder.ts'
export { ScriptedRecorder, ScriptedTranscriber } from './scripted.ts'
export { defaultModelPath, WhisperCppTranscriber, type WhisperOptions } from './whisper.ts'

// Turning a name in a config file into something that listens.
//
// One entry per implementation, like every other port: call sites ask for a
// name and never reach for a constructor.

export interface TranscriberConfig {
  driver?: string
  model?: string
  base_url?: string
  api_key_env?: string
  language?: string
  binary?: string
}

export interface RecorderConfig {
  driver?: string
  device?: string
  binary?: string
}

export const transcribers: Record<string, (config: TranscriberConfig) => Transcriber> = {
  'whisper-cpp': (c) => new WhisperCppTranscriber(pruned(c)),
  openai: (c) => new OpenAiTranscriber({ ...pruned(c), preset: 'openai' }),
  groq: (c) => new OpenAiTranscriber({ ...pruned(c), preset: 'groq' }),
  scripted: () => new ScriptedTranscriber(),
}

export const recorders: Record<string, (config: RecorderConfig) => Recorder> = {
  ffmpeg: (c) => new FfmpegRecorder({ ...(c.device ? { device: c.device } : {}) }),
  scripted: () => new ScriptedRecorder(),
}

export function makeTranscriber(config: TranscriberConfig = {}): Transcriber {
  const name = config.driver ?? 'whisper-cpp'
  const make = transcribers[name]
  if (!make) throw new Error(`unknown transcriber: ${name}`)
  return make(config)
}

export function makeRecorder(config: RecorderConfig = {}): Recorder {
  const name = config.driver ?? 'ffmpeg'
  const make = recorders[name]
  if (!make) throw new Error(`unknown recorder: ${name}`)
  return make(config)
}

/** Config keys are snake_case and optional; constructors want neither. */
function pruned(config: TranscriberConfig) {
  return {
    ...(config.model ? { model: config.model } : {}),
    ...(config.base_url ? { baseUrl: config.base_url } : {}),
    ...(config.api_key_env ? { apiKeyEnv: config.api_key_env } : {}),
    ...(config.language ? { language: config.language } : {}),
    ...(config.binary ? { binary: config.binary } : {}),
  }
}
