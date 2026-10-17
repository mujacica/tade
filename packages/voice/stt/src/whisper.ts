import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type HowToInstall,
  type RequiredProgram,
  resolveCommand,
  runProgram,
  stringEnv,
} from '@tade/core'
import {
  type AudioClip,
  type Availability,
  type TranscribeOptions,
  type Transcriber,
  type TranscriberCapabilities,
  TranscriberUnavailableError,
  type Transcript,
} from '@tade/voice-core'

// whisper.cpp, on this machine. The default, because Tade is a local-first
// tool and a voice feature that demands an API key by default would contradict
// that: what you say to your own computer about your own code should not have
// to leave it.

/** Rejects as a failed run of the model should: with what whisper said, or the reason it was stopped. */
const execRun: WhisperRun = async (binary, args, opts) => {
  const ran = await runProgram(binary, args, {
    env: opts.env,
    signal: opts.signal,
    maxBuffer: opts.maxBuffer,
    // A clip is seconds of speech on a local model: five minutes is stuck, not slow.
    timeoutMs: 300_000,
  })
  opts.signal?.throwIfAborted()
  if (ran.code !== 0) throw new Error(ran.stderr.trim() || `${binary} exited ${ran.code}`)
}

/**
 * How the model is actually run. Injected so a test can hold this engine to
 * the whole of its contract — the arguments it builds, the text it reads back,
 * what it does with silence — without spending a minute of a runner's time on
 * a model, which is what `test/no-gui.ts` now refuses outright.
 */
export type WhisperRun = (
  binary: string,
  args: string[],
  opts: { env: Record<string, string>; signal?: AbortSignal; maxBuffer: number },
) => Promise<unknown>

/** Homebrew renamed the binary; older installs still have the old names. */
const BINARIES = ['whisper-cli', 'whisper-cpp', 'whisper', 'main']

/**
 * How whisper.cpp's program gets onto a machine. Homebrew has it, on a Mac and
 * on Linux alike, as `whisper.cpp` — `whisper-cpp` is the name it had, which
 * the Cellar no longer uses. No distribution's stable release does: Debian packages
 * `whisper-cli` only in testing and unstable (`whisper.cpp-tools`), and
 * Fedora's `whisper-cpp` is the library alone — a `dnf install whisper-cpp`
 * would install something else under the same name. So Linux is told the
 * upstream build, with static libraries so the one file can be put anywhere.
 */
const INSTALL: HowToInstall = {
  brew: 'whisper.cpp',
  instead: {
    linux:
      'no stable distribution packages whisper-cli, so build it (git, cmake and a C++ compiler): ' +
      '`git clone https://github.com/ggml-org/whisper.cpp && ' +
      'cmake -S whisper.cpp -B whisper.cpp/build -DBUILD_SHARED_LIBS=OFF && ' +
      'cmake --build whisper.cpp/build -j --config Release`, ' +
      'then put whisper.cpp/build/bin/whisper-cli on your PATH',
  },
}

export interface WhisperOptions {
  /** Path to a ggml model. */
  model?: string
  /** Overrides the search for a whisper binary. */
  binary?: string
  language?: string
  /** Threads. Default is whisper's own choice. */
  threads?: number
  env?: NodeJS.ProcessEnv
  /** Overrides how the model is run. For tests: the default runs whisper.cpp. */
  run?: WhisperRun
}

export function defaultModelPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.TADE_HOME ?? join(homedir(), '.tade')
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
  private readonly run: WhisperRun

  /**
   * whisper.cpp's program, wherever this engine would run it from: an older
   * install answers to an older name, and calling that one missing because
   * nothing answers to `whisper-cli` would be a lie about the one that runs.
   * A PATH lookup, and only when somebody asks.
   */
  get programs(): readonly RequiredProgram[] {
    const found = this.binary()
    return [
      {
        command: 'whisper-cli',
        title: 'whisper.cpp',
        why: 'hearing you on this machine, so nothing you say leaves it',
        versionArgs: ['--version'],
        // Typing works without it: speech is never a reason to stop.
        optional: true,
        ...(found ? { at: found } : {}),
        install: INSTALL,
      },
    ]
  }

  constructor(opts: WhisperOptions = {}) {
    this.opts = opts
    this.env = stringEnv(opts.env ?? process.env)
    this.run = opts.run ?? execRun
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
    // What is missing, never which installer fixes it: that is this
    // machine's line, which setup and `tade voice` read out of `programs`.
    if (!this.binary()) {
      const looked = this.opts.binary ?? 'whisper-cli'
      return { ok: false, reason: `whisper.cpp is not installed (no ${looked} on the PATH)` }
    }
    const model = this.model()
    if (!existsSync(model)) {
      return { ok: false, reason: `no model at ${model} (run \`tade voice setup\`)` }
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
      await this.run(binary, args, {
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
