import { spawn } from 'node:child_process'

// Runs a harness that must not outlive Tade, and ends it when Tade is gone.
//
// The thing you talk to has no terminal of its own and cannot be found again:
// left running, it is a model process nobody can see, drive or stop — the one
// outcome worse than either closing it or keeping it. Its own exit path stops
// it, but an exit path only runs when there is one: a window killed outright
// leaves nothing behind to do it.
//
// So it is watched from here rather than promised there. This sits between
// Tade and the harness, hands its own standard streams straight through, and
// watches the pid it was given: when that pid is gone, the harness goes with
// it. Polled rather than signalled, because there is no signal for "my parent
// died" that survives the parent dying.
//
//   node reaper.ts <tade's pid> <command> [args...]

/** How often Tade is looked for. Long enough to cost nothing, short enough to feel immediate. */
const LOOK_MS = 500

/** Is this process still there? EPERM means yes, and not ours to signal. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const [watched, command, ...args] = process.argv.slice(2)
const parent = Number(watched)
if (!command || !Number.isInteger(parent)) {
  process.stderr.write('reaper: <pid> <command> [args...]\n')
  process.exit(2)
}

const child = spawn(command, args, { stdio: 'inherit' })

const end = (signal: NodeJS.Signals = 'SIGTERM') => {
  try {
    child.kill(signal)
  } catch {
    // Already gone, which is the outcome we wanted.
  }
}

const looking = setInterval(() => {
  if (alive(parent)) return
  clearInterval(looking)
  end()
  // Gone politely, or gone anyway: a harness that ignores SIGTERM is still a
  // process nobody can reach.
  const forced = setTimeout(() => {
    end('SIGKILL')
    process.exit(0)
  }, 5_000)
  forced.unref?.()
}, LOOK_MS)

child.on('exit', (code, signal) => {
  clearInterval(looking)
  process.exit(signal ? 1 : (code ?? 0))
})
child.on('error', (err) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})

// Asked to stop, it stops what it started: never leaving the harness behind.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    clearInterval(looking)
    end(signal)
  })
}
