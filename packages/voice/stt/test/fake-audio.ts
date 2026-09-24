import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { SpawnCapture } from '../src/recorder.ts'

// A microphone that is not one.
//
// `FfmpegRecorder` is the only part of voice with real hardware behind it, and
// so the only part whose interesting cases — stopping cleanly, cancelling, a
// device that goes away halfway through — could not be reached without opening
// somebody's microphone. This is what its `spawn` seam is handed instead: a
// process-shaped object that answers `q`, `kill`, and stderr the way ffmpeg
// does, and writes the file ffmpeg would have written.
//
// It is deliberately a fake of the *process*, not of the recorder: everything
// above it is the real class, including the arguments it builds, the settling,
// the header-only check and the reading of the tail for the meter.

/** 16-bit mono PCM at a steady amplitude, with the WAV header ffmpeg writes. */
export function wavOf(ms: number, amplitude = 8_000, sampleRate = 16_000): Buffer {
  const samples = Math.floor((sampleRate * ms) / 1000)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.byteLength, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.byteLength, 40)
  return Buffer.concat([header, data])
}

/** One capture, as the recorder sees it and as a test drives it. */
export class FakeCapture extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  /** Everything typed at it. `q` is how ffmpeg is asked to finish writing. */
  typed = ''
  /** The file it was told to write, which is the last argument ffmpeg takes. */
  readonly path: string
  /** How much audio it will have written by the time it is asked to stop. */
  captured: number
  /** Ignores `q`, like an ffmpeg that has wedged on a device that stopped answering. */
  private readonly deaf: boolean

  constructor(path: string, captured: number, deaf = false) {
    super()
    this.path = path
    this.captured = captured
    this.deaf = deaf
    this.stdin.on('data', (chunk: Buffer) => {
      this.typed += chunk.toString()
      // ffmpeg finishes the file and exits on `q`, which is why the recorder
      // asks that way rather than signalling: a signal loses the header.
      if (!this.deaf && this.typed.includes('q')) this.finish()
    })
  }

  /** What ffmpeg does when told to wrap up: write a valid file, and exit 0. */
  private finish(): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    if (this.captured > 0) writeFileSync(this.path, wavOf(this.captured))
    this.exitCode = 0
    this.emit('exit', 0, null)
  }

  /**
   * The device went away mid-recording — unplugged, taken by another program,
   * or permission never granted. ffmpeg says so on stderr and exits, leaving
   * a file with nothing in it.
   */
  deviceLost(said: string): void {
    this.stderr.write(said)
    this.captured = 0
    this.exitCode = 1
    // Given to the recorder's stderr handler before the exit it has to explain.
    setImmediate(() => this.emit('exit', 1, null))
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.signalCode = (typeof signal === 'string' ? signal : 'SIGKILL') as NodeJS.Signals
    this.emit('exit', null, this.signalCode)
    return true
  }
}

export interface FakeSpawn {
  /** Hand this to `FfmpegRecorder`'s `spawn`. */
  spawn: SpawnCapture
  /** Every capture started, in order, with what it was asked for. */
  readonly starts: Array<{ binary: string; args: string[]; options: Record<string, unknown> }>
  /** The capture going now, for a test that wants to interfere with it. */
  readonly capture: FakeCapture | null
}

/**
 * A `spawn` that opens no device. `captured` is how many milliseconds of audio
 * will be in the file by the time it is stopped; zero is a device that never
 * produced anything, which is what an untrusted microphone looks like. `deaf`
 * is one that has stopped answering `q` altogether, which is the only way to
 * reach the recorder's escalation — a fixture that always exits politely is
 * kinder than reality, and the ladder that stops push-to-talk hanging forever
 * would never run.
 */
export function fakeCapture({ captured = 200, deaf = false } = {}): FakeSpawn {
  const state: FakeSpawn = {
    starts: [],
    capture: null,
    spawn: ((binary: string, args: string[], options: Record<string, unknown>) => {
      state.starts.push({ binary, args, options })
      // ffmpeg's output file is its last argument; `-y` is the flag before it.
      const capture = new FakeCapture(args.at(-1) ?? '', captured, deaf)
      ;(state as { capture: FakeCapture | null }).capture = capture
      return capture as unknown as ChildProcess
    }) as unknown as SpawnCapture,
  }
  return state
}
