import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type Config, loadConfig } from '@tade/core'
import { changeOf, heldIn } from '@tade/workbench/config-changes'
import { withTranscript } from '../model.ts'
import type { Ui } from '../screen.ts'
import { editSettings, writeSetting } from '../settings.ts'
import { tadeDid } from '../transcript.ts'
import { configPathOf, notify, type Wiring, why } from './context.ts'

// The config written by the window outside the Settings page: muting, the
// orchestrator's model and thinking, an extension or a tool server turned on
// or off, what an extension's setup panel saves, and `/settings` and
// `/project` on the shared screen.
//
// Each still goes through the one write path (`writeSetting`), and each key
// that changed is written down as `config_changed` the way the page writes its
// own (`Settings.write`) — what it was, what it is, and who asked, `window` or
// `orchestrator` — because a change nobody watched has to be one somebody can
// find and undo. A credential is said as `set` or `not set` (`changeOf`), and
// a line the journal would not take is said in the conversation, never dropped.
//
// Free functions over `Wiring` rather than a door every subject is handed:
// the subjects that write already hold the wiring, and their files are full.

type Value = Parameters<typeof writeSetting>[2]

/** One key the window writes, and whether its value is a credential, which is never said. */
export interface WindowWrite {
  key: string
  value: Value
  secret?: boolean
}

/**
 * Write `key` into the window's config and write it down `by` whoever asked,
 * with their words where somebody's asked for it (`said`).
 * Throws what writing throws, and then nothing is written down.
 */
export function writeRecorded(
  wire: Wiring,
  key: string,
  value: Value,
  by = 'window',
  said = '',
): void {
  const path = configPathOf(wire.opts)
  const before = heldIn(path)
  writeSetting(path, key, value)
  recordWritten(wire, before, [{ key, value }], by, said)
}

/**
 * Write `writes`, then hand the config to whatever takes it up (`apply`) — and
 * only once that held, write them down. Where it throws, the file is put back
 * exactly as it was and the reason thrown on: a line for a change that was
 * then put back is worse than none.
 */
export async function writeApplied(
  wire: Wiring,
  writes: readonly WindowWrite[],
  apply: () => Promise<void>,
  by = 'window',
): Promise<void> {
  const path = configPathOf(wire.opts)
  const text = readOrNothing(path)
  const before = heldIn(path)
  try {
    for (const one of writes) writeSetting(path, one.key, one.value)
    await apply()
  } catch (err) {
    if (text === null) rmSync(path, { force: true })
    else writeFileSync(path, text, { mode: 0o600 })
    throw err
  }
  recordWritten(wire, before, writes, by)
}

/** Write down `writes`, already made over what the config held `before` (`heldIn`). */
export function recordWritten(
  wire: Wiring,
  before: unknown,
  writes: readonly WindowWrite[],
  by = 'window',
  said = '',
): void {
  for (const one of writes) {
    const change = changeOf(before, one.key, one.value, by, one.secret)
    if (change) void recordChange(wire, { ...change, ...(said ? { said } : {}) })
  }
}

/** `/settings` on the shared screen: the terminal's settings editor, its changes written down. */
export function editRecorded(wire: Wiring, ui: Ui): Promise<void> {
  return editSettings(ui, configPathOf(wire.opts), async (before, key, value) =>
    recordWritten(wire, before, [{ key, value }]),
  )
}

/**
 * The config as a write left it, for the window to take up — or null, with
 * what would not load said on the orchestrator's line. Passed over without a
 * word, the window carried on with what it had while the file said otherwise,
 * and nobody was told why the change never took.
 */
export async function reloaded(wire: Wiring): Promise<Config | null> {
  const loaded = await loadConfig(configPathOf(wire.opts))
  if (loaded.ok) return loaded.config
  const first = loaded.issues[0]
  const reason = first ? (first.path ? `${first.path}: ${first.message}` : first.message) : null
  notify(
    wire,
    `the config would not load (${reason ?? 'no reason given'}), so this window carries on with what it had`,
  )
  return null
}

/**
 * One `config_changed` line, said in the conversation where the journal would
 * not take it: without it a change is one nobody can find and undo, and a
 * carried one reads to the next carry as changed here. Begun before anything
 * is awaited, so lines written in a loop keep their order.
 */
export async function recordChange(wire: Wiring, detail: Record<string, string>): Promise<void> {
  try {
    await wire.opts.client.log.append({ type: 'config_changed', detail })
  } catch (err) {
    const text = unrecordedSays(detail, why(err))
    wire.put(withTranscript(wire.state, tadeDid(wire.state.transcript, text, wire.now())))
    wire.draw()
  }
}

/** The file as it is, to put back; null where there is none yet. */
function readOrNothing(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** What is said where a change's `config_changed` line could not be written. */
function unrecordedSays(detail: Readonly<Record<string, string>>, trouble: string): string {
  const after =
    detail.carried === undefined
      ? 'so nothing records what it was before'
      : `so the next carry from ${detail.carried} reads it as changed here and leaves it`
  return `${detail.path} is written, but the journal would not take the line that says so (${trouble}), ${after}.`
}
