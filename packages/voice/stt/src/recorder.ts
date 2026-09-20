import { type ChildProcess, spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCommand, stringEnv } from '@tade/core'
import {
  type AudioClip,
  type Availability,
  type Recorder,
  type RecorderOptions,
  RecorderUnavailableError,
  type Recording,
} from '@tade/voice-core'

// Capturing a microphone with ffmpeg, which is already on most machines and
// speaks to every platform's audio stack.
//
// 16 kHz mono is what every speech model wants; anything more is bytes that
// get thrown away on the way in.

const DEFAULTS = { sampleRate: 16_000, maxMs: 120_000 }

/** A WAV header and nothing else: what ffmpeg leaves if it captured nothing. */
const EMPTY_WAV = 44

export interface FfmpegOptions {
  binary?: string
  /** Input device in the platform's own terms. macOS numbers them. */
  device?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

interface Input {
  format: string
  device: string
}

export class FfmpegRecorder implements Recorder {
  readonly id = 'ffmpeg'
  private readonly opts: FfmpegOptions
  private readonly env: Record<string, string>
  private readonly platform: NodeJS.Platform

  constructor(opts: FfmpegOptions = {}) {
    this.opts = opts
    this.env = stringEnv(opts.env ?? process.env)
    this.platform = opts.platform ?? process.platform
  }

  private binary(): string | null {
    return resolveCommand(this.opts.binary ?? 'ffmpeg', this.env)
  }

  private input(): Input | null {
    const device = this.opts.device
    if (this.platform === 'darwin') return { format: 'avfoundation', device: device ?? ':0' }
    if (this.platform === 'linux') return { format: 'pulse', device: device ?? 'default' }
    return null
  }

  async available(): Promise<Availability> {
    // The platform first, because no amount of installing ffmpeg answers it:
    // where there is no audio input we know how to open, that is the reason,
    // whatever else is on the machine. Asked the other way round, what a
    // person is told depends on whether they happen to have ffmpeg.
    if (!this.input()) {
      return { ok: false, reason: `no known audio input for ${this.platform}` }
    }
    if (!this.binary()) {
      return { ok: false, reason: `ffmpeg is not installed (${this.howToInstall()})` }
    }
    return { ok: true }
  }

  /** Said in the terms of the machine it is said on: `brew` is not an answer on Linux. */
  private howToInstall(): string {
    return this.platform === 'darwin' ? 'brew install ffmpeg' : 'apt install ffmpeg'
  }

  async start(opts: RecorderOptions = {}): Promise<Recording> {
    const availability = await this.available()
    if (!availability.ok) throw new RecorderUnavailableError(this.id, availability.reason)
    const binary = this.binary()
    const input = this.input()
    if (!binary || !input) throw new RecorderUnavailableError(this.id, 'ffmpeg went missing')

    const sampleRate = opts.sampleRate ?? DEFAULTS.sampleRate
    const dir = mkdtempSync(join(tmpdir(), 'tade-speech-'))
    const path = join(dir, 'speech.wav')
    const child = spawn(
      binary,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        input.format,
        '-i',
        opts.device ?? input.device,
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        // A stuck key must not record until the disk is full.
        '-t',
        String(Math.ceil((opts.maxMs ?? DEFAULTS.maxMs) / 1000)),
        '-y',
        path,
      ],
      // Its own process group, like everything else Tade starts in the
      // background: a child in the terminal's foreground group is what
      // Terminal.app names the window after, so every push-to-talk renamed
      // the window `ffmpeg`. It is still ours — stopped and cancelled below.
      { stdio: ['pipe', 'ignore', 'pipe'], env: this.env, detached: true },
    )

    let problem = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      problem += chunk
    })
    const startedAt = Date.now()
    const cleanup = () => rmSync(dir, { recursive: true, force: true })

    return {
      stop: async (): Promise<AudioClip> => {
        // `q` is how ffmpeg is asked to finish writing a valid file; a signal
        // is the fallback, and a header-only file means it never started.
        child.stdin?.write('q')
        child.stdin?.end()
        await settle(child, 2_000)
        const size = sizeOf(path)
        if (size <= EMPTY_WAV) {
          cleanup()
          throw new Error(
            problem.trim() ||
              'nothing was recorded — check that your terminal is allowed to use the microphone',
          )
        }
        return { path, sampleRate, durationMs: Date.now() - startedAt }
      },
      cancel: async (): Promise<void> => {
        child.kill('SIGKILL')
        await settle(child, 1_000)
        cleanup()
      },
      // ffmpeg writes the file as it records, so the newest tenth of a second
      // is always at its end.
      level: () => levelOf(tailOf(path, Math.round(sampleRate / 10) * 2)),
    }
  }
}

/** Wait for a process to exit, escalating rather than hanging forever. */
async function settle(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const timer = new Promise<'timeout'>((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms)
    t.unref?.()
  })
  if ((await Promise.race([exited.then(() => 'done' as const), timer])) === 'timeout') {
    child.kill('SIGINT')
    const second = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), ms)
      t.unref?.()
    })
    if ((await Promise.race([exited.then(() => 'done' as const), second])) === 'timeout') {
      child.kill('SIGKILL')
      await exited
    }
  }
}

/**
 * Loudness of little-endian 16-bit PCM, 0 to 1: the RMS, lifted so that
 * speech at a normal distance fills most of a meter instead of a sliver of it.
 */
export function levelOf(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2)
  if (samples === 0) return 0
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2) / 32768
    sum += value * value
  }
  const rms = Math.sqrt(sum / samples)
  return Math.min(1, Math.sqrt(rms) * 1.6)
}

/** The last `bytes` of the audio after the header, aligned to whole samples. */
function tailOf(path: string, bytes: number): Buffer {
  const size = sizeOf(path)
  const available = Math.max(0, size - EMPTY_WAV)
  const length = Math.min(bytes, available) & ~1
  if (length <= 0) return Buffer.alloc(0)
  const buffer = Buffer.alloc(length)
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    readSync(fd, buffer, 0, length, EMPTY_WAV + ((available - length) & ~1))
    return buffer
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
