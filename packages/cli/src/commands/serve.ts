import { Heart, saidLine } from '@tade/app/heart'
import { defaultConfigPath, keptByService, loadConfig, tadeHome, type Unclosed } from '@tade/core'
import type { ExtensionWorkbench } from '@tade/extensions-core'
import {
  brokerFor,
  extensionWorkbench,
  loadExtensions,
  workbenchExtensions,
} from '@tade/orchestrator'
import { makeCollector } from '@tade/status'
import { watchProcess } from '@tade/telemetry'
import { HomeBusyError, Workbench } from '@tade/workbench'
import { lookAtCertificate } from '@tade/workbench/certificate'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { type Orchestrating, orchestrating } from '../orchestrating.ts'
import { closeAll, endSoon, hangingUp, leftBehind, onSignals } from '../quitting.ts'
import { reporterLater, reportJournal } from '../telemetry.ts'

// `tade serve` — the window with no screen, for a machine nobody sits at.
//
// It is `Heart.alone`: the beat, and on it the queue, schedules and watches,
// and intake; the orchestrator, started as the window starts it
// (`orchestrating.ts`) and told what happens; and the away view, with the
// notifications it sends — over the same workbench and the same lock as
// `tade app`, so the two never run on one home at once and every "while a
// window is open" is true of it. What the window would have drawn in the
// conversation is written to standard error instead, a line each, which is a
// service's log — the orchestrator's words and what it ran among them; nothing
// is ever written to standard output, and nothing reads a key. It runs until it
// is asked to stop — a signal, or the terminal it was started in going — and
// closing it is closing the window: the agents are the workbench's and carry
// on under a driver whose lanes outlive it.

/** What runs here with no screen, said first. */
export const SERVES =
  'the beat, the queue, schedules and watches, intake, the orchestrator, and the away view with its notifications'

/**
 * What does not run here yet, said beside it, because a person reading the
 * log is deciding whether this is enough for their machine.
 */
export const NOT_SERVED =
  'Not under `tade serve` yet: the batched checks, links to other machines, and updating Tade from the orchestrator — `tade app` does them.'

/** What the orchestrator is told of a part of the window `tade serve` does not have. */
const WITHOUT = 'is not done by `tade serve`, which has no screen: `tade app` does it'

/** What went wrong, in words. */
function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerServe(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('serve')
    .description(
      'The window with no screen: the beat, the queue, schedules and watches, and intake, for a machine nobody sits at. Holds the home as `tade app` does, writes what it says to standard error, and stops on a signal',
    )
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      const home = tadeHome()
      const safe = program.opts().safe === true
      // Its own trouble goes where the window's does, and only once a DSN is set.
      const { reporter: report, open: openReporting } = reporterLater(cfg.config)
      let stopHeart: () => Promise<void> = async () => {}
      const stopWatching = report.on
        ? watchProcess(report, { where: 'tade serve', onFatal: () => stopHeart() })
        : () => {}
      let warn: (message: string) => Promise<void> = async (message) => {
        io.err(message)
      }
      // The servers a person turned on, and the extensions — the watches and
      // intake's sources among them — loaded as the window loads them.
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
      let forExtensions: ExtensionWorkbench | null = null
      let client: Workbench
      try {
        client = await Workbench.open({
          home,
          extensions: workbenchExtensions(extensions, home, () => forExtensions),
          report,
        })
      } catch (err) {
        io.err(
          err instanceof HomeBusyError
            ? `${err.message}. Only one window at a time, and \`tade serve\` is one with no screen.`
            : err instanceof Error
              ? err.message
              : String(err),
        )
        setExit(Exit.error)
        stopWatching()
        await mcp
          .close()
          .catch((closing: unknown) =>
            io.err(`the MCP servers could not be closed: ${why(closing)}`),
          )
        return
      }
      // A warning the journal would not take is still said, where the log is.
      warn = async (message) => {
        await client.log
          .append({ type: 'warning', detail: { message } })
          .catch((writing: unknown) => io.err(`${message} (not in the journal: ${why(writing)})`))
      }
      const stopReporting = reportJournal(report, client)
      // Status in a child of its own, as the window looks: the fork storm of a
      // look is never on the thread the beat runs on.
      const looking = makeCollector('child')
      // An agent an extension starts has nowhere to be put in front of anybody.
      forExtensions = extensionWorkbench(client)
      const late: Unclosed[] = []
      // The orchestrator and the way back for its tools, as the window has
      // them: the socket now, the orchestrator once the heart is beating.
      let thinking: Orchestrating | null = null
      // Settled by the first signal, or by the terminal it was started in going.
      let stop: () => void = () => {}
      const stopped = new Promise<void>((resolve) => {
        stop = resolve
      })
      let heart: Heart | null = null
      try {
        const tools = await orchestrating({
          client,
          home,
          configPath: cfg.path,
          config: cfg.config,
          safe,
          looking,
          extensions,
          forExtensions: () => forExtensions,
          without: WITHOUT,
        })
        thinking = tools
        heart = await Heart.alone(
          {
            client,
            config: cfg.config,
            home,
            cwd: process.cwd(),
            keptBy: keptByService(process.env, process.platform),
            status: looking,
            extensions,
            extensionWorkbench: forExtensions,
            report,
            // Its conversation, kept short and told what it is told now, as
            // the window keeps it (`Keeping`).
            restartThinker: () => tools.restart(),
            toldNow: (since) => tools.toldNow(since),
            // The public name's certificate, looked at on the away view's
            // clock: a real window's, and this is one.
            certificate: (name) => lookAtCertificate(name),
            // A server turned off through the one door ends its session at once.
            endServers: (servers) => mcp.useServers(servers),
          },
          (line) => io.err(saidLine(line)),
        )
        void openReporting()
        void mcp.warm()
        const running = heart
        stopHeart = () => running.stop()
        io.err(`tade serve on ${home}: ${SERVES}, with no screen.`)
        io.err(NOT_SERVED)
        // Its tools are the heart's to answer from here on, and it is started
        // on them: a few seconds, said in the log when it is ready or why not.
        tools.hold(running)
        tools.start()
        onSignals(
          process,
          stop,
          () => process.exit(130),
          () => false,
          hangingUp(process, stop),
        )
        await stopped
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err))
        setExit(Exit.error)
      } finally {
        stopReporting()
        late.push(
          ...(await closeAll({
            together: [
              ...(thinking?.closes() ?? []),
              // The away view and the status look, named as the window names them.
              ...(heart?.closes() ?? []),
              { name: 'the MCP servers', close: () => mcp.close() },
              { name: 'the status child', close: () => looking.close() },
            ],
            between: stopWatching,
            // Last, and alone: lets go of the lanes; under tmux the agents carry on working.
            last: { name: 'the workbench', close: () => client.close() },
            meanwhile: [{ name: 'the reporter', close: () => report.close() }],
          })),
        )
        for (const line of leftBehind(late)) io.err(line)
        io.err(`tade serve on ${home} stopped.`)
        endSoon()
      }
    })
}
