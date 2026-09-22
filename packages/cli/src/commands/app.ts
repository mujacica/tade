import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { App, thinkerOffers } from '@tade/app'
import {
  activityFrom,
  defaultConfigPath,
  expandHome,
  historyFrom,
  isReady,
  loadConfig,
  modelDetail,
  readiness,
  Secrets,
  type ThinkingLevel,
  tadeHome,
} from '@tade/core'
import type { ExtensionWorkbench } from '@tade/extensions-core'
import { installedServers as claudeServers } from '@tade/harnesses-claude/installed'
import { installedServers as codexServers } from '@tade/harnesses-codex/installed'
import { piBinary } from '@tade/harnesses-pi/adapter'
import { installedPieces } from '@tade/harnesses-pi/installed'
import { credentials, findModel, usableModels } from '@tade/harnesses-pi/models'
import { shownServers } from '@tade/mcp-broker'
import {
  brokerFor,
  extensionWorkbench,
  loadExtensions,
  Orchestrator,
  orchestratorExtensions,
  ToolHost,
  type ToolHostOptions,
  workbenchExtensions,
  writtenTools,
} from '@tade/orchestrator'
import { collectStatus } from '@tade/status'
import { watchProcess } from '@tade/telemetry'
import { makeRecorder, makeTranscriber } from '@tade/voice-stt'
import { HomeBusyError, Workbench } from '@tade/workbench'
import { livenessFrom } from '@tade/workbench/lane-liveness'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { reporterFor, reportJournal } from '../telemetry.ts'
import { gather } from './setup.ts'

/** Run the wizard attached to this terminal, and report how it went. */
async function runSetup(): Promise<number> {
  const bin = fileURLToPath(new URL('../bin.ts', import.meta.url))
  const child = spawn(process.execPath, [bin, 'setup'], { stdio: 'inherit' })
  return new Promise((done) => child.once('exit', (code) => done(code ?? 1)))
}

// The window. Everything it does is in `@tade/app`; this opens the workbench,
// starts the orchestrator and the way back for its tools, then gets out of the
// way. Closing it lets go of the lanes rather than ending them.

export function registerApp(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('app', { isDefault: true })
    .description('The window: every project, the agent you are watching, and the orchestrator')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { config: string }) => {
      const opened = Date.now()
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      if (!process.stdout.isTTY) {
        io.err('`tade app` needs a terminal')
        setExit(Exit.error)
        return
      }

      // What the machine calls this process, and so what a terminal that names
      // its window after the program running in it will say: `tade`, not
      // `node` and the whole path to a file in this repository. The window
      // writes its own title over the top of that; this is what is left when a
      // terminal insists on the process name as well, and what `ps` says.
      //
      // Only the window. On macOS a title overwrites the argument list a
      // process shows, so a short-lived command would stop saying which
      // command it was, which is worth more than a name nobody reads.
      process.title = 'tade'

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
      // falls back to a typed line and `tade voice` says what is missing.
      const voice = cfg.config.surfaces.voice
      const recorder = makeRecorder(voice.mic)
      const transcriber = makeTranscriber(voice.stt)
      const canHear = (await recorder.available()).ok && (await transcriber.available()).ok

      const home = tadeHome()
      const safe = program.opts().safe === true
      // Where Tade's own trouble goes, if anywhere: nothing is sent until a
      // DSN is set, and what a crash takes down is sent on the way out.
      const report = await reporterFor(cfg.config)
      let restoreTerminal: () => Promise<void> = async () => {}
      const stopWatching = report.on
        ? watchProcess(report, {
            where: 'the window',
            // The terminal comes back before anything else: a crash that left
            // it in raw mode is a crash you cannot read.
            onFatal: () => restoreTerminal(),
          })
        : () => {}
      // Loaded before anything that hands them out: the workbench gives agents
      // their tools, the host gives the orchestrator its, the window runs them.
      // How long Tade takes to open, in the parts it is made of.
      const timingOpen = report.doing({
        name: 'open the window',
        op: 'tade.open',
        startedAt: opened,
      })
      const loadingExtensions = timingOpen.inside({
        name: 'load the extensions',
        op: 'tade.extensions',
      })
      // Where a warning goes: the journal, once the window has one — which
      // the warm-up always waits for, since it happens after the window is up.
      let warn: (message: string) => Promise<void> = async (message) => {
        io.err(message)
      }
      // Where keys are kept, opened once: finding out costs a process on
      // macOS, and everything that reads one — the extensions, the servers,
      // the page — is asking the same question about the same home.
      const secrets = Secrets.open({ home })
      // The MCP servers a person has turned on, brokered here rather than
      // inside `loadExtensions` so the window can ask each of them what it
      // offers once it is up, and end their sessions on the way out.
      const mcp = brokerFor({
        config: cfg.config,
        home,
        safe,
        secrets,
        onWarning: (message) => void warn(message),
      })
      const extensions = await loadExtensions({
        config: cfg.config,
        home,
        safe,
        configPath: cfg.path,
        secrets,
        mcp,
      })
      loadingExtensions.end()
      const extensionsRoot = expandHome(cfg.config.orchestrator.extensions)
      // What an extension may ask of the window, once there is one.
      let windowForExtensions: ExtensionWorkbench | null = null
      let client: Workbench
      const openingWorkbench = timingOpen.inside({
        name: 'open the workbench',
        op: 'tade.workbench',
      })
      try {
        client = await Workbench.open({
          home,
          extensions: workbenchExtensions(extensions, home, () => windowForExtensions),
          report,
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
        openingWorkbench.wrong(err)
        openingWorkbench.end()
        timingOpen.end()
        return
      }
      openingWorkbench.end()

      warn = async (message) => {
        await client.log.append({ type: 'warning', detail: { message } }).catch(() => {})
      }

      // Everything the journal says, for whoever is watching Tade itself.
      const stopReporting = reportJournal(report, client)

      // The way back for the orchestrator's own tools: it runs as pi in its
      // own process, so `tade_run_start` has to reach us somehow. One socket,
      // named after this process, gone when the window is.
      // A terminal the orchestrator opens or runs something in comes to the
      // front of the window, which starts after the socket does.
      let showTerminal: (terminal: string) => void = () => {}
      let keepOrchestratorModel: (model: { provider: string; id: string }) => void = () => {}
      let handOff: NonNullable<ToolHostOptions['handOff']> = async () => ({ note: '', images: [] })
      // The queue is the window's to run, and the window comes up after this.
      let queue: ReturnType<App['queueTools']> | null = null
      const opening = () => new Error('Tade is still opening: ask again in a moment')
      const tools = await ToolHost.listen({
        tade: client,
        path: join(home, 'runs', `tools-${process.pid}.sock`),
        onTerminal: (terminal) => showTerminal(terminal),
        handOff: (cwd) => handOff(cwd),
        queue: {
          describe: async () => {
            if (!queue) throw opening()
            return queue.describe()
          },
          change: async (req) => {
            if (!queue) throw opening()
            return queue.change(req)
          },
          plan: async (plan) => {
            if (!queue) throw opening()
            return queue.plan(plan)
          },
          schedule: async (req) => {
            if (!queue) throw opening()
            return queue.schedule(req)
          },
        },
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
          // Among what the orchestrator's own harness offers, and kept for
          // the next start either way.
          const chosen = orchestrator
            ? await orchestrator.resolveModel(said)
            : await (async () => {
                const found = findModel(said, await usableModels())
                if (!found.ok) throw new Error(found.reason)
                return { provider: found.provider, id: found.id }
              })()
          keepOrchestratorModel(chosen)
          // A harness that takes a model only when it starts is started again
          // on it, on the same conversation.
          if (orchestrator && orchestrator.capabilities.model !== 'live') await restartThinker()
          return chosen
        },
        extensions: async (call) =>
          (
            await extensions.call(call.tool, call.input, {
              caller: { kind: 'orchestrator' },
              id: call.callId,
              tade: windowForExtensions,
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
          report,
          // What an agent can be started on: the models you are signed in to.
          models: () => usableModels(),
          // Signed in, or a key: which one is paying, said beside the model.
          credentials: () => credentials(),
          signIn: () => ({ command: process.execPath, args: [piBinary()] }),
          restartThinker: () => restartThinker(),
          // The orchestrator's own harness may offer other models than agents'.
          orchestratorModels: async () => (await orchestrator?.models()) ?? [],
          reloadWindow: async () => {
            shouldReload = true
            await app.stop()
          },
          written: () => writtenTools(extensionsRoot),
          extensions,
          // What each harness loads by itself, listed and nothing more: pi's
          // own extensions and skills, and the MCP servers Claude Code and
          // Codex were set up with outside Tade. Reading them is not adopting
          // them — their tools are not Tade's and are not named by it.
          harnessExtensions: async () => [
            ...installedPieces(homedir(), process.cwd()),
            ...claudeServers(homedir(), process.cwd()),
            ...codexServers(homedir()),
          ],
          // Every server Tade has been told about, the catalogue's among
          // them, with what each offered when anybody last asked. Read again
          // whenever a setting changes, never on the way to a frame.
          mcpServers: (now) =>
            shownServers(brokerFor({ config: now, home, safe, secrets }).servers, {
              home,
              servers: now.mcp.servers,
            }),
        })
        timingOpen.end()
        // Now that there is a window, ask each server that is on what it
        // offers and write it down. Never on the way up: what an agent
        // launching right now gets is the cache, which is what makes the
        // first agent after a restart have the tools at all.
        void mcp.warm()
        restoreTerminal = () => app.stop().catch(() => {})
        showTerminal = (terminal) => void app.showTerminal(terminal)
        keepOrchestratorModel = (model) => app.thinkerMovedTo(model)
        // An agent an extension starts is put in front of you, like one you started.
        windowForExtensions = extensionWorkbench(client, (task) => app.showTask(task))
        app.useExtensionWorkbench(windowForExtensions)

        // Files you attached go to the agents the orchestrator starts in answer.
        handOff = (cwd) => app.handOff(cwd)
        queue = app.queueTools()

        // The orchestrator is a model in another process and takes a few
        // seconds to come up. The window does not wait for it: an empty
        // terminal while something else starts is the worst first second Tade
        // could have, and it says so in the strip when it arrives. If it never
        // does — no model configured yet — everything except free text still
        // works, which is the honest outcome.
        const startThinker = async () => {
          // Read again: a model chosen in the window is in the file, not in
          // what was loaded when this started.
          const now = await loadConfig(opts.config)
          const config = now.ok ? now.config : cfg.config
          // The journal it opens on: what its own lessons are measured
          // against, and what it is told happened while it was not running.
          const journal = await client.events({ limit: 2_000 }).catch(() => [])
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
                historyFrom(journal, Date.now()),
                Object.keys(config.projects),
              ),
              journal,
              // What it was tracking: the queue's own words, so the briefing
              // and tade_queue can never say different things.
              queue: await queue?.describe().catch(() => ''),
              safe,
              extensions: orchestratorExtensions(extensions, home, config.orchestrator.harness),
              onUsage: ({ model, ...usage }) => {
                void client.log
                  .append({
                    type: 'usage',
                    task: null,
                    // The model written the one way everything writes it: what
                    // the orchestrator costs is the same question as what an
                    // agent costs, and a second spelling of one model here is
                    // a second row of it on the Spend page.
                    detail: { by: 'orchestrator', ...usage, ...modelDetail(model) },
                  })
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
                  // Its thinking level, moved without restarting it: the
                  // conversation carries on at the new level.
                  setThinking: (level) => started.setThinking(level as ThinkingLevel),
                  // Stopping a turn without ending the conversation, and what
                  // its harness says about being asked to.
                  interrupt: () => started.interrupt(),
                  offers: thinkerOffers(config.orchestrator.harness, started.capabilities),
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
        let starting = startThinker()
        // A new model for the orchestrator: the old one stops, and the new one
        // carries on the same conversation — its session id never changes, so
        // there is nothing to ask for beyond starting it again.
        restartThinker = async () => {
          await starting
          await stopOrchestrator()
          orchestrator = null
          starting = startThinker()
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
        // Whoever started a server ends it: a window that closed is a window
        // with no MCP client in it.
        await mcp.close().catch(() => {})
        await tools.close().catch(() => {})
        stopWatching()
        stopReporting()
        // What is queued has a moment to be sent, and never more than that.
        await report.close()
        // Lets go of the lanes; under tmux the agents carry on working.
        await client.close().catch(() => {})
      }
    })
}
