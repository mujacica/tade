import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { App } from '@wilco/app'
import {
  activityFrom,
  defaultConfigPath,
  expandHome,
  historyFrom,
  isReady,
  loadConfig,
  readiness,
  wilcoHome,
} from '@wilco/core'
import type { ExtensionWorkbench } from '@wilco/extensions-core'
import { piBinary } from '@wilco/harnesses-pi/adapter'
import { installedPieces } from '@wilco/harnesses-pi/installed'
import { credentials, findModel, loggedInProviders, usableModels } from '@wilco/harnesses-pi/models'
import {
  decideProposal,
  extensionWorkbench,
  loadExtensions,
  Orchestrator,
  orchestratorExtensions,
  proposedExtensions,
  ToolHost,
  type ToolHostOptions,
  workbenchExtensions,
} from '@wilco/orchestrator'
import { collectStatus } from '@wilco/status'
import { makeRecorder, makeTranscriber } from '@wilco/voice-stt'
import { HomeBusyError, Workbench } from '@wilco/workbench'
import { livenessFrom } from '@wilco/workbench/lane-liveness'
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
      const safe = program.opts().safe === true
      // Loaded before anything that hands them out: the workbench gives agents
      // their tools, the host gives the orchestrator its, the window runs them.
      const extensions = await loadExtensions({ config: cfg.config, home, safe })
      const extensionsRoot = expandHome(cfg.config.orchestrator.extensions)
      // What an extension may ask of the window, once there is one.
      let windowForExtensions: ExtensionWorkbench | null = null
      let client: Workbench
      try {
        client = await Workbench.open({
          home,
          extensions: workbenchExtensions(extensions, home, () => windowForExtensions),
        })
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
      // A terminal the orchestrator opens or runs something in comes to the
      // front of the window, which starts after the socket does.
      let showTerminal: (terminal: string) => void = () => {}
      let keepOrchestratorModel: (model: { provider: string; id: string }) => void = () => {}
      let handOff: NonNullable<ToolHostOptions['handOff']> = async () => ({ note: '', images: [] })
      const tools = await ToolHost.listen({
        wilco: client,
        path: join(home, 'runs', `tools-${process.pid}.sock`),
        onTerminal: (terminal) => showTerminal(terminal),
        handOff: (cwd) => handOff(cwd),
        status: () =>
          collectStatus({
            config: client.config,
            now: Date.now(),
            home: homedir(),
            cwd: process.cwd(),
            pr: false,
            liveness: livenessFrom(client),
          }),
        orchestratorModel: async (said) => {
          const found = findModel(said, await usableModels())
          if (!found.ok) throw new Error(found.reason)
          const chosen = { provider: found.provider, id: found.id }
          keepOrchestratorModel(chosen)
          return chosen
        },
        extensions: async (call) =>
          (
            await extensions.call(call.tool, call.input, {
              caller: { kind: 'orchestrator' },
              id: call.callId,
              wilco: windowForExtensions,
            })
          ).text,
      })
      // Held so it can be stopped on the way out, whenever it finishes coming
      // up. Typed explicitly: assigned only from inside a callback, which is
      // not something inference can see.
      let orchestrator: Orchestrator | null = null
      let restartThinker: () => Promise<void> = async () => {}
      const stopOrchestrator = async () => {
        await orchestrator?.stop().catch(() => {})
      }
      try {
        let shouldReload = false
        const app = await App.start({
          client,
          config: cfg.config,
          home,
          cwd: process.cwd(),
          ...(canHear ? { recorder, transcriber } : {}),
          // What an agent can be started on: the models you are signed in to.
          models: () => usableModels(),
          accounts: () => loggedInProviders(),
          // Signed in, or a key: which one is paying, said beside the model.
          credentials: () => credentials(),
          signIn: () => ({ command: process.execPath, args: [piBinary()] }),
          restartThinker: () => restartThinker(),
          reloadWindow: async () => {
            shouldReload = true
            await app.stop()
          },
          proposals: {
            list: () => proposedExtensions(extensionsRoot),
            decide: (name, verdict) => decideProposal(extensionsRoot, name, verdict),
          },
          extensions,
          harnessExtensions: async () => installedPieces(homedir(), process.cwd()),
        })
        showTerminal = (terminal) => void app.showTerminal(terminal)
        keepOrchestratorModel = (model) => app.thinkerMovedTo(model)
        // An agent an extension starts is put in front of you, like one you started.
        windowForExtensions = extensionWorkbench(client, (task) => app.showTask(task))
        app.useExtensionWorkbench(windowForExtensions)

        // Files you attached go to the agents the orchestrator starts in answer.
        handOff = (cwd) => app.handOff(cwd)

        // The orchestrator is a model in another process and takes a few
        // seconds to come up. The window does not wait for it: an empty
        // terminal while something else starts is the worst first second Wilco
        // could have, and it says so in the strip when it arrives. If it never
        // does — no model configured yet — everything except free text still
        // works, which is the honest outcome.
        const startThinker = async (resume: boolean) => {
          // Read again: a model chosen in the window is in the file, not in
          // what was loaded when this started.
          const now = await loadConfig(opts.config)
          const config = now.ok ? now.config : cfg.config
          return (
            Orchestrator.start({
              home,
              socket: tools.path,
              runDir: join(home, 'orchestrator'),
              cwd: process.cwd(),
              config,
              // So it knows what you have told it, not just what it can do.
              notes: client.recallAll(),
              // And which of its own lessons still apply.
              activity: activityFrom(
                historyFrom(await client.events({ limit: 2_000 }), Date.now()),
                Object.keys(config.projects),
              ),
              safe,
              ...(resume ? { resume: true } : {}),
              extensions: orchestratorExtensions(extensions, home, config.orchestrator.harness),
              onUsage: (usage) => {
                void client.log
                  .append({ type: 'usage', task: null, detail: { by: 'orchestrator', ...usage } })
                  .catch(() => {})
              },
            })
              .then(async (started) => {
                orchestrator = started
                app.attachThinker({
                  ask: (text, images = []) =>
                    started.askFor(
                      text,
                      120_000,
                      images.map(({ data, mimeType }) => ({ data, mimeType })),
                    ),
                  tell: (text) => started.tell(text),
                  onEvent: (listener) => started.onEvent(listener),
                })
                // Nothing chosen, so the harness picked: keep what it picked, so the
                // next time an agent switches model the orchestrator does not follow.
                if (!config.orchestrator.model) {
                  const model = await started.model().catch(() => null)
                  if (model) app.keepThinkerModel(model)
                }
              })
              // Said in the conversation, where you would have waited for an answer.
              .catch((err: unknown) => {
                app.thinkerFailed(err instanceof Error ? err.message : String(err))
              })
          )
        }
        let starting = startThinker(false)
        // A new model for the orchestrator: the old one stops, and the new one
        // carries on the same conversation.
        restartThinker = async () => {
          await starting
          await stopOrchestrator()
          orchestrator = null
          starting = startThinker(true)
          await starting
        }
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
          // Closing while it is still starting would leave a model process
          // behind with nothing to talk to.
          await starting
        }
        if (shouldReload) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            stdio: 'inherit',
            detached: true,
          })
          child.unref()
        }
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err))
        setExit(Exit.error)
      } finally {
        await stopOrchestrator()
        await tools.close().catch(() => {})
        // Lets go of the lanes; under tmux the agents carry on working.
        await client.close().catch(() => {})
      }
    })
}
