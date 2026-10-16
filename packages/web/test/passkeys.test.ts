import { describe, expect, it } from 'vitest'
import type { Device } from '../src/devices.ts'
import {
  CHALLENGE_MS,
  Challenges,
  ceremonyFor,
  creationOptions,
  ENROL_MS,
  passkeyStanding,
  requestOptions,
} from '../src/passkeys.ts'
import type { Origin, Surface } from '../src/surface.ts'
import { OFF } from '../src/surface.ts'
import { userIdOf } from '../src/webauthn.ts'

// What the machine sets and says about a device's passkey, as values: the
// challenges it holds, which ceremony a device may begin, what the page is
// told, and what the authenticator is asked for. `passkey.test.ts` is the same
// over a real socket.

const NOW = Date.parse('2026-10-16T12:00:00Z')
const HOUR = 3_600_000
const PUBLIC: Origin = { scheme: 'https', host: 'tade.example.com', listener: 'public' }
const SURFACE: Surface = {
  ...OFF,
  enabled: true,
  passkeyMs: 12 * HOUR,
  publicName: 'tade.example.com',
}

function device(over: Partial<Device> = {}): Device {
  return {
    id: '00112233445566aa',
    label: 'iPhone',
    digest: 'f'.repeat(64),
    host: 'tade.example.com',
    csrf: 'x'.repeat(43),
    until: NOW + 30 * 24 * HOUR,
    pairedAt: NOW,
    scopes: ['read', 'steer'],
    projects: null,
    granted: [],
    from: '203.0.113.7',
    revoked: null,
    owner: false,
    passkey: null,
    ...over,
  }
}

const passkey = (proved: number) => ({
  id: 'AQID',
  key: 'k'.repeat(120),
  alg: -7 as const,
  counter: 0,
  synced: true,
  transports: ['internal'],
  at: NOW,
  proved,
})

describe('the challenges this machine sets', () => {
  it('is one per device, taken on its answer, and gone once it ran out', () => {
    const held = new Challenges()
    const first = held.set('a', 'create', 'https://x', 'x', NOW)
    const second = held.set('a', 'create', 'https://x', 'x', NOW)
    expect(second.challenge).not.toBe(first.challenge)
    expect(held.take('a', NOW)?.challenge).toBe(second.challenge)
    expect(held.take('a', NOW)).toBeNull()
    held.set('b', 'get', 'https://x', 'x', NOW)
    expect(held.take('b', NOW + CHALLENGE_MS)).toBeNull()
  })

  it('forgets the ones that ran out whenever it sets another', () => {
    const held = new Challenges()
    held.set('a', 'create', 'https://x', 'x', NOW)
    held.set('b', 'create', 'https://x', 'x', NOW + CHALLENGE_MS)
    expect(held.take('a', NOW)).toBeNull()
    expect(held.take('b', NOW + CHALLENGE_MS)).not.toBeNull()
  })
})

describe('which ceremony a device may begin', () => {
  it('is making one in the minutes after pairing, using one it made, and neither after', () => {
    expect(ceremonyFor(device(), NOW + ENROL_MS - 1)).toBe('create')
    expect(ceremonyFor(device(), NOW + ENROL_MS)).toBeNull()
    expect(ceremonyFor(device({ passkey: passkey(NOW) }), NOW + 100 * HOUR)).toBe('get')
  })
})

describe('what the page is told', () => {
  it('says the machine’s own answer, and nothing where nothing is asked', () => {
    const fresh = passkeyStanding(device({ passkey: passkey(NOW) }), PUBLIC, SURFACE, NOW + HOUR)
    expect(fresh).toEqual({
      asks: true,
      made: true,
      proven: true,
      until: new Date(NOW + 12 * HOUR).toISOString(),
      makeBy: null,
      hours: 12,
    })
    const stale = passkeyStanding(
      device({ passkey: passkey(NOW) }),
      PUBLIC,
      SURFACE,
      NOW + 13 * HOUR,
    )
    expect(stale.proven).toBe(false)
    const making = passkeyStanding(device(), PUBLIC, SURFACE, NOW)
    expect(making.makeBy).toBe(new Date(NOW + ENROL_MS).toISOString())
    const here = passkeyStanding(device(), { ...PUBLIC, listener: 'loopback' }, SURFACE, NOW)
    expect(here).toMatchObject({ asks: false, proven: false, until: null, makeBy: null })
    const off = passkeyStanding(device(), PUBLIC, { ...SURFACE, passkeyMs: 0 }, NOW)
    expect(off.asks).toBe(false)
    const address = passkeyStanding(device(), { ...PUBLIC, host: '203.0.113.7' }, SURFACE, NOW)
    expect(address.asks).toBe(false)
  })
})

describe('what the authenticator is asked for', () => {
  const held = new Challenges()

  it('makes one with a face or a passcode, no attestation, and this device’s own user id', () => {
    const set = held.set(
      '00112233445566aa',
      'create',
      'https://tade.example.com',
      'tade.example.com',
      NOW,
    )
    const options = creationOptions(device(), set) as Record<string, never>
    expect(options).toMatchObject({
      challenge: set.challenge,
      rp: { id: 'tade.example.com', name: 'Tade' },
      user: { id: userIdOf('00112233445566aa'), name: 'iPhone' },
      attestation: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    })
    expect(creationOptions(device({ label: ' ' }), set)).toMatchObject({
      user: { name: 'this device' },
    })
  })

  it('uses this device’s passkey and no other', () => {
    const set = held.set(
      '00112233445566aa',
      'get',
      'https://tade.example.com',
      'tade.example.com',
      NOW,
    )
    expect(requestOptions(device({ passkey: passkey(NOW) }), set)).toMatchObject({
      rpId: 'tade.example.com',
      allowCredentials: [{ type: 'public-key', id: 'AQID', transports: ['internal'] }],
      userVerification: 'required',
    })
    const bare = { ...passkey(NOW), transports: [] }
    expect(requestOptions(device({ passkey: bare }), set)).toMatchObject({
      allowCredentials: [{ type: 'public-key', id: 'AQID' }],
    })
    expect(requestOptions(device(), set)).toMatchObject({ allowCredentials: [] })
  })
})
