import { homedir } from 'node:os'
import { join } from 'node:path'
import { type BriefTask, composeBrief, defaultConfigPath, loadConfig, wilcoHome } from '@wilco/core'
import { DaemonClient } from '@wilco/daemon/client'
import { laneLiveness } from '@wilco/daemon/lane-liveness'
import { socketPath } from '@wilco/daemon/protocol'
import { collectStatus } from '@wilco/probes'
import { Speaker } from '@wilco/surface-voice'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// One paragraph, before the kettle boils. Derived fresh like everything else:
// a brief assembled from what an agent remembers saying would be confidently
// wrong by the second day.

export function registerBrief(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('brief')
    .description('Everything that matters, in one paragraph')
    .option('--speak', 'say it out loud as well as printing it')
    .option('--no-pr', 'skip PR lookups via gh (they hit the network)')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { speak?: boolean; pr: boolean; config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`wilco config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }

      // The daemon knows what is waiting on a human; without one the brief is
      // still true, just less specific about why something is blocked.
      const socket = socketPath()
      const client = (await DaemonClient.isRunning(socket))
        ? await DaemonClient.connect(socket).catch(() => null)
        : null
      const waiting = new Map<string, string>()
      if (client) {
        for (const approval of await client.pendingApprovals().catch(() => [])) {
          if (!waiting.has(approval.task)) waiting.set(approval.task, approval.summary)
        }
      }

      const lanes = await laneLiveness()
      try {
        const workspace = await collectStatus({
          config: cfg.config,
          now: Date.now(),
          home: homedir(),
          cwd: process.cwd(),
          pr: opts.pr && process.env.WILCO_NO_GH !== '1',
          ...(lanes ? { liveness: lanes.probe } : {}),
        })
        const tasks: BriefTask[] = workspace.projects.flatMap((project) =>
          project.tasks.map((task) => ({
            task: task.id,
            state: task.state,
            waiting: waiting.get(task.id) ?? null,
            reason: task.reason,
          })),
        )
        const brief = composeBrief(tasks, { localHour: new Date().getHours() })
        io.out(brief.spoken)
        if (opts.speak) {
          const speaker = await Speaker.create({ soundDir: join(wilcoHome(), 'sounds') })
          await speaker.speak(brief.spoken)
        }
      } finally {
        await lanes?.close()
        await client?.close().catch(() => {})
      }
    })
}
