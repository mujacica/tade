import { afterEach, describe, expect, it } from 'vitest'
import { devicesIn, readDevices, writeDevices } from '../src/devices.ts'
import { mintOwner, ownerHost } from '../src/owner.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { ask, closeAll, homeFor, pair, start } from './harness.ts'

// An owner device (`tade web pair --owner`, REMOTE-TADE.md §11 item 4): minted
// by a shell on this machine, bound to it, and usable only through it.
//
// The guard's own cross-product (`guard.test.ts`, "this machine is the
// loopback listener and a loopback Host, both") holds the cell that matters
// most — a session minted for this machine, presented on a public listener, is
// a `403` — so what is here is the owner's own half: what is written, the
// session it is, and that nothing a request can do makes one.

afterEach(closeAll)

describe('an owner device', () => {
  it('is a session for this machine’s own name, written with everything', async () => {
    const home = await homeFor('owner')
    const owner = await mintOwner(
      home,
      { port: 7654, label: 'mac', from: '203.0.113.9' },
      Date.now(),
    )
    expect(owner.host).toBe('localhost:7654')
    expect(owner.cookie.startsWith(`${owner.device}.`)).toBe(true)
    const { devices } = await readDevices(home)
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ id: owner.device, owner: true, host: 'localhost:7654' })
    expect(devices[0]?.projects).toBeNull()
  })

  it('reads and acts on the loopback listener, by the exact host it was minted for', async () => {
    const one = await start({ acting: true })
    const port = Number(one.host.split(':')[1])
    const owner = await mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
    const cookie = `tade_away=${owner.cookie}`
    const read = await ask(one, '/api/snapshot', { headers: { host: owner.host, cookie } })
    expect(read.status).toBe(200)

    // The same machine by another of its names is not the host it was minted
    // for, so it is not a session: a session is bound to its host exactly.
    const elsewhere = await ask(one, '/api/snapshot', { headers: { host: one.host, cookie } })
    expect(elsewhere.status).toBe(401)

    const signedOut = await ask(one, `/api/devices/${owner.device}`, {
      method: 'DELETE',
      headers: {
        host: owner.host,
        origin: `http://${owner.host}`,
        cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: owner.csrf,
      },
    })
    expect(signedOut.status).toBe(200)
  })

  it('is never made by pairing, from the window or from a written code', async () => {
    const one = await start()
    one.answer = async () => ({ let: true, projects: null, granted: [], scopes: ['read'] })
    const paired = await pair(one)
    expect(paired.answer.status).toBe(201)
    const device = (await readDevices(one.home)).devices.find((d) => d.id === paired.device)
    expect(device?.owner).toBe(false)
  })

  it('is an ordinary device where its line names anything but this machine', async () => {
    // A line written by hand for a public name: the record says somebody let
    // it in, and it is not an owner — the local reach must never be reachable
    // from a name the internet can use.
    const home = await homeFor('forged')
    const line = {
      kind: 'paired' as const,
      at: new Date().toISOString(),
      label: 'forged',
      digest: 'a'.repeat(64),
      csrf: 'x'.repeat(43),
      until: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: ['read' as const],
      projects: null,
      granted: [],
      from: '',
      owner: true as const,
    }
    await writeDevices(home, [
      { ...line, device: '00112233445566aa', host: 'tade.example.com' },
      { ...line, device: '00112233445566bb', host: '127.0.0.1:7654' },
      { ...line, device: '00112233445566cc', host: '[::1]:7654' },
    ])
    const { devices } = await readDevices(home)
    expect(devices.map((d) => [d.host, d.owner])).toEqual([
      ['tade.example.com', false],
      ['127.0.0.1:7654', true],
      ['[::1]:7654', true],
    ])
  })

  it('is not an owner where its line does not say so, whatever host it is bound to', () => {
    const { devices } = devicesIn(
      `${JSON.stringify({
        kind: 'paired',
        device: '00112233445566aa',
        at: new Date().toISOString(),
        label: 'phone',
        digest: 'a'.repeat(64),
        host: ownerHost(7654),
        csrf: 'x'.repeat(43),
        until: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: ['read'],
        projects: null,
        granted: [],
        from: '127.0.0.1',
      })}\n`,
    )
    expect(devices[0]?.owner).toBe(false)
  })
})
