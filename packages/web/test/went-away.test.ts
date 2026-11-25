import { createServer, type IncomingMessage, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { readBody, wentAway } from '../src/request.ts'

// A request whose asker went away mid-body (`wentAway`, `request.ts`): a page
// closed, a phone that lost signal, the other machine's Tade stopping. Node
// rejects the body being read with `aborted`, and the away view used to report
// that as its own trouble (TADE-C). Over a real socket, because what Node
// throws when a client hangs up is the thing being relied on.

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((one) => new Promise((done) => one.close(done))))
})

/** A server that reads one body and hands back what reading it threw, with the request. */
async function reading(): Promise<{
  port: number
  arrived: Promise<void>
  caught: Promise<{ error: unknown; req: IncomingMessage }>
}> {
  let settle: (got: { error: unknown; req: IncomingMessage }) => void = () => {}
  const caught = new Promise<{ error: unknown; req: IncomingMessage }>((done) => {
    settle = done
  })
  let came: () => void = () => {}
  const arrived = new Promise<void>((done) => {
    came = done
  })
  const server = createServer((req, res) => {
    came()
    readBody(req).then(
      () => {
        settle({ error: null, req })
        res.end()
      },
      (error: unknown) => settle({ error, req }),
    )
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { port: (server.address() as AddressInfo).port, arrived, caught }
}

describe('a request whose asker went away', () => {
  it('is told apart when the client hangs up before its body is all there', async () => {
    const { port, arrived, caught } = await reading()
    const asking = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/conversation',
      headers: { 'content-type': 'application/json', 'content-length': '1000' },
    })
    asking.on('error', () => {})
    asking.write('{"from":')
    // Hung up once the server is reading the body, as a closed page does.
    await arrived
    asking.destroy()
    const { error, req } = await caught
    expect(error).toBeInstanceOf(Error)
    expect(wentAway(error, req)).toBe(true)
  })

  it('is not anything else that failed, so real trouble is still said', async () => {
    const { port, caught } = await reading()
    const asking = request({ host: '127.0.0.1', port, method: 'POST', path: '/' })
    asking.end('{}')
    const { req } = await caught
    // The socket is still there: an `aborted` from something a route asked
    // of another machine is that route's trouble, not a client gone.
    const reset = Object.assign(new Error('aborted'), { code: 'ECONNRESET' })
    expect(wentAway(reset, req)).toBe(false)
    req.socket.destroy()
    expect(wentAway(new Error('something broke'), req)).toBe(false)
    expect(wentAway(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), req)).toBe(
      false,
    )
    expect(wentAway('aborted', req)).toBe(false)
    expect(wentAway(reset, req)).toBe(true)
  })
})
