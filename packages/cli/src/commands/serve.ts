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
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { closeAll, endSoon, hangingUp, leftBehind, onSignals } from '../quitting.ts'
import { reporterLater, reportJournal } from '../telemetry.ts'

// `tade serve` — the window with no screen, for a machine nobody sits at.
//
// It is `Heart.alone`: the beat, and on it the queue, schedules and watches,
// and intake, over the same workbench and the same lock as `tade app`, so the
// two never run on one home at once and every "while a window is open" is
// true of it. What the window would have drawn in the conversation is written
// to standard error instead, a line each, which is a service's log; nothing is
// ever written to standard output, and nothing reads a key. It runs until it
// is asked to stop — a signal, or the terminal it was started in going — and
// closing it is closing the window: the agents are the workbench's and carry
// on under a driver whose lanes outlive it.

/** What runs here with no screen, said first. */
export const SERVES = 'the beat, the queue, schedules and watches, and intake'

/**
 * What does not run here yet, said beside it, because a person reading the
 * log is deciding whether this is enough for their machine.
 */
export const NOT_SERVED =
  'Not under `tade serve` yet: the away view, the orchestrator, notifications, the batched checks, reopening agents that were working when Tade closed, and reading the config again while it runs — `tade app` does them.'

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
      // Settled by the first signal, or by the terminal it was started in going.
      let stop: () => void = () => {}
      const stopped = new Promise<void>((resolve) => {
        stop = resolve
      })
      let heart: Heart | null = null
      try {
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
          },
          (line) => io.err(saidLine(line)),
        )
        void openReporting()
        void mcp.warm()
        const running = heart
        stopHeart = () => running.stop()
        io.err(`tade serve on ${home}: ${SERVES}, with no screen.`)
        io.err(NOT_SERVED)
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
              { name: 'the beat', close: async () => heart?.stop() },
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
