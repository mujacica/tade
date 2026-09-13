import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { defaultConfigPath, loadConfig, wilcoHome } from '@wilco/core'
import { Orchestrator, ToolHost } from '@wilco/orchestrator'
import { HomeBusyError, Workbench } from '@wilco/workbench'
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
      const home = wilcoHome()
      let wilco: Workbench
      try {
        wilco = await Workbench.open({ home })
      } catch (err) {
        io.err(
          err instanceof HomeBusyError
            ? `${err.message}. Talk to it there instead.`
            : err instanceof Error
              ? err.message
              : String(err),
        )
        setExit(Exit.error)
        return
      }
      const tools = await ToolHost.listen({
        wilco,
        path: join(home, 'runs', `tools-${process.pid}.sock`),
      })

      const chat = await Orchestrator.start({
        // Fetched and handed over, so composing the prompt stays pure.
        notes: wilco.recallAll(),
        home,
        socket: tools.path,
        runDir: join(home, 'orchestrator'),
        cwd: process.cwd(),
        config: cfg.config,
        // `wilco --safe chat` loads none of the self-written tools.
        safe: program.opts().safe === true,
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
        // `for await` ends on EOF and on close; `question()` does neither, so
        // Ctrl-D or piped input would hang here forever with the agent still
        // running behind it.
        rl.setPrompt('> ')
        rl.prompt()
        for await (const input of rl) {
          const line = input.trim()
          if (line === '.exit' || line === 'exit') break
          if (line !== '') {
            const idle = untilIdle()
            await chat.ask(line)
            await idle
          }
          rl.prompt()
        }
      } catch {
        // Ctrl-C or a closed pipe: leave quietly.
      } finally {
        rl.close()
        await chat.stop()
        await tools.close().catch(() => {})
        await wilco.close().catch(() => {})
      }
    })
}
