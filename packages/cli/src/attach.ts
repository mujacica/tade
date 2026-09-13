import type { LaneId } from '@wilco/core'
import type { Workbench } from '@wilco/workbench'
import { Exit, type Io } from './io.ts'

// Attaching puts the user's terminal into raw mode. Getting the restore wrong
// leaves people with a broken terminal and they never trust the tool again,
// so every exit path goes through one `restore()` that is safe to call twice.

/** Ctrl-\ (0x1c) twice within this window detaches. */
const DETACH_KEY = 0x1c
const DETACH_WINDOW_MS = 1_000

export async function attachToLane(
  client: Workbench,
  lane: LaneId,
  io: Io,
  streams: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {},
): Promise<number> {
  const stdin = streams.stdin ?? process.stdin
  const stdout = streams.stdout ?? process.stdout
  const interactive = Boolean(stdin.isTTY && stdout.isTTY)

  let restored = false
  let lastDetachKey = 0
  let exitCode: number | null = null

  const onData = (chunk: Buffer) => {
    // Scan the chunk rather than expecting one byte per keypress: fast typing
    // and paste both arrive coalesced.
    if (interactive) {
      for (const byte of chunk) {
        if (byte !== DETACH_KEY) continue
        const now = Date.now()
        if (now - lastDetachKey < DETACH_WINDOW_MS) {
          void finish()
          return
        }
        lastDetachKey = now
      }
    }
    void client.write(lane, chunk).catch(() => finish())
  }

  const onResize = () => {
    if (interactive)
      void client.resize(lane, stdout.columns ?? 80, stdout.rows ?? 24).catch(() => {})
  }

  const restore = () => {
    if (restored) return
    restored = true
    stdin.removeListener('data', onData)
    if (interactive) {
      try {
        stdin.setRawMode(false)
      } catch {
        // the terminal may already be gone
      }
      process.removeListener('SIGWINCH', onResize)
    }
    stdin.pause()
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('SIGHUP', onSignal)
    process.removeListener('exit', restore)
  }

  let settle: (code: number) => void = () => {}
  const finished = new Promise<number>((resolve) => {
    settle = resolve
  })

  const finish = async (code: number = Exit.ok) => {
    restore()
    stop?.()
    settle(code)
  }

  const onSignal = () => void finish(Exit.error)

  const watching = await client.watch(lane, (chunk) => stdout.write(chunk), {
    onExit: ({ code }) => {
      exitCode = code
      void finish()
    },
  })
  const stop: (() => void) | null = watching.stop

  // Paint what the lane looks like right now, then follow along live.
  stdout.write(`${watching.snapshot}\n`)
  if (interactive) {
    io.err('[attached — press Ctrl-\\ twice to detach]')
    try {
      stdin.setRawMode(true)
    } catch {
      // not a real tty after all
    }
    process.on('SIGWINCH', onResize)
    onResize()
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGHUP', onSignal)
  process.on('exit', restore)
  stdin.resume()
  stdin.on('data', onData)

  const code = await finished
  restore()
  if (exitCode !== null) io.err(`[lane exited with code ${exitCode}]`)
  else io.err('[detached]')
  return code
}
