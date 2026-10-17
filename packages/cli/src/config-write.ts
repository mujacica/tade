import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tadeHome, textOf, writeSetting, writtenAt } from '@tade/core'
import { recordConfigChanges } from '@tade/workbench/config-changes'
import { parseDocument } from 'yaml'

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

/** A leaf whose value is a credential, wherever it is: an extension's key, a session. */
const CREDENTIAL = /(?:^|[._])(?:key|token|secret|password|session|csrf)$/

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
 * What the file at `path` holds now, as data: what each line will say its key
 * `was`, read before the write. Nothing where there is no file, or none that
 * reads as YAML.
 */
export function heldIn(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  const doc = parseDocument(text)
  return doc.errors.length > 0 ? {} : (doc.toJS() ?? {})
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
