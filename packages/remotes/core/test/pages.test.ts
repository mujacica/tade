import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { isPage, LinkError, type PagesHere, pagesOver, type Remote } from '../src/index.ts'

// Another machine's connect pages served here (`pages.ts`), against a far end
// that is a plain listener writing down what reached it: what it is handed is
// the whole question — the browser's own `Host` and `Origin`, and none of this
// machine's cookies — and what a browser here is handed back. The conformance
// suite holds every link to the same through a real away view.

const REMOTE: Remote = {
  name: 'vps',
  address: 'vps',
  tade: 'tade',
  session: { device: 'd', cookie: 'd.c', csrf: 'x', host: 'localhost:1' },
}

interface Reached {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
  body: string
}

let far: Server | null = null
let pages: PagesHere | null = null

afterEach(async () => {
  await pages?.close()
  pages = null
  await new Promise<void>((done) => (far === null ? done() : far.close(() => done())))
  far = null
})

/** A far end that answers every request, and what reached it. */
async function farEnd(
  answer: (res: import('node:http').ServerResponse) => void = (res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'tade=theirs; Path=/' })
    res.end('<h1>Connect</h1>')
  },
): Promise<{ reached: Reached[]; dial: () => Promise<Duplex> }> {
  const reached: Reached[] = []
  far = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      reached.push({ method: req.method, url: req.url, headers: req.headers, body })
      answer(res)
    })
  })
  await new Promise<void>((done) => far?.listen(0, '127.0.0.1', done))
  const port = (far.address() as AddressInfo).port
  const dial = () =>
    new Promise<Duplex>((done, failed) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => done(socket))
      socket.once('error', failed)
    })
  return { reached, dial }
}

/** One request to the pages as a browser here makes it, with headers it is free to send. */
function ask(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((done, failed) => {
    const req = request(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', failed)
    req.end(options.body)
  })
}

describe('another machine’s connect pages, served here', () => {
  it('passes the page and a press with the browser’s own Host and Origin, and none of this machine’s cookies', async () => {
    const { reached, dial } = await farEnd()
    pages = await pagesOver(dial, REMOTE)
    const here = new URL(pages.url)
    const page = await ask(pages.url, {
      headers: { cookie: 'tade_session=this-machines-own', authorization: 'Bearer here' },
    })
    expect(page.status).toBe(200)
    expect(page.body).toBe('<h1>Connect</h1>')
    // Nothing that far end says may land on this machine's own away view.
    expect(page.headers['set-cookie']).toBeUndefined()
    const press = await ask(`${here.origin}/connect/slack/keep`, {
      method: 'POST',
      headers: { origin: here.origin, 'content-type': 'application/json', cookie: 'a=b' },
      body: '{"signing_secret":"x"}',
    })
    expect(press.status).toBe(200)
    expect(reached.map((one) => [one.method, one.url, one.body])).toEqual([
      ['GET', '/connect', ''],
      ['POST', '/connect/slack/keep', '{"signing_secret":"x"}'],
    ])
    for (const one of reached) {
      expect(one.headers.host).toBe(here.host)
      expect(one.headers.cookie).toBeUndefined()
      expect(one.headers.authorization).toBeUndefined()
    }
    expect(reached[1]?.headers.origin).toBe(here.origin)
  })

  it('passes a callback with its query, as the source sent the browser back', async () => {
    const { reached, dial } = await farEnd()
    pages = await pagesOver(dial, REMOTE)
    const here = new URL(pages.url).origin
    expect((await ask(`${here}/connect/github/made?code=c0de&state=w0rd`)).status).toBe(200)
    expect(reached.map((one) => one.url)).toEqual(['/connect/github/made?code=c0de&state=w0rd'])
  })

  it('serves nothing else of that machine, which is never asked', async () => {
    const { reached, dial } = await farEnd()
    pages = await pagesOver(dial, REMOTE)
    const here = new URL(pages.url).origin
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/api/snapshot'],
      ['POST', '/api/connect'],
      ['GET', '/connect/../api/snapshot'],
      ['GET', '/connect/%2e%2e/api'],
      ['GET', '/connectx'],
      ['GET', '/connect/slack/keep/more'],
      ['PUT', '/connect/slack/keep'],
      ['DELETE', '/connect'],
    ] as const) {
      const answer = await ask(`${here}${path}`, { method })
      expect(answer.status, `${method} ${path}`).toBe(404)
      expect(answer.body).toContain("only vps's /connect pages")
    }
    expect(reached).toEqual([])
  })

  it('says a far end that is not answering is not, in the link’s own words', async () => {
    pages = await pagesOver(async () => {
      throw new LinkError('failed', 'nothing answers on localhost:1 there: its Tade is not open')
    }, REMOTE)
    const answer = await ask(pages.url)
    expect(answer.status).toBe(502)
    expect(answer.body).toBe('nothing answers on localhost:1 there: its Tade is not open\n')
  })

  it('gives up on a far end that never answers, at its deadline', async () => {
    const { dial } = await farEnd(() => {
      // Heard, and never answered.
    })
    pages = await pagesOver(dial, REMOTE, 200)
    const answer = await ask(pages.url)
    expect(answer.status).toBe(504)
    expect(answer.body).toContain('vps did not answer within 0.2s')
  })

  it('stops listening when closed, with a browser’s kept-alive connection open, and twice is fine', async () => {
    const { dial } = await farEnd()
    pages = await pagesOver(dial, REMOTE)
    const url = pages.url
    await ask(url, { headers: { connection: 'keep-alive' } })
    await pages.close()
    await expect(ask(url)).rejects.toThrow()
    await pages.close()
  })
})

describe('which requests are the pages', () => {
  it('is GET and POST on /connect and a source’s two segments under it, with a query', () => {
    expect(isPage('GET', '/connect')).toBe(true)
    expect(isPage('GET', '/connect?x=1')).toBe(true)
    expect(isPage('POST', '/connect/linear/install')).toBe(true)
    expect(isPage('HEAD', '/connect')).toBe(false)
    expect(isPage(undefined, '/connect')).toBe(false)
    expect(isPage('GET', '/connect/')).toBe(false)
    expect(isPage('GET', '/connect/Slack/keep')).toBe(false)
  })
})
