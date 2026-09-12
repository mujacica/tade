import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { defaultConfigPath, loadConfig, wilcoHome } from '@wilco/core'
import { makeRecorder, makeTranscriber } from '@wilco/stt'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// Can Wilco hear you, and if not, what would fix it.
//
// Speech is the one part of this that depends on things Wilco cannot install
// for you, so the answer has to be a sentence you can act on rather than a
// stack trace after you have already spoken.

const MODELS = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

/** The ones worth suggesting, with what they cost to download. */
const SIZES: Record<string, string> = {
  'tiny.en': '75 MB',
  'base.en': '142 MB',
  'small.en': '466 MB',
  'large-v3-turbo': '1.6 GB',
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
    .option('-m, --model <name>', 'tiny.en | base.en | small.en | large-v3-turbo', 'base.en')
    .action(async (opts: { model: string }) => {
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
        await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
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
  return `${Math.round(bytes / 1_000_000)} MB`
}
