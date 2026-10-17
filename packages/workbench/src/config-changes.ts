import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configChangesSpool, type EventInput, heldSays, textOf, writtenAt } from '@tade/core'
import { parseDocument } from 'yaml'
import { EventLog } from './events.ts'
import { HomeBusyError, lockHome } from './lock.ts'

// A config change made where the journal is not this process's to append to:
// `tade host domain --write`, `tade mcp enable`, `tade web on` and every other
// command that writes the config from a terminal.
//
// **One writer numbers the journal.** `seq` is counted in the memory of
// whoever holds the home (`lockHome`), so a terminal appending beside an open
// window would hand out a number the window hands out again. So a change goes
// into a spool under the home first, and is written down by whoever holds the
// journal: the terminal itself where nobody does — it takes the lock and folds
// the spool in, like a window opening — and otherwise the window, on its next
// beat, by its own append (`Settings.fold`). Either way every number is the
// holder's, and the window's `config_changed` lines and the terminal's read
// alike: `copiedHosts` and `changedThere` fold over both.
//
// **A spool file is the whole of one write**, renamed into place once complete,
// so a fold never reads half of one, and the keys one command wrote stay next
// to each other in the journal. A fold appends a file's lines and only then
// removes it; an append that fails leaves what was not written for the next
// fold, and the trouble is handed back to be said, never dropped.
//
// **Only `config_changed` comes in this way**, and only what one says — the
// path, what it was, what it is now and who — so the spool is a door for this
// and not a second journal anything could write `said` into. Never `carried`:
// a carry arrives through the window that holds the journal there
// (`Settings.writeKey`). `at` is when the terminal made the change, which is
// the journal's way of saying so (`statsFrom`): the line's own `ts` is when it
// was written down, a beat later or the next time Tade opens.

/** One config change, as its `config_changed` line says it: never a key, and every value as text. */
export interface ConfigChange {
  path: string
  was: string
  now: string
  by: string
}

/** A leaf whose value is a credential, wherever it is: an extension's key, a session. */
export const CREDENTIAL = /(?:^|[._])(?:key|token|secret|password|session|csrf)$/

/**
 * What the file at `path` holds now, as data: what a line will say a key
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
 * The line a write of `value` at `key` leaves, over what the config held
 * `before` (`heldIn`) — or null where it changed nothing. A credential is said
 * only as whether there is one (`heldSays`), as every writer says one, never
 * how long it is; a block only as `set`, because a key may be inside one; a
 * list as its items with spaces between. For a writer that holds the journal,
 * or hands its lines to whoever does (`recordConfigChanges`) — a terminal's
 * included.
 */
export function changeOf(
  before: unknown,
  key: string,
  value: unknown,
  by: string,
  secret = false,
): ConfigChange | null {
  const was = writtenAt(before, key)
  if (textOf(was) === textOf(value)) return null
  const credential = secret || CREDENTIAL.test(key)
  return { path: key, was: saidOnLine(was, credential), now: saidOnLine(value, credential), by }
}

/** A value as `changeOf` says it. */
function saidOnLine(value: unknown, credential: boolean): string {
  if (credential) return heldSays(value)
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.every((one) => one === null || typeof one !== 'object') ? value.join(' ') : 'set'
  }
  return typeof value === 'object' ? 'set' : String(value)
}

/** What a spool file holds: one write's changes, and when it was made. */
interface Spooled {
  at: number
  changes: ConfigChange[]
}

/** What a fold wrote down, and what stopped it, if anything did. */
export interface Folded {
  folded: number
  trouble: string | null
}

/**
 * Write `changes` down as `config_changed` lines in this home's journal: now,
 * holding the lock, where nobody holds the home — `'journal'` — or on the next
 * beat of the window that does — `'spool'`. Null where there was nothing to
 * write down. Throws where they could be neither, or where the journal would
 * not take them, saying they wait in the spool for the next fold.
 */
export async function recordConfigChanges(
  home: string,
  changes: readonly ConfigChange[],
  at: Date = new Date(),
): Promise<'journal' | 'spool' | null> {
  if (changes.length === 0) return null
  await spool(home, { at: at.getTime(), changes: [...changes] })
  let lock: Awaited<ReturnType<typeof lockHome>>
  try {
    lock = await lockHome(home)
  } catch (err) {
    // A window holds it: the change is its to write down, on its beat.
    if (err instanceof HomeBusyError) return 'spool'
    throw err
  }
  try {
    const log = await EventLog.open({ path: join(home, 'events.jsonl') })
    try {
      const { trouble } = await foldConfigChanges(home, (line) => log.append(line))
      if (trouble !== null) {
        throw new Error(`${trouble}; it waits in ${configChangesSpool(home)} for the next window`)
      }
    } finally {
      await log.close()
    }
  } finally {
    await lock.release()
  }
  return 'journal'
}

/**
 * Append every change waiting in the spool to the journal its caller holds,
 * oldest first, and take each file away once it is all written down. Never
 * throws: what stopped it is handed back, and what was not written down stays
 * for the next fold. A spool that is not there is nothing to fold, and costs
 * one look at a directory.
 */
export async function foldConfigChanges(
  home: string,
  append: (line: EventInput) => Promise<unknown>,
): Promise<Folded> {
  const dir = configChangesSpool(home)
  let names: string[]
  try {
    names = (await readdir(dir)).filter(waiting).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { folded: 0, trouble: null }
    return { folded: 0, trouble: `could not read ${dir}: ${String(err)}` }
  }
  let folded = 0
  for (const name of names) {
    const file = join(dir, name)
    try {
      const read = spooledFrom(await readFile(file, 'utf8'))
      if (typeof read === 'string') {
        // Not a write Tade spooled: said, and set aside rather than read again every beat.
        await append({
          type: 'warning',
          detail: {
            message: `${file} is not a config change Tade spooled (${read}), so nothing in it was written down; it is kept as ${name}.unread`,
          },
        })
        await rename(file, `${file}.unread`)
        continue
      }
      for (const [i, change] of read.changes.entries()) {
        try {
          await append({ type: 'config_changed', detail: { ...change, at: read.at } })
        } catch (err) {
          // What is in the journal is not appended again: the rest take its place.
          if (i > 0) {
            await spoolAt(file, { ...read, changes: read.changes.slice(i) }).catch(
              (also: unknown) => {
                throw new Error(
                  `${String(err)}; and the ${i} already written could not be taken out of the file, so the next fold writes them again: ${String(also)}`,
                )
              },
            )
          }
          throw err
        }
        folded += 1
      }
      await rm(file, { force: true })
    } catch (err) {
      return { folded, trouble: `could not write down ${file}: ${String(err)}` }
    }
  }
  return { folded, trouble: null }
}

/** A finished spool file: never one still being written, nor one set aside. */
function waiting(name: string): boolean {
  return !name.startsWith('.') && name.endsWith('.json')
}

/** Into the spool, named so the oldest sorts first, and whole or not at all. */
async function spool(home: string, spooled: Spooled): Promise<void> {
  const dir = configChangesSpool(home)
  await mkdir(dir, { recursive: true })
  await spoolAt(join(dir, `${spooled.at}-${process.pid}-${randomUUID().slice(0, 8)}.json`), spooled)
}

/** Written beside its name and renamed over it, so a fold reads all of it or none. */
async function spoolAt(file: string, spooled: Spooled): Promise<void> {
  const draft = join(file, '..', `.${randomUUID()}.draft`)
  await writeFile(draft, JSON.stringify(spooled), { mode: 0o600 })
  await rename(draft, file)
}

/** The changes a spool file holds, or why it is not one Tade wrote. */
function spooledFrom(text: string): Spooled | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return `not JSON: ${err instanceof Error ? err.message : String(err)}`
  }
  const shape = 'not the shape Tade writes'
  if (parsed === null || typeof parsed !== 'object') return shape
  const { at, changes } = parsed as { at?: unknown; changes?: unknown }
  if (typeof at !== 'number' || !Number.isFinite(at) || !Array.isArray(changes)) return shape
  const read: ConfigChange[] = []
  for (const one of changes) {
    const { path, was, now, by } = (one ?? {}) as Record<string, unknown>
    if (typeof path !== 'string' || path === '') return shape
    if (typeof was !== 'string' || typeof now !== 'string' || typeof by !== 'string') return shape
    read.push({ path, was, now, by })
  }
  return { at, changes: read }
}
