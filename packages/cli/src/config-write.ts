import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tadeHome, textOf, writeSetting, writtenAt } from '@tade/core'
import { CREDENTIAL, heldIn, recordConfigChanges } from '@tade/workbench/config-changes'

export { heldIn }

// The config written from a terminal: through the one write path
// (`writeSetting`), and every key that changed written down as
// `config_changed`, `by: cli` — what it was and what it is now — the way the
// Settings page and the orchestrator write theirs, because a change nobody
// watched has to be one somebody can find and undo. While a window holds the
// journal the line waits for it in a spool (`@tade/workbench/config-changes`).
//
// **Never a key on the line**: a credential is said as a count of characters,
// and a block — an MCP server, a remote with its session — as `set`, because a
// key may be inside one. A list is its items with spaces between, as Settings
// says one, so `copiedHosts` reads a trusted-hostnames line from here the way
// it reads one from there.
//
// Only this home's config is written down in this home's journal: `--config`
// naming another file is not a change to this Tade.

type Value = Parameters<typeof writeSetting>[2]

/** One key a command writes, and whether its value is a credential, which is never said. */
export interface ShellWrite {
  key: string
  value: Value
  secret?: boolean
}

/** Where a line could not be written down, what is said: the key is written either way. */
export type Unrecorded = (said: string) => void

/**
 * Write `writes` into the config at `path`, in order, and write each one that
 * changed something down as `config_changed`. What stopped the writing down is
 * said to `unrecorded` rather than thrown: the config is written already.
 */
export async function writeFromShell(
  path: string,
  writes: readonly ShellWrite[],
  unrecorded: Unrecorded,
): Promise<void> {
  const before = heldIn(path)
  for (const one of writes) writeSetting(path, one.key, one.value)
  await recordFromShell(path, before, writes, unrecorded)
}

/**
 * Change the config at `path` as data — `change` is handed a copy of what it
 * holds — and write back only the keys that differ, one at a time, each
 * written down as a line of its own: a block is its leaves, so every key is
 * said by its own name. What `tade setup` writes with. Printing the data again
 * instead would drop every comment somebody wrote in the file.
 *
 * Only for blocks whose leaves are named for what they are, since a leaf is
 * kept off the line by its name (`CREDENTIAL`): one a key may hide in under
 * another name — an MCP server's environment — goes through `writeFromShell`
 * whole, and is said as `set`.
 */
export async function patchFromShell(
  path: string,
  change: (config: Record<string, unknown>) => void,
  unrecorded: Unrecorded,
): Promise<void> {
  const held = heldIn(path)
  const before = isObject(held) ? held : {}
  const after = structuredClone(before)
  change(after)
  mkdirSync(dirname(path), { recursive: true })
  await writeFromShell(path, differences([], before, after), unrecorded)
}

/** Each key `after` sets or takes away from `before`, as a write of its own. */
function differences(at: string[], before: unknown, after: unknown): ShellWrite[] {
  if (isObject(after)) {
    const was = isObject(before) ? before : {}
    return [
      ...Object.keys(was)
        .filter((key) => !(key in after))
        .map((key) => ({ key: [...at, key].join('.'), value: undefined })),
      ...Object.entries(after).flatMap(([key, value]) =>
        differences([...at, key], was[key], value),
      ),
    ]
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  return [{ key: at.join('.'), value: after as Value }]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Write down `writes`, made to the config at `path` over what it held
 * `before` (`heldIn`), as `config_changed` lines in `home`'s journal — for a
 * command that read the config back before it knew the write would stand. A
 * key written as what it already was is no change, and no line.
 */
export async function recordFromShell(
  path: string,
  before: unknown,
  writes: readonly ShellWrite[],
  unrecorded: Unrecorded,
  home: string = tadeHome(),
): Promise<void> {
  if (resolve(path) !== resolve(join(home, 'config.yaml'))) return
  const changes = writes
    .map((one) => ({ one, was: writtenAt(before, one.key) }))
    .filter(({ one, was }) => textOf(was) !== textOf(one.value))
    .map(({ one, was }) => {
      const secret = one.secret === true || CREDENTIAL.test(one.key)
      return { path: one.key, was: saidAs(was, secret), now: saidAs(one.value, secret), by: 'cli' }
    })
  try {
    await recordConfigChanges(home, changes)
  } catch (err) {
    const keys = changes.map((one) => one.path).join(', ')
    unrecorded(
      `${keys} ${changes.length === 1 ? 'is' : 'are'} written, but not yet in the journal: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** A value as its line says it: never a credential, and a block only as being there. */
function saidAs(value: unknown, secret: boolean): string {
  if (value === undefined || value === null) return ''
  if (secret) {
    if (typeof value !== 'string') return 'set'
    return value === '' ? '' : `${value.length} characters`
  }
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.every((one) => one === null || typeof one !== 'object') ? value.join(' ') : 'set'
  }
  return typeof value === 'object' ? 'set' : String(value)
}
