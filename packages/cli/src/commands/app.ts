import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { App, thinkerOffers } from '@tade/app'
import {
  activityFrom,
  type Config,
  defaultConfigPath,
  effortsIn,
  expandHome,
  finishedFrom,
  historyFrom,
  isReady,
  keptByService,
  LOCAL,
  loadConfig,
  modelDetail,
  readiness,
  type ThinkingLevel,
  TOLD_EVENTS,
  type ToldPrint,
  tadeHome,
  type Unclosed,
  unheardNotes,
} from '@tade/core'
import type { ExtensionWorkbench } from '@tade/extensions-core'
import { installedServers as claudeServers } from '@tade/harnesses-claude/installed'
import { installedServers as codexServers } from '@tade/harnesses-codex/installed'
import { piBinary } from '@tade/harnesses-pi/adapter'
import { installedPieces } from '@tade/harnesses-pi/installed'
import { credentials } from '@tade/harnesses-pi/models'
import { shownServers } from '@tade/mcp-broker'
import {
  brokerFor,
  extensionWorkbench,
  loadExtensions,
  Orchestrator,
  type OrchestratorOptions,
  orchestratorExtensions,
  orchestratorHistory,
  ToolHost,
  type ToolHostOptions,
  tellingOf,
  workbenchExtensions,
  writtenTools,
} from '@tade/orchestrator'
import { makeCollector } from '@tade/status'
import { watchProcess } from '@tade/telemetry'
import { makeRecorder, makeTranscriber } from '@tade/voice-stt'
import { HomeBusyError, Workbench } from '@tade/workbench'
import { lookAtCertificate } from '@tade/workbench/certificate'
import { lookAtDomain } from '@tade/workbench/domain'
import { livenessTableFrom } from '@tade/workbench/lane-liveness'
import { lookAtUpdates } from '@tade/workbench/programs'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { handOverOpening, unsayOpening } from '../opening.ts'
import { closeAll, endSoon, leftBehind, onSignals } from '../quitting.ts'
import { reporterLater, reportJournal } from '../telemetry.ts'
import { gather } from './setup-facts.ts'

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
        unsayOpening()
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
        unsayOpening()
        if ((await runSetup()) !== 0) {
          setExit(Exit.error)
          return
        }
      }

      // Where everything stands, looked at in a process of the window's own
      // (`lookInChild`), so the fork storm and the garbage of a look are never
      // on the thread that draws. One for the window: its beat asks it, and so
      // does `tade_status`, which the efforts in the briefing are folded out
      // of. It ends with the window, however the window ends.
      //
      // Made here, before the workbench, because making it starts it: Node
      // takes the better part of a second to boot one, and that happens beside
      // everything below rather than after it, so it is ready when the first
      // look asks.
      const looking = makeCollector('child')

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
      // DSN is set, and what a crash takes down is sent on the way out. Usable
      // now and opened once the window has drawn (`openReporting`): what is
      // reported before that is kept, and a crash before it still goes.
      const { reporter: report, open: openReporting } = reporterLater(cfg.config)
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
      // The MCP servers a person has turned on, brokered here rather than
      // inside `loadExtensions` so the window can ask each of them what it
      // offers once it is up, and end their sessions on the way out.
      const mcp = brokerFor({
        config: cfg.config,
        home,
        safe,
        onWarning: (message) => void warn(message),
      })
      const extensions = await loadExtensions({
        config: cfg.config,
        home,
        safe,
        configPath: cfg.path,
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
        unsayOpening()
        await looking.close()
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
      // The config is the window's too: a setting written has to be read back
      // and used everywhere that holds one, and the boundary saying what the
      // orchestrator may touch is checked there rather than in its own process.
      let settings: ReturnType<App['configTools']> | null = null
      let watches: ReturnType<App['watchTools']> | null = null
      // Updating and reloading are the window's: the run is in a terminal it
      // puts in front, and the person's words are checked there.
      let updates: ReturnType<App['updateTools']> | null = null
      let remotes: ReturnType<App['remoteTools']> | null = null
      // How far the turn in flight reaches, and what a narrowed one is
      // answered with. Null until the window is up, and **a remote arm is
      // impossible until then**: the host reads `LOCAL` for every call, which
      // is the right answer because nothing from away can have arrived yet —
      // the listener is the window's too.
      let away: ReturnType<App['awayTools']> | null = null
      const opening = () => new Error('Tade is still opening: ask again in a moment')
      const status = async () => {
        const answer = await looking.collect({
          config: client.config,
          now: Date.now(),
          home: homedir(),
          tadeHome: tadeHome(),
          cwd: process.cwd(),
          pr: false,
          lanes: await livenessTableFrom(client),
        })
        // A tool fails by throwing: a look that could not be had is said,
        // never answered with a workspace that has nothing in it.
        if (!answer.known) throw new Error(answer.why)
        return answer.workspace
      }
      const tools = await ToolHost.listen({
        tade: client,
        path: join(home, 'runs', `tools-${process.pid}.sock`),
        onTerminal: (terminal) => showTerminal(terminal),
        handOff: (task) => handOff(task),
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
          decide: async (req) => {
            if (!queue) throw opening()
            return queue.decide(req)
          },
        },
        config: {
          settings: async (find) => {
            if (!settings) throw opening()
            return settings.settings(find)
          },
          change: async (req) => {
            if (!settings) throw opening()
            return settings.change(req)
          },
          openProject: async (req) => {
            if (!settings) throw opening()
            return settings.openProject(req)
          },
          closeProject: async (req) => {
            if (!settings) throw opening()
            return settings.closeProject(req)
          },
          renameProject: async (req) => {
            if (!settings) throw opening()
            return settings.renameProject(req)
          },
          reorderProjects: async (req) => {
            if (!settings) throw opening()
            return settings.reorderProjects(req)
          },
          configureProject: async (req) => {
            if (!settings) throw opening()
            return settings.configureProject(req)
          },
        },
        watches: {
          list: async (find) => {
            if (!watches) throw opening()
            return watches.watches(find)
          },
          change: async (req) => {
            if (!watches) throw opening()
            return watches.change(req)
          },
        },
        // A race is a plan the window's queue starts, and its pick is checked
        // there against the person's own lines.
        race: {
          start: async (req) => {
            if (!queue) throw opening()
            return queue.race.start(req)
          },
          standing: async (req) => {
            if (!queue) throw opening()
            return queue.race.standing(req)
          },
          pick: async (req) => {
            if (!queue) throw opening()
            return queue.race.pick(req)
          },
        },
        // A replay is a plan the window's queue starts and paces, and starting
        // one is checked there against the person's own lines.
        replay: {
          start: async (req) => {
            if (!queue) throw opening()
            return queue.replay.start(req)
          },
          standing: async (req) => {
            if (!queue) throw opening()
            return queue.replay.standing(req)
          },
        },
        // Another machine's orchestrator, over the window's link to it, and
        // checked there against the person's own lines.
        remotes: {
          tell: async (req) => {
            if (!remotes) throw opening()
            return remotes.tell(req)
          },
        },
        updates: {
          read: async (check) => {
            if (!updates) throw opening()
            return updates.read(check)
          },
          run: async (req) => {
            if (!updates) throw opening()
            return updates.run(req)
          },
          reload: async (req) => {
            if (!updates) throw opening()
            return updates.reload(req)
          },
        },
        status,
        remote: {
          arm: () => away?.arm() ?? LOCAL,
          seen: async (arm) => {
            if (!away) throw opening()
            return away.seen(arm)
          },
          refused: (arm, method, why) => away?.refused(arm, method, why),
        },
        orchestratorModel: async (said) => {
          // Among what the orchestrator's own harness offers, and kept for
          // the next start either way. Only its own: a model is resolved by
          // the harness it is for, so with nobody there to ask, the honest
          // answer is that there is nobody there to ask — pi's catalog is
          // not Claude Code's or Codex's to answer out of.
          if (!orchestrator) throw opening()
          const chosen = await orchestrator.resolveModel(said)
          keepOrchestratorModel(chosen)
          // A harness that takes a model only when it starts is started again
          // on it, on the same conversation.
          if (orchestrator.capabilities.model !== 'live') await restartThinker()
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
      let toldNow = async (_since: number): Promise<ToldPrint> => {
        throw opening()
      }
      const stopOrchestrator = async () => {
        await orchestrator?.stop().catch(() => {})
      }
      // The window closing, for a start still under way: it is stopped where it
      // is (`Orchestrator.start`'s `signal`) rather than waited out and stopped.
      const quitting = new AbortController()
      let starting: Promise<void> = Promise.resolve()
      // What closing gave up waiting for or could not close, the window's own and the rest.
      const late: Unclosed[] = []
      try {
        let shouldReload = false
        const app = await App.start({
          client,
          config: cfg.config,
          home,
          cwd: process.cwd(),
          // Read here, once: the window never reads the environment for it.
          keptBy: keptByService(process.env, process.platform),
          status: looking,
          ...(canHear ? { recorder, transcriber } : {}),
          report,
          // The mark up while it opened stops where the window starts drawing.
          takingScreen: handOverOpening,
          // What an agent can be started on is its harness's to say, and the
          // workbench holds the adapters: nothing here knows which harness it
          // is, which is the whole point of asking one.
          // Signed in, or a key: which one is paying, said beside the model.
          credentials: () => credentials(),
          signIn: () => ({ command: process.execPath, args: [piBinary()] }),
          restartThinker: () => restartThinker(),
          toldNow: (since) => toldNow(since),
          // What was said to it before this window, out of its harness's own
          // record: shown before it has started, and if it never does.
          history: orchestratorHistory({
            config: cfg.config,
            runDir: join(home, 'orchestrator'),
            cwd: process.cwd(),
          }),
          // The orchestrator's own harness may offer other models than agents'.
          // Before it is up there is nobody to ask, which is said rather than
          // answered with somebody else's list.
          orchestratorModels: async () =>
            orchestrator
              ? await orchestrator.models()
              : {
                  harness: cfg.config.orchestrator.harness,
                  models: [],
                  why: 'is still starting: ask again in a moment',
                },
          reloadWindow: async () => {
            shouldReload = true
            await app.stop()
          },
          // Asked on a clock too, which only a real window is handed: a test's
          // never reaches the network it runs on.
          updates: (config, at, ask) => lookAtUpdates(config, at, { ask }),
          // The public name's certificate, the same way: only a real window dials.
          certificate: (name) => lookAtCertificate(name),
          // And the records it needs, looked at when Settings shows its row.
          domain: (name) => lookAtDomain(name),
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
            shownServers(brokerFor({ config: now, home, safe }).servers, {
              home,
              servers: now.mcp.servers,
            }),
        })
        timingOpen.end()
        // It has drawn, so the reporter's SDK may load now: never before.
        void openReporting()
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
        handOff = (task) => app.handOff(task)
        queue = app.queueTools()
        settings = app.configTools()
        watches = app.watchTools()
        updates = app.updateTools()
        remotes = app.remoteTools()
        away = app.awayTools()

        // The orchestrator is a model in another process and takes a few
        // seconds to come up. The window does not wait for it: an empty
        // terminal while something else starts is the worst first second Tade
        // could have, and it says so in the strip when it arrives. If it never
        // does — no model configured yet — everything except free text still
        // works, which is the honest outcome.
        // Everything it is started with, read again at every start: also what
        // `toldNow` composes, so the two can only differ by what really moved.
        const thinkerOptions = async (): Promise<OrchestratorOptions & { config: Config }> => {
          // Read again: a model chosen in the window is in the file, not in
          // what was loaded when this started.
          const now = await loadConfig(opts.config)
          const config = now.ok ? now.config : cfg.config
          // The journal it opens on: what its own lessons are measured
          // against, and what it is told happened while it was not running.
          const journal = await client.events({ limit: 2_000 }).catch(() => [])
          return {
            home,
            socket: tools.path,
            runDir: join(home, 'orchestrator'),
            cwd: process.cwd(),
            config,
            // So it knows what you have told it, not just what it can do.
            notes: client.recallAll(),
            // And which of its own lessons still apply.
            activity: activityFrom(historyFrom(journal, Date.now()), Object.keys(config.projects)),
            journal,
            // What it was tracking: the queue's own words, so the briefing
            // and tade_queue can never say different things.
            queue: await queue?.describe().catch(() => ''),
            // And what spans repositories, which the journal alone cannot
            // say: an effort is the fold of the task files that name it,
            // read out of the same status answer everything else reads.
            efforts: effortsIn(
              (await status().catch(() => null))?.projects.flatMap((project) => project.tasks) ??
                [],
              new Set(finishedFrom(journal).keys()),
            ),
            safe,
            // Whether the conversation needs a gate on its own tool calls,
            // which is wired when it starts. Read from the config here
            // rather than asked later, because a gate added mid-session
            // would be a gate the turn already in flight never had — and
            // the setting says *takes effect on restart* for that reason.
            talking: config.surfaces.web.enabled && config.surfaces.web.orchestrator,
            signal: quitting.signal,
            extensions: orchestratorExtensions(extensions, home, config.orchestrator.harness),
            // What its conversation was told before, read for that alone:
            // it may be older than the briefing's two thousand lines.
            toldBefore: await client.events({ types: TOLD_EVENTS, limit: 20 }).catch(() => []),
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
          }
        }
        // What it would be told now, its own notes since `since` left out:
        // they are in its conversation already.
        toldNow = async (since) => {
          const options = await thinkerOptions()
          return tellingOf({ ...options, notes: unheardNotes(options.notes ?? [], since) }).told
        }
        const startThinker = async () => {
          const options = await thinkerOptions()
          const config = options.config
          return (
            Orchestrator.start(options)
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
                  // The away half: a turn under an arm, and the three
                  // questions anything outside the window asks about one. All
                  // four are the orchestrator's own, so there is no second
                  // answer to *whose turn is this* anywhere.
                  askFrom: (text, arm) => started.askFrom(text, arm),
                  arm: () => started.arm,
                  busy: () => started.busy,
                  unarmed: () => started.unarmed,
                  // Its conversation, kept short and told what it is told now:
                  // the window decides when (`Keeping`), never mid-turn.
                  compact: () => started.compact(),
                  context: () => started.context,
                  told: () => started.told,
                })
                // Nothing chosen, so the harness picked: keep what it picked, so the
                // next time an agent switches model the orchestrator does not follow.
                if (!config.orchestrator.model) {
                  const model = await started.model().catch(() => null)
                  if (model) app.keepThinkerModel(model)
                }
              })
              // Said in the conversation, where you would have waited for an
              // answer — unless it was the window closing that stopped it.
              .catch((err: unknown) => {
                if (quitting.signal.aborted) return
                app.thinkerFailed(err instanceof Error ? err.message : String(err))
              })
          )
        }
        starting = startThinker()
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
        // Leaving the terminal in raw mode would outlive us, so the first
        // signal closes the window the same way as quitting. Any after it — or
        // after a quit already under way — ends Tade there and then: the
        // terminal is already back, and asking twice is never asking for a wait.
        // Kept to the end, since a listener on SIGINT is what turns Node's off.
        onSignals(
          process,
          () => void app.stop(),
          () => process.exit(130),
          () => app.closing,
        )
        try {
          late.push(...(await app.wait()))
        } finally {
          // The window has given the screen back, so the line said before it
          // took it is taken back too.
          unsayOpening()
        }
        if (shouldReload) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            stdio: 'inherit',
            detached: true,
          })
          child.unref()
        }
      } catch (err) {
        unsayOpening()
        io.err(err instanceof Error ? err.message : String(err))
        setExit(Exit.error)
      } finally {
        // Everything that can close at once does, each by one deadline rather
        // than each waiting on the one before (`quitting.ts`). An orchestrator
        // still starting is stopped under its start, which then settles at once
        // — closing while it starts would otherwise leave a model process
        // behind with nothing to talk to, or wait for one.
        quitting.abort()
        stopReporting()
        late.push(
          ...(await closeAll({
            together: [
              { name: 'the orchestrator', close: () => starting.then(stopOrchestrator) },
              // Whoever started a server ends it: a window that closed is a
              // window with no MCP client in it.
              { name: 'the MCP servers', close: () => mcp.close() },
              { name: "the orchestrator's tools", close: () => tools.close() },
              { name: 'the status child', close: () => looking.close() },
            ],
            between: stopWatching,
            // Last, and alone: lets go of the lanes; under tmux the agents carry on working.
            last: { name: 'the workbench', close: () => client.close() },
            // What is queued has a moment to be sent, and never more than that.
            meanwhile: [{ name: 'the reporter', close: () => report.close() }],
          })),
        )
        for (const line of leftBehind(late)) io.err(line)
        // Whatever still holds the process open now — a child somebody let go
        // of without ending, a socket a reporter left — is not a reason to keep
        // the terminal: everything has had its chance to close.
        endSoon()
      }
    })
}
