import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Config, type EventInput, parseConfig, writeSetting } from '@tade/core'
import { type ConfigChange, changeOf, heldIn } from './config-changes.ts'

// What the workbench writes into the config for itself: an account added,
// taken away or chosen for a harness, and an account's API key. Never what one
// running agent was moved to: that agent alone moves, and what new agents start
// on is a setting of its own (`workers.routes.<route>`), written where every
// setting is.
//
// Through the one write path (`writeSetting`), read back so what was written
// is what runs, and every key that changed written down as `config_changed`
// the way the Settings page writes its own — because a change nobody watched
// has to be one somebody can find and undo. The workbench holds the journal,
// so it appends its own lines. **Never a key on one**: a credential is said as
// `set` or `not set`, and an account as a block, `set`, since its key is in it.

type Value = Parameters<typeof writeSetting>[2]

/** One key the workbench writes, and whether its value is a credential, which is never said. */
export interface KeptWrite {
  key: string
  value: Value
  secret?: boolean
}

/** The config as it loads after a write, and the lines that write leaves. */
export interface Kept {
  config: Config
  changes: ConfigChange[]
}

/**
 * Write `writes` into `home`'s config, in order, and read it back. Throws,
 * having put the file back exactly as it was, where it would not load: the
 * next window must never find a file it refuses.
 */
export function keptIn(home: string, writes: readonly KeptWrite[], by: string): Kept {
  const path = join(home, 'config.yaml')
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null
  const held = heldIn(path)
  for (const one of writes) writeSetting(path, one.key, one.value)
  const parsed = parseConfig(readFileSync(path, 'utf8'), path)
  if (!parsed.ok) {
    if (before === null) rmSync(path, { force: true })
    else writeFileSync(path, before, { mode: 0o600 })
    throw new Error(`that would make config.yaml invalid: ${parsed.issues[0]?.message ?? ''}`)
  }
  const changes = writes.flatMap((one) => changeOf(held, one.key, one.value, by, one.secret) ?? [])
  return { config: parsed.config, changes }
}

/**
 * Write `changes` down in the journal the workbench holds, once the config is
 * written. Throws where the journal would not take one, saying the key is
 * written all the same: the line is what makes it a change somebody can undo.
 */
export async function recordKept(
  changes: readonly ConfigChange[],
  append: (line: EventInput) => Promise<unknown>,
): Promise<void> {
  for (const detail of changes) {
    try {
      await append({ type: 'config_changed', detail: { ...detail } })
    } catch (err) {
      throw new Error(
        `${detail.path} is written, but the journal would not take the line that says so: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
