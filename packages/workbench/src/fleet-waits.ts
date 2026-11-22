import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { FLEET_WAIT_READS, type Fleet, type FleetMachine, MACHINE_ID } from '@tade/core'
import { copyKept, readCopy } from './feeds.ts'
import { ifMissing } from './machine-file.ts'

// What a wait on another machine is settled by, read out of the copies of the
// others' journals kept under this home (`feeds.ts`): each machine's
// `task_*` and document lines, what it calls itself and what this machine
// calls it, and when it was last heard — the `Fleet` the queue's rule reads
// (`@tade/core`'s `fleet-waits.ts`).
//
// **Asked on every look at the queue, so it costs a `stat` per copy** and
// reads a copy again only when it moved: a hub keeps every machine's journal,
// and reading them all four times a second is the window that stops drawing.

/** What a copy looked like the last time it was read: its journal's size and time, and its sync file's. */
type Stamp = string

interface Read {
  stamp: Stamp
  machine: FleetMachine
}

export class FleetWaits {
  private readonly home: string
  private readonly kept = new Map<string, Read>()

  constructor(home: string) {
    this.home = home
  }

  /**
   * Every other machine whose journal is kept here, as a wait reads it. A copy
   * taken away meanwhile is left out — its waits hold, which is what evidence
   * nobody could read must do — and one there that cannot be read throws.
   */
  async read(self: string): Promise<Fleet> {
    const root = join(this.home, 'machines')
    const entries = await readdir(root, { withFileTypes: true }).catch(ifMissing([]))
    const machines: FleetMachine[] = []
    const here = new Set<string>()
    for (const entry of entries) {
      if (!entry.isDirectory() || !MACHINE_ID.test(entry.name)) continue
      here.add(entry.name)
      // A copy taken away while it is read is one this home does not hold;
      // anything else is thrown to whoever asked, who says it (`Live`).
      const one = await this.copy(entry.name).catch(ifMissing(null))
      if (one !== null) machines.push(one)
    }
    for (const id of this.kept.keys()) if (!here.has(id)) this.kept.delete(id)
    return { self, machines }
  }

  private async copy(id: string): Promise<FleetMachine | null> {
    const dir = join(this.home, 'machines', id)
    const stamp = (await Promise.all(['events.jsonl', 'sync.json', 'feed.json'].map(stampOf(dir))))
      .map((one) => one ?? '-')
      .join(' ')
    const was = this.kept.get(id)
    if (was?.stamp === stamp) return was.machine
    const { meta, sync } = await copyKept(this.home, id)
    if (meta === null) {
      this.kept.delete(id)
      return null
    }
    const lines = (await readCopy(this.home, meta, { types: [...FLEET_WAIT_READS] })) ?? []
    // Heard: the last exchange with it, or the newest line of its own that
    // reached here — relayed through a third machine, a line is all there is.
    const newest = await lastLineAt(join(dir, 'events.jsonl'))
    const synced = sync?.state.at ?? 0
    const heard = Math.max(newest, synced)
    const machine: FleetMachine = {
      name: meta.name,
      ...(sync?.called ? { called: sync.called } : {}),
      heardAt: heard > 0 ? heard : null,
      lines,
    }
    this.kept.set(id, { stamp, machine })
    return machine
  }
}

/** A file's size and modification time, or null where it is not there. */
function stampOf(dir: string) {
  return async (file: string): Promise<string | null> => {
    const seen = await stat(join(dir, file)).catch(ifMissing(null))
    return seen === null ? null : `${seen.size}:${seen.mtimeMs}`
  }
}

/** How much of a copy's end is read for its newest line. */
const TAIL_BYTES = 64 * 1024

/** When the newest whole line of a journal was written, by its own clock; 0 for none. */
async function lastLineAt(path: string): Promise<number> {
  const file = await open(path, 'r').catch(ifMissing(null))
  if (file === null) return 0
  try {
    const { size } = await file.stat()
    const from = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(size - from)
    await file.read(buffer, 0, buffer.length, from)
    const lines = buffer.toString('utf8').split('\n').reverse()
    for (const line of lines) {
      const at = /"ts":"([^"]+)"/.exec(line)?.[1]
      const when = at === undefined ? Number.NaN : Date.parse(at)
      if (Number.isFinite(when)) return when
    }
    return 0
  } finally {
    await file.close()
  }
}
