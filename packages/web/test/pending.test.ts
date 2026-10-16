import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { appendDevice, devicesPath, readDevices, revokeAll } from '../src/devices.ts'
import { PENDING_MS, writeCode } from '../src/pending.ts'
import { GRANTS } from '../src/reach.ts'
import { SCOPES } from '../src/surface.ts'
import { Tickets } from '../src/tickets.ts'
import { type Answer, ask, closeAll, homeFor, type Running, said, start } from './harness.ts'

// A pairing code the terminal wrote (`tade web pair`, REMOTE-TADE.md §11 item
// 3), claimed through a real listener.
//
// The window's ticket has `pairing.test.ts`; this is the one ticket that is on
// a disk, and the questions are the same five — a replay, two requests racing,
// a refusal, a deadline, a crash — plus the one a disk adds: a restart between
// the claim and the device.

afterEach(closeAll)

/** Everything, as `tade web pair` lets a device have unless told otherwise. */
const EVERYTHING = { scopes: [...SCOPES], projects: null, granted: [...GRANTS] }

/** Present a value on the pairing route, as the page does with a link's fragment. */
function claim(one: Running, ticket: string, host = one.host): Promise<Answer> {
  return ask(one, '/api/pair', {
    method: 'POST',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket, label: 'iPhone' }),
  })
}

/** The kinds of the device list's lines, in the order they were written. */
async function kinds(home: string): Promise<string[]> {
  const text = await readFile(devicesPath(home), 'utf8')
  return text
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { kind: string }).kind)
}

describe('a code the terminal wrote', () => {
  it('lets a device in with nobody asked, as the device the code named', async () => {
    const one = await start({ acting: true, talking: true })
    const code = await writeCode(one.home, { host: one.host, label: '', ...EVERYTHING }, Date.now())
    const answer = await claim(one, code.secret)
    expect(answer.status).toBe(201)
    // Running the command was the yes: the window's question is never asked.
    expect(one.asked).toEqual([])
    expect(said(answer).device).toBe(code.device)
    // The burn is written before the device is.
    expect(await kinds(one.home)).toEqual(['pending', 'claimed', 'paired'])
    const { devices, pending } = await readDevices(one.home)
    expect(pending).toEqual([])
    const device = devices.find((d) => d.id === code.device)
    expect(device?.host).toBe(one.host)
    expect(device?.label).toBe('iPhone')
    // Never an owner, whatever it was let have: no request mints one.
    expect(device?.owner).toBe(false)
    const line = one.told.find((told) => told.type === 'web_paired')
    expect(line?.detail).toMatchObject({ device: code.device, code: 'terminal' })

    // And it is a session, on the host it was claimed on.
    const cookie = (answer.headers['set-cookie'] ?? '').split(';')[0] ?? ''
    const read = await ask(one, '/api/snapshot', { headers: { cookie } })
    expect(read.status).toBe(200)
  })

  it('carries the terminal’s name for it and what it was let have', async () => {
    const one = await start({ acting: true })
    const code = await writeCode(
      one.home,
      {
        host: one.host,
        label: 'the kitchen iPad',
        scopes: ['read'],
        projects: ['tade'],
        granted: [],
      },
      Date.now(),
    )
    expect((await claim(one, code.secret)).status).toBe(201)
    const device = (await readDevices(one.home)).devices[0]
    expect(device).toMatchObject({
      label: 'the kitchen iPad',
      scopes: ['read'],
      projects: ['tade'],
    })
  })

  it('is one use: the same code again finds nothing', async () => {
    const one = await start()
    const code = await writeCode(one.home, { host: one.host, label: '', ...EVERYTHING }, Date.now())
    expect((await claim(one, code.secret)).status).toBe(201)
    const again = await claim(one, code.secret)
    expect(again.status).toBe(401)
    expect(said(again).error).toBe('no_session')
    expect((await readDevices(one.home)).devices).toHaveLength(1)
  })

  it('lets exactly one of two racing claims in', async () => {
    const one = await start()
    const code = await writeCode(one.home, { host: one.host, label: '', ...EVERYTHING }, Date.now())
    const answers = await Promise.all([claim(one, code.secret), claim(one, code.secret)])
    expect(answers.map((a) => a.status).sort()).toEqual([201, 401])
    expect((await readDevices(one.home)).devices).toHaveLength(1)
  })

  it('stays spent across a restart, because the burn is on the disk', async () => {
    const home = await homeFor('restart')
    const first = await start({}, { home })
    const code = await writeCode(home, { host: first.host, label: '', ...EVERYTHING }, Date.now())
    expect((await claim(first, code.secret)).status).toBe(201)
    await first.server.close()
    // A new window: a new ticket store, so nothing of the first claim is in
    // memory. What refuses the replay is the `claimed` line.
    const second = await start({}, { home })
    expect((await claim(second, code.secret)).status).toBe(401)
    // Nothing in the file names it any more, so it reads as a guess would.
    expect(second.told.find((t) => t.type === 'web_denied')?.detail).toMatchObject({
      why: 'unknown',
    })
    expect(await kinds(home)).toEqual(['pending', 'claimed', 'paired'])
  })

  it('refuses one past its few minutes, and burns it all the same', async () => {
    const one = await start()
    const code = await writeCode(
      one.home,
      { host: one.host, label: '', ...EVERYTHING },
      Date.now() - PENDING_MS - 1,
    )
    expect((await claim(one, code.secret)).status).toBe(401)
    expect(one.told.find((t) => t.type === 'web_denied')?.detail).toMatchObject({
      why: 'expired',
      code: 'terminal',
    })
    expect(await kinds(one.home)).toEqual(['pending', 'claimed'])
  })

  it('refuses one presented on a host its link did not name, and burns it', async () => {
    const one = await start()
    const code = await writeCode(
      one.home,
      { host: 'studio.yak-bebop.ts.net', label: '', ...EVERYTHING },
      Date.now(),
    )
    expect((await claim(one, code.secret)).status).toBe(401)
    expect(one.told.find((t) => t.type === 'web_denied')?.detail).toMatchObject({
      why: 'elsewhere',
    })
    expect((await readDevices(one.home)).pending).toEqual([])
  })

  it('refuses one revoked before anybody used it', async () => {
    const one = await start()
    const code = await writeCode(one.home, { host: one.host, label: '', ...EVERYTHING }, Date.now())
    await appendDevice(one.home, {
      kind: 'revoked',
      device: code.device,
      at: new Date().toISOString(),
      why: 'revoked at the machine',
    })
    expect((await claim(one, code.secret)).status).toBe(401)
    expect((await readDevices(one.home)).devices).toEqual([])
  })

  it('keeps only the newest code claimable, as the window’s panel does', async () => {
    const one = await start()
    const old = await writeCode(one.home, { host: one.host, label: '', ...EVERYTHING }, Date.now())
    const now = await writeCode(one.home, { host: one.host, label: '', ...EVERYTHING }, Date.now())
    expect((await readDevices(one.home)).pending.map((code) => code.id)).toEqual([now.device])
    expect((await claim(one, old.secret)).status).toBe(401)
    expect((await claim(one, now.secret)).status).toBe(201)
  })

  it('is taken by "disconnect everything", which is one phone short otherwise', async () => {
    const home = await homeFor('everything')
    await writeCode(home, { host: 'localhost:7654', label: '', ...EVERYTHING }, Date.now())
    expect(await revokeAll(home, new Date())).toEqual([])
    expect((await readDevices(home)).pending).toEqual([])
  })

  it('writes the digest of the secret, never the secret', async () => {
    const home = await homeFor('digest')
    const code = await writeCode(
      home,
      { host: 'localhost:7654', label: '', ...EVERYTHING },
      Date.now(),
    )
    const text = await readFile(devicesPath(home), 'utf8')
    expect(text).not.toContain(code.secret)
    expect(code.secret).toMatch(/^[A-Za-z0-9_-]{27}$/)
  })

  it('burns in memory before anything is awaited, so a store says no the second time', () => {
    const tickets = new Tickets()
    expect(tickets.spend('00112233445566aa')).toBe(true)
    expect(tickets.spend('00112233445566aa')).toBe(false)
  })
})
