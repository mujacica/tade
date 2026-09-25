import { type ChildProcess, spawn } from 'node:child_process'
import { accessSync, constants, mkdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  type CallContext,
  McpError,
  type McpTransport,
  type OfferedTool,
  type ServerAbout,
  type ServerDeclaration,
  type ServerSession,
  type ToolOutcome,
  type TransportContext,
  type TransportOptions,
} from '@tade/mcp-core'
import * as wire from '@tade/mcp-core/protocol'

// A server that is a program on this machine, talked to over its own pipes.
//
// Everything here follows from one thing: the program is somebody else's, and
// it runs as you, with the window's privileges. Nothing contains it — Tade had
// a `sandbox` key here and it was half a promise, since the default was `none`
// and containing a program somebody deliberately handed the machine to was
// never Tade's to do. What it does have is real, and is all of it:
//
//   It is **detached**, in a process group of its own, so a signal meant for
//   Tade's own group never sweeps it up by accident — and, per the rule that
//   goes with that, whoever started it ends its group.
//
//   Its **environment is what the broker scrubbed** and nothing else: `PATH`,
//   `HOME`, `TMPDIR`, what the declaration itself names, and the credential
//   where `auth` says. Not the window's own environment, which holds
//   everybody's tokens.
//
//   It works in **a scratch directory of its own**, never in a project unless
//   it is scoped to one — which bounds where it writes by default and stops
//   nothing, and is said as that where somebody turns a server on.
//
//   Nothing it does can hang the window: the handshake has a deadline, a call
//   can be given up on, and a program that dies is an answer with what it
//   said on its way out.
//
// `ready()` answers from the declaration and the filesystem — `which`, in
// effect — and never starts anything and never dials anything.

/** How long a program is given to die politely before it is made to. */
const KILL_MS = 2_000

/** What is kept of what a program wrote to standard error, for saying why it would not start. */
const SAID_CAP = 2_000

/**
 * The longest a single answer may be before it is given up on.
 *
 * A server that never writes a newline is a server that would otherwise be
 * read into memory until the window dies, and a frame this size is not one
 * anybody meant to send.
 */
const FRAME_CAP = 8 * 1024 * 1024

/** How many pages of a tool list are read before Tade stops asking. */
const PAGES = 20

export type StdioTransportOptions = TransportOptions

export function makeStdioTransport(options: StdioTransportOptions = {}): McpTransport {
  const cap = options.cap ?? 20_000

  return {
    id: 'stdio',
    capabilities: {
      spawns: true,
      network: false,
      // A server says its list changed on the same pipe it says everything else on.
      announces: true,
      cancel: true,
    },
    async ready(server, ctx) {
      return readiness(server, ctx)
    },
    async open(server, ctx) {
      const said = readiness(server, ctx)
      if (said) throw new McpError('unavailable', said)
      return start(server, ctx, cap)
    },
  }
}

/**
 * Whether this program could be started at all, and what to do about it when
 * it could not. The filesystem and the declaration, and nothing else.
 */
function readiness(server: ServerDeclaration, ctx: TransportContext): string | null {
  if (!server.command) return `${server.name} is a program Tade starts, and nothing says which`
  if (!found(server.command, ctx.env)) {
    // Tade never installs anything: the line is shown, and running it is an
    // act somebody takes in a lane they are looking at.
    return `${server.command} is not on this machine${server.install ? `: ${server.install}` : ''}`
  }
  return null
}

/** Where a server of its own keeps whatever it writes: never a project, unless it is scoped to one. */
export function scratch(home: string, name: string): string {
  return join(home, 'mcp', name)
}

/** Whether a program is here, the way `which` answers it: the declaration, and the filesystem. */
export function found(command: string, env: Readonly<Record<string, string>>): boolean {
  if (command.includes('/')) return runnable(command)
  const path = env.PATH ?? ''
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => runnable(join(dir, command)))
}

function runnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * What a project-scoped server is started with: `${project}` is the root of
 * the project the call came from. Pure, so what a server is handed is a table
 * test rather than something read off a spawn.
 */
export function withProject(args: readonly string[], project: string | undefined): string[] {
  if (!project) return [...args]
  return args.map((arg) => arg.split(PLACE).join(project))
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: it is the declaration's own placeholder, not ours.
const PLACE = '${project}'

/** The environment the program gets: what was scrubbed, and the credential where `auth` says. */
function environment(
  server: ServerDeclaration,
  ctx: TransportContext,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...ctx.env }
  // The one copy of the credential this transport is given goes exactly where
  // the declaration says, and nowhere else: not in the lane's spec, not in a
  // file, not in the window's own environment.
  if (server.auth === 'env' && server.authName && ctx.credential) {
    env[server.authName] = ctx.credential
  }
  return env
}

async function start(
  server: ServerDeclaration,
  ctx: TransportContext,
  cap: number,
): Promise<ServerSession> {
  const dir = scratch(ctx.home, server.name)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // A home that cannot be written is a server with nowhere of its own to
    // work in, which only matters if it tries; it is not a reason not to start.
  }
  const launch = { command: server.command ?? '', args: withProject(server.args, ctx.cwd) }
  const child = spawn(launch.command, launch.args, {
    cwd: ctx.cwd ?? dir,
    env: environment(server, ctx),
    // Its own process group: a signal to Tade's never reaches it by accident,
    // and ending it is ending the group, which `close()` does.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  // A server nobody closed must never be what keeps the window from exiting.
  child.unref()
  return handshake(server, ctx, child, cap)
}

interface Waiting {
  resolve: (result: Record<string, unknown>) => void
  reject: (err: unknown) => void
}

/**
 * Open the conversation, or say why it could not be opened.
 *
 * Three things can happen and all three are answers: it says hello, it dies
 * saying why, or it says nothing at all — and the third is what the deadline
 * is for. Nothing here waits without one.
 */
async function handshake(
  server: ServerDeclaration,
  ctx: TransportContext,
  child: ChildProcess,
  cap: number,
): Promise<ServerSession> {
  const waiting = new Map<number, Waiting>()
  const progressing = new Map<number, (text: string) => void>()
  const changed = new Set<() => void>()
  let next = 1
  let said = ''
  let over: McpError | null = null
  let closed = false
  let rest = ''

  /** Everything still waiting comes back with why, rather than waiting for ever. */
  const ended = (err: McpError) => {
    over ??= err
    for (const one of [...waiting.values()]) one.reject(err)
    waiting.clear()
    progressing.clear()
  }

  const send = (message: wire.Message): void => {
    if (over) throw over
    try {
      child.stdin?.write(`${JSON.stringify(message)}\n`)
    } catch (err) {
      throw new McpError('gone', `${server.name} is not listening any more`, why(err))
    }
  }

  const ask = (message: wire.Asked): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (over) return reject(over)
      waiting.set(message.id, { resolve, reject })
      try {
        send(message)
      } catch (err) {
        waiting.delete(message.id)
        reject(err)
      }
    })

  const took = (message: wire.Message): void => {
    if (typeof message.id === 'number' && (message.result || message.error)) {
      const one = waiting.get(message.id)
      waiting.delete(message.id)
      progressing.delete(message.id)
      if (!one) return
      if (message.error) {
        // The server answered, and what it said was no. That is an answer
        // about this request, never a reason to give up on the session.
        one.reject(new McpError('refused', message.error.message ?? 'it would not say why'))
        return
      }
      one.resolve(message.result ?? {})
      return
    }
    if (message.method === 'notifications/progress') {
      const id = wire.progressFor(message.params)
      const text = wire.progress(message.params)
      if (id !== null && text !== null) progressing.get(id)?.(text)
      return
    }
    if (message.method === 'notifications/tools/list_changed') {
      for (const listener of [...changed]) listener()
    }
    // Anything else — a server asking Tade for something Tade does not offer
    // — is left alone. Not answering is the refusal: no sampling, no
    // elicitation, no roots, and nothing to argue with.
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    rest += chunk
    if (rest.length > FRAME_CAP) {
      // Nobody meant to send this. Dropping what is held is the only thing
      // that is not "read somebody else's program into memory until we die".
      rest = ''
      return
    }
    let at = rest.indexOf('\n')
    while (at !== -1) {
      const line = rest.slice(0, at).trim()
      rest = rest.slice(at + 1)
      // A banner, a warning, half a line of something: a server that writes
      // what is not a message is a server that still works.
      if (line !== '') {
        const message = wire.parse(line)
        if (message) took(message)
      }
      at = rest.indexOf('\n')
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    // What it says on its way out is what a person needs to read on the page.
    said = `${said}${chunk}`.slice(-SAID_CAP)
  })
  child.on('error', (err) => {
    ended(new McpError('unavailable', `${server.name} would not start: ${why(err)}`, said.trim()))
  })
  child.on('exit', (code, signal) => {
    const how = signal ? `on ${signal}` : `with code ${code ?? 0}`
    ended(new McpError('gone', `${server.name} stopped ${how}`, said.trim()))
  })

  /** End it, and its group with it: whoever started one ends it. */
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    ended(over ?? new McpError('gone', `${server.name} was closed`))
    try {
      child.stdin?.end()
    } catch {
      // It is already gone, which is where this was heading.
    }
    stop(child, 'SIGTERM')
    // Held again while it is being ended: an unreferenced child is one node
    // does not wait to reap, so its exit would never be delivered and this
    // would wait for ever on a program that is already gone.
    child.ref()
    const later = setTimeout(() => stop(child, 'SIGKILL'), KILL_MS)
    try {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.once('exit', () => resolve())
        // A program that will not die is not a window that cannot close.
        setTimeout(resolve, KILL_MS + 500).unref?.()
      })
    } finally {
      clearTimeout(later)
      child.unref()
    }
  }

  const id = next++
  const hello = await Promise.race([
    ask(wire.initialize(id)),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(
          new McpError(
            'timeout',
            `${server.name} did not answer in ${Math.round(ctx.deadlineMs / 1000)}s`,
          ),
        )
      }, ctx.deadlineMs)
      timer.unref?.()
    }),
  ]).catch(async (err: unknown) => {
    // An open that did not answer is abandoned rather than waited on, and a
    // program abandoned mid-handshake is a program ended.
    await close()
    if (err instanceof McpError) throw err
    throw new McpError('unavailable', `${server.name} would not start: ${why(err)}`, said.trim())
  })

  const about: ServerAbout = wire.about(hello)
  send(wire.initialized())

  const usable = () => {
    if (closed || over) throw over ?? new McpError('gone', `${server.name} was closed`)
  }

  return {
    about,
    async listTools(signal?: AbortSignal): Promise<readonly OfferedTool[]> {
      usable()
      const out: OfferedTool[] = []
      let cursor: string | null = null
      for (let page = 0; page < PAGES; page++) {
        if (signal?.aborted) break
        const result: Record<string, unknown> = await ask(wire.listTools(next++, cursor))
        out.push(...wire.tools(result))
        cursor = wire.more(result)
        if (!cursor) break
      }
      return out
    },
    async callTool(
      name: string,
      input: Readonly<Record<string, unknown>>,
      call: CallContext,
    ): Promise<ToolOutcome> {
      usable()
      const mine = next++
      progressing.set(mine, (text) => call.progress(text))
      const stopping = () => {
        // An agent told to stop is not one left waiting: the server is told,
        // and the call comes back rather than staying out there.
        try {
          send(wire.cancelled(mine, 'Tade gave up on it'))
        } catch {
          // It is gone, which is the same outcome by another road.
        }
        const one = waiting.get(mine)
        waiting.delete(mine)
        progressing.delete(mine)
        one?.reject(new McpError('refused', `${server.name} was given up on`))
      }
      call.signal.addEventListener('abort', stopping, { once: true })
      try {
        const result = await ask(wire.callTool(mine, name, input))
        const outcome = wire.outcome(result)
        return { text: outcome.text.slice(0, cap), failed: outcome.failed }
      } finally {
        call.signal.removeEventListener('abort', stopping)
        progressing.delete(mine)
      }
    },
    onToolsChanged(listener: () => void) {
      changed.add(listener)
      return () => changed.delete(listener)
    },
    close,
  }
}

/**
 * End a program and the group it is in.
 *
 * The group, because a server that started children of its own — a language
 * runtime, a browser — leaves them behind otherwise, and nobody would ever
 * find them again. The pid on its own is the fallback for a platform where
 * there was no group to sign.
 */
function stop(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (child.pid) process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already gone: the outcome asked for.
    }
  }
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
