import { request } from 'node:http'
import { GRANTS, SCOPES, writeCode } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { closeAll, machine } from './away-harness.ts'

// A code `tade web pair` wrote, claimed through the window's own listener
// (REMOTE-TADE.md §11 item 3). Running the command was the yes, so the
// window's question never opens — and the strip is where somebody watching
// this window hears that a device got in.

afterEach(closeAll)

describe('letting a device in with a code the terminal wrote', () => {
  it('asks nobody, says so in the strip, and lists the device now', async () => {
    const one = await machine()
    await one.away.open()
    const host = `localhost:${one.port}`
    const code = await writeCode(
      one.home,
      { host, label: '', scopes: [...SCOPES], projects: null, granted: [...GRANTS] },
      Date.now(),
    )
    expect(await claimOn(one.port, host, code.secret)).toBe(201)
    await until(() => one.away.inputs().devices === 1)
    expect(one.news.join(' ')).toContain(
      `a device paired with a code from \`tade web pair\`: ${code.device}`,
    )
    expect(one.news.join(' ')).not.toContain('wants to pair')
  })
})

/** Present a written code on the window's own listener, as the page would. */
function claimOn(port: number, host: string, ticket: string): Promise<number> {
  const body = JSON.stringify({ ticket, label: 'iPhone' })
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/pair',
        method: 'POST',
        headers: {
          host,
          origin: `http://${host}`,
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          'content-length': String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        res.resume()
        res.on('end', () => done(res.statusCode ?? 0))
      },
    )
    req.on('error', failed)
    req.end(body)
  })
}

/** Wait for something the window does without being awaited, with a deadline. */
async function until(ok: () => boolean, ms = 5_000): Promise<void> {
  const by = Date.now() + ms
  while (!ok()) {
    if (Date.now() > by) throw new Error('it never happened')
    await new Promise((done) => setTimeout(done, 20))
  }
}
