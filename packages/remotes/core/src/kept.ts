import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { machineDir } from '@tade/core'
import { readSnapshot } from './held.ts'
import type { Held, LinkCursor } from './port.ts'

// What this machine last heard from another, kept on its disk: the projection,
// the moment it was last known to be current, and the cursor it is at, in
// `<home>/machines/<name>/projection.json` (`machineDir`).
//
// **So `as of` survives a restart.** A link holds the last projection when the
// remote stops answering (`port.ts`), and before this it held it in memory
// only — a window opened while the VPS was down drew it as never heard from,
// which reads as "nothing is running there" about a machine whose agents are
// working perfectly well. Kept here, it is drawn `as of` the moment it was
// heard, which is still this machine's clock, written down.
//
// **A copy of what that machine said, never a second truth about it**: read
// back only for drawing until the remote answers, replaced whole by the first
// snapshot it sends, and always safe to delete. It is read for its shape like
// any projection (`readSnapshot`), because it was written by another machine
// first; a file that is not one is no file. It holds what an owner device is
// sent — the person's own work, and notes — so it is `0600`, in Tade's home,
// like the config beside it.

/** What is kept of one remote. */
export interface Kept {
  projection: NonNullable<Held['projection']>
  heardAt: number
  cursor: LinkCursor | null
}

const FILE = 'projection.json'

/** Where one remote's copy is, or null for a name no path is made of. */
export function keptPath(home: string, name: string): string | null {
  // `machineDir`'s own rule, asked rather than caught: a name it would refuse makes no path.
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(name)) return null
  return join(machineDir(home, name), FILE)
}

/**
 * What was kept of one remote, or null where nothing was — no file, or a name
 * no path is made of. A file that is there and could not be read, or is not a
 * projection, throws what to say: a copy nobody can draw is said, never passed
 * off as there being none.
 */
export async function readKept(home: string, name: string): Promise<Kept | null> {
  const path = keptPath(home, name)
  if (path === null) return null
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`what was last heard from ${name} could not be read back: ${String(err)}`)
  }
  const unread = (why: string) =>
    new Error(`what was last heard from ${name} was kept in a file that ${why}, so it is not drawn`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw unread(`is not JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  if (typeof value !== 'object' || value === null) throw unread('holds no projection')
  const { projection, heardAt, cursor } = value as Record<string, unknown>
  if (typeof heardAt !== 'number' || !Number.isFinite(heardAt)) throw unread('says no moment')
  const read = readSnapshot(JSON.stringify(projection))
  if (typeof read === 'string') throw unread(`is not a projection: ${read}`)
  return { projection: read, heardAt, cursor: cursorIn(cursor) }
}

function cursorIn(value: unknown): LinkCursor | null {
  if (typeof value !== 'object' || value === null) return null
  const { epoch, rev } = value as Record<string, unknown>
  return typeof epoch === 'string' && Number.isInteger(rev) ? { epoch, rev: rev as number } : null
}

/**
 * Keep one remote's projection: written beside itself and renamed over the
 * copy, so a crash mid-write leaves the last one whole. Throws what to say
 * where it could not be written.
 */
export async function writeKept(home: string, name: string, kept: Kept): Promise<void> {
  const path = keptPath(home, name)
  if (path === null) return
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(kept), { mode: 0o600 })
  await rename(temp, path)
}
