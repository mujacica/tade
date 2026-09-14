import { readFileSync, writeFileSync } from 'node:fs'
import { describeSetting, loadConfig, parseSetting, type Setting, settingsOf } from '@wilco/core'
import { parseDocument } from 'yaml'
import type { Ui } from './screen.ts'

// Changing what Wilco has been told, on whatever screen is in front of you.
//
// Lives here rather than in the CLI because the window has to be able to open
// it too: needing to close Wilco to change a Wilco setting is the kind of
// thing that makes people keep a second terminal open forever.

const DONE = 'done'

/** Choose a setting, change it, repeat. Every change is written immediately. */
export async function editSettings(ui: Ui, path: string): Promise<void> {
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
 * Add a project to the config, keeping everything else as it was.
 *
 * Its own function rather than a `write` of a dotted path, because a project
 * is two values that only mean something together, and half of one written
 * down is a config that fails to load.
 */
export function addProject(path: string, name: string, root: string): void {
  writeSetting(path, `projects.${name}.root`, root)
}

/**
 * Write one setting back, keeping everything else exactly as it was.
 *
 * Read, change, write: the file belongs to whoever wrote it, so comments and
 * key order survive everything this touches except the one line it changed.
 */
function write(path: string, key: string, value: string | number | boolean | undefined): void {
  writeSetting(path, key, value)
}

/**
 * Write one setting back into the file as a document, not as data: parsing to
 * an object and printing it again loses every comment in the file, and the
 * file belongs to whoever wrote those comments.
 */
export function writeSetting(
  path: string,
  key: string,
  value:
    | string
    | number
    | boolean
    | readonly string[]
    | Readonly<Record<string, unknown>>
    | undefined,
): void {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // No file yet: this starts it.
  }
  const doc = parseDocument(text)
  const at = key.split('.')
  if (value === undefined || value === '') doc.deleteIn(at)
  else doc.setIn(at, typeof value === 'object' ? doc.createNode(value) : value)
  writeFileSync(path, doc.toString())
}
