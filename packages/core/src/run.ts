import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { constants } from 'node:os'
import { resolveCommand } from './which.ts'

// Running a program: the one way Tade starts one it waits for.
//
// Terminal.app names its window after the newest process in the terminal's
// foreground process group, and iTerm2 its job the same way. Anything Tade
// starts in that group — a `git`, a `ps`, the clipboard's `osascript` —
// retitles the window for as long as it runs, which is what made the title
// flicker between them. So every program runs in a group of its own.
//
// `execFile` cannot do that, whatever its options say. It hands `spawn` a fixed
// list of them and `detached` is not on it, so `execFile(…, { detached: true })`
// runs in Tade's own group every time — five files said otherwise in a comment,
// and the types were right. `test/spawns.test.ts` keeps `execFile` and `exec`
// out of every package's `src`; `spawn` with `detached` is setsid.
//
// And always from an absolute path. Given a bare name, libuv forks to search
// PATH and calls setsid in the child, which sits in Tade's group, named `node`,
// for about a millisecond and costs the thread that draws ~2.7 ms; given a path
// it is posix_spawn with SETSID, ~0.35 ms and no such moment. A command is
// looked up once per name and PATH (`located`), and looked up again a minute
// later, so a program installed or moved meanwhile is found.

export interface RunOptions {
  cwd?: string
  /** The whole environment it runs with. Tade's own when not given. */
  env?: Readonly<Record<string, string | undefined>>
  /** When it and everything it started are killed. 0 waits as long as it takes. */
  timeoutMs?: number
  /** Bytes of each of its outputs kept. Past it, it is stopped and that is said. */
  maxBuffer?: number
  /** Aborting it kills it, and everything it started. */
  signal?: AbortSignal
}

/** What running it came to. Never thrown: a failure is a code and what was said. */
export interface RunResult {
  /** Its exit code; 128 and the signal's number when one ended it, as a shell says it. */
  code: number
  stdout: string
  stderr: string
  /** It ran out of time and was killed. */
  timedOut: boolean
  /** Nothing answers to the command: not installed, or not on PATH. */
  missing: boolean
}

/** Long enough for any probe; a caller that waits on a person says 0. */
const DEADLINE_MS = 120_000
const MAX_BUFFER = 64 * 1024 * 1024
/** How long a lookup stands. A lookup is a stat per PATH entry; a spawn from a bare name is far dearer. */
const LOOKUP_MS = 60_000

const looked = new Map<string, { path: string | null; at: number }>()

/**
 * The absolute path a command runs from, or the command as given where nothing
 * answers to it — so starting it fails the ordinary way. A command with a slash
 * in it names its own file and is taken as written.
 */
export function located(
  command: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (command.includes('/')) return command
  const path = env.PATH ?? ''
  const key = `${command}\0${path}`
  const now = Date.now()
  const known = looked.get(key)
  if (known && now - known.at < LOOKUP_MS) return known.path ?? command
  const found = resolveCommand(command, { PATH: path })
  looked.set(key, { path: found, at: now })
  return found ?? command
}

/** Process groups started and not yet finished, so leaving never leaves one behind. */
const running = new Set<number>()
let reaping = false

/** Kill a group, or the one process when it is somehow not a leader. Gone already is fine. */
function stop(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone, which is what was wanted.
    }
  }
}

/**
 * End a process group Tade started and talks to itself rather than waits for —
 * the same end `runProgram` gives its own, so the catches live here once.
 */
export function stopGroup(pid: number): void {
  stop(pid)
}

function track(pid: number): void {
  running.add(pid)
  if (reaping) return
  reaping = true
  // Detached means Ctrl+C on the terminal no longer reaches them, so Tade
  // ending ends them: whoever started one ends it.
  process.once('exit', () => {
    for (const one of running) stop(one)
  })
}

/** Keeps the first `cap` bytes of a stream and says when there was more. */
function keeper(cap: number, over: () => void) {
  const chunks: Buffer[] = []
  let size = 0
  return {
    take(chunk: Buffer): void {
      const room = cap - size
      if (chunk.length <= room) {
        chunks.push(chunk)
        size += chunk.length
        return
      }
      // Past the cap, however the chunks fell: one that filled it exactly
      // left no room, and the next byte is the one that is too many.
      if (room > 0) chunks.push(chunk.subarray(0, room))
      size = cap
      over()
    },
    text: (): string => Buffer.concat(chunks).toString('utf8'),
  }
}

/** A shell's number for a signal: 128 and its own. */
function codeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code
  const number = signal ? constants.signals[signal] : undefined
  return typeof number === 'number' ? 128 + number : 1
}

/**
 * Run a program in a process group of its own, from an absolute path, with a
 * deadline, and never throw. Standard input is empty; each output is kept up
 * to `maxBuffer` bytes.
 */
export function runProgram(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const env = options.env ?? process.env
  const file = located(command, env)
  const deadline = options.timeoutMs ?? DEADLINE_MS
  const cap = options.maxBuffer ?? MAX_BUFFER
  return new Promise((done) => {
    let child: ChildProcess | undefined
    let timer: NodeJS.Timeout | undefined
    let settled = false
    let timedOut = false
    let capped = false
    const notes: string[] = []
    const kill = () => {
      if (child?.pid) stop(child.pid)
    }
    const finish = (result: Omit<RunResult, 'timedOut'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', kill)
      if (child?.pid) running.delete(child.pid)
      const stderr = [result.stderr, ...notes].filter(Boolean).join('\n')
      done({ ...result, stderr, timedOut })
    }
    const over = (which: string) => () => {
      if (capped) return
      capped = true
      notes.push(`${command} said more than ${cap} bytes on ${which} and was stopped`)
      kill()
    }
    const out = keeper(cap, over('stdout'))
    const err = keeper(cap, over('stderr'))
    try {
      child = spawn(file, [...args], {
        cwd: options.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (failed) {
      finish({ code: 126, stdout: '', stderr: (failed as Error).message, missing: false })
      return
    }
    child.stdout?.on('data', out.take)
    child.stderr?.on('data', err.take)
    child.on('error', (failed: NodeJS.ErrnoException) => {
      // ENOENT is a program that is not there or a folder that is not: which is said.
      // A bare name here is one `located` found nowhere on PATH.
      if (failed.code === 'ENOENT') looked.delete(`${command}\0${env.PATH ?? ''}`)
      const missing = failed.code === 'ENOENT' && (!file.includes('/') || !existsSync(file))
      const nowhere = failed.code === 'ENOENT' && options.cwd && !existsSync(options.cwd)
      finish({
        code: missing ? 127 : 126,
        stdout: '',
        stderr: missing
          ? `there is no ${command} on this machine`
          : nowhere
            ? `${options.cwd} is not there to run ${command} in`
            : failed.message,
        missing,
      })
    })
    child.on('close', (code, signal) => {
      finish({ code: codeOf(code, signal), stdout: out.text(), stderr: err.text(), missing: false })
    })
    if (child.pid) track(child.pid)
    if (deadline > 0) {
      timer = setTimeout(() => {
        timedOut = true
        notes.push(
          `${command} took longer than ${Math.round(deadline / 100) / 10}s and was stopped`,
        )
        kill()
      }, deadline)
    }
    if (options.signal?.aborted) kill()
    else options.signal?.addEventListener('abort', kill, { once: true })
  })
}
