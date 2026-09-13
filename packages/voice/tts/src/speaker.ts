import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Making Wilco audible.
//
// Earcons carry state, speech carries content. Three distinct tones are the
// highest-leverage detail in the whole voice design: you learn them in a day
// and can then track several agents through one earbud without hearing a
// single sentence.
//
// Nothing here may ever throw into the daemon. A machine with no audio should
// lose the sound and keep the work.

export type Tone = 'blocked' | 'review' | 'failed'

export interface ToneSpec {
  /** Hz per step; 0 is a rest. */
  steps: number[]
  msPerStep: number
}

/** Deliberately distinguishable at low volume through one earbud. */
export const TONES: Record<Tone, ToneSpec> = {
  // Falling: something wants you.
  blocked: { steps: [880, 620], msPerStep: 140 },
  // Rising: something is finished.
  review: { steps: [620, 880], msPerStep: 140 },
  // Flat double: something is stuck.
  failed: { steps: [740, 0, 740], msPerStep: 110 },
}

const SAMPLE_RATE = 22_050

/** A mono 16-bit WAV. Pure, so the shape of a tone is testable. */
export function toneWav(spec: ToneSpec, sampleRate = SAMPLE_RATE): Buffer {
  const perStep = Math.floor((spec.msPerStep / 1000) * sampleRate)
  const samples = new Int16Array(perStep * spec.steps.length)
  const fade = Math.min(Math.floor(perStep / 8), 220)

  spec.steps.forEach((frequency, step) => {
    for (let i = 0; i < perStep; i++) {
      if (frequency === 0) continue
      // Fade each edge, or the steps click.
      const envelope = Math.min(1, i / fade, (perStep - i) / fade)
      const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * envelope * 0.35
      samples[step * perStep + i] = Math.round(value * 32_767)
    }
  })

  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.byteLength, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(data.byteLength, 40)
  return Buffer.concat([header, data])
}

export interface Command {
  command: string
  args: string[]
}

export type Runner = (command: Command) => Promise<void>

export interface SpeakerOptions {
  /** Where generated earcons are cached. */
  soundDir: string
  platform?: NodeJS.Platform
  /** Overrides the platform default; `null` disables speech. */
  voice?: ((text: string) => Command) | null
  /** Overrides the platform default; `null` disables sound. */
  player?: ((file: string) => Command) | null
  run?: Runner
  /** Rate for the built-in macOS voice. */
  rate?: number
}

export interface SpeakerCapabilities {
  speech: boolean
  sound: boolean
}

export class Speaker {
  readonly capabilities: SpeakerCapabilities
  private readonly soundDir: string
  private readonly voice: ((text: string) => Command) | null
  private readonly player: ((file: string) => Command) | null
  private readonly run: Runner

  private constructor(opts: {
    soundDir: string
    voice: ((text: string) => Command) | null
    player: ((file: string) => Command) | null
    run: Runner
  }) {
    this.soundDir = opts.soundDir
    this.voice = opts.voice
    this.player = opts.player
    this.run = opts.run
    this.capabilities = { speech: opts.voice !== null, sound: opts.player !== null }
  }

  static async create(opts: SpeakerOptions): Promise<Speaker> {
    const platform = opts.platform ?? process.platform
    const speaker = new Speaker({
      soundDir: opts.soundDir,
      voice: opts.voice === undefined ? defaultVoice(platform, opts.rate ?? 190) : opts.voice,
      player: opts.player === undefined ? defaultPlayer(platform) : opts.player,
      run: opts.run ?? execRunner,
    })
    await speaker.prepare()
    return speaker
  }

  /** Write the earcons once, so playing one is just a file read later. */
  async prepare(): Promise<void> {
    if (!this.capabilities.sound) return
    await mkdir(this.soundDir, { recursive: true })
    for (const [tone, spec] of Object.entries(TONES)) {
      const file = this.toneFile(tone as Tone)
      if (!existsSync(file)) await writeFile(file, toneWav(spec))
    }
  }

  toneFile(tone: Tone): string {
    return join(this.soundDir, `${tone}.wav`)
  }

  async speak(text: string): Promise<void> {
    if (!this.voice || text.trim() === '') return
    await this.safely(this.voice(text))
  }

  async earcon(tone: Tone): Promise<void> {
    if (!this.player) return
    await this.safely(this.player(this.toneFile(tone)))
  }

  /** Audio failing is never a reason for the rest of Wilco to stop. */
  private async safely(command: Command): Promise<void> {
    try {
      await this.run(command)
    } catch {
      // no audio on this machine, or the tool is missing
    }
  }
}

function defaultVoice(platform: NodeJS.Platform, rate: number): ((text: string) => Command) | null {
  if (platform === 'darwin') {
    return (text) => ({ command: 'say', args: ['-r', String(rate), text] })
  }
  if (platform === 'linux') {
    return (text) => ({ command: 'spd-say', args: ['--wait', text] })
  }
  return null
}

function defaultPlayer(platform: NodeJS.Platform): ((file: string) => Command) | null {
  if (platform === 'darwin') return (file) => ({ command: 'afplay', args: [file] })
  if (platform === 'linux') return (file) => ({ command: 'paplay', args: [file] })
  return null
}

const execRunner: Runner = ({ command, args }) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 20_000 }, (err) => (err ? reject(err) : resolve()))
  })
