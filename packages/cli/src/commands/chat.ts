import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { defaultConfigPath, loadConfig, wilcoHome } from '@wilco/core'
import { DaemonClient } from '@wilco/daemon/client'
import { socketPath } from '@wilco/daemon/protocol'
import { Orchestrator } from '@wilco/orchestrator'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// Talking to Wilco. The orchestrator does the thinking; this is a text field
// and a printer, deliberately thin, because voice will sit in the same place
// later and neither should own the conversation.

export function registerChat(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('chat')
    .description('Talk to Wilco')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`wilco config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      const socket = socketPath()
      if (!(await DaemonClient.isRunning(socket))) {
        io.err('daemon not running: start it with `wilco daemon start`')
        setExit(Exit.error)
        return
      }

      const home = wilcoHome()
      const chat = await Orchestrator.start({
        home,
        socket,
        runDir: join(home, 'orchestrator'),
        cwd: process.cwd(),
        config: cfg.config,
      })

      chat.onMessage((text) => io.out(text))
      // Its working, on stderr so `wilco chat > transcript` keeps just the words.
      chat.onTool((tool) => io.err(`· ${tool.replace(/^wilco_/, '')}`))

      let settled = () => {}
      chat.onIdle(() => settled())
      const untilIdle = () =>
        new Promise<void>((resolve) => {
          settled = resolve
        })

      const rl = createInterface({ input: process.stdin, output: process.stdout })
      rl.on('SIGINT', () => rl.close())
      try {
        for (;;) {
          const line = (await rl.question('> ')).trim()
          if (line === '') continue
          if (line === '.exit' || line === 'exit') break
          const idle = untilIdle()
          await chat.ask(line)
          await idle
        }
      } catch {
        // Ctrl-C or a closed pipe: leave quietly.
      } finally {
        rl.close()
        await chat.stop()
      }
    })
}
