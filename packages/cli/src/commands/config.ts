import { editSettings, runScreen, ScreenCancelled } from '@tade/app'
import { defaultConfigPath, describeSetting, loadConfig, settingsOf } from '@tade/core'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// Reading and changing what Tade has been told.
//
// The file is the truth and stays hand-editable — this writes YAML a person
// would have written — but nobody should have to learn a schema to turn
// approvals on. Every setting says what it is now and what changing it does,
// because the name of a key almost never answers the second question.

export function registerConfig(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('config')
    .description('See what Tade has been told, and change it')
    .option('--check', 'validate the config file and exit, changing nothing')
    .option('--json', 'print the effective config, defaults included')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { check?: boolean; json?: boolean; config: string }) => {
      const result = await loadConfig(opts.config)
      if (!result.ok) {
        io.err(`${result.path}: invalid config`)
        for (const issue of result.issues) io.err(`  ${issue.path || '(file)'}: ${issue.message}`)
        setExit(Exit.invalidInput)
        return
      }
      if (opts.check) {
        io.out(result.exists ? `${result.path}: ok` : `${result.path}: not found, using defaults`)
        return
      }
      if (opts.json) {
        io.out(JSON.stringify(result.config, null, 2))
        return
      }
      // Printed rather than drawn where there is nothing to draw on: a pipe
      // wants the settings, not an alternate screen it cannot show.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        for (const group of settingsOf(result.config)) {
          io.out(group.title)
          for (const setting of group.settings) io.out(`  ${describeSetting(setting)}`)
        }
        return
      }

      try {
        await runScreen({ title: 'Settings', context: [result.path] }, (ui) =>
          editSettings(ui, opts.config),
        )
      } catch (err) {
        if (err instanceof ScreenCancelled) return
        io.err(err instanceof Error ? err.message : String(err))
        setExit(Exit.error)
      }
    })
}
