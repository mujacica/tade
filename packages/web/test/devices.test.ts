import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendDevice,
  DEVICES_FILE,
  devicesIn,
  devicesPath,
  readDevices,
  revokeAll,
  writeDevices,
} from '../src/devices.ts'
import { mint, SESSION_MS } from '../src/sessions.ts'
import { DEVICES_AND_AGENTS, DEVICES_SEEN_BY_AGENTS, reachOf } from '../src/surface.ts'

const NOW = Date.parse('2026-10-08T12:00:00Z')
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
    scopes: ['read'],
    projects: null,
    granted: [],
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
    expect(await readDevices(await home())).toEqual({ devices: [], skipped: 0 })
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

  it('ignores a revoked line for a device nothing introduced', () => {
    // It parsed and says something true; there is just nothing to disconnect.
    // Not a skip, and not a device.
    const text = JSON.stringify({
      kind: 'revoked',
      device: '0011223344556677',
      at: new Date(NOW).toISOString(),
      why: 'signed out',
    })
    expect(devicesIn(text)).toEqual({ devices: [], skipped: 0 })
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

describe('read scopes, as a reach', () => {
  it('turns no project list into every project', () => {
    const { devices } = devicesIn(`${JSON.stringify(pairedLine({ projects: null }))}\n`)
    expect(reachOf(devices[0] as never).projects).toEqual({ kind: 'every' })
  })

  it('turns a list into exactly that list', () => {
    const { devices } = devicesIn(`${JSON.stringify(pairedLine({ projects: ['tade', 'ops'] }))}\n`)
    expect(reachOf(devices[0] as never).projects).toEqual({
      kind: 'listed',
      names: ['tade', 'ops'],
    })
  })

  it('carries the grants it recognises and drops a word it does not', () => {
    // A line in this file is one an agent on this machine could have written,
    // so a grant nobody here understands is exactly the shape of one somebody
    // invented. Dropped, which is what `has()` would have made of it anyway.
    const { devices } = devicesIn(
      `${JSON.stringify(pairedLine({ granted: ['notes', 'spend'] }))}\n`,
    )
    expect(reachOf(devices[0] as never).granted).toEqual(['notes', 'spend'])
    expect(reachOf({ id: 'a', projects: null, granted: ['notes', 'everything'] }).granted).toEqual([
      'notes',
    ])
  })

  it('refuses a grant word in the file itself, which is the stronger guard', () => {
    const { skipped } = devicesIn(`${JSON.stringify(pairedLine({ granted: ['everything'] }))}\n`)
    expect(skipped).toBe(1)
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
