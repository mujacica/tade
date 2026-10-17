import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { App } from '@tade/app'
import {
  defaultConfigPath,
  expandHome,
  isReady,
  keptByService,
  loadConfig,
  readiness,
  tadeHome,
  type Unclosed,
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
  orchestratorHistory,
  workbenchExtensions,
  writtenTools,
} from '@tade/orchestrator'
import { makeCollector } from '@tade/status'
import { watchProcess } from '@tade/telemetry'
import { makeRecorder, makeTranscriber, voiceDeclared } from '@tade/voice-stt'
import { HomeBusyError, Workbench } from '@tade/workbench'
import { lookAtCertificate } from '@tade/workbench/certificate'
import { lookAtDomain } from '@tade/workbench/domain'
import { lookAtUpdates } from '@tade/workbench/programs'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { handOverOpening, unsayOpening } from '../opening.ts'
import { orchestrating } from '../orchestrating.ts'
import { closeAll, endSoon, hangingUp, leftBehind, onSignals } from '../quitting.ts'
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

      // The orchestrator and the way back for its tools, which `tade serve`
      // starts the same way (`orchestrating.ts`): the socket now, so it exists
      // for anything started on it; the orchestrator once the window is up.
      const thinking = await orchestrating({
        client,
        home,
        configPath: opts.config,
        config: cfg.config,
        safe,
        looking,
        extensions,
        forExtensions: () => windowForExtensions,
        without: 'is not something this window does',
      })
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
          restartThinker: () => thinking.restart(),
          toldNow: (since) => thinking.toldNow(since),
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
          orchestratorModels: () => thinking.models(),
          reloadWindow: async () => {
            shouldReload = true
            await app.stop()
          },
          // Asked on a clock too, which only a real window is handed: a test's
          // never reaches the network it runs on.
          updates: (config, at, ask) =>
            lookAtUpdates(config, at, { ask, also: voiceDeclared(config.surfaces.voice) }),
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
          // And the sessions of the ones that are on, held here since the
          // window opened: a server turned off has its session ended at once.
          endServers: (servers) => mcp.useServers(servers),
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
        // An agent an extension starts is put in front of you, like one you started.
        windowForExtensions = extensionWorkbench(client, (task) => app.showTask(task))
        app.useExtensionWorkbench(windowForExtensions)

        // The orchestrator's tools are the window's to answer from here on,
        // and the orchestrator is started on them. It is a model in another
        // process and takes a few seconds to come up: the window does not wait
        // for it, because an empty terminal while something else starts is the
        // worst first second Tade could have, and it says so in the strip when
        // it arrives.
        thinking.hold(app)
        thinking.start()
        // Leaving the terminal in raw mode would outlive us, so the first
        // signal closes the window the same way as quitting. Any after it — or
        // after a quit already under way — ends Tade there and then: the
        // terminal is already back, and asking twice is never asking for a wait.
        // Kept to the end, since a listener on SIGINT is what turns Node's off.
        // Closing the terminal itself closes the window the same way, and
        // from then on nothing is written to it (`hangingUp`): the window's
        // restore, the lines below about what did not close, any of it.
        onSignals(
          process,
          () => void app.stop(),
          () => process.exit(130),
          () => app.closing,
          hangingUp(process, () => void app.stop()),
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
        // still starting is stopped under its start (`orchestrating.ts`).
        stopReporting()
        late.push(
          ...(await closeAll({
            together: [
              ...thinking.closes(),
              // Whoever started a server ends it: a window that closed is a
              // window with no MCP client in it.
              { name: 'the MCP servers', close: () => mcp.close() },
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
