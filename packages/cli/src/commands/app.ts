import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { App } from '@wilco/app'
import { defaultConfigPath, isReady, loadConfig, readiness, wilcoHome } from '@wilco/core'
import { Orchestrator, ToolHost } from '@wilco/orchestrator'
import { makeRecorder, makeTranscriber } from '@wilco/voice-stt'
import { HomeBusyError, Workbench } from '@wilco/workbench'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { gather } from './setup.ts'

/** Run the wizard attached to this terminal, and report how it went. */
async function runSetup(): Promise<number> {
  const bin = fileURLToPath(new URL('../bin.ts', import.meta.url))
  const child = spawn(process.execPath, [bin, 'setup'], { stdio: 'inherit' })
  return new Promise((done) => child.once('exit', (code) => done(code ?? 1)))
}

// The window. Everything it does is in `@wilco/app`; this opens the workbench,
// starts the orchestrator and the way back for its tools, then gets out of the
// way. Closing it lets go of the lanes rather than ending them.

export function registerApp(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('app', { isDefault: true })
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

      // Speech is wired in only when it can actually work. Recording into an
      // engine that has no model would lose what you said, so push-to-talk
      // falls back to a typed line and `wilco voice` says what is missing.
      const voice = cfg.config.surfaces.voice
      const recorder = makeRecorder(voice.mic)
      const transcriber = makeTranscriber(voice.stt)
      const canHear = (await recorder.available()).ok && (await transcriber.available()).ok

      const home = wilcoHome()
      let client: Workbench
      try {
        client = await Workbench.open({ home })
      } catch (err) {
        io.err(
          err instanceof HomeBusyError
            ? `${err.message}. Only one window at a time.`
            : err instanceof Error
              ? err.message
              : String(err),
        )
        setExit(Exit.error)
        return
      }

      // The way back for the orchestrator's own tools: it runs as pi in its
      // own process, so `wilco_run_start` has to reach us somehow. One socket,
      // named after this process, gone when the window is.
      const tools = await ToolHost.listen({
        wilco: client,
        path: join(home, 'runs', `tools-${process.pid}.sock`),
      })
      // Anything the grammar does not recognise goes to the orchestrator. If
      // it cannot start — no model configured yet — the window still works and
      // free text is simply not understood, which is the honest outcome.
      const orchestrator = await Orchestrator.start({
        home,
        socket: tools.path,
        runDir: join(home, 'orchestrator'),
        cwd: process.cwd(),
        config: cfg.config,
        // So it knows what you have told it, not just what it can do.
        notes: client.recallAll(),
        safe: program.opts().safe === true,
      }).catch(() => null)

      try {
        const app = await App.start({
          client,
          config: cfg.config,
          home,
          cwd: process.cwd(),
          ...(canHear ? { recorder, transcriber } : {}),
          ...(orchestrator
            ? { thinker: { ask: (text: string) => orchestrator.askFor(text) } }
            : {}),
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
        await orchestrator?.stop().catch(() => {})
        await tools.close().catch(() => {})
        // Lets go of the lanes; under tmux the agents carry on working.
        await client.close().catch(() => {})
      }
    })
}
