import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer as tcp } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as tls } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lookAtCertificate } from '../src/certificate.ts'

// The look a phone's handshake would make, against a real TLS server on this
// machine with a certificate `openssl` makes for the run — so no key is ever
// in the repository, and the dates are the ones the certificate says.

const DAY = 86_400_000
const closing: (() => void)[] = []
let key = ''
let cert = ''

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tade-cert-'))
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '30',
      '-subj',
      '/O=Tade Test/CN=tade.test',
    ],
    { stdio: 'ignore' },
  )
  key = await readFile(join(dir, 'key.pem'), 'utf8')
  cert = await readFile(join(dir, 'cert.pem'), 'utf8')
})

afterAll(() => {
  for (const close of closing) close()
})

/** A server on loopback, and the port it got. */
async function serving(server: ReturnType<typeof tls> | ReturnType<typeof tcp>): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  closing.push(() => server.close())
  return (server.address() as { port: number }).port
}

describe('a look at the certificate a name answers with', () => {
  it('reads its dates and issuer, and says it does not verify rather than refusing it', async () => {
    const port = await serving(tls({ key, cert }, (socket) => socket.end()))
    const before = Date.now()
    const look = await lookAtCertificate('tade.test', { host: '127.0.0.1', port })
    expect('seen' in look).toBe(true)
    if (!('seen' in look)) return
    expect(look.seen.issuer).toBe('Tade Test')
    expect(look.seen.authorized).toBe(false)
    expect(look.seen.error).toMatch(/SELF_SIGNED/)
    // Thirty days, to the second the certificate was made in.
    expect(look.seen.validTo - look.seen.validFrom).toBe(30 * DAY)
    expect(Math.abs(look.seen.validFrom - before)).toBeLessThan(60_000)
    expect(look.at).toBeGreaterThanOrEqual(before)
  })

  it('says it could not look where nothing answers, in the error’s own code', async () => {
    const server = tcp()
    const port = await serving(server)
    await new Promise<void>((done) => server.close(() => done()))
    const look = await lookAtCertificate('tade.test', { host: '127.0.0.1', port })
    expect(look).toMatchObject({ cannot: 'ECONNREFUSED' })
  })

  it('says it could not look where something answers and never speaks TLS, by its deadline', async () => {
    const held: { destroy(): void }[] = []
    const port = await serving(tcp((socket) => held.push(socket)))
    closing.push(() => {
      for (const one of held) one.destroy()
    })
    const look = await lookAtCertificate('tade.test', { host: '127.0.0.1', port, ms: 200 })
    expect(look).toMatchObject({ cannot: 'no answer in 0.2 s' })
  })
})
