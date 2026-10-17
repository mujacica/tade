import { connect } from 'node:net'

// How the pieces that run inside a Codex agent — its hooks and the server that
// lends it Tade's tools — ask Tade something: one JSON line to the run's
// socket, one JSON line back.
//
// Loaded by Codex's own processes, so it uses Node's built-ins and nothing of
// ours: no workspace imports, nothing that has to be resolved.

/** Where Tade is listening for this run, when it launched it at all. */
export const SOCKET = process.env.TADE_RUN_SOCKET

/**
 * Tade's answer, or null when it cannot be asked — no Tade, a window that
 * closed, an answer that never came. `wait` is how long an answer may take:
 * a tool call held for a person waits for as long as they take.
 */
export async function ask(request: unknown, wait = 5_000): Promise<unknown> {
  return (await reach(request, wait)).reply
}

/**
 * The same, and whether the question reached Tade at all. Only nobody
 * listening says it was never heard: a window that took it and then said
 * nothing, or nothing readable, may have heard every word.
 */
export function reach(
  request: unknown,
  wait = 5_000,
): Promise<{ reply: unknown; reached: boolean }> {
  const path = SOCKET
  if (!path) return Promise.resolve({ reply: null, reached: false })
  return new Promise((resolve) => {
    let settled = false
    let reached = false
    let buffer = ''
    const done = (value: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ reply: value, reached })
    }
    const socket = connect(path)
    const timer = setTimeout(() => done(null), wait)
    socket.on('connect', () => {
      reached = true
      socket.write(`${JSON.stringify(request)}\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const end = buffer.indexOf('\n')
      if (end < 0) return
      try {
        done(JSON.parse(buffer.slice(0, end)))
      } catch {
        done(null)
      }
    })
    socket.on('error', () => done(null))
    socket.on('close', () => done(null))
  })
}

/** Everything on standard input, as JSON; null when it is not. */
export async function readInput(): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    // An array is an object and is not an event: everything downstream reads
    // `event.hook_event_name`, so a list would arrive as an event with every
    // field missing rather than as nothing at all.
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
