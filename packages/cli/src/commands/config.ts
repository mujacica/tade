import { readFileSync, writeFileSync } from 'node:fs'
import { runScreen, ScreenCancelled, type Ui } from '@wilco/app'
import {
  applySetting,
  defaultConfigPath,
  describeSetting,
  loadConfig,
  parseSetting,
  type Setting,
  settingsOf,
} from '@wilco/core'
import type { Command } from 'commander'
import { parse, stringify } from 'yaml'
import { Exit, type Io } from '../io.ts'

// Reading and changing what Wilco has been told.
//
// The file is the truth and stays hand-editable — this writes YAML a person
// would have written — but nobody should have to learn a schema to turn
// approvals on. Every setting says what it is now and what changing it does,
// because the name of a key almost never answers the second question.

export function registerConfig(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('config')
    .description('See what Wilco has been told, and change it')
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
          edit(ui, opts.config),
        )
      } catch (err) {
        if (err instanceof ScreenCancelled) return
        io.err(err instanceof Error ? err.message : String(err))
        setExit(Exit.error)
      }
    })
}

const DONE = 'done'

/** Choose a setting, change it, repeat. Every change is written immediately. */
async function edit(ui: Ui, path: string): Promise<void> {
  for (;;) {
    const loaded = await loadConfig(path)
    if (!loaded.ok) throw new Error(`${path}: invalid config`)
    const groups = settingsOf(loaded.config)
    const flat = groups.flatMap((group) =>
      group.settings.map((setting) => ({ group: group.title, setting })),
    )

    const options = [
      ...flat.map(({ group, setting }) => `${group.padEnd(20)} ${describeSetting(setting)}`),
      DONE,
    ]
    const picked = await ui.choose('What would you like to change?', options)
    const chosen = flat[picked]
    if (!chosen) return

    const changed = await change(ui, chosen.setting)
    if (changed === null) continue
    write(path, chosen.setting.path, changed)
    ui.say(
      changed === undefined
        ? `${chosen.setting.title} back to its default (${chosen.setting.fallback})`
        : `${chosen.setting.title} is now ${String(changed)}`,
    )
  }
}

/** Ask for the new value in whatever way suits it. `null` means never mind. */
async function change(
  ui: Ui,
  setting: Setting,
): Promise<string | number | boolean | undefined | null> {
  ui.say('')
  ui.say(`${setting.title}: ${setting.means}`)

  if (setting.type.kind === 'choice') {
    const options = [...setting.type.options, `leave it (${setting.value || setting.fallback})`]
    const picked = await ui.choose(setting.title, options)
    return picked < setting.type.options.length ? (setting.type.options[picked] ?? null) : null
  }
  if (setting.type.kind === 'flag') {
    return ui.confirm(setting.title, setting.value !== 'false')
  }
  const placeholder = setting.type.kind === 'text' ? setting.type.placeholder : setting.fallback
  const said = await ui.ask(`${setting.title} (blank for ${setting.fallback})`, '')
  if (said === '' && setting.value === '') return null
  const parsed = parseSetting(setting, said)
  if (said !== '' && parsed === undefined) {
    ui.say(`  that is not a usable value — ${placeholder} is the shape of one`)
    return null
  }
  return parsed
}

/**
 * Write one setting back, keeping everything else exactly as it was.
 *
 * Read, change, write: the file belongs to whoever wrote it, so comments and
 * key order survive everything this touches except the one line it changed.
 */
function write(path: string, key: string, value: string | number | boolean | undefined): void {
  let config: Record<string, unknown> = {}
  try {
    config = (parse(readFileSync(path, 'utf8')) as Record<string, unknown>) ?? {}
  } catch {
    // No file yet, or one we cannot read: start from nothing rather than
    // refusing to save a setting somebody just chose.
  }
  applySetting(config, key, value)
  writeFileSync(path, stringify(config))
}
