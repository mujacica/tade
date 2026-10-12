import { request } from 'node:http'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { readAssets } from '../src/assets.ts'
import { encodingFor } from '../src/files.ts'
import { closeAll, start } from './harness.ts'

// What a file costs a phone to fetch: the page's own files, compressed for
// whoever can take them, each encoding its own entity.

afterEach(closeAll)

/** One file's raw bytes and headers, with whatever encoding was asked for. */
function fetched(host: string, path: string, headers: Record<string, string> = {}) {
  const [address, port] = host.split(':')
  return new Promise<{ status: number; headers: Record<string, string>; bytes: Buffer }>(
    (done, failed) => {
      const req = request(
        { host: address, port: Number(port), path, headers: { host, ...headers } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            done({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string>,
              bytes: Buffer.concat(chunks),
            }),
          )
        },
      )
      req.on('error', failed)
      req.end()
    },
  )
}

describe('which encoding a request is answered in', () => {
  const text = { type: 'text/css; charset=utf-8' }
  it('prefers brotli, takes gzip, and honours a weight of nought', () => {
    expect(encodingFor('gzip, deflate, br', text)).toBe('br')
    expect(encodingFor('gzip', text)).toBe('gzip')
    expect(encodingFor('br;q=0, gzip;q=0.5', text)).toBe('gzip')
    expect(encodingFor('*', text)).toBe('br')
    expect(encodingFor('identity', text)).toBeNull()
    expect(encodingFor(null, text)).toBeNull()
  })

  it('never compresses an image, which is compressed already', () => {
    expect(encodingFor('br', { type: 'image/png' })).toBeNull()
  })
})

describe('a file, compressed', () => {
  it('is the same bytes once decoded, smaller on the wire, and says how it varies', async () => {
    const one = await start()
    const raw = (await readAssets()).get('away.css')
    if (raw === undefined) throw new Error('no away.css in the folder')
    const br = await fetched(one.host, '/assets/away.css', { 'accept-encoding': 'br' })
    expect(br.status).toBe(200)
    expect(br.headers['content-encoding']).toBe('br')
    expect(br.headers.vary).toBe('accept-encoding')
    expect(br.bytes.length).toBeLessThan(raw.bytes.length / 2)
    expect(brotliDecompressSync(br.bytes).equals(raw.bytes)).toBe(true)
    const gz = await fetched(one.host, '/assets/away.css', { 'accept-encoding': 'gzip' })
    expect(gunzipSync(gz.bytes).equals(raw.bytes)).toBe(true)
    const plain = await fetched(one.host, '/assets/away.css')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.bytes.equals(raw.bytes)).toBe(true)
  })

  it('answers each encoding’s own validator with a 304, and never another’s', async () => {
    const one = await start()
    const br = await fetched(one.host, '/assets/away.css', { 'accept-encoding': 'br' })
    const plain = await fetched(one.host, '/assets/away.css')
    expect(br.headers.etag).not.toBe(plain.headers.etag)
    const again = await fetched(one.host, '/assets/away.css', {
      'accept-encoding': 'br',
      'if-none-match': br.headers.etag ?? '',
    })
    expect(again.status).toBe(304)
    const crossed = await fetched(one.host, '/assets/away.css', {
      'accept-encoding': 'br',
      'if-none-match': plain.headers.etag ?? '',
    })
    expect(crossed.status).toBe(200)
  })
})
