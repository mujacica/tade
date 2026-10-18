import { chmod, lstat, stat, unlink } from 'node:fs/promises'
import { type IncomingMessage, request, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { type DirSeen, publicDirProblem } from '@tade/core'
import { readsProxyHeaders } from './proxied.ts'
import { codeOf, serverFor } from './request.ts'
import { type Listener, listenerAt, listenOn, type Surface } from './surface.ts'

// The sockets one away view listens on: the TCP addresses `listenOn` names,
// each its own server, and — where a public name is set — the Unix socket
// Caddy connects to, which is a server of its own too.
//
// **Every server says which listener it is when it is made** (`serverFor`),
// so nothing about a request can make it another: a TCP one by the address it
// is bound to (`listenerAt`), and the proxy's socket `public`, whatever is on
// the other end of it and whatever a request on it names.
//
// **A failure to listen is a named warning and nothing listens there.** Never
// a quiet bind somewhere else: a URL in somebody's hand that goes nowhere is
// worse than a surface that said it could not come up.

type Handle = (req: IncomingMessage, res: ServerResponse, listener: Listener) => Promise<void>

/** What came up. */
export interface Listening {
  servers: Server[]
  /** Each TCP listener, as `address:port`. */
  bound: string[]
  /** The addresses alone, for the `Host` allow-list. */
  hosts: string[]
  /** The socket Caddy connects to, where the public listener came up. */
  public: string | null
  /** Why it did not, where a public name is set and it did not. Also a warning. */
  trouble: string | null
}

/** Listen on everything `surface` says, and say what could not be. */
export async function listenAll(
  surface: Surface,
  handle: Handle,
  socket: string,
  warn: (message: string, where: string) => void,
): Promise<Listening> {
  const out: Listening = { servers: [], bound: [], hosts: [], public: null, trouble: null }
  for (const host of listenOn(surface)) {
    const server = serverFor(listenerAt(host), handle)
    const failed = await listening(server, { host, port: surface.port, ipv6Only: host === '::' })
    if (failed !== null) {
      server.close()
      warn(`the away view could not listen on ${host}:${surface.port} — ${failed}`, host)
      continue
    }
    out.servers.push(server)
    // Typed here rather than imported from `node:net`, so that the rule "this
    // package names no `node:net`" holds without an exception somebody has to
    // remember is harmless (`test/separation.test.ts`).
    const at = server.address() as { address: string; port: number } | string | null
    if (at !== null && typeof at !== 'string') {
      out.bound.push(`${at.address}:${at.port}`)
      out.hosts.push(at.address)
    }
  }
  if (surface.publicName !== null) {
    // **Never alone.** The window says whether anything listens by what is
    // bound on this machine, so a public socket up beside nothing would be a
    // panel saying *off* while the internet reaches it. Up beside the loopback
    // listener, or not at all.
    const up =
      out.servers.length === 0
        ? 'nothing listens on this machine, so the public listener does not come up alone'
        : await listenPublic(handle, socket, (said) => warn(said, socket))
    if (typeof up === 'string') {
      out.trouble = up
      warn(up, socket)
    } else {
      out.servers.push(up)
      out.public = socket
    }
  }
  return out
}

/**
 * The public listener, on `socket`, or why not.
 *
 * The directory is checked before anything listens in it, and refused rather
 * than repaired (`publicDirProblem`): it is what decides that Caddy and nobody
 * else can connect. A socket left by a Tade that did not close is taken over,
 * one that something still answers on is not, and anything that is not a
 * socket is never removed.
 */
export async function listenPublic(
  handle: Handle,
  socket: string,
  warn: (said: string) => void,
): Promise<Server | string> {
  const dir = dirname(socket)
  const uid = process.getuid?.() ?? -1
  let seen: DirSeen | null
  try {
    seen = await dirSeen(dir)
  } catch (error) {
    return `${dir} could not be looked at, so nothing listens for Caddy — ${codeOf(error)}`
  }
  const problem = publicDirProblem(seen, uid, dir)
  if (problem !== null) return problem
  const server = serverFor('public', handle)
  readsProxyHeaders(server, warn)
  let failed = await listening(server, { path: socket })
  if (failed === 'EADDRINUSE') {
    const left = await lstat(socket).then(
      (one) => one,
      (error: unknown) => codeOf(error),
    )
    if (typeof left === 'string') {
      return `${socket} is in use and could not be looked at, so nothing listens for Caddy — ${left}`
    }
    if (!left.isSocket() || left.uid !== uid) {
      return `${socket} is there and is not a socket of this user’s, so nothing listens for Caddy`
    }
    if (await answering(socket)) {
      return `something already listens at ${socket} — another Tade? — so this one does not`
    }
    const gone = await unlink(socket).then(
      () => null,
      (error: unknown) => codeOf(error),
    )
    if (gone !== null) {
      return `${socket} was left by a Tade that did not close, and could not be removed — ${gone}`
    }
    failed = await listening(server, { path: socket })
  }
  if (failed !== null) {
    server.close()
    return `the away view could not listen at ${socket} — ${failed}`
  }
  // Caddy has to be able to write to it to connect, and its group is the
  // directory's (setgid). The directory keeps everybody else out.
  const narrowed = await chmod(socket, 0o660).then(
    () => null,
    (error: unknown) => codeOf(error),
  )
  if (narrowed !== null) {
    server.close()
    return `${socket} could not be made Caddy’s group’s to open, so nothing listens there — ${narrowed}`
  }
  return server
}

/**
 * The socket's directory, as `stat` sees it, or null where there is none. Any
 * other failure to look is thrown: a directory that could not be looked at is
 * not one that is not there.
 */
export async function dirSeen(dir: string): Promise<DirSeen | null> {
  try {
    const one = await stat(dir)
    return { directory: one.isDirectory(), uid: one.uid, mode: one.mode }
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null
    throw error
  }
}

/** Listen, and answer with the error's code, or null once listening. */
function listening(
  server: Server,
  at: { host: string; port: number; ipv6Only: boolean } | { path: string },
): Promise<string | null> {
  return new Promise((done) => {
    const failed = (error: unknown) => done(codeOf(error))
    server.once('error', failed)
    server.listen(at, () => {
      server.removeListener('error', failed)
      done(null)
    })
  })
}

/**
 * Whether anything answers on a socket: connecting is enough to say, and
 * nothing is written to it. A second asks no further, because a socket nobody
 * listens on refuses at once.
 */
export function answering(socket: string): Promise<boolean> {
  return new Promise((done) => {
    const asked = request({ socketPath: socket, timeout: 1000 })
    asked.on('socket', (made) => {
      made.once('connect', () => {
        done(true)
        asked.destroy()
      })
    })
    asked.on('timeout', () => asked.destroy())
    asked.on('error', () => done(false))
  })
}
