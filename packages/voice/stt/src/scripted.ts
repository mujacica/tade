import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AudioClip,
  Availability,
  Recorder,
  RecorderOptions,
  Recording,
  TranscribeOptions,
  Transcriber,
  TranscriberCapabilities,
  Transcript,
} from '@wilco/voice-core'

// A microphone and an engine that exist only in a test.
//
// Every layer above this — push-to-talk, the intent grammar, the resolver, the
// window — can then be exercised end to end with no audio hardware, no model
// and no network, which is the only way any of it runs in CI.

export class ScriptedTranscriber implements Transcriber {
  readonly id = 'scripted'
  readonly capabilities: TranscriberCapabilities = {
    local: true,
    streaming: false,
    vocabulary: true,
  }

  /** What it will "hear", in order. The last line repeats once used up. */
  private readonly lines: string[]
  private at = 0
  /** Every clip it was asked about, so a test can check what was captured. */
  readonly heard: AudioClip[] = []
  /** The vocabulary it was offered, which is worth asserting on. */
  readonly offered: string[][] = []
  private availability: Availability = { ok: true }

  constructor(lines: string[] = ['']) {
    this.lines = lines
  }

  /** Pretend the model is missing, to exercise the honest failure path. */
  setAvailability(availability: Availability): void {
    this.availability = availability
  }

  async available(): Promise<Availability> {
    return this.availability
  }

  async transcribe(clip: AudioClip, opts: TranscribeOptions = {}): Promise<Transcript> {
    opts.signal?.throwIfAborted()
    this.heard.push(clip)
    if (opts.vocabulary) this.offered.push(opts.vocabulary)
    const text = this.lines[Math.min(this.at, this.lines.length - 1)] ?? ''
    this.at += 1
    return { text, confidence: null, by: this.id }
  }
}

/** A valid, empty WAV: header only, which is what silence looks like. */
function emptyWav(sampleRate = 16_000): Buffer {
  const data = Buffer.alloc(44)
  data.write('RIFF', 0)
  data.writeUInt32LE(36, 4)
  data.write('WAVE', 8)
  data.write('fmt ', 12)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(sampleRate, 24)
  data.writeUInt32LE(sampleRate * 2, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(0, 40)
  return data
}

export class ScriptedRecorder implements Recorder {
  readonly id = 'scripted'
  /** Recordings that were started, whether or not they were stopped. */
  readonly started: RecorderOptions[] = []
  cancelled = 0

  async available(): Promise<Availability> {
    return { ok: true }
  }

  async start(opts: RecorderOptions = {}): Promise<Recording> {
    this.started.push(opts)
    const at = Date.now()
    // A real file in a real temp directory, because the caller owns the clip
    // and deletes it: handing back a path nobody may unlink (`/dev/null`) is a
    // fixture being kinder than reality.
    const dir = mkdtempSync(join(tmpdir(), 'wilco-scripted-'))
    const path = join(dir, 'speech.wav')
    return {
      stop: async (): Promise<AudioClip> => {
        writeFileSync(path, emptyWav())
        return { path, sampleRate: opts.sampleRate ?? 16_000, durationMs: Date.now() - at }
      },
      cancel: async () => {
        this.cancelled += 1
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }
}
