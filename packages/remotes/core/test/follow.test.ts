import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PROTOCOL_VERSION } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { linkOver } from '../src/links.ts'
import type { Remote, RemoteLink } from '../src/port.ts'

// A remote that breaks in the ways a network does, which a far end that
// behaves never will: a connection cut in the middle of a stream, and in the
// middle of carrying a presence. Node destroys the answer and raises `aborted`
// on it only for a listener, so what reaches the follower is a `close` — and
// what that must come to is a link that is down and keeps what it held, never
// one still called live over a dead socket, and a presence that says it did
// not get there rather than a beat that waits on it.

const EPOCH = '7f3a9c21-0000-4000-8000-000000000000'

const SNAPSHOT = JSON.stringify({
  v: PROTOCOL_VERSION,
  fresh: {
    at: '',
    epoch: EPOCH,
    rev: 1,
    openedAt: '',
    machineUpSince: null,
    spendSince: null,
    warnings: [],
  },
  you: {},
  pages: {},
  projects: [{ name: 'api', title: '', open: true, can: [], cannot: [] }],
  tasks: [],
  queue: [],
  findings: [],
  notes: [],
  plans: [],
  chat: [],
  intake: [],
  sources: [],
  runs: [],
  workflows: [],
})

const REMOTE: Remote = {
  name: 'vps',
  address: 'here',
  tade: 'tade',
  session: { device: 'ab12cd34', cookie: 'ab12cd34.secret', csrf: 'token', host: 'localhost:7654' },
}

const servers: Server[] = []
const links: RemoteLink[] = []

afterEach(async () => {
  await Promise.all(links.map((link) => link.shutdown()))
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
  links.length = 0
  servers.length = 0
})

/** A listener that answers the stream with a snapshot, and then does what `then` says. */
async function remote(then: (res: ServerResponse, path: string) => void): Promise<number> {
  const server = createServer((req, res) => {
    req.socket.on('error', () => {})
    if (req.url === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: snapshot\nid: ${EPOCH}:1\ndata: ${SNAPSHOT}\n\n`)
    }
    then(res, req.url ?? '')
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

function linkTo(port: number): RemoteLink {
  const link = linkOver(
    {
      id: 'test',
      capabilities: { pairs: false, identifies: false, terminals: false },
      programs: [],
      pair: () => Promise.reject(new Error('not here')),
      unpair: () => Promise.reject(new Error('not here')),
      reaching: () => ({ reach: async () => ({ host: '127.0.0.1', port }), drop: async () => {} }),
      connect: () => Promise.reject(new Error('not here')),
    },
    { home: '/nonexistent/home' },
  )
  links.push(link)
  return link
}

async function until(link: RemoteLink, what: string, holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!holds()) {
    if (Date.now() > deadline)
      throw new Error(`waited for ${what}: ${JSON.stringify(link.held('vps')?.link)}`)
    link.beat(Date.now())
    await new Promise((done) => setTimeout(done, 20))
  }
}

describe('a remote whose connection is cut', () => {
  it('in the middle of a stream is a link that is down, holding what it had', async () => {
    let cut = false
    const port = await remote((res, path) => {
      if (path !== '/api/stream' || cut) return
      cut = true
      setTimeout(() => res.socket?.destroy(), 50)
    })
    const link = linkTo(port)
    link.open(REMOTE)
    await until(link, 'the snapshot', () => link.held('vps')?.projection !== null)
    await until(link, 'the link down', () => link.held('vps')?.link.kind === 'down')
    expect(link.held('vps')?.projection?.projects.map((p) => p.name)).toEqual(['api'])
  })

  it('in the middle of carrying a presence is said, and the stream goes on', async () => {
    const port = await remote((res, path) => {
      if (path === '/api/presence') res.socket?.destroy()
    })
    const link = linkTo(port)
    link.open(REMOTE)
    await until(link, 'the link up', () => link.held('vps')?.link.kind === 'live')
    link.present(Date.now() - 1_000)
    await until(link, 'the presence said', () => (link.held('vps')?.presence ?? null) !== null)
    expect(link.held('vps')?.presence).toContain('connection dropped')
    expect(link.held('vps')?.link.kind).toBe('live')
  })
})
