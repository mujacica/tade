import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type Epoch, isEpoch, MACHINE_ID, machineFile } from '@tade/core'

// Who this machine is to the person's other machines (`@tade/core`'s
// `feeds.ts`): an id, minted the first time a window opens this home and never
// again, and the epoch of its journal — minted with the journal, and again by
// `tade host restore`, because a restored journal hands out numbers it has
// handed out before. Written by whoever holds the home (the window opening it,
// or a restore, which refuses a held home), by rename so a reader never sees
// half a file; read by anything, without the lock.

/** What `machine.json` holds. */
export interface MachineFile {
  id: string
  epoch: Epoch
}

/**
 * This home's machine file, or null where there is none yet, or it is not
 * one. Throws where it is there and could not be read, which is not the same
 * as none: an id minted over it would be a new machine to everybody.
 */
export async function readMachine(home: string): Promise<MachineFile | null> {
  const text = await readFile(machineFile(home), 'utf8').catch(ifMissing(null))
  if (text === null) return null
  let parsed: Partial<MachineFile>
  try {
    parsed = JSON.parse(text) as Partial<MachineFile>
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  }
  if (typeof parsed?.id !== 'string' || !MACHINE_ID.test(parsed.id) || !isEpoch(parsed.epoch)) {
    return null
  }
  return { id: parsed.id, epoch: { id: parsed.epoch.id, at: parsed.epoch.at } }
}

/** `fallback` where there is nothing at the path, and the error thrown on otherwise. */
export function ifMissing<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return fallback
    throw err
  }
}

/** A new epoch, minted now. */
export function newEpoch(now: number): Epoch {
  return { id: randomBytes(8).toString('hex'), at: new Date(now).toISOString() }
}

async function write(home: string, file: MachineFile): Promise<void> {
  const path = machineFile(home)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.writing`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o644 })
  await rename(tmp, path)
}

/** What opening a home did to who it is, for the journal's first lines. */
export interface MachineOpened {
  file: MachineFile
  /** A new id, because this home never had one. */
  minted: boolean
  /** A new epoch, and why: a journal begun from nothing. Null where the epoch stood. */
  newEpoch: string | null
}

/**
 * Who this home is, made sure of before its journal is opened: an id minted
 * where there is none, and a new epoch where the journal is about to begin
 * from nothing — never made, or emptied — since its numbers start again at
 * one. The caller holds the home's lock.
 *
 * A machine file that cannot be read back as one is not thrown over: it is set
 * aside beside itself and a new one minted, because a home that will not open
 * over it is worse — and that is said, in the opening's `newEpoch`.
 */
export async function ensureMachine(home: string, now: number): Promise<MachineOpened> {
  const journal = await stat(join(home, 'events.jsonl')).catch(ifMissing(null))
  const fresh = journal === null || journal.size === 0
  const had = await readMachine(home)
  if (had === null) {
    const unreadable = await stat(machineFile(home)).catch(ifMissing(null))
    if (unreadable !== null) {
      await rename(machineFile(home), `${machineFile(home)}.unreadable-${now}`)
    }
    const file = { id: randomUUID(), epoch: newEpoch(now) }
    await write(home, file)
    return {
      file,
      minted: true,
      newEpoch:
        unreadable === null
          ? null
          : 'machine.json could not be read, so it was set aside and this machine has a new id',
    }
  }
  if (!fresh) return { file: had, minted: false, newEpoch: null }
  const file = { id: had.id, epoch: newEpoch(now) }
  await write(home, file)
  return { file, minted: false, newEpoch: 'the journal begins from nothing' }
}

/**
 * A new epoch for a home whose journal was put back from somewhere else: `tade
 * host restore`. The id stays — it is the same machine, come back — and every
 * other machine holding a copy of its journal sets that copy aside and begins
 * the new life beside it, rather than taking lines numbered again as more of
 * the old. A home with no machine file yet (a backup from before ids) gets one.
 */
export async function mintEpoch(home: string, now: number): Promise<MachineFile> {
  const had = await readMachine(home)
  const file = { id: had?.id ?? randomUUID(), epoch: newEpoch(now) }
  await write(home, file)
  return file
}
