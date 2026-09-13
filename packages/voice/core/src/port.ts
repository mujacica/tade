// Turning speech into text, and capturing the speech in the first place.
//
// Two ports, because they are two jobs with different backends: a microphone
// is captured by ffmpeg or sox, and the result is transcribed by whisper.cpp
// locally or by an API. Wiring them together is the surface's business.
//
// Vocabulary rule, as everywhere: no method here may use one implementation's
// words. It is `transcribe(clip)`, never `whisper(wav)`.

/** A recording, as a WAV file on disk. The caller owns it and deletes it. */
export interface AudioClip {
  path: string
  sampleRate: number
  durationMs: number
}

/** Whether something can run here at all, and in plain words why not. */
export type Availability = { ok: true } | { ok: false; reason: string }

export interface TranscriberCapabilities {
  /** Runs on this machine: nothing is sent anywhere. */
  local: boolean
  /** Can produce text while you are still talking. */
  streaming: boolean
  /** Can be told the words to expect, like task and project names. */
  vocabulary: boolean
}

export interface Transcript {
  /** What was said, verbatim. Empty when nothing was. */
  text: string
  /** 0–1, where the engine reports one. */
  confidence: number | null
  /** Which engine produced it, so the journal can say. */
  by: string
}

export interface TranscribeOptions {
  /**
   * Names the speaker is likely to say. Task and project names are exactly the
   * words a general model gets wrong, so engines that accept a hint get one.
   */
  vocabulary?: string[]
  /** BCP-47-ish language tag. Undefined means let the engine decide. */
  language?: string
  signal?: AbortSignal
}

export interface Transcriber {
  readonly id: string
  readonly capabilities: TranscriberCapabilities
  /**
   * Whether this machine can actually run it. Checked before anything is
   * recorded, so a missing model is a sentence rather than a failure after
   * you have already spoken.
   */
  available(): Promise<Availability>
  transcribe(clip: AudioClip, opts?: TranscribeOptions): Promise<Transcript>
}

/** A recording in progress. */
export interface Recording {
  /** Stop, and hand back what was captured. */
  stop(): Promise<AudioClip>
  /** Give up. Nothing is transcribed and the audio is deleted. */
  cancel(): Promise<void>
}

export interface RecorderOptions {
  /** Input device, in whatever the backend calls them. Default is the default. */
  device?: string
  /** Hz. 16k is what every speech model wants; more is wasted bytes. */
  sampleRate?: number
  /** Stop by itself after this long, so a stuck key cannot record forever. */
  maxMs?: number
}

export interface Recorder {
  readonly id: string
  available(): Promise<Availability>
  start(opts?: RecorderOptions): Promise<Recording>
}

export class TranscriberUnavailableError extends Error {
  readonly code = 'TRANSCRIBER_UNAVAILABLE'
  constructor(id: string, reason: string) {
    super(`transcriber ${id} is unavailable: ${reason}`)
    this.name = 'TranscriberUnavailableError'
  }
}

export class RecorderUnavailableError extends Error {
  readonly code = 'RECORDER_UNAVAILABLE'
  constructor(id: string, reason: string) {
    super(`recorder ${id} is unavailable: ${reason}`)
    this.name = 'RecorderUnavailableError'
  }
}
