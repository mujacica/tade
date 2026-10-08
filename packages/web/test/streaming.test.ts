import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Streams } from '../src/peers.ts'
import type { Delta } from '../src/protocol.ts'
import type { Reach } from '../src/reach.ts'
import { idFor } from '../src/stream.ts'
import { NOW } from './fixtures.ts'
import { ask, closeAll, pair, projectorFor, type Running, said, start } from './harness.ts'

// The stream, over a real socket.
//
// The rules themselves are `stream.test.ts` and `peers.test.ts`, as tables. What
// only a listener can answer is here: that the headers are the ones an
// `EventSource` will accept, that a reopened dead session gets the one status
// that stops a browser retrying, that the guard applies to a connection that
// stays open exactly as it does to one that does not, and that closing the
// window actually reaches a phone.
//
// Loopback and `port: 0` throughout, like the rest of the package: a test that
// bound the LAN would be a listener on whoever's network ran it.

afterEach(async () => {
  await closeAll()
})

/** A live stream, read as it arrives rather than when it ends. */
interface Listening {
  status: number
  headers: Record<string, string>
  /** Every `event:` name seen so far, in order. */
  events(): string[]
  text(): string
  /** Wait until an event of this name has arrived, or give up. */
  until(event: string, most?: number): Promise<void>
  /** Wait until the server ends it. */
  ended(): Promise<void>
  close(): void
}

function listen(
  one: Running,
  path = '/api/stream',
  headers: Record<string, string> = {},
): Promise<Listening> {
  const [address, port] = one.host.split(':')
  return new Promise<Listening>((done, failed) => {
    let got = ''
    let over = false
    const waits: { event: string; done: () => void }[] = []
    let settled: (() => void) | null = null
    const req = request(
      {
        host: address,
        port: Number(port),
        path,
        method: 'GET',
        headers: { host: one.host, 'sec-fetch-site': 'same-origin', ...headers },
      },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          got += chunk
          for (const wait of [...waits]) {
            if (!got.includes(`event: ${wait.event}`)) continue
            waits.splice(waits.indexOf(wait), 1)
            wait.done()
          }
        })
        res.on('end', () => {
          over = true
          settled?.()
        })
        res.on('close', () => {
          over = true
          settled?.()
        })
        done({
          status: res.statusCode ?? 0,
          headers: Object.fromEntries(
            Object.entries(res.headers).map(([name, value]) => [
              name,
              Array.isArray(value) ? value.join(', ') : String(value ?? ''),
            ]),
          ),
          events: () =>
            got
              .split('\n')
              .filter((line) => line.startsWith('event: '))
              .map((line) => line.slice('event: '.length)),
          text: () => got,
          until: (event, most = 2_000) =>
            new Promise<void>((there, not) => {
              if (got.includes(`event: ${event}`)) return there()
              const timer = setTimeout(
                () =>
                  not(new Error(`no ${event} arrived; got ${JSON.stringify(got.slice(0, 400))}`)),
                most,
              )
              waits.push({
                event,
                done: () => {
                  clearTimeout(timer)
                  there()
                },
              })
            }),
          ended: () =>
            new Promise<void>((there) => {
              if (over) return there()
              settled = there
            }),
          close: () => req.destroy(),
        })
      },
    )
    req.on('error', (err) => {
      if (!over) failed(err)
    })
    req.end()
  })
}

/** A device, its cookie, and the streams the server is keeping. */
async function paired(opts: { streams?: Streams } = {}) {
  const one = await start({}, opts)
  const got = await pair(one)
  return { one, cookie: got.cookie, device: got.device, csrf: got.csrf }
}

describe('what an EventSource is served', () => {
  it('opens with the content type and the headers a stream needs', async () => {
    const { one, cookie } = await paired()
    const live = await listen(one, '/api/stream', { cookie })
    expect(live.status).toBe(200)
    expect(live.headers['content-type']).toContain('text/event-stream')
    expect(live.headers['cache-control']).toBe('no-store')
    // The security headers are on this answer too: a refusal, a file, an API
    // answer and a stream all go out through one function.
    expect(live.headers['content-security-policy']).toContain("default-src 'none'")
    expect(live.headers['x-content-type-options']).toBe('nosniff')
    await live.until('snapshot')
    live.close()
  })

  it('stamps the snapshot with the server’s own epoch', async () => {
    // The coupling that would otherwise fail silently: if the projection's
    // epoch and the stream's id epoch were two values, every reconnection
    // would resnapshot — which is *correct*, so nothing would ever go red
    // while a phone downloaded the whole tree every two seconds.
    const { one, cookie } = await paired()
    const live = await listen(one, '/api/stream', { cookie })
    await live.until('snapshot')
    expect(live.text()).toContain(`"epoch":"${one.epoch}"`)
    expect(live.text()).toContain(`id: ${one.epoch}:`)
    live.close()
  })

  it('carries the projection this device was granted and no other', async () => {
    const { one, cookie } = await paired()
    const live = await listen(one, '/api/stream', { cookie })
    await live.until('snapshot')
    // Granted nothing beyond names and counts, so the one note's words are not
    // on the wire while its count is.
    expect(live.text()).not.toContain('the checkout is at')
    expect(live.text()).toContain('"notes"')
    live.close()
  })
})

describe('a session that is not one', () => {
  it('answers 204, because a 401 would make a browser retry for ever', async () => {
    const one = await start()
    const live = await listen(one)
    expect(live.status).toBe(204)
    expect(live.text()).toBe('')
    await live.ended()
  })

  it('answers 204 for a cookie whose device was revoked', async () => {
    const { one, cookie, csrf, device } = await paired()
    const out = await ask(one, `/api/devices/${device}`, {
      method: 'DELETE',
      headers: {
        cookie,
        origin: one.origin,
        'content-type': 'application/json',
        'x-tade-csrf': csrf,
      },
      body: '{}',
    })
    expect(out.status).toBe(200)
    const live = await listen(one, '/api/stream', { cookie })
    expect(live.status).toBe(204)
  })

  it('refuses a Host that is not this listener’s, open answer or not', async () => {
    const { one, cookie } = await paired()
    const live = await listen(one, '/api/stream', { cookie, host: 'evil.invalid' })
    // The rebinding defence applies to the stream like everything else, and a
    // `403` here is right: it is not a session problem, so `204` would tell a
    // browser to stop trying over a host it should simply not use.
    expect(live.status).toBe(403)
    expect(JSON.parse(live.text()).error).toBe('bad_origin')
  })
})

describe('what arrives while it is open', () => {
  it('reaches the socket when the window pushes a delta', async () => {
    const streams = new Streams()
    const { one, cookie, device } = await paired({ streams })
    const live = await listen(one, '/api/stream', { cookie })
    await live.until('snapshot')
    streams.push(device, moved(9), Date.now())
    await live.until('delta')
    expect(live.text()).toContain(`id: ${idFor(epochOf(one), 9)}`)
    live.close()
  })

  it('ends with `revoked` when the device signs itself out', async () => {
    const streams = new Streams()
    const { one, cookie, csrf, device } = await paired({ streams })
    const live = await listen(one, '/api/stream', { cookie })
    await live.until('snapshot')
    await ask(one, `/api/devices/${device}`, {
      method: 'DELETE',
      headers: {
        cookie,
        origin: one.origin,
        'content-type': 'application/json',
        'x-tade-csrf': csrf,
      },
      body: '{}',
    })
    await live.until('revoked')
    await live.ended()
  })

  it('ends with `revoked` when the machine disconnects everything', async () => {
    const streams = new Streams()
    const { one, cookie, device } = await paired({ streams })
    const live = await listen(one, '/api/stream', { cookie })
    await live.until('snapshot')
    streams.revoke(device, 'signed out')
    await live.until('revoked')
    await live.ended()
  })

  it('says Tade is closing, and then closes', async () => {
    const { one, cookie } = await paired()
    const live = await listen(one, '/api/stream', { cookie })
    await live.until('snapshot')
    await one.server.close()
    await live.until('notice')
    expect(live.text()).toContain('Tade is closing')
    await live.ended()
  })

  it('forgets a client that goes away, so nothing is held for it', async () => {
    const { one, cookie } = await paired()
    const live = await listen(one, '/api/stream', { cookie })
    await live.until('snapshot')
    expect(one.server.streams.count).toBe(1)
    live.close()
    await waitUntil(() => one.server.streams.count === 0)
    expect(one.server.streams.listening()).toEqual([])
  })
})

describe('reconnecting', () => {
  it('replays out of the ring rather than resending the projection', async () => {
    const streams = new Streams()
    const { one, cookie, device } = await paired({ streams })
    const first = await listen(one, '/api/stream', { cookie })
    await first.until('snapshot')
    streams.push(device, moved(4), Date.now())
    await first.until('delta')
    first.close()
    await waitUntil(() => streams.count === 0)
    streams.push(device, moved(5), Date.now())

    const back = await listen(one, '/api/stream', {
      cookie,
      'last-event-id': idFor(epochOf(one), 4),
    })
    await back.until('delta')
    expect(back.events()).toEqual(['delta'])
    expect(back.text()).toContain(`id: ${idFor(epochOf(one), 5)}`)
    back.close()
  })

  it('resnapshots once for an epoch that is not this server’s', async () => {
    const { one, cookie } = await paired()
    const back = await listen(one, '/api/stream', {
      cookie,
      'last-event-id': idFor('99999999-0000-4000-8000-000000000000', 400),
    })
    await back.until('snapshot')
    expect(back.events()).toEqual(['snapshot'])
    back.close()
  })
})

describe('both spellings of this machine', () => {
  it('binds two listeners, and a session on one is not a session on the other', async () => {
    // **Two listeners sharing one handler**, never `::` with `ipv6Only: false`
    // — which accepts IPv4-mapped connections on many systems and not all, so
    // which addresses are served would be a property of the machine rather
    // than of the setting (`listenOn`).
    //
    // And the half somebody will call a bug: a device paired on `127.0.0.1`
    // reaching `[::1]` is **not signed in**. That is the honest mitigation for
    // cookies not being isolated by port or spelling (`COOKIES_IGNORE_PORTS`):
    // the session is bound to the exact `Host` it was minted for, so a cookie
    // the browser sent to a different listener on this address is not a
    // session there — and on the stream that is a `204`, which stops a browser
    // retrying rather than making it ask for ever.
    const { one, cookie } = await paired()
    expect(one.server.bound.some((at) => at.startsWith('127.0.0.1'))).toBe(true)
    const six = one.server.bound.find((at) => at.startsWith('::1'))
    if (six === undefined) return
    const port = six.split(':').at(-1) ?? ''
    const over = { host: `[::1]:${port}` }
    const live = await listen(one, '/api/stream', { cookie, ...over })
    expect(live.status).toBe(204)
    // The second listener is plainly up and serving: the shell needs no
    // session, so this is the answer that tells the two apart from a port
    // nothing bound at all.
    const shell = await listen(one, '/', { ...over, 'sec-fetch-site': 'none' })
    expect(shell.status).toBe(200)
  })
})

describe('the caps, on real sockets', () => {
  it('tells a fifth tab of one device why', async () => {
    const { one, cookie } = await paired()
    const held: Listening[] = []
    for (let at = 0; at < 4; at++) {
      const live = await listen(one, '/api/stream', { cookie })
      await live.until('snapshot')
      held.push(live)
    }
    const fifth = await listen(one, '/api/stream', { cookie })
    await fifth.until('too_many')
    await fifth.ended()
    for (const live of held) live.close()
  })

  it('answers 503 with a Retry-After once there are too many altogether', async () => {
    const streams = new Streams({ total: 1, perDevice: 4 })
    const { one, cookie } = await paired({ streams })
    const first = await listen(one, '/api/stream', { cookie })
    await first.until('snapshot')
    const second = await listen(one, '/api/stream', { cookie })
    expect(second.status).toBe(503)
    expect(second.headers['retry-after']).toBe('5')
    expect(JSON.parse(second.text()).error).toBe('busy')
    first.close()
  })
})

describe('what a page refresh costs', () => {
  it('builds no projection for a stream the ring can answer', async () => {
    // The promise that there is no new git or process work per refresh, asked
    // where it can be: the projection is the only thing a read builds, and a
    // reconnection inside the ring builds none of it.
    const streams = new Streams()
    const { one, cookie, device } = await paired({ streams })
    const first = await listen(one, '/api/stream', { cookie })
    await first.until('snapshot')
    first.close()
    await waitUntil(() => streams.count === 0)
    const held = projectorFor(reachFor(device))
    streams.push(device, moved(held.rev + 1), Date.now())
    const before = held.snapshot()
    const back = await listen(one, '/api/stream', {
      cookie,
      'last-event-id': idFor(epochOf(one), held.rev),
    })
    await back.until('delta')
    expect(back.events()).toEqual(['delta'])
    // The very same object: no projection was built to answer this.
    expect(held.snapshot()).toBe(before)
    back.close()
  })

  it('sends a tab that is level with the server nothing at all', async () => {
    const { one, cookie, device } = await paired()
    const held = projectorFor(reachFor(device))
    const back = await listen(one, '/api/stream', {
      cookie,
      'last-event-id': idFor(epochOf(one), held.rev),
    })
    // A beat of the keep-alive rhythm and no frames: a reconnection that
    // missed nothing costs nothing.
    await new Promise((done) => setTimeout(done, 50))
    expect(back.events()).toEqual([])
    back.close()
  })

  it('still answers the plain snapshot route for a page with no stream', async () => {
    const { one, cookie } = await paired()
    const answer = await ask(one, '/api/snapshot', { headers: { cookie } })
    expect(answer.status).toBe(200)
    expect(said(answer).fresh).toBeTruthy()
  })
})

/** A delta at one revision, with one task moved so it is not an empty frame. */
function moved(rev: number): Delta {
  return {
    v: 1,
    rev,
    at: new Date(NOW).toISOString(),
    fresh: null,
    set: { tasks: { 'tade/window': { state: 'blocked' } } },
    del: {},
  }
}

/** The epoch this server's streams are stamping. The server's own. */
function epochOf(one: Running): string {
  return one.epoch
}

/** The reach the server builds a projection for, for one paired device. */
function reachFor(device: string): Reach {
  return { device, projects: { kind: 'every' }, granted: [] }
}

/** Poll a condition, bounded, because a socket closing is another tick away. */
async function waitUntil(there: () => boolean, most = 2_000): Promise<void> {
  const until = Date.now() + most
  while (!there()) {
    if (Date.now() > until) throw new Error('it never happened')
    await new Promise((done) => setTimeout(done, 5))
  }
}
