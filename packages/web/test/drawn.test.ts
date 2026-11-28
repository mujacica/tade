import { createHash } from 'node:crypto'
import { createServer, get, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { Drawing, Drawn } from '../src/drawing.ts'
import { type DrawingDoor, drawingDoor } from '../src/drawn.ts'

// What `/draw` answers, over a real listener: the document, the map, each
// module immutable under its version, and a build made the first time it is
// asked for and made again after one that failed.

const CODE = Buffer.from(`export const drawn = '${'the window, drawn '.repeat(40)}'\n`)
const MODULE: Drawn = {
  path: 'pkg/view.js',
  file: '/nowhere/view.ts',
  bytes: CODE,
  type: 'text/javascript; charset=utf-8',
  etag: `"${createHash('sha256').update(CODE).digest('base64url').slice(0, 27)}"`,
}
const DRAWING: Drawing = {
  version: 'v1a2b3',
  files: new Map([[MODULE.path, MODULE]]),
  importMap: { imports: { view: '/draw/v1a2b3/pkg/view.js' } },
  roots: ['/draw/v1a2b3/pkg/view.js'],
  imports: new Map(),
}

interface Got {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((one) => new Promise((done) => one.close(done))))
})

/** The door behind a listener that says 404 where it answered false and 500 where it threw. */
async function serve(
  door: DrawingDoor,
): Promise<(path: string, headers?: Record<string, string>) => Promise<Got>> {
  const server = createServer((req, res) => {
    const rest = (req.url ?? '').slice('/draw/'.length)
    door.answer(req, res, rest).then(
      (answered) => {
        if (!answered) res.writeHead(404).end()
      },
      (problem: unknown) => res.writeHead(500).end(String((problem as Error).message)),
    )
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  // node:http rather than fetch, which would undo the encoding this is about.
  return (path, headers = {}) =>
    new Promise((done, failed) => {
      get({ host: '127.0.0.1', port, path, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        )
      }).on('error', failed)
    })
}

describe('the drawing door', () => {
  it('answers the document with the map inline and a policy that allows exactly it', async () => {
    const ask = await serve(drawingDoor(async () => DRAWING))
    const got = await ask('/draw/')
    expect(got.status).toBe(200)
    expect(got.headers['content-type']).toBe('text/html; charset=utf-8')
    const map = JSON.stringify(DRAWING.importMap)
    expect(got.body.toString()).toContain(`<script type="importmap">${map}</script>`)
    expect(got.body.toString()).toContain(
      '<meta name="tade-drawing" content="/draw/v1a2b3/pkg/view.js">',
    )
    const hash = createHash('sha256').update(map).digest('base64')
    expect(got.headers['content-security-policy']).toContain(`script-src 'self' 'sha256-${hash}'`)
    expect(got.headers['content-length']).toBe(String(got.body.length))
  })

  it('builds once for every ask, and again on the ask after a build that failed', async () => {
    let builds = 0
    const ask = await serve(
      drawingDoor(async () => {
        builds++
        if (builds === 1) throw new Error('the drawing could not be read')
        return DRAWING
      }),
    )
    const failed = await ask('/draw/')
    expect(failed.status).toBe(500)
    expect(failed.body.toString()).toBe('the drawing could not be read')
    expect((await ask('/draw/')).status).toBe(200)
    expect((await ask('/draw/v1a2b3/importmap.json')).status).toBe(200)
    expect(builds).toBe(2)
  })

  it('answers the map under its version, kept for good', async () => {
    const ask = await serve(drawingDoor(async () => DRAWING))
    const got = await ask('/draw/v1a2b3/importmap.json')
    expect(got.status).toBe(200)
    expect(JSON.parse(got.body.toString())).toEqual(DRAWING.importMap)
    expect(got.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(got.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('answers a module in the encoding asked for, immutable, and a 304 where it is already had', async () => {
    const ask = await serve(drawingDoor(async () => DRAWING))
    const br = await ask('/draw/v1a2b3/pkg/view.js', { 'accept-encoding': 'gzip, br' })
    expect(br.status).toBe(200)
    expect(br.headers['content-encoding']).toBe('br')
    expect(brotliDecompressSync(br.body)).toEqual(CODE)
    expect(br.body.length).toBeLessThan(CODE.length)
    expect(br.headers['content-length']).toBe(String(br.body.length))
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(br.headers.vary).toBe('accept-encoding')
    // Another encoding is another entity, with a validator of its own.
    expect(br.headers.etag).toBe(`${MODULE.etag.slice(0, -1)}-br"`)

    const gz = await ask('/draw/v1a2b3/pkg/view.js', { 'accept-encoding': 'gzip' })
    expect(gz.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(gz.body)).toEqual(CODE)

    const plain = await ask('/draw/v1a2b3/pkg/view.js')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body).toEqual(CODE)
    expect(plain.headers.etag).toBe(MODULE.etag)

    const had = await ask('/draw/v1a2b3/pkg/view.js', { 'if-none-match': MODULE.etag })
    expect(had.status).toBe(304)
    expect(had.body.length).toBe(0)
    expect(had.headers.etag).toBe(MODULE.etag)
  })

  it('has no such file under another version, a path it did not build, or no version at all', async () => {
    const ask = await serve(drawingDoor(async () => DRAWING))
    expect((await ask('/draw/v0ld/pkg/view.js')).status).toBe(404)
    expect((await ask('/draw/v1a2b3/pkg/other.js')).status).toBe(404)
    expect((await ask('/draw/importmap.json')).status).toBe(404)
  })
})
