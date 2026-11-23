import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// How much of this machine's disk other machines may fill.
//
// Everything another machine hands this one is written under
// `<home>/machines/` — the copy of its journal and every copy of it a fork set
// aside (`feeds.ts`), its conversation and the files beside it
// (`conversation-share.ts`) — and each answer is bounded, but answers come every
// beat and a fork, a new epoch or a machine id nobody has heard of each start
// another file. **Whoever controls another machine** — an agent there, which
// runs as you — could fill this one's disk a megabyte a beat. So all of it
// together has a ceiling, asked before anything is taken, and past it nothing
// more is taken and that is said: a copy here is always safe to delete
// (`feedDir`), and the next exchange fetches what is wanted again.
//
// Four gibibytes: a heavy month on one Mac is 280 MB of lines that travel
// (measured 2026-11-23, of a 659 MB journal), so this is room for many busy
// machines and still a bound on a hostile one.

/** The most bytes everything other machines gave this one may take up here, together. */
export const PEERS_BYTES_MOST = 4 * 1024 ** 3

/** What is said where the ceiling stopped something being taken. */
export function peersFullSays(most: number = PEERS_BYTES_MOST): string {
  return `this machine keeps at most ${Math.round(most / 1024 ** 2)} MB of what other machines give it, and that is used up — nothing more is taken until some of it goes; every copy under machines/ in Tade's home is safe to delete, and is fetched again`
}

/** The bytes of every file under `<home>/machines/`. A folder that is not there is nought. */
export async function peersBytes(home: string): Promise<number> {
  return bytesUnder(join(home, 'machines'), 0)
}

async function bytesUnder(dir: string, depth: number): Promise<number> {
  if (depth > 8) return 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return []
      throw err
    },
  )
  let total = 0
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await bytesUnder(path, depth + 1)
    else if (entry.isFile()) {
      total +=
        (
          await stat(path).catch((err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return null
            throw err
          })
        )?.size ?? 0
    }
  }
  return total
}

/**
 * The room left under the ceiling, as one taker sees it: the folder walked at
 * most once every `every` milliseconds, and what this taker wrote since added
 * as it writes — so a burst of rounds walks it once, and two takers can each
 * see the other's writes by the next walk.
 */
export class PeerRoom {
  private readonly home: string
  private readonly most: number
  private readonly every: number
  private used = 0
  private walked = Number.NEGATIVE_INFINITY

  constructor(home: string, opts: { most?: number; every?: number } = {}) {
    this.home = home
    this.most = opts.most ?? PEERS_BYTES_MOST
    this.every = opts.every ?? 30_000
  }

  /** Whether `bytes` more still fit. */
  async fits(bytes: number, now: number): Promise<boolean> {
    if (now - this.walked >= this.every) {
      this.used = await peersBytes(this.home)
      this.walked = now
    }
    return this.used + bytes <= this.most
  }

  /** Bytes this taker just wrote, counted until the next walk counts them itself. */
  spent(bytes: number): void {
    this.used += bytes
  }

  /** The sentence for a refusal by this ceiling. */
  says(): string {
    return peersFullSays(this.most)
  }
}
