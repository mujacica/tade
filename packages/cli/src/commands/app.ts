import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { App } from '@wilco/app'
import { defaultConfigPath, isReady, loadConfig, readiness, wilcoHome } from '@wilco/core'
import { DaemonClient } from '@wilco/daemon/client'
import { socketPath } from '@wilco/daemon/protocol'
import { makeRecorder, makeTranscriber } from '@wilco/stt'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { gather } from './setup.ts'

/** Run the wizard attached to this terminal, and report how it went. */
async function runSetup(): Promise<number> {
  const bin = fileURLToPath(new URL('../bin.ts', import.meta.url))
  const child = spawn(process.execPath, [bin, 'setup'], { stdio: 'inherit' })
  return new Promise((done) => child.once('exit', (code) => done(code ?? 1)))
}

// The window. Everything it does is in `@wilco/app`; this only checks that
// there is a terminal and a daemon to talk to, then gets out of the way.

export function registerApp(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('app')
    .description('The window: every project, the agent you are watching, and the orchestrator')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`wilco config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      if (!process.stdout.isTTY) {
        io.err('`wilco app` needs a terminal')
        setExit(Exit.error)
        return
      }

      // A fresh machine gets led through setup rather than shown an empty
      // window. Same command, so there is only one implementation of it.
      if (!isReady(readiness(await gather()))) {
        if ((await runSetup()) !== 0) {
          setExit(Exit.error)
          return
        }
      }

      const socket = socketPath()
      if (!(await DaemonClient.isRunning(socket))) {
        io.err('daemon not running: start it with `wilco daemon start`')
        setExit(Exit.error)
        return
      }

      // Speech is wired in only when it can actually work. Recording into an
      // engine that has no model would lose what you said, so push-to-talk
      // falls back to a typed line and `wilco voice` says what is missing.
      const voice = cfg.config.surfaces.voice
      const recorder = makeRecorder(voice.mic)
      const transcriber = makeTranscriber(voice.stt)
      const canHear = (await recorder.available()).ok && (await transcriber.available()).ok

      const client = await DaemonClient.connect(socket)
      try {
        const app = await App.start({
          client,
          config: cfg.config,
          home: wilcoHome(),
          cwd: process.cwd(),
          ...(canHear ? { recorder, transcriber } : {}),
        })
        // Leaving the terminal in raw mode would outlive us, so stop on a
        // signal the same way as on quitting.
        const stop = () => void app.stop()
        process.on('SIGINT', stop)
        process.on('SIGTERM', stop)
        try {
          await app.wait()
        } finally {
          process.removeListener('SIGINT', stop)
          process.removeListener('SIGTERM', stop)
        }
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err))
        setExit(Exit.error)
      } finally {
        await client.close()
      }
    })
}
