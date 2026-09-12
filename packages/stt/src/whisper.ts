import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  type AudioClip,
  type Availability,
  resolveCommand,
  stringEnv,
  type TranscribeOptions,
  type Transcriber,
  type TranscriberCapabilities,
  TranscriberUnavailableError,
  type Transcript,
} from '@wilco/core'

// whisper.cpp, on this machine. The default, because Wilco is a local-first
// tool and a voice feature that demands an API key by default would contradict
// that: what you say to your own computer about your own code should not have
// to leave it.

const run = promisify(execFile)

/** Homebrew renamed the binary; older installs still have the old names. */
const BINARIES = ['whisper-cli', 'whisper-cpp', 'whisper', 'main']

export interface WhisperOptions {
  /** Path to a ggml model. */
  model?: string
  /** Overrides the search for a whisper binary. */
  binary?: string
  language?: string
  /** Threads. Default is whisper's own choice. */
  threads?: number
  env?: NodeJS.ProcessEnv
}

export function defaultModelPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.WILCO_HOME ?? join(homedir(), '.wilco')
  return join(home, 'models', 'ggml-base.en.bin')
}

export class WhisperCppTranscriber implements Transcriber {
  readonly id = 'whisper-cpp'
  readonly capabilities: TranscriberCapabilities = {
    local: true,
    // whisper.cpp can stream, but push-to-talk does not need it and the
    // streaming build is a different binary. Declared honestly as false.
    streaming: false,
    // `--prompt` biases decoding, which is exactly what task names need.
    vocabulary: true,
  }

  private readonly opts: WhisperOptions
  private readonly env: Record<string, string>

  constructor(opts: WhisperOptions = {}) {
    this.opts = opts
    this.env = stringEnv(opts.env ?? process.env)
  }

  private binary(): string | null {
    if (this.opts.binary) return resolveCommand(this.opts.binary, this.env)
    for (const name of BINARIES) {
      const found = resolveCommand(name, this.env)
      if (found) return found
    }
    return null
  }

  private model(): string {
    return this.opts.model ?? defaultModelPath(this.opts.env ?? process.env)
  }

  async available(): Promise<Availability> {
    if (!this.binary()) {
      return { ok: false, reason: 'whisper.cpp is not installed (brew install whisper-cpp)' }
    }
    const model = this.model()
    if (!existsSync(model)) {
      return { ok: false, reason: `no model at ${model} (run \`wilco voice setup\`)` }
    }
    return { ok: true }
  }

  async transcribe(clip: AudioClip, opts: TranscribeOptions = {}): Promise<Transcript> {
    const availability = await this.available()
    if (!availability.ok) throw new TranscriberUnavailableError(this.id, availability.reason)
    opts.signal?.throwIfAborted()

    const binary = this.binary()
    if (!binary) throw new TranscriberUnavailableError(this.id, 'whisper.cpp went missing')

    // Written beside the clip rather than parsed out of stdout, which carries
    // the model's own progress chatter.
    const prefix = `${clip.path}.out`
    const args = [
      '-m',
      this.model(),
      '-f',
      clip.path,
      '--output-txt',
      '--output-file',
      prefix,
      '--no-timestamps',
      '--no-prints',
    ]
    const language = opts.language ?? this.opts.language
    if (language) args.push('--language', language)
    if (this.opts.threads) args.push('--threads', String(this.opts.threads))
    // Task and project names are exactly the words a general model gets wrong.
    if (opts.vocabulary?.length) args.push('--prompt', opts.vocabulary.join(', '))

    try {
      await run(binary, args, {
        env: this.env,
        ...(opts.signal ? { signal: opts.signal } : {}),
        maxBuffer: 8 * 1024 * 1024,
      })
      return { text: readText(`${prefix}.txt`), confidence: null, by: this.id }
    } finally {
      rmSync(`${prefix}.txt`, { force: true })
    }
  }
}

function readText(path: string): string {
  try {
    return clean(readFileSync(path, 'utf8'))
  } catch {
    // No output file means it heard nothing worth writing down.
    return ''
  }
}

/**
 * whisper writes bracketed noise annotations for silence — `[BLANK_AUDIO]`,
 * `(silence)` — which are not words anybody said.
 */
function clean(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:silence|no speech|blank audio)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
