import { createHash } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunId } from './port.ts'

// What a harness writes for one run so that a line could launch it — Claude
// Code's settings, MCP config, instructions and plugin, Codex's and ACP's
// pictures and launch file — goes in a folder named after the run, beside the
// harness's other runs. It was never taken away: on one machine 628 of
// Claude Code's alone, 12 MB, 595 of them for tasks long removed. What
// decides a run is over is the workbench's (`settleRuns`); this is only the
// part every adapter shares, finding a run's files among the rest.

/** The name a run's files go under: derived from the run, so every launch of it finds the same ones. */
export function runFolderName(run: string): string {
  return createHash('sha1').update(run).digest('hex').slice(0, 12)
}

/**
 * Remove from `folder` the entries `namesOf` says are a run's, for each of
 * `runs`, and say which runs had any. The folder is read once, so asking
 * about every run there ever was costs one listing. A folder not made yet has
 * nothing in it; anything else that goes wrong is thrown rather than passed
 * off as tidied, because a folder of Tade's it cannot empty grows for good.
 */
export async function forgetRunFiles(
  folder: string,
  runs: readonly RunId[],
  namesOf: (run: RunId) => readonly string[],
): Promise<RunId[]> {
  let there: Set<string>
  try {
    there = new Set(await readdir(folder))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const gone: RunId[] = []
  for (const run of runs) {
    const names = namesOf(run).filter((name) => there.has(name))
    if (names.length === 0) continue
    for (const name of names) await rm(join(folder, name), { recursive: true, force: true })
    gone.push(run)
  }
  return gone
}
