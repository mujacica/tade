import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { saidOf } from './call.ts'
import { LinkError, type PagesHere, type Remote } from './port.ts'

// Another machine's guided pages that connect a source (`/connect`, `@tade/web`'s
// `connected.ts`), served on this machine's loopback while a browser here uses
// them (`RemoteLink.pages`): the one step that was an `ssh -L` somebody had to
// write by hand, knowing that machine's port.
//
// **Why a browser here needs them at all.** What a source's own page shows the
// person — Slack's signing secret, its client's id and secret, Linear's webhook
// secret — is pasted into that machine's own page and never carried there by
// an owner's ask (`OwnerAskSchema`), and the link ends in a stream no browser
// opens. So what reaches that machine from here is exactly what an `ssh -L` to
// its loopback listener carries, and its guard answers it as one: its loopback
// listener, a loopback `Host`, an `Origin` that is that `Host` (`thisMachine`).
//
// **Narrower than the forward it replaces.** Only `/connect` and the paths
// under it, and only `GET` and `POST`: nothing else of its away view, whose
// owner routes a browser here has no session for anyway. No cookie goes and
// none comes back, because a browser's cookies for a loopback host are every
// port's, so they are this machine's own away view's. A stream per request
// (`Transport.connect`), so no link need be held and none is disturbed, each
// with a deadline; and it listens only while somebody holds it open — `tade
// remote connect`, until ctrl+c.
//
// **Still a port on loopback**, which every account on this machine reaches
// while it is open, as it would the forward. What that reaches there is what
// that machine's own door is (`CONNECT_IS_HERE`): an app made or replaced, a
// secret kept, and nothing that grants anybody anything.

/** How long one request to the pages may take, there and back. */
export const PAGE_MS = 30_000

/** The paths passed on: `/connect`, and a source's press or callback under it. */
const PAGE_PATH = /^\/connect(?:\/[a-z0-9-]{1,40}){0,2}$/

/** Not passed on either way: hop-by-hop, and what is this machine's own. */
const NOT_THERE = new Set([
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cookie',
  'authorization',
])
const NOT_BACK = new Set([
  'connection',
  'keep-alive',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
])

/** Whether a request is one of the pages: a `GET` or a `POST` on one of their paths. */
export function isPage(method: string | undefined, url: string): boolean {
  if (method !== 'GET' && method !== 'POST') return false
  return PAGE_PATH.test(url.split('?')[0] ?? '')
}

/** That machine's pages served here, over `connect`'s stream per request, until closed. */
export function pagesOver(
  connect: () => Promise<Duplex>,
  remote: Remote,
  ms: number = PAGE_MS,
): Promise<PagesHere> {
  const server = createServer((req, res) => {
    void pass(connect, remote, req, res, ms)
  })
  return new Promise((done, failed) => {
    server.once('error', (err) => {
      failed(
        new LinkError(
          'failed',
          `nothing could listen here for ${remote.name}'s pages: ${err.message}`,
        ),
      )
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      done({ url: `http://127.0.0.1:${port}/connect`, close: () => closed(server) })
    })
  })
}

async function pass(
  connect: () => Promise<Duplex>,
  remote: Remote,
  req: IncomingMessage,
  res: ServerResponse,
  ms: number,
): Promise<void> {
  const path = req.url ?? ''
  if (!isPage(req.method, path)) {
    say(res, 404, `only ${remote.name}'s /connect pages are served here`)
    req.resume()
    return
  }
  let stream: Duplex | null = null
  const timer = setTimeout(() => {
    say(res, 504, `${remote.name} did not answer within ${ms / 1000}s`)
    stream?.destroy()
  }, ms)
  res.on('close', () => {
    clearTimeout(timer)
    stream?.destroy()
  })
  try {
    stream = await connect()
  } catch (err) {
    say(res, 502, err instanceof LinkError ? err.message : saidOf(err, remote))
    return
  }
  if (res.writableEnded || res.destroyed) {
    stream.destroy()
    return
  }
  const opened = stream
  const out = request(
    {
      createConnection: () => opened as never,
      method: req.method,
      path,
      // The browser's own `Host` and `Origin`, which are this door's: that
      // machine answers them as its own loopback door, and mints a callback's
      // word for this one.
      headers: { ...only(req.headers, NOT_THERE), connection: 'close' },
    },
    (back) => {
      if (res.headersSent) {
        back.resume()
        return
      }
      res.writeHead(back.statusCode ?? 502, only(back.headers, NOT_BACK))
      back.on('error', () => res.destroy())
      back.pipe(res)
    },
  )
  out.on('error', (err) => say(res, 502, saidOf(err, remote)))
  req.pipe(out)
}

/** The headers but those named. */
function only(headers: IncomingHttpHeaders, dropped: ReadonlySet<string>): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => value !== undefined && !dropped.has(name)),
  )
}

/** A sentence for the browser, where nothing else has been sent yet. */
function say(res: ServerResponse, status: number, said: string): void {
  if (res.writableEnded || res.destroyed) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(`${said}\n`)
}

/** Stop listening, and end what is open, rather than waiting on a browser's kept-alive one. */
function closed(server: Server): Promise<void> {
  return new Promise((done) => {
    if (!server.listening) {
      done()
      return
    }
    server.close(() => done())
    server.closeAllConnections()
  })
}
