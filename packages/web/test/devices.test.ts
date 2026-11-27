import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendDevice,
  DEVICES_FILE,
  devicesIn,
  devicesPath,
  nameDevice,
  readDevices,
  revokeAll,
  writeDevices,
} from '../src/devices.ts'
import { mint, SESSION_MS } from '../src/sessions.ts'
import { DEVICES_AND_AGENTS, DEVICES_SEEN_BY_AGENTS } from '../src/surface.ts'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const HOUR = 3_600_000
const homes: string[] = []

async function home(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'tade-devices-'))
  homes.push(made)
  return made
}

afterEach(() => {
  homes.length = 0
})

function pairedLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  const minted = mint()
  return {
    kind: 'paired',
    device: minted.device,
    at: new Date(NOW).toISOString(),
    label: 'iPhone',
    digest: minted.digest,
    host: '192.168.1.10:7654',
    csrf: minted.csrf,
    until: new Date(NOW + SESSION_MS).toISOString(),
    from: '192.168.1.42',
    ...over,
  }
}

describe('the file', () => {
  it('is under the home and never inside a project', async () => {
    const at = await home()
    expect(devicesPath(at)).toBe(join(at, DEVICES_FILE))
    expect(devicesPath(at)).not.toContain('.tade/projects')
  })

  it('is 0600 from the moment it exists', async () => {
    const at = await home()
    await appendDevice(at, pairedLine() as never)
    const mode = (await stat(devicesPath(at))).mode & 0o777
    // Created with the mode rather than created and then narrowed: the gap
    // between the two is a window in which the digests are world-readable.
    expect(mode.toString(8)).toBe('600')
  })

  it('narrows the mode again on every write, not only at creation', async () => {
    const at = await home()
    await appendDevice(at, pairedLine() as never)
    await writeFile(devicesPath(at), await readFile(devicesPath(at)), { mode: 0o644 })
    await appendDevice(at, pairedLine() as never)
    expect(((await stat(devicesPath(at))).mode & 0o777).toString(8)).toBe('600')
  })

  it('is no devices at all where there is no file', async () => {
    expect(await readDevices(await home())).toEqual({ devices: [], skipped: 0, pending: [] })
  })

  it('appends rather than rewriting, so the file is the record', async () => {
    const at = await home()
    const one = pairedLine()
    await appendDevice(at, one as never)
    await appendDevice(at, {
      kind: 'revoked',
      device: one.device as string,
      at: new Date(NOW + 1).toISOString(),
      why: 'signed out',
    })
    const lines = (await readFile(devicesPath(at), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}').kind).toBe('paired')
  })
})

describe('the fold', () => {
  it('reads a paired device', () => {
    const { devices, skipped } = devicesIn(`${JSON.stringify(pairedLine())}\n`)
    expect(skipped).toBe(0)
    expect(devices).toHaveLength(1)
    expect(devices[0]?.label).toBe('iPhone')
    expect(devices[0]?.revoked).toBeNull()
  })

  it('skips a bad line rather than throwing it over', () => {
    // A file one truncated write has damaged must still be the list of your
    // other devices. The alternative is a window that will not open because
    // of a half-written line about a phone somebody sold.
    const text = [
      JSON.stringify(pairedLine()),
      'not json at all',
      '{"kind":"paired"}',
      '{"kind":"nothing-of-the-sort","device":"0011223344556677"}',
      // A row of another kind: a machine credential is not a device, and the
      // strict schema is what keeps this file holding one kind of thing.
      '{"kind":"paired","device":"0011223344556677","token":"sk-live-whatever"}',
      '',
      JSON.stringify(pairedLine()),
    ].join('\n')
    const { devices, skipped } = devicesIn(text)
    expect(devices).toHaveLength(2)
    expect(skipped).toBe(4)
  })

  it('refuses a device id that is not one, so nothing builds a path from it', () => {
    for (const device of ['../../etc/passwd', '', 'NOTHEX0123456789', 'a'.repeat(17)]) {
      const { devices, skipped } = devicesIn(`${JSON.stringify(pairedLine({ device }))}\n`)
      expect(devices, device).toHaveLength(0)
      expect(skipped, device).toBe(1)
    }
  })

  it('bounds a label, which is text a phone claimed', () => {
    const { skipped } = devicesIn(`${JSON.stringify(pairedLine({ label: 'x'.repeat(121) }))}\n`)
    expect(skipped).toBe(1)
  })

  it('ends a device on a revoked line, and says why', () => {
    const one = pairedLine()
    const text = [
      JSON.stringify(one),
      JSON.stringify({
        kind: 'revoked',
        device: one.device,
        at: new Date(NOW + 1).toISOString(),
        why: 'revoked at the machine',
      }),
    ].join('\n')
    expect(devicesIn(text).devices[0]?.revoked).toBe('revoked at the machine')
  })

  it('moves an expiry on a renewed line, and nothing else', () => {
    const one = pairedLine()
    const later = new Date(NOW + SESSION_MS * 2).toISOString()
    const text = [
      JSON.stringify(one),
      JSON.stringify({
        kind: 'renewed',
        device: one.device,
        at: new Date(NOW + 1).toISOString(),
        until: later,
      }),
    ].join('\n')
    const found = devicesIn(text).devices[0]
    expect(found?.until).toBe(Date.parse(later))
    expect(found?.digest).toBe(one.digest)
    expect(found?.revoked).toBeNull()
  })

  it('renames a device on a named line, in a label’s grammar, and nothing else', () => {
    const one = pairedLine({ label: 'LAPTOP-A1B2C3' })
    const named = { kind: 'named', device: one.device, at: new Date(NOW + 1).toISOString() }
    const text = [JSON.stringify(one), JSON.stringify({ ...named, label: 'laptop' })].join('\n')
    const found = devicesIn(text).devices[0]
    expect(found?.label).toBe('laptop')
    expect(found?.digest).toBe(one.digest)
    expect(found?.until).toBe(Date.parse(String(one.until)))
    // A name that is not a label's is skipped, and the device keeps the one it had.
    for (const label of ['', 'x'.repeat(61), 'mac\u202e', '<b>mac</b>', 'a/b']) {
      const read = devicesIn([JSON.stringify(one), JSON.stringify({ ...named, label })].join('\n'))
      expect(read.skipped, label).toBe(1)
      expect(read.devices[0]?.label).toBe('LAPTOP-A1B2C3')
    }
  })

  it('writes a new name down only where it is not the one the list has', async () => {
    const dir = await home()
    const one = pairedLine({ label: 'LAPTOP-A1B2C3' })
    await writeDevices(dir, [one as never])
    const [device] = (await readDevices(dir)).devices
    if (device === undefined) throw new Error('no device')
    expect(await nameDevice(dir, device, 'laptop', new Date(NOW))).toBe(true)
    const [renamed] = (await readDevices(dir)).devices
    expect(renamed?.label).toBe('laptop')
    if (renamed === undefined) throw new Error('no device')
    expect(await nameDevice(dir, renamed, 'laptop', new Date(NOW))).toBe(false)
    const lines = (await readFile(devicesPath(dir), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    // Pairing again is a new label, whatever the device called itself since.
    await appendDevice(dir, { ...one, label: 'studio' } as never)
    expect((await readDevices(dir)).devices[0]?.label).toBe('studio')
  })

  it('ignores a revoked line for a device nothing introduced', () => {
    // It parsed and says something true; there is just nothing to disconnect.
    // Not a skip, and not a device.
    const text = JSON.stringify({
      kind: 'revoked',
      device: '0011223344556677',
      at: new Date(NOW).toISOString(),
      why: 'signed out',
    })
    expect(devicesIn(text)).toEqual({ devices: [], skipped: 0, pending: [] })
  })

  it('lets pairing the same phone again replace the old credential', () => {
    const first = pairedLine()
    const second = pairedLine({ device: first.device, label: 'iPhone again' })
    const { devices } = devicesIn(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
    expect(devices).toHaveLength(1)
    expect(devices[0]?.label).toBe('iPhone again')
    // The old secret is then unusable, which is the whole point of replacing
    // rather than keeping two rows for one phone.
    expect(devices[0]?.digest).not.toBe(first.digest)
  })
})

describe('a passkey, in the file', () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString()
  const passkeyLine = (device: string, over: Record<string, unknown> = {}) => ({
    kind: 'passkey',
    device,
    at: at(60_000),
    id: 'a'.repeat(43),
    key: 'b'.repeat(120),
    alg: -7,
    counter: 0,
    synced: true,
    transports: ['internal'],
    ...over,
  })
  const fold = (...lines: unknown[]) =>
    devicesIn(lines.map((line) => `${JSON.stringify(line)}\n`).join(''))

  it('is no passkey for a device that made none', () => {
    expect(fold(pairedLine()).devices[0]?.passkey).toBeNull()
  })

  it('is the one it made, proved at the moment it was made', () => {
    const paired = pairedLine()
    const device = String(paired.device)
    const passkey = fold(paired, passkeyLine(device)).devices[0]?.passkey
    expect(passkey).toMatchObject({ alg: -7, synced: true, counter: 0, transports: ['internal'] })
    expect(passkey?.proved).toBe(NOW + 60_000)
    expect(passkey?.at).toBe(NOW + 60_000)
  })

  it('moves its proof and its counter on a proved line, and nothing else', () => {
    const paired = pairedLine()
    const device = String(paired.device)
    const proved = { kind: 'proved', device, at: at(HOUR), counter: 3 }
    const after = fold(paired, passkeyLine(device), proved).devices[0]?.passkey
    expect(after).toMatchObject({ proved: NOW + HOUR, counter: 3, at: NOW + 60_000 })
  })

  it('proves nothing for a device with no passkey, and makes none for a device nobody paired', () => {
    const paired = pairedLine()
    const device = String(paired.device)
    const lone = fold(paired, { kind: 'proved', device, at: at(HOUR), counter: 0 })
    expect(lone.devices[0]?.passkey).toBeNull()
    expect(lone.skipped).toBe(0)
    const nobody = fold(passkeyLine('ffeeddccbbaa9988'))
    expect(nobody.devices).toEqual([])
    expect(nobody.skipped).toBe(0)
  })

  it('skips a line whose key is not base64url or whose kind of key Tade never asked for', () => {
    const paired = pairedLine()
    const device = String(paired.device)
    expect(fold(paired, passkeyLine(device, { key: 'not base64url!' })).skipped).toBe(1)
    expect(fold(paired, passkeyLine(device, { alg: -35 })).skipped).toBe(1)
    expect(fold(paired, passkeyLine(device, { secret: 'x' })).skipped).toBe(1)
  })

  it('is gone with a device that pairs again, which is a new device with none', () => {
    const paired = pairedLine()
    const device = String(paired.device)
    const again = { ...pairedLine(), device }
    expect(fold(paired, passkeyLine(device), again).devices[0]?.passkey).toBeNull()
  })
})

describe('every paired device is the person’s own', () => {
  it('reads a line with nothing about what it may do as a device that may do everything', () => {
    const { devices, skipped } = devicesIn(`${JSON.stringify(pairedLine())}\n`)
    expect(skipped).toBe(0)
    expect(devices[0]).toMatchObject({ clear: false, owner: false })
  })

  it('reads a device paired in the clear as one that never acts', () => {
    const { devices } = devicesIn(`${JSON.stringify(pairedLine({ clear: true }))}\n`)
    expect(devices[0]?.clear).toBe(true)
  })
})

describe('what an older Tade wrote', () => {
  it('still parses its scopes, projects and grants, words this Tade no longer has included', () => {
    const line = pairedLine({
      scopes: ['read', 'answer', 'steer'],
      projects: ['tade'],
      granted: ['titles', 'everything'],
    })
    const { devices, skipped } = devicesIn(`${JSON.stringify(line)}\n`)
    expect(skipped).toBe(0)
    expect(devices[0]).toMatchObject({ id: line.device, clear: false })
  })

  it('reads a line it cut to reading alone, off this machine, as paired in the clear', () => {
    // That Tade wrote no `clear`: it wrote `read` alone where the origin was
    // not trusted. Read in the direction that takes authority away.
    const lan = devicesIn(`${JSON.stringify(pairedLine({ scopes: ['read'] }))}\n`)
    expect(lan.devices[0]?.clear).toBe(true)
    const here = pairedLine({ scopes: ['read'], host: 'localhost:7654' })
    expect(devicesIn(`${JSON.stringify(here)}\n`).devices[0]?.clear).toBe(false)
  })

  it('parses its allowed and granted lines, and folds them into nothing', () => {
    const one = pairedLine()
    const text = [
      JSON.stringify(one),
      JSON.stringify({ kind: 'allowed', device: one.device, at: 'x', scopes: ['read'] }),
      JSON.stringify({ kind: 'granted', device: one.device, at: 'x', granted: [] }),
    ].join('\n')
    const { devices, skipped } = devicesIn(text)
    expect(skipped).toBe(0)
    expect(devices[0]).toMatchObject({ clear: false, digest: one.digest, revoked: null })
  })
})

describe('disconnect everything', () => {
  it('revokes every live device, and needs no network', async () => {
    const at = await home()
    const a = pairedLine()
    const b = pairedLine()
    await writeDevices(at, [a, b] as never)
    const gone = await revokeAll(at, new Date(NOW + 1))
    expect(gone.sort()).toEqual([a.device, b.device].sort())
    const after = await readDevices(at)
    expect(after.devices.every((one) => one.revoked === 'everything disconnected')).toBe(true)
  })

  it('leaves the file there, and revokes nothing twice', async () => {
    const at = await home()
    await writeDevices(at, [pairedLine()] as never)
    await revokeAll(at, new Date(NOW + 1))
    expect(await revokeAll(at, new Date(NOW + 2))).toEqual([])
    expect((await readFile(devicesPath(at), 'utf8')).trim().split('\n')).toHaveLength(2)
  })
})

describe('the sentence nothing in the file can answer', () => {
  it('says an agent could pair itself, and says the way out in the same breath', () => {
    // The same treatment `KEYS_AND_AGENTS` gets in `@tade/core`: the fact, and
    // what stands against it, in one sentence, so no control can quietly say
    // the comfortable half.
    expect(DEVICES_AND_AGENTS).toContain('0600')
    expect(DEVICES_AND_AGENTS).toContain('an agent is not another person')
    expect(DEVICES_AND_AGENTS).toContain('pair')
    expect(DEVICES_AND_AGENTS).toContain('Disconnect everything')
    expect(DEVICES_SEEN_BY_AGENTS).toBe('an agent on this machine could pair itself')
  })

  it('never says the file is one only you can read', () => {
    for (const word of ['only you', 'nobody else', 'cannot be read', 'private to you'])
      expect(DEVICES_AND_AGENTS.toLowerCase()).not.toContain(word)
  })
})
