import { readFileSync, rmSync } from 'node:fs'

// What this process wrote to say it holds something — the run lock, a slot of
// the machine's, a run in flight — given back however the process ends.
//
// Each is read as held for as long as its pid is alive, which was enough while
// a process that ended took its pid with it. A reload keeps the pid (the CLI's
// `startAgain` replaces the process in place), so the window that comes back
// would find what its old self held still held by somebody alive, and every
// agent's checks would wait behind a run that is no longer there. So it goes
// on `exit`, which a reload says too, and only while it still names this
// process: one somebody took over since is theirs.

const held = new Set<string>()
let listening = false

/** Remove this file when the process ends, unless it is let go of first (`letGoOf`). */
export function holdUntilExit(path: string): void {
  held.add(path)
  if (listening) return
  listening = true
  process.on('exit', giveBack)
}

/** Given back already, or somebody else's now. */
export function letGoOf(path: string): void {
  held.delete(path)
}

function giveBack(): void {
  for (const path of held) {
    try {
      if (namesThisProcess(readFileSync(path, 'utf8'))) rmSync(path, { force: true })
    } catch (err) {
      // Gone already is what was wanted; anything else leaves a lock behind, and says so.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        process.stderr.write(`could not give back ${path}: ${(err as Error).message}\n`)
    }
  }
  held.clear()
}

/** Whose the record is, read the way it is written: `{"pid":123,…}`. Half a write names nobody. */
function namesThisProcess(text: string): boolean {
  return Number(/"pid":(\d+)/.exec(text)?.[1]) === process.pid
}
