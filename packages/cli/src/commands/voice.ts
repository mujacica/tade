import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { defaultConfigPath, loadConfig, wilcoHome } from '@wilco/core'
import { makeRecorder, makeTranscriber } from '@wilco/voice-stt'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// Can Wilco hear you, and if not, what would fix it.
//
// Speech is the one part of this that depends on things Wilco cannot install
// for you, so the answer has to be a sentence you can act on rather than a
// stack trace after you have already spoken.

const MODELS = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

/**
 * The models worth offering, what they cost to download, and what they can
 * hear. The `.en` ones are English-only and noticeably better at it for their
 * size; everything else understands about a hundred languages, which is the
 * choice most people are actually making here.
 */
export interface WhisperModel {
  name: string
  size: string
  english: boolean
  note: string
}

export const WHISPER_MODELS: WhisperModel[] = [
  { name: 'tiny.en', size: '75 MB', english: true, note: 'fastest, roughest' },
  { name: 'base.en', size: '142 MB', english: true, note: 'a good default' },
  { name: 'small.en', size: '466 MB', english: true, note: 'better, slower' },
  { name: 'tiny', size: '75 MB', english: false, note: 'fastest, roughest' },
  { name: 'base', size: '142 MB', english: false, note: 'a good default' },
  { name: 'small', size: '466 MB', english: false, note: 'better, slower' },
  { name: 'medium', size: '1.5 GB', english: false, note: 'better again' },
  { name: 'large-v3-turbo', size: '1.6 GB', english: false, note: 'best, still quick' },
]

const SIZES: Record<string, string> = Object.fromEntries(
  WHISPER_MODELS.map((model) => [model.name, model.size]),
)

/**
 * A progress line that redraws itself.
 *
 * Written with a carriage return rather than newlines, so it is one line that
 * changes rather than a thousand that scroll — and a download with no sign of
 * life is one people assume has hung and kill.
 */
export function progressLine(done: number, total: number, perSecond: number, width = 28): string {
  const share = total > 0 ? Math.min(1, done / total) : 0
  const filled = Math.round(share * width)
  const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
  const percent = total > 0 ? `${Math.floor(share * 100)}%`.padStart(4) : '    '
  const speed = perSecond > 0 ? ` ${mb(perSecond)}/s` : ''
  const left = total > 0 && perSecond > 0 ? ` · ${duration((total - done) / perSecond)} left` : ''
  return `  ${bar} ${percent}  ${mb(done)}${total > 0 ? ` of ${mb(total)}` : ''}${speed}${left}`
}

function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return 'a moment'
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  return `${Math.ceil(seconds / 60)}m`
}

/**
 * Count the bytes going past and say so, at most a few times a second.
 *
 * A pass-through rather than a wrapper around the whole download: it has to
 * report while the bytes are moving, and the thing being reported on is a
 * stream somebody else owns.
 */
function showProgress(total: number, write: (line: string) => void): Transform {
  let done = 0
  let last = 0
  const began = Date.now()
  return new Transform({
    transform(chunk: Buffer, _encoding, next) {
      done += chunk.byteLength
      const now = Date.now()
      // Four times a second: often enough to look alive, rarely enough that
      // the drawing is not what is slowing the download down.
      if (now - last >= 250) {
        last = now
        const elapsed = (now - began) / 1000
        write(`\r${progressLine(done, total, elapsed > 0 ? done / elapsed : 0)}`)
      }
      next(null, chunk)
    },
    flush(next) {
      const elapsed = (Date.now() - began) / 1000
      write(`\r${progressLine(done, total || done, elapsed > 0 ? done / elapsed : 0)}\n`)
      next()
    },
  })
}

function modelPath(name: string): string {
  return join(wilcoHome(), 'models', `ggml-${name}.bin`)
}

export function registerVoice(program: Command, io: Io, setExit: (code: number) => void): void {
  const voice = program.command('voice').description('Speech: what is set up, and what is missing')

  voice
    .command('status', { isDefault: true })
    .description('Whether Wilco can hear you, and what would fix it')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`wilco config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      const voiceConfig = cfg.config.surfaces.voice
      const recorder = makeRecorder(voiceConfig.mic)
      const transcriber = makeTranscriber(voiceConfig.stt)

      const mic = await recorder.available()
      const engine = await transcriber.available()
      io.out(`microphone  ${recorder.id.padEnd(12)} ${mic.ok ? 'ok' : `— ${mic.reason}`}`)
      io.out(
        `speech      ${transcriber.id.padEnd(12)} ${engine.ok ? 'ok' : `— ${engine.reason}`}` +
          `${transcriber.capabilities.local ? '  (local)' : '  (sends audio to a provider)'}`,
      )
      if (mic.ok && engine.ok) {
        io.out('')
        io.out('hold ctrl+space in `wilco app` and say something.')
        return
      }
      io.out('')
      if (!engine.ok && transcriber.id === 'whisper-cpp') {
        io.out('to set up local speech:  brew install whisper-cpp && wilco voice setup')
      }
      if (!engine.ok && !transcriber.capabilities.local) {
        io.out('set the API key in your environment, or switch to a local engine:')
        io.out('  surfaces: { voice: { stt: { driver: whisper-cpp } } }')
      }
      // Not an error: typing into the window works regardless.
      io.out('until then, ctrl+space opens a line you can type into.')
    })

  voice
    .command('setup')
    .description('Download a local speech model')
    .option('-m, --model <name>', 'which model to fetch', 'base.en')
    .option('--list', 'show the models on offer and what they cost')
    .action(async (opts: { model: string; list?: boolean }) => {
      if (opts.list) {
        for (const model of WHISPER_MODELS) {
          const languages = model.english ? 'English only' : 'any language'
          io.out(`${model.name.padEnd(16)} ${model.size.padStart(7)}  ${languages}, ${model.note}`)
        }
        return
      }
      const target = modelPath(opts.model)
      if (existsSync(target)) {
        io.out(`already there: ${target} (${mb(statSync(target).size)})`)
        return
      }
      const url = `${MODELS}/ggml-${opts.model}.bin`
      io.out(`downloading ${opts.model}${SIZES[opts.model] ? ` (${SIZES[opts.model]})` : ''}…`)
      try {
        const response = await fetch(url)
        if (!response.ok || !response.body) {
          io.err(`could not download ${opts.model}: ${response.status}`)
          setExit(Exit.error)
          return
        }
        mkdirSync(dirname(target), { recursive: true })
        // Streamed to a partial file and renamed only on success, so an
        // interrupted download never looks like a usable model.
        const partial = `${target}.partial`
        const total = Number(response.headers.get('content-length') ?? 0)
        await pipeline(
          Readable.fromWeb(response.body),
          // Written straight out rather than through `io`, which ends every
          // line: a progress bar is one line that is rewritten, and a newline
          // per update would be a thousand lines of scrollback.
          showProgress(total, (line) => process.stdout.write(line)),
          createWriteStream(partial),
        )
        const { renameSync } = await import('node:fs')
        renameSync(partial, target)
        io.out(`${target} (${mb(statSync(target).size)})`)
        io.out('run `wilco voice` to check it.')
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err))
        setExit(Exit.error)
      }
    })
}

function mb(bytes: number): string {
  // Below a megabyte, "0 MB/s" reads as stalled when it is merely slow.
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`
  return `${Math.round(bytes / 1_000_000)} MB`
}
