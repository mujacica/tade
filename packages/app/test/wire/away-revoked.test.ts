import { request } from 'node:http'
import { appendDevice, type Device } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { lostSessions } from '../../src/wire/web-sessions.ts'
import { COOKIE, closeAll, DEVICE, type Machine, machine, paired, waitFor } from './away-harness.ts'

// What revoking a device at the machine does to a page that is already open.
//
// **The claim this file holds is the one `tade web revoke` prints**: *its
// credential is no longer a session, and any open page stops within a beat*.
// Two halves, and they are answered by two different things:
//
// 1. Every **request** is refused, which the listener does on its own: it
//    reads `web-devices.jsonl` per request, so a line the terminal appended a
//    moment ago is read by the next `/api/snapshot`.
// 2. Every **open stream** ends. That one is the window's, and it is the half
//    that cannot be answered by reading a file at a request — an `EventSource`
//    makes no further request, so nothing would ever re-ask. A session lasts
//    thirty days, so a stream nothing closed is thirty days of the projection
//    still leaving this machine for a credential somebody revoked.
//
// **Revoked by another process**, which is the case that matters and is not
// the window's own control: `tade web revoke` and `tade web off` append to the
// device list without the window being open, by design, because disconnecting
// a phone you have lost must not depend on Tade running. When a window *is*
// open, it is the thing holding the socket.

afterEach(closeAll)

/** A machine with a device paired and the listener up. */
async function ready(): Promise<Machine> {
  const one = await machine()
  await paired(one.home, one.port, ['read'])
  await one.away.open()
  return one
}

/** What `tade web revoke <device>` appends, written by something that is not the window. */
function revokeOutside(home: string): Promise<void> {
  return appendDevice(home, {
    kind: 'revoked',
    device: DEVICE,
    at: new Date().toISOString(),
    why: 'revoked at the machine',
  })
}

/** One `GET`, with everything the guard asks of a read on it. */
function get(port: number, path: string): Promise<{ status: number; text: string }> {
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          host: `127.0.0.1:${port}`,
          cookie: COOKIE,
          'sec-fetch-site': 'same-origin',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', failed)
    req.end()
  })
}

/** An open stream, and everything it has been sent so far. */
interface Listening {
  /** Every byte the server has written to this stream. */
  text(): string
  /** Whether the server has closed it. */
  ended(): boolean
  close(): void
}

/**
 * A stream held open, the way a phone holds one.
 *
 * Not `fetch`, for the harness's own reason — and because what this test is
 * about is a socket that stays open and makes no second request.
 */
async function listen(port: number): Promise<Listening> {
  return new Promise((done, failed) => {
    let said = ''
    let over = false
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/stream',
        method: 'GET',
        headers: {
          host: `127.0.0.1:${port}`,
          cookie: COOKIE,
          accept: 'text/event-stream',
          'sec-fetch-site': 'same-origin',
        },
      },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          said += chunk.toString('utf8')
        })
        res.on('end', () => {
          over = true
        })
        done({
          text: () => said,
          ended: () => over,
          close: () => req.destroy(),
        })
      },
    )
    req.on('error', failed)
    req.end()
  })
}

/** Let the event loop deliver whatever the server has written. */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 30))
}

describe('a device revoked somewhere other than the window', () => {
  it('is refused at every request, because the listener reads the file at one', async () => {
    const one = await ready()
    expect((await get(one.port, '/api/snapshot')).status).toBe(200)

    await revokeOutside(one.home)

    const after = await get(one.port, '/api/snapshot')
    expect(after.status).toBe(401)
  })

  it('has its open stream closed, and is told why', async () => {
    const one = await ready()
    const held = await listen(one.port)
    await settle()
    // The stream is live: a change to the world reaches it.
    one.running(one.task)
    await one.refresh()
    await settle()
    expect(held.text()).toContain('event: delta')

    await revokeOutside(one.home)
    // One beat, which is what the terminal's own sentence promises.
    await one.refresh()
    await settle()

    expect(held.text()).toContain('event: revoked')
    expect(held.ended()).toBe(true)
    held.close()
  })

  it('is sent nothing more of the projection after that beat', async () => {
    const one = await ready()
    const held = await listen(one.port)
    await settle()
    one.running(one.task)
    await one.refresh()
    await settle()

    await revokeOutside(one.home)
    await one.refresh()
    await settle()
    const closed = held.text()

    // Whatever else happens in the world, nothing of it reaches this socket —
    // asked of what came **after** the refusal rather than of what came after
    // a moment the test chose, which is the half a sleep can get wrong.
    one.checked(one.task, 'fail')
    await one.refresh()
    await settle()
    expect(held.text()).toBe(closed)
    const after = closed.slice(closed.indexOf('event: revoked'))
    expect(after).not.toContain('event: delta')
    held.close()
  })

  it('is written down, so the journal says the stream was closed', async () => {
    const one = await ready()
    const held = await listen(one.port)
    await settle()
    await revokeOutside(one.home)
    await one.refresh()
    await settle()
    const said = await waitFor(one.client, 'web_revoked')
    expect(said.length).toBeGreaterThan(0)
    held.close()
  })
})

describe('which of the devices listening no longer holds a session', () => {
  const one = (over: Partial<Device> = {}): Device =>
    ({
      id: 'aa',
      label: 'iPhone',
      pairedAt: '2026-10-09T00:00:00.000Z',
      digest: 'x',
      host: '127.0.0.1:1',
      csrf: 'y',
      until: '2026-11-09T00:00:00.000Z',
      scopes: ['read'],
      projects: null,
      granted: [],
      from: '127.0.0.1',
      revoked: null,
      ...over,
    }) as unknown as Device

  it('names nobody while every one of them is still paired', () => {
    expect(lostSessions(['aa'], [one()])).toEqual([])
  })

  it('carries the file’s own reason for a revoked one, rather than a word of its own', () => {
    // The three the file can say are a person's choices — signed out, revoked
    // at the machine, everything disconnected — and the page is told which.
    expect(lostSessions(['aa'], [one({ revoked: 'everything disconnected' })])).toEqual([
      { device: 'aa', why: 'everything disconnected' },
    ])
  })

  it('lets go of one the list does not have, which is a `401` at every request', () => {
    expect(lostSessions(['aa'], [])).toEqual([
      { device: 'aa', why: 'no session at this machine any more' },
    ])
  })

  it('leaves the others alone, so one revocation is one stream', () => {
    const gone = lostSessions(['aa', 'bb'], [one(), one({ id: 'bb', revoked: 'signed out' })])
    expect(gone).toEqual([{ device: 'bb', why: 'signed out' }])
  })
})
