import type { Server } from 'node:http'
import { type ProxyHeader, readProxyHeader } from './proxy-protocol.ts'

// The public listener's server: an HTTP server like the others, except that
// each connection is first read for a PROXY header (`proxy-protocol.ts`), and
// handed on with the client's address written down beside it.
//
// **The server's own `connection` listener is wrapped, not replaced by a
// second server**, so Node's own bounds — `headersTimeout`, `requestTimeout`,
// the connection tracking `closeAllConnections` walks — are the same ones every
// listener here has. A connection is the HTTP server's from the moment the
// header has been read off it, with whatever came after the header put back in
// front of it.

/** How long a connection may take to say who it is for. The `headersTimeout` it would have had. */
export const HEADER_MS = 10_000

/** The client's address per connection, as the PROXY header gave it. */
const told = new WeakMap<object, string>()

/** The address a PROXY header gave for this connection, if one did. */
export function peerOf(socket: object): string | undefined {
  return told.get(socket)
}

/** What a socket needs to be read here: Node's own, narrowed to what is used. */
interface Socket {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'error' | 'end', listener: () => void): unknown
  removeListener(event: 'data', listener: (chunk: Buffer) => void): unknown
  removeListener(event: 'error' | 'end', listener: () => void): unknown
  unshift(chunk: Buffer): void
  destroy(): void
}

/**
 * Make `server` read a PROXY header off every connection before it reads a
 * request. `tell` is said at most once per kind of trouble, because only Caddy
 * can connect, so a second time is the same Caddy saying the same thing.
 */
export function readsProxyHeaders(server: Server, tell: (said: string) => void): void {
  const http = server.listeners('connection') as ((socket: unknown) => void)[]
  server.removeAllListeners('connection')
  const waiting = new Set<Socket>()
  const said = new Set<string>()
  const once = (kind: string, words: string) => {
    if (said.has(kind)) return
    said.add(kind)
    tell(words)
  }

  server.on('connection', (socket: Socket) => {
    waiting.add(socket)
    let bytes = Buffer.alloc(0)
    const timer = setTimeout(() => drop(), HEADER_MS)
    timer.unref()
    // Only these three are taken off again: a socket has listeners of its own
    // (`end` closes the writing half), and the HTTP server's go on after.
    const stop = () => {
      clearTimeout(timer)
      waiting.delete(socket)
      socket.removeListener('data', read)
      socket.removeListener('end', drop)
      socket.removeListener('error', drop)
    }
    const drop = () => {
      stop()
      socket.destroy()
    }
    const read = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk])
      const header: ProxyHeader = readProxyHeader(bytes)
      if (header.kind === 'more') return
      if (header.kind === 'bad') {
        once('bad', `the public listener closed a connection whose PROXY header was ${header.why}`)
        return drop()
      }
      stop()
      const rest = header.kind === 'header' ? bytes.subarray(header.length) : bytes
      if (header.kind === 'header' && header.from !== null) told.set(socket, header.from)
      if (header.kind === 'none') {
        once(
          'none',
          'Caddy is not sending the PROXY header, so every phone on the public name shares one ' +
            'pairing limit: `tade host caddy` prints the site block with `proxy_protocol v2` in it',
        )
      }
      // Put back before the HTTP server's listeners go on, and read by them
      // before anything that arrives after it: a paused stream's buffer is
      // emitted on the next tick, and a socket's next read is a later turn.
      if (rest.length > 0) socket.unshift(rest)
      for (const listener of http) listener.call(server, socket)
    }
    socket.on('error', drop)
    socket.on('end', drop)
    socket.on('data', read)
  })

  // A connection still saying who it is for is not the HTTP server's yet, so
  // its own `closeAllConnections` cannot see it — and `close` would wait on it
  // for as long as `HEADER_MS`. Closing everything closes these too.
  const all = server.closeAllConnections.bind(server)
  server.closeAllConnections = () => {
    for (const socket of waiting) socket.destroy()
    waiting.clear()
    all()
  }
}
