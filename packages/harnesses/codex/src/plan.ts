import { type ChildProcess, spawn } from 'node:child_process'
import { located, stopGroup } from '@tade/core'
import type { PlanLimits } from '@tade/harnesses-core'
import { type CodexWindow, windowsAsLimits } from './sessions.ts'

// Asking Codex how much of its plan is used, without running anything.
//
// Codex hears its plan's windows from the service as each turn ends, which is
// what `limitsIn` reads out of a rollout. Its app server can also be asked
// outright — `account/rateLimits/read`, one request, no model and no turn — and
// that is what lets the queue know a plan before it lets a start through to
// find out (`planTooTight`). It is JSON-RPC, one message per line each way.
//
// The server ends when its input does, *before* it has answered — so its input
// is held open until the answer comes, and then its process group is ended,
// whichever comes first of that and the deadline. Should Tade itself end in
// between, its end of the pipe closes, and so does the server.
//
// Every way it can come to nothing is said (`say`), because an ask that failed
// in silence reads exactly like a plan nobody has asked about — except a codex
// that is not here at all, which is nothing to ask rather than a failure.

const HELLO = 1
const READ = 2

/**
 * Ask `bin`'s app server for the plan; null where no answer came within
 * `timeoutMs`, with why handed to `say`. Never throws.
 */
export function askPlan(
  bin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  say: (why: string) => void,
): Promise<PlanLimits | null> {
  return new Promise((done) => {
    let child: ChildProcess | undefined
    let buffer = ''
    let settled = false
    const finish = (limits: PlanLimits | null, why?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child?.stdin?.end()
      if (child?.pid) stopGroup(child.pid)
      if (why) say(why)
      done(limits)
    }
    const failed = (err: unknown) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      finish(null, missing ? undefined : `it could not be started: ${(err as Error).message}`)
    }
    const timer = setTimeout(
      () => finish(null, `it did not answer within ${Math.round(timeoutMs / 1000)}s`),
      timeoutMs,
    )
    const write = (message: object) => child?.stdin?.write(`${JSON.stringify(message)}\n`)
    const heard = (message: Record<string, unknown>) => {
      const error = record(message.error)
      if (message.id === HELLO) {
        if (error) return finish(null, `it refused to start talking: ${String(error.message)}`)
        write({ jsonrpc: '2.0', method: 'initialized' })
        write({
          jsonrpc: '2.0',
          id: READ,
          method: 'account/rateLimits/read',
          params: { excludeResetCreditDetails: true },
        })
      } else if (message.id === READ) {
        if (error) return finish(null, `it answered ${String(error.message)}`)
        const limits = limitsOf(record(message.result)?.rateLimits, Date.now())
        finish(limits, limits ? undefined : 'it answered in a shape Codex does not have')
      }
    }
    try {
      // Its own process group, like everything Tade starts, from an absolute path.
      child = spawn(located(bin, env), ['app-server'], {
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: true,
      })
    } catch (err) {
      failed(err)
      return
    }
    child.on('error', failed)
    child.on('close', () => finish(null, 'it ended before it answered'))
    // A server that died before reading is a write into a closed pipe.
    child.stdin?.on('error', failed)
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        // Only a line that is a message is read: one that is not — a banner,
        // a log — said nothing to us, and one that only looks like it is said.
        if (!line.startsWith('{')) continue
        let message: Record<string, unknown> | null
        try {
          message = record(JSON.parse(line))
        } catch (err) {
          finish(null, `it said something that is not JSON-RPC: ${(err as Error).message}`)
          return
        }
        if (message) heard(message)
      }
    })
    write({
      jsonrpc: '2.0',
      id: HELLO,
      method: 'initialize',
      params: { clientInfo: { name: 'tade', title: 'Tade', version: '1' } },
    })
  })
}

/** The app server's snapshot as a plan, or null where it is not a shape Codex has. */
export function limitsOf(snapshot: unknown, at: number): PlanLimits | null {
  const said = record(snapshot)
  if (!said) return null
  const window = (value: unknown): CodexWindow | null => {
    const one = record(value)
    if (!one || typeof one.usedPercent !== 'number' || !Number.isFinite(one.usedPercent))
      return null
    const seconds = typeof one.resetsAt === 'number' ? one.resetsAt : 0
    const minutes = typeof one.windowDurationMins === 'number' ? one.windowDurationMins : 0
    return { used: one.usedPercent, resetsAt: seconds * 1000, minutes }
  }
  return windowsAsLimits([window(said.primary), window(said.secondary)], at)
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
